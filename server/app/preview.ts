/**
 * 预览与嵌入（docs/architecture-design.md §3.6、§3.7）。
 *
 * 统一票据模型：一次性票据（数据库存哈希，默认 60s）→ 换取**预览域**受限 Cookie（30min，
 * 绑定单个蓝图 + 版本）→ 子资源逐请求校验。产物不再匿名可读，且资源被归档/撤权/停用后
 * 一律拒绝，不再出现「归档后仍能打开」的情况。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/types.js';
import { AppError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { visibleToContext } from '../domain/scopes.js';
import type { RequestContext } from '../domain/entities.js';
import { buildUserContext } from './context.js';

export const PREVIEW_COOKIE_NAME = 'yz_preview';
/** 换票后预览域 Cookie 的有效期（与票据的 60s 分开） */
export const PREVIEW_COOKIE_TTL_SECONDS = 30 * 60;
const TICKET_PREFIX = 'yz_pt_';
const COOKIE_VERSION = 'v1';

export type PreviewPurpose = 'preview' | 'embed';

export interface PreviewTicketInput {
  readonly blueprintId: string;
  readonly version?: string;
  readonly purpose: PreviewPurpose;
}

export interface PreviewTicketResult {
  readonly ticket: string;
  readonly expiresAt: Date;
  readonly url: string;
  readonly blueprintId: string;
  readonly version: string;
  readonly purpose: PreviewPurpose;
}

export interface PreviewCookiePayload {
  /** blueprintId */
  readonly b: string;
  /** version */
  readonly v: string;
  /** purpose */
  readonly p: PreviewPurpose;
  /** 签发时的用户；嵌入场景为 null */
  readonly u: string | null;
  /** 过期时间（epoch 秒） */
  readonly exp: number;
}

export interface PreviewTarget {
  readonly blueprintId: string;
  readonly version: string;
  readonly groupId: string;
  readonly artifactPath: string;
  readonly entryPath: string;
}

export function hashTicket(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateTicket(): string {
  return `${TICKET_PREFIX}${randomBytes(32).toString('hex')}`;
}

function previewBaseUrl(config: AppConfig): string {
  const base = config.preview.domain.replace(/\/+$/, '');
  const path = config.preview.publicBasePath.replace(/\/+$/, '');
  return `${base}${path}`;
}

/** 未归档且可交付的版本；未指定时取「最新未归档」 */
async function resolveVersion(
  db: Db,
  blueprintId: string,
  requested: string | undefined,
): Promise<{ version: string; artifactPath: string; entryPath: string }> {
  const query = db
    .selectFrom('blueprint_versions')
    .select(['version', 'artifact_path', 'entry_path'])
    .where('blueprint_id', '=', blueprintId)
    .where('archived_at', 'is', null);
  const row =
    requested === undefined
      ? await query.orderBy('is_latest', 'desc').orderBy('deployed_at', 'desc').limit(1).executeTakeFirst()
      : await query.where('version', '=', requested).executeTakeFirst();
  if (row === undefined) throw new AppError('VERSION_NOT_FOUND');
  return { version: row.version, artifactPath: row.artifact_path, entryPath: row.entry_path };
}

async function loadActiveBlueprint(db: Db, blueprintId: string): Promise<{ id: string; groupId: string }> {
  const row = await db
    .selectFrom('blueprints')
    .select(['id', 'group_id', 'archived_at'])
    .where('id', '=', blueprintId)
    .executeTakeFirst();
  // 归档与不存在都回 404：不泄露资源是否存在
  if (row === undefined || row.archived_at !== null) throw new AppError('BLUEPRINT_NOT_FOUND');
  return { id: row.id, groupId: row.group_id };
}

/**
 * 申请票据。
 * - `purpose='preview'`：`ctx` 必须是已登录且有该蓝图查看权的工作台用户。
 * - `purpose='embed'`：`ctx` 为 null，凭证是嵌入共享密钥（在路由层校验）。
 */
export async function issuePreviewTicket(
  db: Db,
  config: AppConfig,
  input: PreviewTicketInput,
  ctx: RequestContext | null,
): Promise<PreviewTicketResult> {
  if (input.purpose === 'preview' && ctx === null) {
    throw new AppError('UNAUTHENTICATED');
  }
  if (input.purpose === 'embed' && config.preview.embedSecret === '') {
    // 未配置嵌入密钥：不接受嵌入票据申请，而不是退回某个默认值
    throw new AppError('SERVICE_UNAVAILABLE', '当前部署未启用嵌入');
  }

  const blueprint = await loadActiveBlueprint(db, input.blueprintId);
  const version = await resolveVersion(db, input.blueprintId, input.version);

  if (ctx !== null) {
    const visible = visibleToContext(ctx, {
      kind: 'blueprint',
      id: blueprint.id,
      groupId: blueprint.groupId,
    });
    if (!visible) throw new AppError('FORBIDDEN', '当前账号没有此蓝图的查看权限');
  }

  const raw = generateTicket();
  const expiresAt = new Date(Date.now() + config.preview.ticketTtlSeconds * 1000);
  await db
    .insertInto('preview_tickets')
    .values({
      id: newId('tkt'),
      ticket_hash: hashTicket(raw),
      blueprint_id: blueprint.id,
      version: version.version,
      issued_to_user_id: ctx === null ? null : ctx.userId,
      purpose: input.purpose,
      expires_at: expiresAt,
    })
    .execute();

  const url = `${previewBaseUrl(config)}/p/${encodeURIComponent(blueprint.id)}/${encodeURIComponent(
    version.version,
  )}/?t=${raw}`;
  return {
    ticket: raw,
    expiresAt,
    url,
    blueprintId: blueprint.id,
    version: version.version,
    purpose: input.purpose,
  };
}

/**
 * 换票：校验一次性票据并**作废**它，返回写成 Cookie 所需的载荷。
 * 失败原因分开（不存在/已使用/过期/不匹配），前端才能按 P3 的四态呈现。
 */
export async function redeemPreviewTicket(
  db: Db,
  raw: string,
  target: { readonly blueprintId: string; readonly version: string },
): Promise<PreviewCookiePayload> {
  const row = await db
    .selectFrom('preview_tickets')
    .selectAll()
    .where('ticket_hash', '=', hashTicket(raw))
    .executeTakeFirst();
  if (row === undefined) throw new AppError('FORBIDDEN', '票据无效');
  if (row.blueprint_id !== target.blueprintId || row.version !== target.version) {
    throw new AppError('FORBIDDEN', '票据与请求的蓝图版本不匹配');
  }
  if (row.used_at !== null) throw new AppError('FORBIDDEN', '票据已被使用');
  if (row.expires_at.getTime() <= Date.now()) throw new AppError('FORBIDDEN', '票据已过期');

  // 原子作废：并发换票时只有一个能拿到这行
  const claimed = await db
    .updateTable('preview_tickets')
    .set({ used_at: new Date() })
    .where('id', '=', row.id)
    .where('used_at', 'is', null)
    .returning(['id'])
    .executeTakeFirst();
  if (claimed === undefined) throw new AppError('FORBIDDEN', '票据已被使用');

  return {
    b: row.blueprint_id,
    v: row.version,
    p: row.purpose === 'embed' ? 'embed' : 'preview',
    u: row.issued_to_user_id,
    exp: Math.floor(Date.now() / 1000) + PREVIEW_COOKIE_TTL_SECONDS,
  };
}

function sign(config: AppConfig, data: string): string {
  return createHmac('sha256', config.preview.ticketSecret).update(data).digest('base64url');
}

export function signPreviewCookie(config: AppConfig, payload: PreviewCookiePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${COOKIE_VERSION}.${body}.${sign(config, body)}`;
}

/** 只做完整性与过期校验；资源是否仍可预览由 `assertPreviewAccess` 判定 */
export function verifyPreviewCookie(config: AppConfig, value: string): PreviewCookiePayload | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [version, body, signature] = parts as [string, string, string];
  if (version !== COOKIE_VERSION) return null;
  const expected = sign(config, body);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let parsed: PreviewCookiePayload;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PreviewCookiePayload;
  } catch {
    return null;
  }
  if (typeof parsed.exp !== 'number' || parsed.exp * 1000 <= Date.now()) return null;
  return parsed;
}

/**
 * 每个产物请求都要过这一关（§3.6 访问控制）：票据有效 ∧ 资源仍可预览。
 * 归档、撤权、停用、过期一律 403。
 */
export async function assertPreviewAccess(db: Db, payload: PreviewCookiePayload): Promise<PreviewTarget> {
  const blueprint = await db
    .selectFrom('blueprints')
    .select(['id', 'group_id', 'archived_at'])
    .where('id', '=', payload.b)
    .executeTakeFirst();
  if (blueprint === undefined || blueprint.archived_at !== null) {
    throw new AppError('FORBIDDEN', '蓝图已归档或不存在');
  }

  const version = await db
    .selectFrom('blueprint_versions')
    .select(['version', 'artifact_path', 'entry_path', 'archived_at'])
    .where('blueprint_id', '=', payload.b)
    .where('version', '=', payload.v)
    .executeTakeFirst();
  if (version === undefined || version.archived_at !== null) {
    throw new AppError('FORBIDDEN', '版本已归档或不存在');
  }

  if (payload.u !== null) {
    // 撤权/停用要立即生效：每次都按当前授权重新判定，不依赖签发时的快照
    const ctx = await buildUserContext(db, payload.u).catch(() => {
      throw new AppError('FORBIDDEN', '账号已停用或不存在');
    });
    const visible = visibleToContext(ctx, {
      kind: 'blueprint',
      id: blueprint.id,
      groupId: blueprint.group_id,
    });
    if (!visible) throw new AppError('FORBIDDEN', '查看权限已被撤销');
  }

  return {
    blueprintId: blueprint.id,
    version: version.version,
    groupId: blueprint.group_id,
    artifactPath: version.artifact_path,
    entryPath: version.entry_path,
  };
}
