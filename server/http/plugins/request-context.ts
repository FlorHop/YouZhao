/**
 * 会话解析与鉴权上下文装配（HTTP 层唯一入口）。
 *
 * 分工：
 * - `onRequest` 只做「解析 Cookie → 查会话」（一次查询，公开路由也跑，成本可控）；
 * - 受保护路由在 `preHandler` 调 `requireSession`，此时才装载授权上下文（5 次查询）；
 * - 授权上下文按请求缓存，同一请求内多次调用只查一次。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/types.js';
import type { RequestContext } from '../../domain/entities.js';
import { AppError } from '../../domain/errors.js';
import { buildUserContext } from '../../app/context.js';
import { lookupSession, touchSession } from '../../app/session.js';

/** 已通过会话校验、但尚未装载授权上下文的状态。 */
export interface SessionState {
  readonly sessionId: string;
  readonly userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 会话有效时存在；权限判定的一切依据都从它派生。 */
    session?: SessionState;
    /** Cookie 存在但已过期/被吊销——用于区分 401 文案。 */
    sessionExpired?: boolean;
    /** 已装载的授权上下文（按请求缓存）。 */
    authzContext?: RequestContext;
  }
  interface FastifyInstance {
    config: AppConfig;
    db: Db;
  }
}

export interface RequestContextDeps {
  readonly db: Db;
  readonly config: AppConfig;
}

export function registerRequestContext(app: FastifyInstance, deps: RequestContextDeps): void {
  app.decorateRequest('session', undefined);
  app.decorateRequest('sessionExpired', undefined);
  app.decorateRequest('authzContext', undefined);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const cookieName = deps.config.session.cookieName;
    const token = request.cookies[cookieName];
    if (token === undefined || token === '') return;

    const result = await lookupSession(deps.db, token);
    if (result.status === 'active') {
      request.session = { sessionId: result.sessionId, userId: result.userId };
      // 活跃时间落库不阻塞响应，也不延长有效期
      void touchSession(deps.db, result.sessionId).catch(() => undefined);
      return;
    }
    if (result.status === 'expired') request.sessionExpired = true;
  });
}

/** 受保护路由的守卫：无有效会话即 401（区分「已过期」与「未登录」）。 */
export function requireSession(request: FastifyRequest): SessionState {
  const session = request.session;
  if (session === undefined) {
    throw request.sessionExpired === true
      ? new AppError('SESSION_EXPIRED')
      : new AppError('UNAUTHENTICATED');
  }
  return session;
}

/**
 * 取当前请求的授权上下文。
 * 用户已停用 → `buildUserContext` 抛 `UNAUTHENTICATED`（停用无需逐个吊销会话）。
 */
export async function requireContext(
  request: FastifyRequest,
  deps: { readonly db: Db },
): Promise<RequestContext> {
  const session = requireSession(request);
  request.authzContext ??= await buildUserContext(deps.db, session.userId);
  return request.authzContext;
}

export function currentSessionId(request: FastifyRequest): string | undefined {
  return request.session?.sessionId;
}

export function loginCookies(
  config: AppConfig,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(config.session.cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appEnv === 'production',
    expires: expiresAt,
  });
}

export function clearLoginCookie(config: AppConfig, reply: FastifyReply): void {
  reply.clearCookie(config.session.cookieName, { path: '/' });
}

export function requestIp(request: FastifyRequest): string | null {
  return request.ip ?? null;
}
