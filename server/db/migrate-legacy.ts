/**
 * 旧数据迁移 CLI（M5，`docs/architecture-design.md` §8）。
 *
 * 把旧应用的 SQLite 快照（`app_state` 单表 JSON）+ 磁盘产物，迁到新栈的关系模型 + 新产物根。
 *
 * 用法：
 *   pnpm -C server migrate:legacy -- --data-dir /data/youzhao --dry-run
 *   pnpm -C server migrate:legacy -- --data-dir /data/youzhao --owner admin --report /tmp/legacy-report.json
 *
 * 关键参数：
 *   --data-dir <dir>     旧数据目录（含 `youzhao.sqlite` 与 `previews/`）；也可用 $YOUZHAO_LEGACY_DATA_DIR
 *   --state <file.json>  直接用导出的 JSON 快照（与 --data-dir 二选一）
 *   --artifacts <dir>    旧产物根，默认取 `<data-dir>/previews`
 *   --skip-artifacts     不搬产物（版本全部标 missing，之后再手工上传）
 *   --owner <username>   指定谁成为平台所有者；缺省时仅当旧库恰好只有一个 `system-settings:manage` 用户
 *   --default-group <id> 默认分组 id（默认 `group_default`）
 *   --report <file>      把完整报告（含迁移前后可见范围对照）写成 JSON
 *   --dry-run            只读旧数据 + 打印计划与对照，**不碰目标库**
 *   --replace            目标库已有业务数据时，先清空业务表（不动 schema_migrations）
 *
 * 纪律（§8）：迁移**不自动**授予 `blueprint.publish`；已完成（未归档）蓝图与其分组必须原样迁移；
 * `owner` 唯一且由 `--owner` 明确；产物缺失只影响该版本（标 `missing`），不让整次迁移失败。
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError, loadConfig } from '../config.js';
import {
  legacyPreviewRoot,
  readLegacyStateFile,
  readLegacyStateFromDataDir,
  type LegacyStateSource,
} from './legacy/model.js';
import {
  KNOWN_LEGACY_DEFECTS,
  LegacyMigrationError,
  planLegacyMigration,
  type LegacyMigrationPlan,
} from './legacy/plan.js';
import { applyLegacyMigration, LegacyApplyError, type LegacyApplyResult } from './legacy/apply.js';
import { assertMigrationsApplied } from './migrate.js';
import { openStorage } from './open.js';

interface CliOptions {
  dataDir: string | null;
  stateFile: string | null;
  artifactsDir: string | null;
  skipArtifacts: boolean;
  ownerUsername: string | null;
  defaultGroupId: string | null;
  reportPath: string | null;
  dryRun: boolean;
  replace: boolean;
}

const USAGE = `把旧「有招」数据迁移到新栈（见 docs/architecture-design.md §8）

  pnpm -C server migrate:legacy -- [选项]

选项：
  --data-dir <dir>      旧数据目录（含 youzhao.sqlite 与 previews/）；也可用 $YOUZHAO_LEGACY_DATA_DIR
  --state <file.json>   直接用导出的 JSON 快照
  --artifacts <dir>     旧产物根（默认 <data-dir>/previews）
  --skip-artifacts      不搬产物
  --owner <username>    指定平台所有者
  --default-group <id>  默认分组 id（默认 group_default）
  --report <file>       写出完整报告 JSON
  --dry-run             只打印计划与对照，不写目标库
  --replace             目标库有数据时先清空业务表
  -h, --help            显示本帮助
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === 'help') {
    console.info(USAGE);
    return;
  }

  const source = await readSource(options);
  console.info(`→ 已读取旧数据：${source.source}`);

  const plan = planLegacyMigration(source.state, {
    ...(options.ownerUsername ? { ownerUsername: options.ownerUsername } : {}),
    ...(options.defaultGroupId ? { defaultGroupId: options.defaultGroupId } : {}),
  });
  console.info(summarizePlan(plan, options));

  if (options.dryRun) {
    console.info('\n（--dry-run：没有写入目标库。去掉该参数即可执行迁移。）');
    await writeReport(options, plan, null, source);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw error;
  }

  const storage = await openStorage(config);
  try {
    await assertMigrationsApplied(storage.runner);

    const artifactSourceRoot = options.skipArtifacts
      ? null
      : (options.artifactsDir ?? (options.dataDir ? legacyPreviewRoot(options.dataDir) : null));

    const result = await applyLegacyMigration({
      db: storage.db,
      plan,
      artifactSourceRoot,
      artifactTargetRoot: config.preview.storagePath,
      replace: options.replace,
    });

    console.info(summarizeApply(result));
    await writeReport(options, plan, result, source);
    console.info('\n✓ 迁移完成。请用所有者账号登录，逐条处理下面的人工确认项：');
    for (const decision of plan.publishDecisions) {
      console.info(`   · 发布能力：${decision.username}（${decision.note}）`);
    }
    if (plan.publishDecisions.length === 0) console.info('   ·（没有待确认的发布能力）');
  } finally {
    await storage.close().catch(() => undefined);
  }
}

function parseArgs(argv: string[]): CliOptions | 'help' {
  const options: CliOptions = {
    dataDir: process.env.YOUZHAO_LEGACY_DATA_DIR ?? null,
    stateFile: null,
    artifactsDir: null,
    skipArtifacts: false,
    ownerUsername: null,
    defaultGroupId: null,
    reportPath: null,
    dryRun: false,
    replace: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const next = (): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new LegacyMigrationError(`选项 ${arg} 缺少取值`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--data-dir':
        options.dataDir = next();
        break;
      case '--state':
        options.stateFile = next();
        break;
      case '--artifacts':
        options.artifactsDir = next();
        break;
      case '--skip-artifacts':
        options.skipArtifacts = true;
        break;
      case '--owner':
        options.ownerUsername = next();
        break;
      case '--default-group':
        options.defaultGroupId = next();
        break;
      case '--report':
        options.reportPath = next();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--replace':
        options.replace = true;
        break;
      default:
        throw new LegacyMigrationError(`未知选项 ${arg}（用 --help 查看用法）`);
    }
  }

  if (!options.dataDir && !options.stateFile) {
    throw new LegacyMigrationError(
      '必须指定 --data-dir <旧数据目录> 或 --state <json 快照>（也可设 $YOUZHAO_LEGACY_DATA_DIR）',
    );
  }
  return options;
}

async function readSource(options: CliOptions): Promise<LegacyStateSource> {
  if (options.stateFile) {
    return readLegacyStateFile(path.resolve(options.stateFile));
  }
  return readLegacyStateFromDataDir(path.resolve(options.dataDir as string));
}

function summarizePlan(plan: LegacyMigrationPlan, options: CliOptions): string {
  const lines: string[] = [];
  const { counts } = plan;
  lines.push('');
  lines.push('── 迁移计划 ────────────────────────────────────────────');
  lines.push(
    `  所有者：${plan.users.find((user) => user.legacyId === plan.ownerUserId)?.username ?? plan.ownerUserId}`,
  );
  lines.push(
    `  用户 ${counts.users}（用户管理员 ${counts.userAdmins} / 成员 ${counts.members}）` +
      ` · 分组 ${counts.groups} · 蓝图 ${counts.blueprints} · 版本 ${counts.versions}`,
  );
  lines.push(`  查看授权 ${counts.grants} · 业务能力 ${counts.capabilities} · Token ${counts.tokens}`);
  lines.push(
    `  产物：${options.skipArtifacts ? '跳过（--skip-artifacts）' : (options.artifactsDir ?? (options.dataDir ? legacyPreviewRoot(options.dataDir) : '（未指定）'))}`,
  );

  const changed = plan.comparison.filter((row) => row.change !== 'same');
  lines.push('');
  lines.push('── 迁移前后可见范围对照（有变化的人） ──────────────────');
  if (changed.length === 0) {
    lines.push('  所有人的可见范围都不变。');
  } else {
    for (const row of changed) {
      lines.push(
        `  ${row.username}（${row.identity}）：${row.legacyVisible.length} → ${row.migratedVisible.length} 蓝图 · ${row.change === 'widened' ? '变宽' : '变窄'}`,
      );
      for (const note of row.notes) lines.push(`      · ${note}`);
    }
  }

  lines.push('');
  lines.push('── 需要人工确认 ────────────────────────────────────────');
  for (const decision of plan.publishDecisions) {
    lines.push(`  发布能力：${decision.username}（分组：${decision.groups.join('、') || '（无）'}）`);
  }
  if (plan.publishDecisions.length === 0) lines.push('  （无）');

  if (plan.dropped.length > 0) {
    lines.push('');
    lines.push('── 不迁移的旧数据 ──────────────────────────────────────');
    for (const item of plan.dropped) lines.push(`  · ${item}`);
  }

  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('── 警告 ────────────────────────────────────────────────');
    for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  }

  lines.push('');
  lines.push('── 本次迁移一并修正的旧模型缺陷 ────────────────────────');
  for (const defect of KNOWN_LEGACY_DEFECTS) {
    lines.push(`  ${defect.id} ${defect.title}`);
  }
  return lines.join('\n');
}

function summarizeApply(result: LegacyApplyResult): string {
  const lines: string[] = [''];
  lines.push('── 已写入目标库 ────────────────────────────────────────');
  const { inserted } = result;
  lines.push(
    `  分组 ${inserted.groups} · 用户 ${inserted.users} · 身份 ${inserted.identities}` +
      ` · 查看授权 ${inserted.grants} · 能力 ${inserted.capabilities}` +
      ` · 蓝图 ${inserted.blueprints} · 版本 ${inserted.versions} · Token ${inserted.tokens}`,
  );
  if (result.artifacts.copied.length > 0) {
    lines.push(`  产物已搬运 ${result.artifacts.copied.length} 个版本：`);
    for (const item of result.artifacts.copied) {
      lines.push(`    · ${item.blueprintId}@${item.version}（${item.files} 个文件 / ${item.bytes} 字节）`);
    }
  }
  for (const item of result.artifacts.missing) {
    lines.push(`  ! 产物缺失 ${item.blueprintId}@${item.version}：${item.reason}`);
  }
  for (const item of result.artifacts.failed) {
    lines.push(`  ✗ 产物搬运失败 ${item.blueprintId}@${item.version}：${item.error}`);
  }
  return lines.join('\n');
}

async function writeReport(
  options: CliOptions,
  plan: LegacyMigrationPlan,
  result: LegacyApplyResult | null,
  source: LegacyStateSource,
): Promise<void> {
  if (!options.reportPath) return;
  const report = {
    generatedAt: new Date().toISOString(),
    source: source.source,
    dryRun: options.dryRun,
    ownerUserId: plan.ownerUserId,
    counts: plan.counts,
    comparison: plan.comparison,
    publishDecisions: plan.publishDecisions,
    warnings: plan.warnings,
    dropped: plan.dropped,
    knownLegacyDefects: KNOWN_LEGACY_DEFECTS,
    applied: result,
  };
  await writeFile(path.resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.info(`→ 报告已写出：${path.resolve(options.reportPath)}`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const known =
    error instanceof LegacyMigrationError ||
    error instanceof LegacyApplyError ||
    error instanceof ConfigError;
  console.error(`${known ? '✗' : '✗ 意外错误：'} ${message}`);
  process.exit(1);
});
