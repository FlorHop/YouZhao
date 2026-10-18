/**
 * 蓝图分组路由（docs/permission-design.md §6.4）。
 *
 * 注意：Action 联合里没有 `group.list`——分组列表**不做 `assertAuthorized`**，
 * 与蓝图列表同一判定：按可见性过滤（用例层 `listBlueprintGroups` 实现）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  blueprintGroupsCreateSchema,
  blueprintGroupsListSchema,
  blueprintGroupsMutationSchema,
  blueprintGroupsReorderSchema,
} from '@youzhao/contracts/schemas';
import type {
  CreateBlueprintGroupRequest,
  ReorderBlueprintGroupsRequest,
} from '@youzhao/contracts/types';
import type { Db } from '../../db/types.js';
import { requireContext, requestIp } from '../plugins/request-context.js';
import {
  archiveBlueprintGroup,
  createBlueprintGroup,
  listBlueprintGroups,
  reorderBlueprintGroups,
  restoreBlueprintGroup,
  type CallerFacts,
} from '../../app/blueprints.js';

export interface BlueprintGroupDependencies {
  readonly db: Db;
}

const groupParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

export function registerBlueprintGroupRoutes(
  app: FastifyInstance,
  deps: BlueprintGroupDependencies,
): void {
  const callerFacts = (request: FastifyRequest): CallerFacts => ({
    ip: requestIp(request),
    requestId: String(request.id),
  });

  app.get(
    '/api/blueprint-groups',
    { schema: { response: { 200: blueprintGroupsListSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const items = await listBlueprintGroups(deps.db, context);
      return {
        data: { items },
        meta: {
          page: 1,
          pageSize: Math.max(1, items.length),
          total: items.length,
          requestId: String(request.id),
        },
      };
    },
  );

  app.post(
    '/api/blueprint-groups',
    { schema: { body: blueprintGroupsCreateSchema, response: { 200: blueprintGroupsMutationSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const data = await createBlueprintGroup(
        deps.db,
        context,
        request.body as CreateBlueprintGroupRequest,
        callerFacts(request),
      );
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.patch(
    '/api/blueprint-groups/reorder',
    { schema: { body: blueprintGroupsReorderSchema, response: { 200: blueprintGroupsListSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const items = await reorderBlueprintGroups(
        deps.db,
        context,
        request.body as ReorderBlueprintGroupsRequest,
        callerFacts(request),
      );
      return {
        data: { items },
        meta: {
          page: 1,
          pageSize: Math.max(1, items.length),
          total: items.length,
          requestId: String(request.id),
        },
      };
    },
  );

  app.delete(
    '/api/blueprint-groups/:id',
    { schema: { params: groupParamsSchema, response: { 200: blueprintGroupsMutationSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id } = request.params as { id: string };
      const data = await archiveBlueprintGroup(deps.db, context, id, callerFacts(request));
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.post(
    '/api/blueprint-groups/:id/restore',
    { schema: { params: groupParamsSchema, response: { 200: blueprintGroupsMutationSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id } = request.params as { id: string };
      const data = await restoreBlueprintGroup(deps.db, context, id, callerFacts(request));
      return { data, meta: { requestId: String(request.id) } };
    },
  );
}
