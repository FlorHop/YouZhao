/**
 * 嵌入票据（docs/architecture-design.md §3.7）。
 *
 * 服务端到服务端调用：没有浏览器 Origin，也没有用户会话，凭 `X-Embed-Secret` 共享密钥
 * （环境变量 `PREVIEW_EMBED_SECRET`）换一张绑定单个蓝图版本的短时票据。
 *
 * 与旧实现的关键差别：旧版有硬编码回退密钥 `youzhao_embed_dev_secret`，且默认可用；
 * 现在**未配置即视为未启用**（503），密钥比较用定时安全比较，接口本身也不再需要会话。
 */
import { timingSafeEqual } from 'node:crypto';
import { embedTicketSchema, previewTicketResponseSchema } from '@youzhao/contracts/schemas';
import type { EmbedTicketRequest } from '@youzhao/contracts/types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { issuePreviewTicket } from '../../app/preview.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/types.js';
import { AppError } from '../../domain/errors.js';

export interface EmbedRouteDeps {
  readonly db: Db;
  readonly config: AppConfig;
}

function equalSecret(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 校验嵌入共享密钥；未配置嵌入 → 503，缺失或不符 → 401（不回显期望值）。 */
export function assertEmbedSecret(config: AppConfig, provided: unknown): void {
  const expected = config.preview.embedSecret;
  if (expected === '') throw new AppError('SERVICE_UNAVAILABLE', '当前部署未启用嵌入');
  if (typeof provided !== 'string' || provided === '' || !equalSecret(provided, expected)) {
    throw new AppError('UNAUTHENTICATED', '嵌入密钥缺失或不正确');
  }
}

export function registerEmbedRoutes(app: FastifyInstance, deps: EmbedRouteDeps): void {
  const { db, config } = deps;

  app.post(
    '/api/embed/tickets',
    { schema: { body: embedTicketSchema, response: { 200: previewTicketResponseSchema } } },
    async (request: FastifyRequest) => {
      assertEmbedSecret(config, request.headers['x-embed-secret']);
      const body = request.body as EmbedTicketRequest;
      // 嵌入票据不绑定用户：可见性取决于「资源当前可预览」，因此归档后立刻失效
      const result = await issuePreviewTicket(
        db,
        config,
        { blueprintId: body.blueprintId, version: body.version, purpose: 'embed' },
        null,
      );
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
}
