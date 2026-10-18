/**
 * 登录 / 登出（§3.4）。登录失败按用户名 + IP 双维度限流（见路由 `config.rateLimit`）。
 *
 * 响应体故意与 `GET /api/me` 完全一致（同一份 `authSessionSchema`）：
 * 前端登录成功后不需要再多发一次请求就能拿到身份、能力与范围。
 * 若口令需强制修改（初始所有者首登），这里不拦——只把 `mustChangePassword` 交给前端；
 * 拦门放在前端「必须改密」门与后续写接口的策略里，避免把登录本身做成死循环。
 */
import type { LoginRequest } from '@youzhao/contracts/types';
import type { FastifyInstance } from 'fastify';
import { authLoginSchema, authSessionSchema } from '@youzhao/contracts/schemas';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/types.js';
import { buildMeView } from '../../app/me.js';
import { login, logout } from '../../app/session.js';
import {
  clearLoginCookie,
  loginCookies,
  requireSession,
  requestIp,
} from '../plugins/request-context.js';

export interface AuthRouteDeps {
  readonly db: Db;
  readonly config: AppConfig;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post(
    '/api/auth/login',
    {
      schema: { body: authLoginSchema, response: { 200: authSessionSchema } },
      config: {
        rateLimit: {
          max: deps.config.rateLimit.loginPerMinute,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const body = request.body as LoginRequest;
      const result = await login(deps.db, deps.config, {
        username: body.username,
        password: body.password,
        userAgent: request.headers['user-agent'] ?? null,
        ip: requestIp(request),
      });
      loginCookies(deps.config, reply, result.token, result.expiresAt);
      return {
        data: await buildMeView(deps.db, result.user.id),
        meta: { requestId: String(request.id) },
      };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const session = requireSession(request);
    await logout(deps.db, session.sessionId, session.userId, requestIp(request));
    clearLoginCookie(deps.config, reply);
    return reply.code(204).send();
  });
}
