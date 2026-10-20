/**
 * 预览与嵌入路由（docs/architecture-design.md §3.6、§3.7）。
 *
 * 两个入口：
 * - `POST /api/preview-tickets`：工作台内申请预览票据（需查看权）。
 * - `GET /preview/p/:blueprintId/:version/*`：预览域交付，支持 `?t=` 一次换票 + 受限 Cookie。
 *
 * 与旧实现的关键差别：产物**不再匿名可读**，也**不再同源交付**（配置层强制预览域与应用域
 * 不同源），并且归档/撤权/停用后立刻拒绝。
 */
import { readFile } from 'node:fs/promises';
import { previewTicketResponseSchema, previewTicketSchema } from '@youzhao/contracts/schemas';
import type { PreviewTicketRequest } from '@youzhao/contracts/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/types.js';
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_COOKIE_TTL_SECONDS,
  assertPreviewAccess,
  issuePreviewTicket,
  redeemPreviewTicket,
  signPreviewCookie,
  type PreviewCookiePayload,
  verifyPreviewCookie,
} from '../../app/preview.js';
import { AppError, isAppError } from '../../domain/errors.js';
import { resolveArtifactPath } from '../../storage/artifacts.js';
import { requireContext } from '../plugins/request-context.js';

export interface PreviewRouteDeps {
  readonly db: Db;
  readonly config: AppConfig;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wasm: 'application/wasm',
};

export function contentTypeFor(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[relPath.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

function previewOrigin(config: AppConfig): string {
  try {
    return new URL(config.preview.domain).origin;
  } catch {
    return config.preview.domain;
  }
}

/**
 * 产物文档的 CSP（§3.6）。`sandbox` 让文档进入不透明来源：读不到 Cookie/localStorage，
 * 也不能同源读应用或别踩我们的 API（`connect-src 'none'`）。子资源按预览域显式放行。
 */
export function cspForArtifact(config: AppConfig, contentType: string): string {
  const origin = previewOrigin(config);
  const ancestors = config.session.originAllowlist.length > 0 ? config.session.originAllowlist.join(' ') : "'none'";
  if (!contentType.startsWith('text/html')) {
    return `default-src 'none'; frame-ancestors ${ancestors}`;
  }
  return [
    'sandbox allow-scripts allow-popups',
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin}`,
    `style-src 'unsafe-inline' ${origin}`,
    `img-src data: blob: ${origin}`,
    `font-src data: ${origin}`,
    `media-src data: blob: ${origin}`,
    "connect-src 'none'",
    `frame-ancestors ${ancestors}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function setPreviewCookie(config: AppConfig, reply: FastifyReply, payload: PreviewCookiePayload): void {
  // 生产 TLS 下用 SameSite=None：产物文档被 CSP sandbox 成不透明来源，
  // 子资源请求会被判为跨站；Lax 会让 assets/* 丢掉 Cookie（见 §3.6 实现注记）。
  const secure = config.appEnv === 'production';
  void reply.setCookie(PREVIEW_COOKIE_NAME, signPreviewCookie(config, payload), {
    path: config.preview.publicBasePath,
    httpOnly: true,
    sameSite: payload.p === 'embed' || secure ? 'none' : 'lax',
    secure,
    maxAge: PREVIEW_COOKIE_TTL_SECONDS,
  });
}

function assertRelPath(relPath: string): void {
  if (relPath.includes('\0') || relPath.includes('\\')) {
    throw new AppError('ARTIFACT_INVALID', '产物路径含非法字符');
  }
  const segments = relPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new AppError('ARTIFACT_INVALID', '产物路径含非法段');
  }
}

/** 浏览器直接打开（Accept 含 text/html）时才给人看的错误页；子资源仍走统一 JSON 错误体。 */
function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 失败文案。票据是一次性的，用户刷新或重复打开就会撞上「票据已被使用」——
 * 这时该告诉他回有招重新打开，而不是甩一段 JSON 错误体。
 * 匹配的是 `server/app/preview.ts` 里的固定文案，改动那边时同步这里。
 */
function previewErrorCopy(error: unknown): { status: number; title: string; hint: string } {
  const message = isAppError(error) ? error.message : '';
  if (message.includes('票据已被使用')) {
    return {
      status: 403,
      title: '这个预览链接已经用过了',
      hint: '预览票据是一次性的，只能兑换一次。请回到有招，在蓝图页重新点「在新窗口打开」。',
    };
  }
  if (message.includes('不匹配')) {
    return {
      status: 403,
      title: '预览会话与版本不匹配',
      hint: '请回到有招，重新打开这个版本的预览。',
    };
  }
  if (message.includes('预览会话')) {
    return {
      status: 403,
      title: '预览会话已过期',
      hint: '预览会话有效期很短。请回到有招，在蓝图页重新打开预览。',
    };
  }
  if (isAppError(error) && error.code === 'NOT_FOUND') {
    return {
      status: 404,
      title: '产物不存在',
      hint: '这个版本的产物在服务端缺失，请换一个版本，或让发布者重新发布。',
    };
  }
  return {
    status: 500,
    title: '预览暂时打不开',
    hint: '请稍后重试；若持续失败，请联系管理员。',
  };
}

function sendPreviewErrorPage(reply: FastifyReply, error: unknown): FastifyReply {
  const { status, title, hint } = previewErrorCopy(error);
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · 有招</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f5; color: #0d0d0d; font-family: 'Söhne', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 30rem; margin: 1.5rem; padding: 2rem; background: #ffffff; border: 1px solid #e5e5e5; border-radius: 12px; }
  h1 { margin: 0 0 0.75rem; font-size: 1.125rem; font-weight: 600; }
  p { margin: 0; font-size: 0.9375rem; line-height: 1.65; color: #6e6e6e; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(hint)}</p>
</main>
</body>
</html>`;
  void reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-length', String(Buffer.byteLength(body)))
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");
  return reply.send(body) as FastifyReply;
}

export function registerPreviewRoutes(app: FastifyInstance, deps: PreviewRouteDeps): void {
  const { db, config } = deps;

  app.post(
    '/api/preview-tickets',
    { schema: { body: previewTicketSchema, response: { 200: previewTicketResponseSchema } } },
    async (request: FastifyRequest) => {
      const body = request.body as PreviewTicketRequest;
      const context = body.purpose === 'preview' ? await requireContext(request, { db }) : null;
      const result = await issuePreviewTicket(db, config, body, context);
      return {
        data: {
          ticket: result.ticket,
          expiresAt: result.expiresAt.toISOString(),
          url: result.url,
          blueprintId: result.blueprintId,
          version: result.version,
          purpose: result.purpose,
        },
        meta: { requestId: String(request.id) },
      };
    },
  );

  const serve = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const params = request.params as { blueprintId: string; version: string; '*'?: string };
    const blueprintId = params.blueprintId;
    const version = params.version;
    const wildcard = params['*'] ?? '';
    const query = request.query as { t?: unknown };

    // 1) 换票：一次性票据 → 预览域 Cookie → 303 到不含票据的地址
    if (typeof query.t === 'string' && query.t !== '') {
      const payload = await redeemPreviewTicket(db, query.t, { blueprintId, version });
      setPreviewCookie(config, reply, payload);
      const base = config.preview.publicBasePath.replace(/\/+$/, '');
      const location = `${base}/p/${encodeURIComponent(blueprintId)}/${encodeURIComponent(version)}/${wildcard}`;
      void reply.code(303).header('location', location);
      return reply.send();
    }

    // 2) Cookie 鉴权（没有票据也没有 Cookie 时明确回 403，而不是交给静态服务器匿名取文件）
    const cookieValue = request.cookies[PREVIEW_COOKIE_NAME];
    if (typeof cookieValue !== 'string' || cookieValue === '') {
      throw new AppError('FORBIDDEN', '预览会话缺失或已过期，请重新打开预览');
    }
    const payload = verifyPreviewCookie(config, cookieValue);
    if (payload === null) throw new AppError('FORBIDDEN', '预览会话无效或已过期，请重新打开预览');
    if (payload.b !== blueprintId || payload.v !== version) {
      throw new AppError('FORBIDDEN', '预览会话与请求的蓝图版本不匹配');
    }

    const target = await assertPreviewAccess(db, payload);

    // 3) 路径安全：Fastify 已解码一次，这里只做段校验，再由 storage 层做前缀断言
    const relPath = wildcard === '' ? target.entryPath : wildcard;
    assertRelPath(relPath);
    const absolute = resolveArtifactPath({
      root: config.preview.storagePath,
      blueprintId: target.blueprintId,
      version: target.version,
      relPath,
    });

    let content: Buffer;
    try {
      content = await readFile(absolute);
    } catch {
      throw new AppError('NOT_FOUND', '产物文件不存在');
    }

    const contentType = contentTypeFor(relPath);
    void reply
      .header('content-type', contentType)
      .header('content-length', String(content.byteLength))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('content-disposition', contentType === 'application/octet-stream' ? 'attachment' : 'inline')
      .header('content-security-policy', cspForArtifact(config, contentType));
    return reply.send(content);
  };

  /**
   * 浏览器直接打开时把失败渲染成一张可读的页面。子资源（css/js）仍抛给统一错误处理，
   * 保持 JSON 错误体——把 HTML 当成样式/脚本塞回 iframe 只会更糟。
   */
  const serveFriendly = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      return await serve(request, reply);
    } catch (error) {
      if (!wantsHtml(request)) throw error;
      return sendPreviewErrorPage(reply, error);
    }
  };

  app.get('/preview/p/:blueprintId/:version/', serveFriendly);
  app.get('/preview/p/:blueprintId/:version/*', serveFriendly);
}
