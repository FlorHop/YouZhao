/**
 * MCP 鉴权链（docs/architecture-design.md §4.4）——HTTP 与 stdio 入口共用。
 *
 * 五步：
 * 1. 从 `Authorization: Bearer <明文>` 取令牌（**只允许请求头**，不接受 query string）；
 * 2. 按明文解出令牌主键并取出 `mcp_tokens` 行；
 * 3. 常量时间比较 `sha256(明文)` 与 `token_hash`；
 * 4. 校验 `status = 'active'` 与 `expires_at`；
 * 5. 用**绑定用户**构造 `RequestContext`（`actorType: 'token'` + `tokenScopes`），
 *    能力仍按绑定用户的身份/能力判定 —— S3：Token 能力 = 绑定用户能力 ∩ Token scope。
 *
 * 每一步失败都抛 `AppError`；HTTP 层据此回 401 + `WWW-Authenticate`，不会泄露「令牌是否存在」之外的信息。
 */
import { buildUserContext } from '../app/context.js';
import type { Db } from '../db/types.js';
import type { RequestContext, TokenScope } from '../domain/entities.js';
import { AppError } from '../domain/errors.js';
import {
  hashMcpToken,
  parseMcpToken,
  readBearerToken,
  tokenHashMatches,
} from '../domain/mcp-token.js';

export interface McpTokenIdentity {
  readonly tokenId: string;
  readonly name: string;
  readonly boundUserId: string;
  readonly scopes: readonly TokenScope[];
}

/** 校验明文令牌并返回身份；失败一律 `UNAUTHENTICATED`。 */
export async function authenticateMcpToken(
  db: Db,
  rawToken: string | null,
): Promise<McpTokenIdentity> {
  if (rawToken === null || rawToken === '') {
    throw new AppError('UNAUTHENTICATED', '缺少 MCP Token');
  }
  const parsed = parseMcpToken(rawToken);
  if (parsed === null) {
    throw new AppError('UNAUTHENTICATED', 'MCP Token 形态无效');
  }

  const row = await db
    .selectFrom('mcp_tokens')
    .selectAll()
    .where('id', '=', parsed.tokenId)
    .executeTakeFirst();
  if (row === undefined || !tokenHashMatches(row.token_hash, hashMcpToken(rawToken))) {
    throw new AppError('UNAUTHENTICATED', 'MCP Token 无效');
  }
  if (row.status !== 'active') {
    throw new AppError('UNAUTHENTICATED', 'MCP Token 已停用');
  }
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
    throw new AppError('UNAUTHENTICATED', 'MCP Token 已过期');
  }

  return {
    tokenId: row.id,
    name: row.name,
    boundUserId: row.bound_user_id,
    scopes: row.scopes as readonly TokenScope[],
  };
}

/** 用绑定用户构造请求上下文；绑定用户被停用/删除则拒绝。 */
export async function buildMcpContext(
  db: Db,
  identity: McpTokenIdentity,
): Promise<RequestContext> {
  const bound = await db
    .selectFrom('users')
    .select(['id', 'status'])
    .where('id', '=', identity.boundUserId)
    .executeTakeFirst();
  if (bound === undefined) {
    throw new AppError('UNAUTHENTICATED', 'MCP Token 的绑定用户不存在');
  }
  if (bound.status !== 'active') {
    throw new AppError('FORBIDDEN', 'MCP Token 的绑定用户已被停用');
  }
  return buildUserContext(db, identity.boundUserId, {
    actorType: 'token',
    tokenScopes: identity.scopes,
  });
}

/** 记录最近使用时间；失败不影响本次调用（只写日志由调用方决定）。 */
export async function touchMcpToken(db: Db, tokenId: string): Promise<void> {
  await db
    .updateTable('mcp_tokens')
    .set({ last_used_at: new Date() })
    .where('id', '=', tokenId)
    .execute();
}

/** 从请求头取出 Bearer 明文（缺省 `undefined` → `null`）。 */
export function bearerFromHeader(header: string | undefined): string | null {
  return readBearerToken(header);
}
