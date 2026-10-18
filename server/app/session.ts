/**
 * 登录、会话解析与吊销（`docs/architecture-design.md` §3.4）。
 *
 * 纪律：
 * - 登录失败**不区分**「用户名不存在 / 口令错误 / 账号被停用」，统一 `UNAUTHENTICATED`
 *   与同一句文案，避免把账号存在性当成探测接口。
 * - 用户名不存在时仍然跑一次口令校验（对一个进程内固定的假哈希），让耗时接近，
 *   不靠「快 = 用户不存在」泄露信息。
 * - 被停用的用户不清会话也进不来：`buildUserContext` 会拒绝，见 `app/context.ts`。
 */
import { writeAudit } from '../audit/audit.js';
import type { AppConfig } from '../config.js';
import type { Db, UserRow } from '../db/types.js';
import { AppError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { hashPassword, verifyPassword } from '../domain/password.js';
import {
  hashSessionToken,
  isSessionActive,
  newSessionToken,
  sessionExpiresAt,
} from '../domain/session.js';

const INVALID_CREDENTIALS = '用户名或密码不正确';

/** 进程内一次性生成的假哈希（仅用于等时比较，不是任何真实凭证）。 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(`youzhao-dummy-${newId('ses')}`);
  return dummyHashPromise;
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface LoginResult {
  readonly token: string;
  readonly user: UserRow;
  readonly expiresAt: Date;
}

export async function login(db: Db, config: AppConfig, input: LoginInput): Promise<LoginResult> {
  const username = input.username.trim();
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('username', '=', username)
    .executeTakeFirst();

  if (user === undefined) {
    await verifyPassword(input.password, await dummyHash());
    await writeAudit(db, {
      actorType: 'user',
      actorId: null,
      action: 'auth.loginFailed',
      result: 'deny',
      errorCode: 'UNAUTHENTICATED',
      detail: { reason: 'unknown_username' },
      ip: input.ip,
    });
    throw new AppError('UNAUTHENTICATED', INVALID_CREDENTIALS);
  }

  const passwordOk = await verifyPassword(input.password, user.password_hash);
  if (!passwordOk || user.status !== 'active') {
    await writeAudit(db, {
      actorType: 'user',
      actorId: user.id,
      action: 'auth.loginFailed',
      result: 'deny',
      errorCode: 'UNAUTHENTICATED',
      detail: { reason: passwordOk ? 'disabled' : 'bad_password' },
      ip: input.ip,
    });
    throw new AppError('UNAUTHENTICATED', INVALID_CREDENTIALS);
  }

  const token = newSessionToken();
  const expiresAt = sessionExpiresAt(new Date(), config.session.ttlSeconds);
  await db
    .insertInto('sessions')
    .values({
      id: newId('ses'),
      token_hash: hashSessionToken(token),
      user_id: user.id,
      expires_at: expiresAt,
      user_agent: input.userAgent,
      ip: input.ip,
    })
    .execute();

  await writeAudit(db, {
    actorType: 'user',
    actorId: user.id,
    action: 'auth.login',
    result: 'allow',
    ip: input.ip,
  });

  return { token, user, expiresAt };
}

export type SessionLookup =
  | { readonly status: 'active'; readonly sessionId: string; readonly userId: string; readonly expiresAt: Date }
  /** 有过这张 Cookie，但已过期或被吊销——前端据此提示「登录已过期」而不是「请先登录」。 */
  | { readonly status: 'expired' }
  | { readonly status: 'none' };

export async function lookupSession(db: Db, token: string): Promise<SessionLookup> {
  const row = await db
    .selectFrom('sessions')
    .select(['id', 'user_id', 'expires_at', 'revoked_at'])
    .where('token_hash', '=', hashSessionToken(token))
    .executeTakeFirst();
  if (row === undefined) return { status: 'none' };
  if (!isSessionActive({ expiresAt: row.expires_at, revokedAt: row.revoked_at })) {
    return { status: 'expired' };
  }
  return { status: 'active', sessionId: row.id, userId: row.user_id, expiresAt: row.expires_at };
}

/** 记录活跃时间（只用于审计与排查；不延长会话有效期）。 */
export async function touchSession(db: Db, sessionId: string): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ last_seen_at: new Date() })
    .where('id', '=', sessionId)
    .execute();
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

/**
 * 吊销某用户的全部会话（可保留当前会话）。
 * 停用用户、改密、移出管理员、重置口令都要调用它（§3.4）。
 */
export async function revokeAllSessionsForUser(
  db: Db,
  userId: string,
  options: { readonly keepSessionId?: string } = {},
): Promise<number> {
  let query = db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null);
  if (options.keepSessionId !== undefined) {
    query = query.where('id', '!=', options.keepSessionId);
  }
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export async function logout(db: Db, sessionId: string, userId: string, ip: string | null): Promise<void> {
  await revokeSession(db, sessionId);
  await writeAudit(db, {
    actorType: 'user',
    actorId: userId,
    action: 'auth.logout',
    result: 'allow',
    ip,
  });
}
