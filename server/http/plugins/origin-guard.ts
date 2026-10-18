/**
 * CSRF 防线（§3.4 规则 6：「状态变更请求校验 Origin / Referer」）。
 *
 * 会话走 HTTP-only Cookie，所以必须防止别的站点拿着用户的 Cookie 发写请求。
 * 规则：
 * - 只对状态变更方法（POST/PUT/PATCH/DELETE）检查；
 * - 带 `Authorization` 的请求跳过——它们是 MCP Token 客户端，不用 Cookie，谈不上 CSRF；
 * - 机器入口（`/api/embed/`、`/api/mcp/`）跳过，它们凭共享密钥或 Bearer 授权，没有浏览器 Origin；
 * - 其余请求要求 Origin 或 Referer 命中允许名单；**允许名单为空一律拒绝**（失败关闭，
 *   配置层已保证允许名单非空，真为空说明部署配置缺失，不该放行）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../domain/errors.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 机器到机器的入口：它们不用 Cookie 会话，因此 CSRF 防线不适用。
 * - `/api/embed/`：嵌入方服务端调用，凭 `X-Embed-Secret` 授权（没有浏览器 Origin）。
 * - `/mcp`：MCP 客户端，凭 `Authorization: Bearer` 授权。缺令牌时也要让请求走到 MCP 鉴权，
 *   由它回 401 `UNAUTHENTICATED`；被这道闸门拦成 403「来源不被信任」会让 MCP 客户端看不懂。
 */
const MACHINE_PREFIXES = ['/api/embed/', '/mcp'];

function originOf(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '') return origin;
  const referer = request.headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

export function registerOriginGuard(app: FastifyInstance, config: AppConfig): void {
  // 配置层保证允许名单非空（见 config.ts）；万一为空则一律拒绝——CSRF 防线失败关闭
  const allowlist = new Set(config.session.originAllowlist);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    if (request.headers.authorization !== undefined) return;
    if (MACHINE_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;

    const origin = originOf(request);
    if (origin === null || !allowlist.has(origin)) {
      throw new AppError('FORBIDDEN', '请求来源不被信任，请从平台页面重新操作');
    }
  });
}
