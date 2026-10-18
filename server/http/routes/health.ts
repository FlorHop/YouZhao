/**
 * 健康检查（docs/architecture-design.md §3.8、docs/deployment-rules.md §12）。
 * 契约：`{ data: { status, time, contractVersion, services: { database } }, meta: { requestId } }`
 * 数据库不可达时返回 503 + `status: "degraded"`，网关据此摘流量。
 */
import type { FastifyInstance } from 'fastify';
import { systemHealthSchema } from '@youzhao/contracts/schemas';
import { CONTRACT_VERSION } from '@youzhao/contracts/version';

export interface HealthDependencies {
  probeDatabase: () => Promise<'up' | 'down'>;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDependencies): void {
  app.get(
    '/api/health',
    {
      schema: {
        response: {
          200: systemHealthSchema,
          503: systemHealthSchema,
        },
      },
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const database = await deps.probeDatabase().catch(() => 'down' as const);
      if (database === 'down') reply.code(503);
      return {
        data: {
          status: database === 'up' ? 'ok' : 'degraded',
          time: new Date().toISOString(),
          contractVersion: CONTRACT_VERSION,
          services: { database },
        },
        meta: { requestId: String(request.id) },
      };
    },
  );
}
