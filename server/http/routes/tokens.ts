/**
 * MCP Token 管理路由（`/api/mcp-tokens/*`，设计文档 §6.3）。
 *
 * 请求体 / 响应体一律引用契约包里的 JSON Schema（`@youzhao/contracts/schemas`），
 * 校验交给 Fastify + ajv 严格模式（`additionalProperties: false` 会真的 400）；
 * 判权与落库都在 `server/app/tokens.ts`，鉴权（会话 + CSRF）由既有插件统一处理，
 * 这里只负责取上下文、取 requestId 与拼响应信封。
 */
import {
  tokensCreateResponseSchema,
  tokensCreateSchema,
  tokensListSchema,
  tokensMutationSchema,
  tokensUpdateSchema,
} from '@youzhao/contracts/schemas';
import type { CreateMcpTokenRequest, UpdateMcpTokenRequest } from '@youzhao/contracts/types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createMcpToken,
  deleteMcpToken,
  listMcpTokens,
  updateMcpToken,
} from '../../app/tokens.js';
import type { TokenAudit } from '../../app/tokens.js';
import type { Db } from '../../db/types.js';
import { requireContext, requestIp } from '../plugins/request-context.js';

export interface TokenRouteDeps {
  readonly db: Db;
}

const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
};

interface IdParams {
  readonly id: string;
}

/**
 * GET 的响应信封必须满足契约 `tokens/list.json`：`meta` 四项（page / pageSize / total /
 * requestId）都是必填（`additionalProperties: false`），所以这里给全——
 * 与本仓库 `routes/users.ts` 的列表写法一致。
 * 列表不分页（一次返回全部可见项），因此 `page = 1`、`total = 返回条数`，
 * `pageSize` 取返回条数并按契约的 `max: 100` 收敛、下限 1。
 */
const MAX_LIST_PAGE_SIZE = 100;

function auditOf(request: FastifyRequest): TokenAudit {
  return { requestId: String(request.id), ip: requestIp(request) };
}

export function registerTokenRoutes(app: FastifyInstance, deps: TokenRouteDeps): void {
  // 列表：所有者看全平台；其他人只看自己创建或绑定给自己的 Token。
  app.get(
    '/api/mcp-tokens',
    { schema: { response: { 200: tokensListSchema } } },
    async (request) => {
      const context = await requireContext(request, deps);
      const data = await listMcpTokens(deps.db, context, auditOf(request));
      const total = data.items.length;
      return {
        data,
        meta: {
          page: 1,
          pageSize: Math.min(Math.max(total, 1), MAX_LIST_PAGE_SIZE),
          total,
          requestId: String(request.id),
        },
      };
    },
  );

  // 创建：201；明文令牌只在本响应里出现一次。
  app.post(
    '/api/mcp-tokens',
    { schema: { body: tokensCreateSchema, response: { 201: tokensCreateResponseSchema } } },
    async (request, reply) => {
      const context = await requireContext(request, deps);
      const data = await createMcpToken(
        deps.db,
        context,
        request.body as CreateMcpTokenRequest,
        auditOf(request),
      );
      reply.code(201);
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  // 改名 / 启停（只允许 name 与 status，由契约体校验把关）。
  app.patch(
    '/api/mcp-tokens/:id',
    {
      schema: {
        params: idParamsSchema,
        body: tokensUpdateSchema,
        response: { 200: tokensMutationSchema },
      },
    },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const data = await updateMcpToken(
        deps.db,
        context,
        id,
        request.body as UpdateMcpTokenRequest,
        auditOf(request),
      );
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  // 删除：物理删除，响应回被删对象的摘要。
  app.delete(
    '/api/mcp-tokens/:id',
    { schema: { params: idParamsSchema, response: { 200: tokensMutationSchema } } },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const data = await deleteMcpToken(deps.db, context, id, auditOf(request));
      return { data, meta: { requestId: String(request.id) } };
    },
  );
}
