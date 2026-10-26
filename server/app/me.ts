/**
 * 本人自助用例（`/api/me/*`，设计文档 §6.2「本人自助」）。
 *
 * 纪律：
 * - 这里**只**处理「我自己」，任何形如「修改他人」的参数都不存在于请求契约里
 *   （`me/update.json` 与 `me/password.json` 都是 `additionalProperties: false`）。
 * - 改自己的口令要验原口令，并把**其他**会话全部吊销（当前会话保留，避免改密即被踢下线）。
 */
import type { ChangeOwnPasswordRequest, SessionResponse, UpdateMeRequest } from '@youzhao/contracts/types';
import { writeAudit } from '../audit/audit.js';
import type { Db } from '../db/types.js';
import { AppError } from '../domain/errors.js';
import type { Identity, RequestContext, ScopeRef } from '../domain/entities.js';
import { assertAcceptablePassword, hashPassword, verifyPassword } from '../domain/password.js';
import { assertAuthorized } from '../domain/policy.js';
import { effectiveCapabilities } from '../domain/scopes.js';
import { capabilitiesOf, jurisdictionOf } from './context.js';
import { revokeAllSessionsForUser } from './session.js';

type MeView = SessionResponse['data'];

/**
 * 组装 `GET /api/me` / 登录成功的响应体（契约 `auth/session.json`）。
 *
 * 形状按 `docs/permission-design.md` §6.1：`user` 只放本人资料，能力 / 查看授权 /
 * 可委派范围与它平级——前端据此分别驱动导航裁剪与授权面板。
 */
export async function buildMeView(db: Db, userId: string): Promise<MeView> {
  const [
    user,
    identityRow,
    managerRows,
    grants,
    capabilities,
    groupManagerRows,
    blueprintManagerRows,
  ] = await Promise.all([
    db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst(),
    db.selectFrom('user_identity').select(['identity']).where('user_id', '=', userId).executeTakeFirst(),
    db.selectFrom('user_managers').select(['manager_user_id']).where('user_id', '=', userId).execute(),
    db.selectFrom('view_grants').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('capabilities').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('group_managers').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('blueprint_managers').selectAll().where('user_id', '=', userId).execute(),
  ]);
  if (user === undefined) throw new AppError('UNAUTHENTICATED');

  const identity = (identityRow?.identity ?? 'member') as Identity;
  const jurisdiction = jurisdictionOf(identity, groupManagerRows, blueprintManagerRows);

  // 授予者姓名：一次批量查询，避免前端为了「由 X 授予」再逐条拉用户
  const granterIds = [...new Set(grants.map((grant) => grant.granted_by))];
  const granters =
    granterIds.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select(['id', 'display_name'])
          .where('id', 'in', granterIds)
          .execute();
  const displayNameById = new Map(granters.map((row) => [row.id, row.display_name]));

  const viewScope: ScopeRef[] = grants
    .map((grant) => ({
      targetType: grant.target_type as ScopeRef['targetType'],
      targetId: grant.target_id,
    }))
    .sort((left, right) => `${left.targetType}:${left.targetId}`.localeCompare(`${right.targetType}:${right.targetId}`));

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      email: user.email,
      phone: user.phone,
      identity,
      status: user.status as MeView['user']['status'],
      mustChangePassword: user.must_change_password,
      managedByUserIds: managerRows.map((row) => row.manager_user_id).sort(),
    },
    capabilities: effectiveCapabilities(capabilitiesOf(capabilities), jurisdiction)
      .map((cap) => ({
        capability: cap.capability as MeView['capabilities'][number]['capability'],
        targetType: cap.targetType as MeView['capabilities'][number]['targetType'],
        targetId: cap.targetId,
      }))
      .sort((left, right) =>
        `${left.capability}:${left.targetType}:${left.targetId}`.localeCompare(
          `${right.capability}:${right.targetType}:${right.targetId}`,
        ),
      ),
    viewGrants: grants
      .map((grant) => ({
        targetType: grant.target_type as MeView['viewGrants'][number]['targetType'],
        targetId: grant.target_id,
        grantedByUserId: grant.granted_by,
        grantedByDisplayName: displayNameById.get(grant.granted_by) ?? '（已删除用户）',
        grantedAt: grant.created_at.toISOString(),
      }))
      .sort((left, right) =>
        `${left.targetType}:${left.targetId}`.localeCompare(`${right.targetType}:${right.targetId}`),
      ),
    // S1：可委派范围 = 用户管理员本人的查看范围；成员为空。管辖不扩大它（§2.3）
    delegableScopes: identity === 'user_admin' ? viewScope : [],
    jurisdiction: {
      groupIds: [...jurisdiction.groupIds],
      blueprintIds: [...jurisdiction.blueprintIds],
    },
  };
}

export async function updateMe(
  db: Db,
  context: RequestContext,
  input: UpdateMeRequest,
  ip: string | null,
): Promise<void> {
  assertAuthorized(context, 'me.update', { kind: 'none' });

  const patch: { display_name?: string; email?: string | null; phone?: string | null; updated_at: Date } = {
    updated_at: new Date(),
  };
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.email !== undefined) patch.email = input.email === '' ? null : input.email;
  if (input.phone !== undefined) patch.phone = input.phone === '' ? null : input.phone;

  await db.updateTable('users').set(patch).where('id', '=', context.userId).execute();
  await writeAudit(db, {
    actorType: context.actorType,
    actorId: context.userId,
    action: 'me.update',
    result: 'allow',
    targetType: 'user',
    targetId: context.userId,
    detail: { fields: Object.keys(input) },
    ip,
  });
}

export async function changeOwnPassword(
  db: Db,
  context: RequestContext,
  input: ChangeOwnPasswordRequest,
  options: { readonly keepSessionId?: string; readonly ip?: string | null } = {},
): Promise<void> {
  assertAuthorized(context, 'me.password', { kind: 'none' });

  const user = await db
    .selectFrom('users')
    .select(['id', 'password_hash'])
    .where('id', '=', context.userId)
    .executeTakeFirstOrThrow();

  if (!(await verifyPassword(input.oldPassword, user.password_hash))) {
    await writeAudit(db, {
      actorType: context.actorType,
      actorId: context.userId,
      action: 'me.password',
      result: 'deny',
      errorCode: 'INVALID_ARGUMENT',
      detail: { reason: 'bad_old_password' },
      ip: options.ip ?? null,
    });
    throw new AppError('INVALID_ARGUMENT', '原密码不正确', { fields: [{ path: '/oldPassword', message: '原密码不正确' }] });
  }

  assertAcceptablePassword(input.newPassword);
  if (input.newPassword === input.oldPassword) {
    throw new AppError('INVALID_ARGUMENT', '新密码不能与原密码相同', {
      fields: [{ path: '/newPassword', message: '新密码不能与原密码相同' }],
    });
  }

  await db
    .updateTable('users')
    .set({
      password_hash: await hashPassword(input.newPassword),
      must_change_password: false,
      updated_at: new Date(),
    })
    .where('id', '=', context.userId)
    .execute();

  // 改密即吊销其他会话（§3.4）；当前会话保留，用户不必立刻重新登录
  await revokeAllSessionsForUser(db, context.userId, { keepSessionId: options.keepSessionId });

  await writeAudit(db, {
    actorType: context.actorType,
    actorId: context.userId,
    action: 'me.password',
    result: 'allow',
    targetType: 'user',
    targetId: context.userId,
    ip: options.ip ?? null,
  });
}
