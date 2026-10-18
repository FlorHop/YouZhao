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
import { AppError } from '../../domain/errors.js';
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

  app.get('/preview/p/:blueprintId/:version/', serve);
  app.get('/preview/p/:blueprintId/:version/*', serve);
}
