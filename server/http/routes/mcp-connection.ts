/**
 * MCP 接入信息路由（`GET /api/mcp/connection-info`，docs/mcp-onboarding-design.md §3.1）。
 *
 * 为什么需要登录：接入信息本身不含密钥，但它是「我的 Token 该指向哪个地址」的上下文，
 * 与 Token 页同一权限面——登录即可读，不额外要求业务能力。
 */
import { mcpConnectionInfoSchema } from '@youzhao/contracts/schemas';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/types.js';
import { AppError } from '../../domain/errors.js';
import { buildMcpConnectionInfo } from '../../mcp/connection.js';
import { requireContext } from '../plugins/request-context.js';

export interface McpConnectionRouteDeps {
  readonly db: Db;
  readonly config: AppConfig;
}

export function registerMcpConnectionRoutes(
  app: FastifyInstance,
  deps: McpConnectionRouteDeps,
): void {
  app.get(
    '/api/mcp/connection-info',
    { schema: { response: { 200: mcpConnectionInfoSchema } } },
    async (request) => {
      await requireContext(request, deps);
      // MCP_ENABLED=false 时明确回 503，而不是让前端拿着一个连不上的地址
      if (!deps.config.mcp.enabled) throw new AppError('MCP_DISABLED');

      return {
        data: buildMcpConnectionInfo(deps.config),
        meta: { requestId: String(request.id) },
      };
    },
  );
}
