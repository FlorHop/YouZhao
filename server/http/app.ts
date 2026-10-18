/**
 * Fastify 组装（docs/architecture-design.md §3.2、§6.2）。
 *
 * 这一层只做"传输层"的事：schema 校验、错误信封、请求 id、契约版本头、限流、安全头、
 * 会话解析与 CSRF 防线。权限判断属于 `domain/policy.ts`，用例编排属于 `app/`。
 */
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { CONTRACT_VERSION } from '@youzhao/contracts/version';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/types.js';
import { AppError, httpStatusFor, isAppError, toErrorBody } from '../domain/errors.js';
import { registerMcpRoutes } from '../mcp/http.js';
import { registerOriginGuard } from './plugins/origin-guard.js';
import { registerRequestContext } from './plugins/request-context.js';
import { registerSecurityHeaders } from './plugins/security-headers.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBlueprintGroupRoutes } from './routes/blueprint-groups.js';
import { registerBlueprintRoutes } from './routes/blueprints.js';
import { registerEmbedRoutes } from './routes/embed.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMeRoutes } from './routes/me.js';
import { registerPreviewRoutes } from './routes/preview.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerUserRoutes } from './routes/users.js';

export interface ServerDependencies {
  config: AppConfig;
  db: Db;
  probeDatabase: () => Promise<'up' | 'down'>;
  logger?: FastifyServerOptions['logger'];
}

export function buildServer(deps: ServerDependencies): FastifyInstance {
  const { config, db } = deps;

  const app = Fastify({
    logger:
      deps.logger ??
      (config.appEnv === 'test' ? false : { level: config.appEnv === 'production' ? 'info' : 'debug' }),
    bodyLimit: config.http.jsonBodyLimitBytes,
    trustProxy: config.appEnv === 'production',
    genReqId: () => randomUUID(),
    // 契约纪律：未知字段一律 400（Fastify 默认 removeAdditional:true 会静默丢弃，
    // 这会让「PATCH /api/me 传 identity」看起来成功，见 test/me-routes.test.ts）
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
  });

  void app.register(cookie);

  app.addHook('onRequest', async (request, reply) => {
    // 每个请求带契约版本，排查前后端契约错位（§6.1 规则 3）
    void reply.header('x-contract-version', CONTRACT_VERSION);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header('x-request-id', String(request.id));
    return payload;
  });

  app.setNotFoundHandler(async (request, reply) => {
    // 未命中任何路由：明确回 NOT_FOUND，而不是让它退化成 500 内部错误
    reply.code(404);
    return toErrorBody(new AppError('NOT_FOUND'), String(request.id));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const requestId = String(request.id);
    const status = httpStatusFor(error);
    if (status >= 500) {
      request.log.error({ err: error, requestId }, 'unhandled error');
    } else {
      request.log.warn({ err: error, requestId }, 'request rejected');
    }
    reply.code(status);
    // 500 类错误不回传内部信息（SQL/路径/堆栈），只回稳定错误码
    return status >= 500 && !isAppError(error)
      ? toErrorBody(undefined, requestId)
      : toErrorBody(error, requestId);
  });

  registerSecurityHeaders(app, config);
  registerOriginGuard(app, config);
  registerRequestContext(app, { db, config });

  registerHealthRoutes(app, { probeDatabase: deps.probeDatabase });
  registerMeRoutes(app, { db });
  registerUserRoutes(app, { db });
  // MCP Token 管理：创建/停用/删除；明文只在创建响应里出现一次
  registerTokenRoutes(app, { db });
  // 蓝图与分组：上传走 multipart，可见性一律经 domain/scopes 的上下文入口判定
  registerBlueprintRoutes(app, { db, config });
  registerBlueprintGroupRoutes(app, { db });
  // 预览域交付 + 嵌入票据：都不走 Cookie 会话里的业务授权，由用例层各自判定
  registerPreviewRoutes(app, { db, config });
  registerEmbedRoutes(app, { db, config });
  // MCP：官方 SDK 的 Streamable HTTP 挂同一应用；Bearer 令牌鉴权 + scope 闸门。
  // 单独作用域：限流插件按路由挂载（global:false），MCP 的额度与浏览器会话不同、且按 Token 维度计数。
  void app.register(async (scope) => {
    await scope.register(rateLimit, { global: false, max: config.rateLimit.mcpPerMinute, timeWindow: '1 minute' });
    registerMcpRoutes(scope, { db, config });
  });

  // 限流插件用 onRoute 挂到每条路由上，因此必须在注册路由**之前**完成加载；
  // 同一 async 插件作用域内 await 注册可以保证这个顺序。
  void app.register(async (scope) => {
    await scope.register(rateLimit, {
      global: false,
      max: config.rateLimit.loginPerMinute,
      timeWindow: '1 minute',
    });
    registerAuthRoutes(scope, { db, config });
  });

  return app;
}
