/**
 * MCP Token 管理用例层（docs/permission-design.md §3.4、§6.3）。
 *
 * 约定（与 `app/users.ts` 同构）：
 * - 判权一律走 `assertAuthorized`（`../domain/policy.js`），本层不手写身份分支；
 *   「只有平台所有者能为他人创建」「scope 不得超出自身能力」都由策略的
 *   `token.create` 分支负责，这里不重复实现。
 * - 每个入口都写审计：成功 `allow`，抛 `AppError` 记 `deny` + `errorCode`，其它异常记 `error`。
 * - 明文令牌只在创建响应里出现一次；库里只落 `token_hash`（sha256）与展示用 `token_prefix`。
 * - 读取可见范围：`identity === 'owner'` 看全部，其他人只看自己创建或绑定给自己的 Token。
 * - 数据库列名是 snake_case（没有 CamelCasePlugin），camelCase ↔ snake_case 的映射在这里手工完成。
 */
import type {
  CreateMcpTokenRequest,
  CreateMcpTokenResponse,
  McpTokenMutationResponse,
  TokensListResponse,
  UpdateMcpTokenRequest,
  VerifyMcpTokenRequest,
  VerifyMcpTokenResponse,
} from '@youzhao/contracts/types';
import { writeAudit } from '../audit/audit.js';
import type { Db } from '../db/types.js';
import type { RequestContext, Resource, TokenScope } from '../domain/entities.js';
import { AppError, isAppError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { buildMcpTokenMaterial, hashMcpToken, parseMcpToken, tokenHashMatches } from '../domain/mcp-token.js';
import { assertAuthorized } from '../domain/policy.js';
import type { McpTokenProbe } from '../mcp/verify.js';
import { DELETED_GRANTER_LABEL } from './users.js';

/** 列表项视图（对齐契约 `tokens/list.json` 的 `McpTokenSummary`）。 */
export type McpTokenSummary = TokensListResponse['data']['items'][number];

/** 库里 token 状态的两值联合（`mcp_tokens.status` 有 check 约束）。 */
type McpTokenStatus = McpTokenSummary['status'];

/** `mcp_tokens` 的一行（Kysely `selectAll()` 的结构化别名，避免到处写 Selectable<>）。 */
interface TokenRow {
  readonly id: string;
  readonly name: string;
  readonly token_hash: string;
  readonly token_prefix: string;
  readonly bound_user_id: string;
  readonly created_by_user_id: string;
  readonly scopes: string[];
  readonly status: string;
  readonly expires_at: Date | null;
  readonly last_used_at: Date | null;
  readonly created_at: Date;
}

/** 可写字段（契约 `tokens/update.json` 只允许改名与启停）。 */
interface TokenPatch {
  name?: string;
  status?: string;
}

/**
 * 审计上下文：由路由层从请求上取。
 *
 * `RequestContext` 里没有 requestId / ip，所以与 `app/users.ts` 一样单独传入；
 * 默认值是为了让「只传 db + context」的调用也能成立（此时审计少 requestId/ip）。
 */
export interface TokenAudit {
  readonly requestId: string | null;
  readonly ip: string | null;
}

const NO_AUDIT: TokenAudit = { requestId: null, ip: null };

interface AuditTarget {
  targetType: string | null;
  targetId: string | null;
}

// ────────────────────────────── 内部工具 ──────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordAudit(
  db: Db,
  ctx: RequestContext,
  action: string,
  result: 'allow' | 'deny' | 'error',
  target: AuditTarget,
  audit: TokenAudit,
  errorCode: string | null,
  detail: unknown,
): Promise<void> {
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.userId,
    requestId: audit.requestId,
    action,
    result,
    targetType: target.targetType,
    targetId: target.targetId,
    errorCode,
    detail,
    ip: audit.ip,
  });
}

/** 审计包装：成功记一条 `allow`；失败记 `deny`（`AppError`）或 `error`，然后原样抛出。 */
async function audited<T>(
  db: Db,
  ctx: RequestContext,
  action: string,
  target: AuditTarget,
  audit: TokenAudit,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const value = await run();
    await recordAudit(db, ctx, action, 'allow', target, audit, null, null);
    return value;
  } catch (error) {
    await recordAudit(
      db,
      ctx,
      action,
      isAppError(error) ? 'deny' : 'error',
      target,
      audit,
      isAppError(error) ? error.code : null,
      isAppError(error) ? (error.details ?? null) : { message: messageOf(error) },
    );
    throw error;
  }
}

async function readTokenRow(db: Db, tokenId: string): Promise<TokenRow | null> {
  const row = await db
    .selectFrom('mcp_tokens')
    .selectAll()
    .where('id', '=', tokenId)
    .executeTakeFirst();
  return row === undefined ? null : row;
}

/**
 * 不存在时抛资源级 `TOKEN_NOT_FOUND`（404）：与 `BLUEPRINT_NOT_FOUND` /
 * `USER_NOT_FOUND` 同惯例，前端可据此把「Token 没了」与通用 `NOT_FOUND` 区分开。
 */
async function requireTokenRow(db: Db, tokenId: string): Promise<TokenRow> {
  const row = await readTokenRow(db, tokenId);
  if (row === null) throw new AppError('TOKEN_NOT_FOUND');
  return row;
}

/** 判权用的 Token 资源（策略只看这三个字段，不看 id）。 */
function tokenResource(row: TokenRow): Resource {
  return {
    kind: 'token',
    boundUserId: row.bound_user_id,
    createdByUserId: row.created_by_user_id,
    scopes: [...row.scopes] as TokenScope[],
  };
}

/** 一次性把涉及的用户显示名取回来；用户已被删除的由调用方回退到占位文案。 */
async function loadDisplayNames(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where('id', 'in', unique)
    .execute();
  return new Map(rows.map((row) => [row.id, row.display_name]));
}

function toSummary(row: TokenRow, names: ReadonlyMap<string, string>): McpTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: [...row.scopes] as TokenScope[],
    status: row.status as McpTokenStatus,
    boundUserId: row.bound_user_id,
    boundUserDisplayName: names.get(row.bound_user_id) ?? DELETED_GRANTER_LABEL,
    createdByUserId: row.created_by_user_id,
    createdByDisplayName: names.get(row.created_by_user_id) ?? DELETED_GRANTER_LABEL,
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

async function summarizeRow(db: Db, row: TokenRow): Promise<McpTokenSummary> {
  const names = await loadDisplayNames(db, [row.bound_user_id, row.created_by_user_id]);
  return toSummary(row, names);
}

// ────────────────────────────── 列表 ──────────────────────────────

/**
 * 列出当前调用者可见的 Token：
 * 所有者看全平台；其他人只看 `created_by_user_id = me` **或** `bound_user_id = me`。
 * 排序 `created_at desc, id asc`（同时创建时用 id 兜底稳定序）。
 */
export async function listMcpTokens(
  db: Db,
  context: RequestContext,
  audit: TokenAudit = NO_AUDIT,
): Promise<TokensListResponse['data']> {
  const target: AuditTarget = { targetType: 'token', targetId: null };
  return await audited(db, context, 'token.list', target, audit, async () => {
    assertAuthorized(context, 'token.list');

    let query = db.selectFrom('mcp_tokens').selectAll();
    if (context.identity !== 'owner') {
      // 可见范围直接进 SQL，不做全表后置裁剪。
      query = query.where((eb) =>
        eb.or([
          eb('created_by_user_id', '=', context.userId),
          eb('bound_user_id', '=', context.userId),
        ]),
      );
    }

    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'asc').execute();
    const names = await loadDisplayNames(
      db,
      rows.flatMap((row) => [row.bound_user_id, row.created_by_user_id]),
    );
    return { items: rows.map((row) => toSummary(row, names)) };
  });
}

// ────────────────────────────── 创建 ──────────────────────────────

/**
 * 创建 Token：`bindUserId` 省略即绑定自己；为他人创建由策略的 `token.create` 把关
 * （只有平台所有者可以）。明文只在本响应里返回一次。
 */
export async function createMcpToken(
  db: Db,
  context: RequestContext,
  input: CreateMcpTokenRequest,
  audit: TokenAudit = NO_AUDIT,
): Promise<CreateMcpTokenResponse['data']> {
  const boundUserId = input.bindUserId ?? context.userId;
  const target: AuditTarget = { targetType: 'token', targetId: null };

  return await audited(db, context, 'token.create', target, audit, async () => {
    const scopes = [...input.scopes] as TokenScope[];
    assertAuthorized(context, 'token.create', {
      kind: 'token',
      boundUserId,
      createdByUserId: context.userId,
      scopes,
    });

    const tokenId = newId('tok');
    const material = buildMcpTokenMaterial(tokenId);

    await db
      .insertInto('mcp_tokens')
      .values({
        id: tokenId,
        name: input.name,
        token_hash: material.tokenHash,
        token_prefix: material.tokenPrefix,
        bound_user_id: boundUserId,
        created_by_user_id: context.userId,
        scopes,
        status: 'active',
        expires_at: input.expiresAt === undefined ? null : new Date(input.expiresAt),
        last_used_at: null,
      })
      .execute();

    target.targetId = tokenId;
    const row = await readTokenRow(db, tokenId);
    if (row === null) throw new AppError('INTERNAL_ERROR', 'Token 写入后无法读回');
    return { token: material.token, ...(await summarizeRow(db, row)) };
  });
}

// ────────────────────────────── 改名 / 启停 ──────────────────────────────

/**
 * 改名与启停。契约 `tokens/update.json` 只允许 `name` / `status`，
 * 不允许改绑定用户与 scopes（要改只能重新创建）。
 *
 * 判权动作统一用 `token.disable`：策略里 `token.disable` / `token.delete` 共用
 * 「所有者，或本人创建，或绑定到本人」这一分支，启停两个方向都落在同一闸门上。
 */
export async function updateMcpToken(
  db: Db,
  context: RequestContext,
  tokenId: string,
  input: UpdateMcpTokenRequest,
  audit: TokenAudit = NO_AUDIT,
): Promise<McpTokenMutationResponse['data']> {
  const target: AuditTarget = { targetType: 'token', targetId: tokenId };

  return await audited(db, context, 'token.disable', target, audit, async () => {
    const row = await requireTokenRow(db, tokenId);
    assertAuthorized(context, 'token.disable', tokenResource(row));

    const patch: TokenPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.status !== undefined) patch.status = input.status;

    // 契约允许空请求体（两个字段都可选）：没有可改字段时不发空 UPDATE（那是非法 SQL）。
    if (Object.keys(patch).length > 0) {
      await db.updateTable('mcp_tokens').set(patch).where('id', '=', tokenId).execute();
    }

    const updated = await requireTokenRow(db, tokenId);
    return await summarizeRow(db, updated);
  });
}

// ────────────────────────────── 删除 ──────────────────────────────

/** 物理删除；返回被删对象的摘要（先取行、判权，再删）。 */
export async function deleteMcpToken(
  db: Db,
  context: RequestContext,
  tokenId: string,
  audit: TokenAudit = NO_AUDIT,
): Promise<McpTokenMutationResponse['data']> {
  const target: AuditTarget = { targetType: 'token', targetId: tokenId };

  return await audited(db, context, 'token.delete', target, audit, async () => {
    const row = await requireTokenRow(db, tokenId);
    assertAuthorized(context, 'token.delete', tokenResource(row));

    const summary = await summarizeRow(db, row);
    await db.deleteFrom('mcp_tokens').where('id', '=', tokenId).execute();
    return summary;
  });
}

// ────────────────────────────── 连接自检 ──────────────────────────────

/**
 * 自检一个 Token（`POST /api/mcp-tokens/verify`，docs/mcp-onboarding-design.md §3.2）。
 *
 * 为什么收明文：库里只落 `token_hash`（sha256），服务端无法反推已创建 Token 的明文，
 * 因此只能由调用方把明文交回来做一次真实环回调用。
 *
 * 判权动作 `token.verify` 与启停/删除同一分支：所有者，或本人创建，或绑定到本人。
 * 探针由路由注入（`server/mcp/verify.ts`）：用例层只依赖函数签名，便于单测替身。
 */
export async function verifyMcpToken(
  db: Db,
  context: RequestContext,
  input: VerifyMcpTokenRequest,
  probe: McpTokenProbe,
  audit: TokenAudit = NO_AUDIT,
): Promise<VerifyMcpTokenResponse['data']> {
  const target: AuditTarget = { targetType: 'token', targetId: null };

  return await audited(db, context, 'token.verify', target, audit, async () => {
    const parsed = parseMcpToken(input.token);
    if (parsed === null) throw new AppError('TOKEN_INVALID', '令牌格式不正确');

    const row = await readTokenRow(db, parsed.tokenId);
    if (row === null) throw new AppError('TOKEN_INVALID', '令牌不存在或已被删除');
    if (!tokenHashMatches(row.token_hash, hashMcpToken(input.token))) {
      throw new AppError('TOKEN_INVALID', '令牌校验失败');
    }
    if (row.status !== 'active') throw new AppError('TOKEN_INVALID', '令牌已停用');
    if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
      throw new AppError('TOKEN_INVALID', '令牌已过期');
    }

    target.targetId = row.id;
    assertAuthorized(context, 'token.verify', tokenResource(row));

    const outcome = await probe(input.token);
    return {
      ok: true,
      tokenId: row.id,
      tokenPrefix: row.token_prefix,
      scopes: [...row.scopes] as TokenScope[],
      serverInfo: outcome.serverInfo,
      protocolVersion: outcome.protocolVersion,
      toolCount: outcome.tools.length,
      tools: outcome.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        scope: tool.scope,
      })),
      latencyMs: outcome.latencyMs,
    };
  });
}
