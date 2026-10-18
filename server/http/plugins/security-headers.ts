/**
 * 安全响应头（§7 安全设计）。
 *
 * 两类响应有**相反**的内嵌需求，必须区别对待：
 * - API 响应（`/api/*`）：只返回 JSON，绝不允许被嗅探、缓存或嵌入任何页面；
 * - 预览产物（`{PREVIEW_PUBLIC_BASE_PATH}/p/*`）：**必须**允许被工作台 iframe 嵌入，
 *   并允许产物自身的脚本/样式运行，因此不能套用 API 的 `x-frame-options: DENY`
 *   与 `default-src 'none'`。产物侧的 CSP 由 `http/routes/preview.ts` 按内容类型单独给出
 *   （HTML 带 `sandbox allow-scripts allow-popups`，子资源按预览域放行）。
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';

export function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): void {
  const previewPrefix = `${config.preview.publicBasePath.replace(/\/+$/, '')}/`;

  app.addHook('onSend', async (request, reply, payload) => {
    // 预览域产物：头部由产物路由自己决定（CSP 按内容类型、Content-Disposition、no-store），
    // 这里一旦覆盖就会让 iframe 无法加载或让多文件产物的子资源被拦。
    if (request.url.startsWith(previewPrefix)) return payload;

    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // API 响应绝不允许被嵌入任何页面
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (request.url.startsWith('/api/')) {
      // 会话相关响应不得进任何缓存（含中间代理与浏览器回退缓存）
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}
