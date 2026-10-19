/**
 * MCP 的 HTTP 入口（docs/architecture-design.md §4.3、§4.7）：把官方 SDK 的
 * Streamable HTTP 处理器挂到**同一个 Fastify 应用**的 `/mcp` 上。
 *
 * 为什么不用 `@modelcontextprotocol/fastify` 的 `createMcpFastifyApp()`：
 * 那是「另起一个 Fastify 实例」的写法，会得到第二套日志、限流与错误处理，
 * 且无法复用本应用的配置校验；SDK 暴露的 `toNodeHandler(handler)` 才是官方给出的
 * 「挂进既有框架」的接缝（框架只负责把 `request.raw` / `reply.raw` 交给它）。
 *
 * 鉴权在本函数里先做（`Bearer` → 绑定用户上下文），再进 SDK：这样 401/403 走的是
 * 本应用的统一错误信封，而不是 MCP 协议层错误。
 */
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/types.js';
import { AppError } from '../domain/errors.js';
import { authenticateMcpToken, bearerFromHeader, buildMcpContext, touchMcpToken } from './auth.js';
import { normalizeMcpPath } from './connection.js';
import { buildYouzhaoMcpServer, requiredScopeForTool } from './tools.js';

export interface McpRouteDeps {
  readonly db: Db;
  readonly config: AppConfig;
}

/** MCP 未启用时不注册任何路由（`MCP_ENABLED=false`）。 */
export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const { db, config } = deps;
  if (!config.mcp.enabled) return;

  app.all(
    normalizeMcpPath(config.mcp.path),
    {
      bodyLimit: config.mcp.maxBodyBytes,
      // 按 Token 维度限流（同一 Token 共享配额；无/坏 Token 时按 IP，401 之前的尝试也计入）。
      // 不走浏览器会话的 CSRF / 会话 Cookie 通道。
      config: {
        rateLimit: {
          max: config.rateLimit.mcpPerMinute,
          timeWindow: '1 minute',
          keyGenerator: rateLimitKey,
        },
      },
    },
    async (request, reply) => {
      let identity;
      try {
        identity = await authenticateMcpToken(db, bearerFromHeader(request.headers.authorization));
      } catch (error) {
        // 401 必须带 WWW-Authenticate（§4.4），客户端据此触发重新取令牌
        reply.header(
          'www-authenticate',
          isInvalidToken(error) ? 'Bearer realm="youzhao", error="invalid_token"' : 'Bearer realm="youzhao"',
        );
        throw error;
      }

      // 协议层 scope 闸门：SCOPE_DENIED 必须是 403 + WWW-Authenticate insufficient_scope（§4.4），
      // 而不是 JSON-RPC 结果里的 isError。工具过滤只影响 tools/list，挡不住直接 tools/call。
      const requiredScope = requiredScopeForTool(toolNameFromBody(request.body));
      if (requiredScope !== undefined && !identity.scopes.includes(requiredScope)) {
        reply.header(
          'www-authenticate',
          `Bearer realm="youzhao", error="insufficient_scope", scope="${requiredScope}"`,
        );
        throw new AppError('SCOPE_DENIED', `Token 缺少 ${requiredScope} scope`);
      }

      const context = await buildMcpContext(db, identity);
      const server = buildYouzhaoMcpServer({
        db,
        config,
        context,
        tokenId: identity.tokenId,
        scopes: identity.scopes,
        call: { ip: request.ip ?? null, requestId: String(request.id) },
      });
      // legacy: 'stateless' —— 对尚未升级到 2026-07-28 的客户端（initialize 时代）
      // 也提供服务；工具本身无状态，无需服务端会话存储。
      const handler = createMcpHandler(() => server, { legacy: 'stateless' });

      // 之后由 SDK 直接写 reply.raw，Fastify 不能再回包
      reply.hijack();
      await toNodeHandler(handler)(request.raw, reply.raw, request.body);
      await touchMcpToken(db, identity.tokenId);
    },
  );
}

/**
 * 限流的键：优先用 Token 的**前 8 位**（够区分、又不把完整密钥长期留在内存里），
 * 退化时用 IP。这里不解码 Token，任何请求形态都能得到稳定的桶。
 */
function rateLimitKey(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return `token:${header.slice('Bearer '.length, 'Bearer '.length + 8)}`;
  }
  return `ip:${request.ip ?? 'unknown'}`;
}

/** 从 JSON-RPC 请求体里取出 `tools/call` 的工具名；其他方法返回 null。 */
function toolNameFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const message = body as { method?: unknown; params?: unknown };
  if (message.method !== 'tools/call') return '';
  if (typeof message.params !== 'object' || message.params === null) return '';
  const name = (message.params as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function isInvalidToken(error: unknown): boolean {
  return error instanceof AppError && error.code === 'UNAUTHENTICATED';
}
