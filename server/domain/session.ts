/**
 * 会话令牌的纯函数部分（`docs/architecture-design.md` §3.4）。
 *
 * 纪律：
 * - 令牌本身**从不落库**，只存 sha256 哈希；数据库被读取也无法反推出可用凭证。
 * - 会话是**不透明**的（没有 JWT 声明），所以「立刻吊销」只需写一行 `revoked_at`。
 * - 这里是纯函数，不碰数据库、不碰 Fastify，便于单测与复用。
 */
import { createHash, randomBytes } from 'node:crypto';

/** 32 字节随机 → base64url（约 43 字符，便于放进 Cookie） */
const SESSION_TOKEN_BYTES = 32;

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sessionExpiresAt(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}

export interface SessionTiming {
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export function isSessionActive(session: SessionTiming, now: Date = new Date()): boolean {
  if (session.revokedAt !== null) return false;
  return session.expiresAt.getTime() > now.getTime();
}

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: '/';
  readonly maxAge: number;
}

/**
 * Cookie 属性（§3.4）：HttpOnly 挡住脚本读取、SameSite=Lax 挡住跨站表单提交、
 * 生产必须 Secure。`maxAge` 与 `sessions.expires_at` 同源（同一个 TTL）。
 */
export function sessionCookieOptions(secure: boolean, ttlSeconds: number): SessionCookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: ttlSeconds };
}

/** 清除 Cookie 用（退出登录）：`maxAge: 0` 让浏览器立刻丢弃。 */
export function clearedSessionCookieOptions(secure: boolean): SessionCookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 0 };
}
