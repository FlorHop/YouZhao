/**
 * 用户与授权管理路由（`/api/users/*`，设计文档 §6.2）。
 *
 * 这一组接口只对所有者与用户管理员开放；普通用户（含目标是自己）由用例层的命名空间
 * 闸门整体拒绝（不变量 10）。请求体 / 响应体一律引用契约包里的 JSON Schema，
 * 校验交给 Fastify + ajv 严格模式（`additionalProperties: false` 会真的 400）；
 * 判权与落库都在 `server/app/users.ts`。
 */
import {
  usersAccessSchema,
  usersCapabilitiesSchema,
  usersCreateSchema,
  usersGrantsChangeSchema,
  usersGrantsSchema,
  usersIdentitySchema,
  usersJurisdictionSchema,
  usersJurisdictionSetSchema,
  usersListSchema,
  usersManagedBySchema,
  usersPasswordSchema,
  usersUpdateSchema,
} from '@youzhao/contracts/schemas';
import type {
  CreateUserRequest,
  ResetUserPasswordRequest,
  SetManagedByRequest,
  SetUserCapabilitiesRequest,
  SetUserIdentityRequest,
  SetUserJurisdictionRequest,
  UpdateUserRequest,
  UserGrantsChangeRequest,
} from '@youzhao/contracts/types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  changeUserGrants,
  createUser,
  DEFAULT_PAGE_SIZE,
  deleteUser,
  getUserAccess,
  listUserGrants,
  listUsers,
  MAX_PAGE_SIZE,
  resetUserPassword,
  setManagedBy,
  setUserCapabilities,
  setUserIdentity,
  setUserJurisdiction,
  updateUser,
} from '../../app/users.js';
import type { UserAudit } from '../../app/users.js';
import type { Db } from '../../db/types.js';
import type { Identity, UserStatus } from '../../domain/entities.js';
import { requireContext, requestIp } from '../plugins/request-context.js';

export interface UserRouteDeps {
  readonly db: Db;
}

/** 列表查询参数（契约未提供，路由内做最小校验；`page` / `pageSize` 与契约 meta 的取值范围一致）。 */
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
    keyword: { type: 'string', maxLength: 128 },
    status: { type: 'string', enum: ['active', 'disabled'] },
    identity: { type: 'string', enum: ['owner', 'user_admin', 'member'] },
  },
};

const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
};

interface ListUsersQueryInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly keyword?: string;
  readonly status?: UserStatus;
  readonly identity?: Identity;
}

interface IdParams {
  readonly id: string;
}

function auditOf(request: FastifyRequest): UserAudit {
  return { requestId: String(request.id), ip: requestIp(request) };
}

export function registerUserRoutes(app: FastifyInstance, deps: UserRouteDeps): void {
  // 列表：所有者看全平台；用户管理员只看「管理归属含自己」的普通用户。
  app.get(
    '/api/users',
    { schema: { querystring: listQuerySchema, response: { 200: usersListSchema } } },
    async (request) => {
      const context = await requireContext(request, deps);
      const query = request.query as ListUsersQueryInput;
      const result = await listUsers(
        deps.db,
        context,
        {
          page: query.page ?? 1,
          pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
          keyword: query.keyword,
          status: query.status,
          identity: query.identity,
        },
        auditOf(request),
      );
      return {
        data: { items: result.items },
        meta: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          requestId: String(request.id),
        },
      };
    },
  );

  // 建号：所有者可指定归属；用户管理员只能建 member，且自动归属自己。
  app.post(
    '/api/users',
    { schema: { body: usersCreateSchema } },
    async (request) => {
      const context = await requireContext(request, deps);
      const user = await createUser(
        deps.db,
        context,
        request.body as CreateUserRequest,
        auditOf(request),
      );
      return { data: user, meta: { requestId: String(request.id) } };
    },
  );

  // 改资料 / 改状态：按状态分派 disable / enable / update 两个动作。
  app.patch(
    '/api/users/:id',
    { schema: { params: idParamsSchema, body: usersUpdateSchema } },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const user = await updateUser(
        deps.db,
        context,
        id,
        request.body as UpdateUserRequest,
        auditOf(request),
      );
      return { data: user, meta: { requestId: String(request.id) } };
    },
  );

  // 重置密码：口令强度校验 + 吊销目标用户全部会话。
  app.post(
    '/api/users/:id/password',
    { schema: { params: idParamsSchema, body: usersPasswordSchema } },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const user = await resetUserPassword(
        deps.db,
        context,
        id,
        request.body as ResetUserPasswordRequest,
        auditOf(request),
      );
      return { data: user, meta: { requestId: String(request.id) } };
    },
  );

  // 硬删除（仅所有者）：清掉本人全部关联行后删 users，审计日志保留。
  app.delete(
    '/api/users/:id',
    { schema: { params: idParamsSchema } },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      await deleteUser(deps.db, context, id, auditOf(request));
      return { data: { id }, meta: { requestId: String(request.id) } };
    },
  );

  // 管理归属整体替换（仅所有者）。
  app.put(
    '/api/users/:id/managed-by',
    { schema: { params: idParamsSchema, body: usersManagedBySchema } },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const user = await setManagedBy(
        deps.db,
        context,
        id,
        request.body as SetManagedByRequest,
        auditOf(request),
      );
      return { data: user, meta: { requestId: String(request.id) } };
    },
  );

  // 身份设置（仅所有者；不能设为 owner，不能降级所有者）。
  app.put(
    '/api/users/:id/identity',
    { schema: { params: idParamsSchema, body: usersIdentitySchema } },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const user = await setUserIdentity(
        deps.db,
        context,
        id,
        request.body as SetUserIdentityRequest,
        auditOf(request),
      );
      return { data: user, meta: { requestId: String(request.id) } };
    },
  );

  // 查看授权：所有者，或用户管理员在自己管理的用户上。
  app.get(
    '/api/users/:id/grants',
    {
      schema: {
        params: idParamsSchema,
        querystring: listQuerySchema,
        response: { 200: usersGrantsSchema },
      },
    },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const query = request.query as ListUsersQueryInput;
      const result = await listUserGrants(
        deps.db,
        context,
        id,
        { page: query.page ?? 1, pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE },
        auditOf(request),
      );
      return {
        data: { items: result.items },
        meta: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          requestId: String(request.id),
        },
      };
    },
  );

  // 增量授予 / 撤销（add → grant.view.add，remove → grant.view.remove）。
  app.post(
    '/api/users/:id/grants',
    {
      schema: {
        params: idParamsSchema,
        body: usersGrantsChangeSchema,
        response: { 200: usersGrantsSchema },
      },
    },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const result = await changeUserGrants(
        deps.db,
        context,
        id,
        request.body as UserGrantsChangeRequest,
        auditOf(request),
      );
      return {
        data: { items: result.items },
        meta: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          requestId: String(request.id),
        },
      };
    },
  );

  // 能力整体替换（仅所有者）。
  app.put(
    '/api/users/:id/capabilities',
    { schema: { params: idParamsSchema, body: usersCapabilitiesSchema } },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const capabilities = await setUserCapabilities(
        deps.db,
        context,
        id,
        request.body as SetUserCapabilitiesRequest,
        auditOf(request),
      );
      return { data: { id, capabilities }, meta: { requestId: String(request.id) } };
    },
  );

  // 完整写权限视图：例外授权 + 有效能力 + 管辖范围（仅所有者）。
  app.get(
    '/api/users/:id/access',
    { schema: { params: idParamsSchema, response: { 200: usersAccessSchema } } },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const access = await getUserAccess(deps.db, context, id, auditOf(request));
      return { data: access, meta: { requestId: String(request.id) } };
    },
  );

  // 管辖整体替换（仅所有者）：分组管辖派生发布 + 维护，单蓝图管辖只派生维护。
  app.put(
    '/api/users/:id/jurisdiction',
    {
      schema: {
        params: idParamsSchema,
        body: usersJurisdictionSetSchema,
        response: { 200: usersJurisdictionSchema },
      },
    },
    async (request) => {
      const context = await requireContext(request, deps);
      const { id } = request.params as IdParams;
      const jurisdiction = await setUserJurisdiction(
        deps.db,
        context,
        id,
        request.body as SetUserJurisdictionRequest,
        auditOf(request),
      );
      return { data: jurisdiction, meta: { requestId: String(request.id) } };
    },
  );
}
