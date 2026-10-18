/**
 * 执行层：把 `LegacyMigrationPlan` 落到新库（M5，§8）。
 *
 * 与 `./plan.ts` 的分工：计划器是纯函数（可脱库单测），这里含全部 IO——
 * 清空/写入关系表、把旧 `previews/` 目录搬进新产物根。
 *
 * 三条硬约束：
 *  1. **不物理删除旧数据**：目标库有数据时必须显式 `replace: true` 才清空，且只清业务表，
 *     绝不动 `schema_migrations`。
 *  2. **产物先校验后落盘**：复用 M2 的 `writeArtifactPackage`（临时目录 + 原子改名），
 *     失败只影响该版本（标记 `missing` 并进报告），不让整次迁移半途而死。
 *  3. **口令只在内存里过一遍**：明文只用于算 scrypt 哈希，绝不写进报告或日志；
 *     旧库没有口令记录的用户拿一个随机不可知口令，必须由管理员重置。
 */

import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { sql as kyselySql } from 'kysely';

import type { Db } from '../types.js';
import { newId } from '../../domain/ids.js';
import { hashPassword } from '../../domain/password.js';
import {
  artifactDirFor,
  writeArtifactPackage,
} from '../../storage/artifacts.js';
import type { ZipEntry } from '../../storage/zip.js';
import type { LegacyMigrationPlan, PlannedUser } from './plan.js';

export interface LegacyApplyInput {
  readonly db: Db;
  readonly plan: LegacyMigrationPlan;
  /** 旧产物根（`<dataDir>/previews`）；null = 不搬产物，版本标 `missing` */
  readonly artifactSourceRoot: string | null;
  /** 新产物根（`PREVIEW_STORAGE_PATH`） */
  readonly artifactTargetRoot: string;
  /** 目标库已有业务数据时是否清空重来 */
  readonly replace: boolean;
  readonly now?: () => Date;
}

export interface LegacyApplyResult {
  readonly wiped: boolean;
  readonly inserted: {
    groups: number;
    users: number;
    identities: number;
    grants: number;
    capabilities: number;
    blueprints: number;
    versions: number;
    tokens: number;
  };
  readonly artifacts: {
    copied: { blueprintId: string; version: string; files: number; bytes: number }[];
    missing: { blueprintId: string; version: string; reason: string }[];
    failed: { blueprintId: string; version: string; error: string }[];
  };
  readonly warnings: string[];
}

export class LegacyApplyError extends Error {}

/** 业务表清空顺序（先子表后父表，FK 安全）；`schema_migrations` 不在其列。 */
const WIPE_ORDER = [
  'preview_tickets',
  'mcp_idempotency',
  'mcp_tokens',
  'capabilities',
  'view_grants',
  'user_managers',
  'sessions',
  'audit_logs',
  'blueprint_versions',
  'blueprints',
  'blueprint_groups',
  'user_identity',
  'users',
] as const;

export async function applyLegacyMigration(
  input: LegacyApplyInput,
): Promise<LegacyApplyResult> {
  const { db, plan } = input;
  const now = input.now ?? (() => new Date());
  const warnings = [...plan.warnings];
  const artifacts: LegacyApplyResult['artifacts'] = { copied: [], missing: [], failed: [] };

  // ── 目标库保护 ───────────────────────────────────────────────────────────
  // 只有一种「非空」是安全的：迁移 0002 会 seed 一个 id 为 group_default 的默认分组，
  // 因此「没有任何非默认分组、没有任何用户」才算空库；其余一律要求 --replace。
  const existing = await db.selectFrom('users').select('id').execute();
  const existingGroups = await db.selectFrom('blueprint_groups').select('id').execute();
  const foreignGroups = existingGroups.filter((group) => group.id !== 'group_default');
  let wiped = false;
  if (existing.length > 0 || foreignGroups.length > 0) {
    if (!input.replace) {
      const detail =
        existing.length > 0
          ? `${existing.length} 个用户`
          : `${foreignGroups.length} 个分组（${foreignGroups
              .slice(0, 3)
              .map((group) => group.id)
              .join('、')}${foreignGroups.length > 3 ? ' 等' : ''}）`;
      throw new LegacyApplyError(
        `目标库已有 ${detail}，迁移被拒绝（避免把真实数据冲掉）。` +
          `确认目标库是空的，或显式加 --replace 清空业务表后重试（不会动 schema_migrations）。`,
      );
    }
    // 迁移期间禁掉外键校验再逐表清空，避免清表顺序成为新的失败点。
    await runRaw(db, 'set session_replication_role = replica');
    try {
      for (const table of WIPE_ORDER) {
        await runRaw(db, `delete from ${table}`);
      }
    } finally {
      await runRaw(db, 'set session_replication_role = default');
    }
    wiped = true;
    warnings.push(`--replace：已清空目标库 ${WIPE_ORDER.length} 张业务表（schema_migrations 未动）`);
  }

  // ── 用户与身份 ───────────────────────────────────────────────────────────
  const passwordHashes = new Map<string, string>();
  for (const user of plan.users) {
    passwordHashes.set(user.legacyId, await passwordHashFor(user));
  }

  const at = now();
  if (plan.users.length > 0) {
    await db
      .insertInto('users')
    .values(
      plan.users.map((user) => ({
        id: user.legacyId,
        username: user.username,
        display_name: user.displayName,
        email: user.email,
        phone: user.phone,
        status: user.status,
        password_hash: passwordHashes.get(user.legacyId) as string,
        must_change_password: true,
        created_by_user_id: null,
        created_at: parseDateOr(user.createdAt, at),
        updated_at: parseDateOr(user.createdAt, at),
      })),
    )
      .execute();
  }

  if (plan.users.length > 0) {
    await db
      .insertInto('user_identity')
    .values(
      plan.users.map((user) => ({
        user_id: user.legacyId,
        identity: user.identity,
        granted_by: user.legacyId === plan.ownerUserId ? null : plan.ownerUserId,
        granted_at: at,
        })),
      )
      .execute();
  }

  // 旧模型没有「管理归属」概念（D6 那套 user_managers 是新模型才有的）：
  // 迁移后所有成员都暂不归属任何用户管理员，由所有者在「权限」页分配。
  if (plan.counts.members + plan.counts.userAdmins > 0) {
    warnings.push(
      '旧模型没有「管理归属」概念：迁移后所有用户都不归属任何用户管理员，请在所有者的「权限」页批量指派',
    );
  }

  // ── 分组与蓝图 ───────────────────────────────────────────────────────────
  if (!wiped && existingGroups.length > 0) {
    // 迁移 0002 seed 的默认分组（id 相同、名字不同）先让位，再由旧快照重建，保证名字/排序忠于旧数据。
    await db.deleteFrom('blueprint_groups').where('id', '=', 'group_default').execute();
    warnings.push('目标库已有 bootstrap 生成的默认分组，已按旧快照重建（名称与排序以旧数据为准）');
  }
  if (plan.groups.length > 0) {
    await db
      .insertInto('blueprint_groups')
    .values(
      plan.groups.map((group) => ({
        id: group.id,
        name: group.name,
        is_default: group.isDefault,
        sort_order: group.sortOrder,
        archived_at: group.archivedAt ? new Date(group.archivedAt) : null,
          created_at: at,
        })),
      )
      .execute();
  }

  if (plan.blueprints.length > 0) {
    await db
      .insertInto('blueprints')
      .values(
        plan.blueprints.map((blueprint) => ({
          id: blueprint.id,
          name: blueprint.name.slice(0, 120),
          summary: blueprint.summary,
          tags: blueprint.tags,
          group_id: blueprint.groupId,
          status: blueprint.status,
          // 旧模型不记录创建者：统一挂到所有者名下（新库该列 not null），并在报告里说明。
          created_by_user_id: plan.ownerUserId,
          created_at: parseDateOr(blueprint.createdAt, at),
          updated_at: parseDateOr(blueprint.updatedAt ?? blueprint.createdAt, at),
        })),
      )
      .execute();
  }

  // ── 版本与产物 ───────────────────────────────────────────────────────────
  const versionRows: {
    id: string;
    blueprint_id: string;
    version: string;
    is_latest: boolean;
    status: 'available' | 'missing';
    entry_path: string;
    artifact_path: string;
    artifact_hash: string | null;
    artifact_bytes: number | null;
    publish_source: 'mcp' | 'web' | 'web-cover';
    publish_note: string;
    deployed_at: Date;
  }[] = [];

  for (const blueprint of plan.blueprints) {
    for (const version of blueprint.versions) {
      const artifactPath = artifactDirFor(input.artifactTargetRoot, blueprint.id, version.version);
      // 新库里的状态只反映「新产物根里到底有没有产物」：默认 missing，只有真的搬成功才置 available。
      // 计划器里的 status 描述的是旧目录的情况，不能直接当作新库状态（否则会出现「标记可用但没有产物」）。
      let status: 'available' | 'missing' = 'missing';
      let hash: string | null = null;
      let bytes: number | null = null;

      if (input.artifactSourceRoot) {
        try {
          const files = await readArtifactDir(input.artifactSourceRoot, blueprint.id, version.version);
          const packageFiles = withInlineMarkdown(files, version.inlineMarkdown);
          if (packageFiles.length === 0) {
            status = 'missing';
            artifacts.missing.push({
              blueprintId: blueprint.id,
              version: version.version,
              reason: '旧产物目录不存在或为空',
            });
          } else if (!packageFiles.some((file) => file.path === 'index.html')) {
            status = 'missing';
            artifacts.missing.push({
              blueprintId: blueprint.id,
              version: version.version,
              reason: '旧产物里没有 index.html（新前端无法打开）',
            });
          } else {
            const published = await writeArtifactPackage({
              root: input.artifactTargetRoot,
              blueprintId: blueprint.id,
              version: version.version,
              files: packageFiles,
              replace: true,
              now,
            });
            status = 'available';
            hash = published.hash;
            bytes = published.bytes;
            artifacts.copied.push({
              blueprintId: blueprint.id,
              version: version.version,
              files: packageFiles.length,
              bytes: published.bytes,
            });
          }
        } catch (error) {
          status = 'missing';
          artifacts.failed.push({
            blueprintId: blueprint.id,
            version: version.version,
            error: (error as Error).message,
          });
          warnings.push(
            `产物搬运失败（${blueprint.id}@${version.version}）：${(error as Error).message}——该版本标记为 missing，可手工补传`,
          );
        }
      }

      versionRows.push({
        id: version.id,
        blueprint_id: blueprint.id,
        version: version.version.slice(0, 64),
        is_latest: version.isLatest,
        status,
        entry_path: 'index.html',
        artifact_path: artifactPath,
        artifact_hash: hash,
        artifact_bytes: bytes,
        publish_source: version.publishSource,
        publish_note: version.publishNote,
        deployed_at: parseDateOr(version.deployedAt, at),
      });
    }
  }

  if (versionRows.length > 0) {
    await db.insertInto('blueprint_versions').values(versionRows).execute();
  }

  if (!input.artifactSourceRoot && versionRows.length > 0) {
    warnings.push(
      `未指定旧产物目录：${versionRows.length} 个版本全部标记为 missing，可在「蓝图」页重新上传`,
    );
  }

  // ── 授权与能力 ───────────────────────────────────────────────────────────
  if (plan.grants.length > 0) {
    await db
      .insertInto('view_grants')
      .values(
        plan.grants.map((grant) => ({
          id: newId('grn'),
          user_id: grant.userId,
          target_type: grant.targetType,
          target_id: grant.targetId,
          // 旧模型没有「谁授予的」：迁移统一记为所有者授予，用户管理员不可撤销他人授予项。
          granted_by: plan.ownerUserId,
          created_at: at,
        })),
      )
      .execute();
  }

  if (plan.capabilities.length > 0) {
    await db
      .insertInto('capabilities')
      .values(
        plan.capabilities.map((capability) => ({
          id: newId('cap'),
          user_id: capability.userId,
          capability: capability.capability,
          target_type: capability.targetType,
          target_id: capability.targetId,
          granted_by: plan.ownerUserId,
          created_at: at,
        })),
      )
      .execute();
  }

  // ── Token（停用占位） ────────────────────────────────────────────────────
  // 旧 Token 的明文已不可回收，且旧哈希格式与新令牌（`yz_mcp_<tokenId>_<secret>`）不兼容，
  // 迁移后一律 `disabled`；这里给一个永不匹配的随机哈希，保证不会被误用。
  if (plan.tokens.length > 0) {
    await db
      .insertInto('mcp_tokens')
      .values(
        plan.tokens.map((token) => ({
          id: token.id,
          name: token.name.slice(0, 80),
          token_hash: legacyPlaceholderHash(token.id),
          token_prefix: `legacy:${token.tokenPrefix}`.slice(0, 60),
          bound_user_id: token.boundUserId,
          created_by_user_id: plan.ownerUserId,
          scopes: token.scopes,
          status: 'disabled' as const,
          expires_at: token.expiresAt ? new Date(token.expiresAt) : null,
          last_used_at: null,
          created_at: parseDateOr(token.createdAt, at),
        })),
      )
      .execute();
  }

  return {
    wiped,
    inserted: {
      groups: plan.groups.length,
      users: plan.users.length,
      identities: plan.users.length,
      grants: plan.grants.length,
      capabilities: plan.capabilities.length,
      blueprints: plan.blueprints.length,
      versions: versionRows.length,
      tokens: plan.tokens.length,
    },
    artifacts,
    warnings,
  };
}

async function passwordHashFor(user: PlannedUser): Promise<string> {
  if (user.plainPassword) return hashPassword(user.plainPassword);
  // 旧凭据表没有这条记录：给随机不可知口令（而不是空哈希，空哈希会被当成可登录）。
  return hashPassword(randomBytes(32).toString('hex'));
}

function legacyPlaceholderHash(tokenId: string): string {
  return createHash('sha256')
    .update(`legacy-disabled:${tokenId}:${randomBytes(16).toString('hex')}`)
    .digest('hex');
}

/** 读旧产物目录为 ZIP 条目（`index.html` 必在根级由新模型保证）。 */
async function readArtifactDir(
  sourceRoot: string,
  blueprintId: string,
  version: string,
): Promise<ZipEntry[]> {
  const dir = path.join(sourceRoot, blueprintId, version);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return [];

  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: ZipEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath ?? dir, entry.name);
    const relative = path.relative(dir, absolute).split(path.sep).join('/');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (relative === 'manifest.json') continue; // 旧清单不带新模型的哈希信息，忽略后重算
    files.push({ path: relative, bytes: await readFile(absolute) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 旧产物把 Markdown 正文写成根级 `blueprint.md`，而新模型的产物只认根级
 * `index.html` + `README.md`（`server/storage/artifacts.ts`）。这里统一归一，
 * 同时保留旧库行内 `markdown`（它是旧库存的当前正文）：
 * - 有行内正文 → 用它写 `README.md`，丢弃可能已过期的 `blueprint.md`；
 * - 没有行内正文（旧数据里正文只落在文件里）→ 把 `blueprint.md` 改名成 `README.md`，不丢文案；
 * - 已经有 `README.md` 时以它为准，只丢弃 `blueprint.md`。
 */
function withInlineMarkdown(files: ZipEntry[], markdown: string | null): ZipEntry[] {
  const atRoot = (file: ZipEntry, name: string): boolean => file.path.toLowerCase() === name;
  const legacyMarkdown = files.find((file) => atRoot(file, 'blueprint.md'));
  const existingReadme = files.find((file) => atRoot(file, 'readme.md'));
  const rest = files.filter((file) => !atRoot(file, 'blueprint.md'));

  if (existingReadme) return rest;
  const bytes = markdown && markdown.trim()
    ? Buffer.from(markdown, 'utf8')
    : legacyMarkdown?.bytes;
  if (!bytes) return rest;
  return [...rest, { path: 'README.md', bytes }].sort((a, b) => a.path.localeCompare(b.path));
}

function parseDateOr(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/** `runRaw` 通道：清空表、切外键会话这类语句不走 Kysely 的插入类型系统。 */
async function runRaw(db: Db, statement: string): Promise<void> {
  await kyselySql.raw(statement).execute(db);
}
