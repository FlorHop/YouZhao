/**
 * 本人自助路由（`/api/me/*`，设计文档 §6.2「本人自助」）。
 *
 * 这三个接口是**所有身份**（含普通用户）唯一能写自己账号的通道；
 * `/api/users/*` 对普通用户整体关闭，对所有者/用户管理员也拒绝「目标是自己」。
 */
import { authSessionSchema, mePasswordSchema, meUpdateSchema } from '@youzhao/contracts/schemas';
import type { ChangeOwnPasswordRequest, UpdateMeRequest } from '@youzhao/contracts/types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../../db/types.js';
import { buildMeView, changeOwnPassword, updateMe } from '../../app/me.js';
import { currentSessionId, requireContext, requestIp } from '../plugins/request-context.js';

export interface MeRouteDeps {
  readonly db: Db;
}

async function meView(db: Db, request: FastifyRequest) {
  const context = await requireContext(request, { db });
  return {
    data: await buildMeView(db, context.userId),
    meta: { requestId: String(request.id) },
  };
}

export function registerMeRoutes(app: FastifyInstance, deps: MeRouteDeps): void {
  app.get(
    '/api/me',
    { schema: { response: { 200: authSessionSchema } } },
    async (request) => meView(deps.db, request),
  );

  app.patch(
    '/api/me',
    { schema: { body: meUpdateSchema, response: { 200: authSessionSchema } } },
    async (request) => {
      const context = await requireContext(request, deps);
      await updateMe(deps.db, context, request.body as UpdateMeRequest, requestIp(request));
      return {
        data: await buildMeView(deps.db, context.userId),
        meta: { requestId: String(request.id) },
      };
    },
  );

  app.post(
    '/api/me/password',
    { schema: { body: mePasswordSchema, response: { 200: authSessionSchema } } },
    async (request: FastifyRequest) => {
      const context = await requireContext(request, deps);
      await changeOwnPassword(deps.db, context, request.body as ChangeOwnPasswordRequest, {
        keepSessionId: currentSessionId(request),
        ip: requestIp(request),
      });
      return {
        data: await buildMeView(deps.db, context.userId),
        meta: { requestId: String(request.id) },
      };
    },
  );
}
