/**
 * 用户与授权管理用例层（docs/permission-design.md §6.2）。
 *
 * 约定：
 * - 判权一律走 `assertAuthorized`（`../domain/policy.js`），本层不手写身份分支；
 *   每个入口先做一次「命名空间闸门」（复用策略里的 `user.list` 判定）——不变量 10
 *   要求 `/api/users/*` 对 member 一律拒绝，包括目标是自己、包括目标不存在时。
 * - 写操作全部 `writeAudit`：成功记 `allow`，抛 `AppError` 记 `deny` + `errorCode`，
 *   其它异常记 `error`。
 * - 数据库列名是 snake_case（没有 CamelCasePlugin），camelCase ↔ snake_case 的映射在这里手工完成。
 * - 用户名重复靠捕获唯一约束冲突（不先查后插）；授权撤销只删目标用户自己的那一行。
 */
import { sql } from 'kysely';
import type { ExpressionBuilder, OperandExpression, SqlBool } from 'kysely';
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
import { writeAudit } from '../audit/audit.js';
import type { Database, Db, UserPatch } from '../db/types.js';
import type {
  CapabilityGrant,
  CapabilityName,
  Identity,
  RequestContext,
  ScopeRef,
  TargetType,
  UserFacts,
  UserStatus,
} from '../domain/entities.js';
import { AppError, isAppError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { assertAcceptablePassword, hashPassword } from '../domain/password.js';
import { assertAuthorized } from '../domain/policy.js';
import { dedupeCapabilities, dedupeScopes, effectiveCapabilities, isScopeSubset } from '../domain/scopes.js';
import { revokeAllSessionsForUser } from './session.js';

/** 分页上限与默认值（与契约 `meta.pageSize` 的 `max: 100` 对齐）。 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** `grantedByDisplayName` 在授权人已被删除时的占位文案（与 `app/me.ts` 一致）。 */
export const DELETED_GRANTER_LABEL = '（已删除用户）';

/** 列表项视图（对齐契约 `users/list.json` 的 `UserSummary`）。 */
export interface UserSummaryView {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: UserStatus;
  readonly identity: Identity;
  readonly managedByUserIds: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 授权项视图（对齐契约 `users/grants.json` 的 `ViewGrantItem`）。 */
export interface GrantView {
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly grantedByUserId: string;
  readonly grantedByDisplayName: string;
  readonly grantedAt: string;
}

/** 能力项视图（对齐契约 `users/capabilities.json` 的 `CapabilityGrant`）。 */
export interface CapabilityView {
  readonly capability: CapabilityName;
  readonly targetType: TargetType;
  readonly targetId: string;
}

/** 审计上下文：由路由层从请求上取。 */
export interface UserAudit {
  readonly requestId: string | null;
  readonly ip: string | null;
}

export interface ListUsersQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly keyword?: string | undefined;
  readonly status?: UserStatus | undefined;
  readonly identity?: Identity | undefined;
}

export interface ListUsersResult {
  readonly items: UserSummaryView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface ListGrantsResult {
  readonly items: GrantView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface PageQuery {
  readonly page: number;
  readonly pageSize: number;
}

// ────────────────────────────── 内部工具 ──────────────────────────────

interface AuditTarget {
  targetType: string | null;
  targetId: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordAudit(
  db: Db,
  ctx: RequestContext,
  action: string,
  result: 'allow' | 'deny' | 'error',
  target: AuditTarget,
  audit: UserAudit,
  errorCode: string | null,
  detail: unknown,
): Promise<void> {
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.userId,
    requestId: audit.requestId,
    action,
    result,
    targetType: target.targetType,
    targetId: target.targetId,
    errorCode,
    detail,
    ip: audit.ip,
  });
}

/**
 * 审计包装：成功按 `actions` 逐条记 `allow`；失败记一条 `deny`（`AppError`）或 `error`。
 * 增量授权可能同时含 add / remove 两个动作，成功时两条都记；失败时记在第一个动作名下
 * （拒绝码本身即可区分是哪一段失败：add → `DELEGATION_EXCEEDED`，remove → `OUT_OF_MANAGED_SCOPE`）。
 */
async function audited<T>(
  db: Db,
  ctx: RequestContext,
  actions: string | readonly string[],
  target: AuditTarget,
  audit: UserAudit,
  run: () => Promise<T>,
): Promise<T> {
  const list = typeof actions === 'string' ? [actions] : actions;
  const primary = list[0] ?? 'user.update';
  try {
    const result = await run();
    for (const action of list) {
      await recordAudit(db, ctx, action, 'allow', target, audit, null, null);
    }
    return result;
  } catch (error) {
    await recordAudit(
      db,
      ctx,
      primary,
      isAppError(error) ? 'deny' : 'error',
      target,
      audit,
      isAppError(error) ? error.code : null,
      isAppError(error) ? (error.details ?? null) : { message: messageOf(error) },
    );
    throw error;
  }
}

/** 空串归一为 NULL（与 `app/me.ts` 的 `updateMe` 一致）。 */
function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function optionalText(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : normalizeText(value);
}

/** LIKE 通配符转义（Postgres 默认转义符是反斜杠）。 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function clampPageSize(value: number): number {
  const size = Math.trunc(value);
  if (!Number.isFinite(size) || size < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
}

function clampPage(value: number): number {
  const page = Math.trunc(value);
  return Number.isFinite(page) && page >= 1 ? page : 1;
}

/** Postgres 唯一约束冲突（23505）。 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (candidate.code === '23505') return true;
  if (typeof candidate.message === 'string' && candidate.message.includes('duplicate key value')) {
    return true;
  }
  return candidate.cause !== undefined && candidate.cause !== error && isUniqueViolation(candidate.cause);
}

// ────────────────────────────── 读取目标用户 ──────────────────────────────

/** 组装判权用的 `UserFacts`（用户不存在返回 null）。 */
export async function loadUserFacts(db: Db, userId: string): Promise<UserFacts | null> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user === undefined) return null;

  const [identityRow, managerRows] = await Promise.all([
    db
      .selectFrom('user_identity')
      .select('identity')
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('user_managers')
      .select('manager_user_id')
      .where('user_id', '=', userId)
      .orderBy('manager_user_id')
      .execute(),
  ]);

  return {
    id: user.id,
    identity: (identityRow?.identity ?? 'member') as Identity,
    status: user.status as UserStatus,
    managedByUserIds: managerRows.map((row) => row.manager_user_id),
  };
}

async function requireUserFacts(db: Db, userId: string): Promise<UserFacts> {
  const facts = await loadUserFacts(db, userId);
  if (facts === null) throw new AppError('USER_NOT_FOUND', '目标用户不存在');
  return facts;
}

interface UserSummaryRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

async function buildSummaries(db: Db, rows: readonly UserSummaryRow[]): Promise<UserSummaryView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [identityRows, managerRows] = await Promise.all([
    db.selectFrom('user_identity').select(['user_id', 'identity']).where('user_id', 'in', ids).execute(),
    db
      .selectFrom('user_managers')
      .select(['user_id', 'manager_user_id'])
      .where('user_id', 'in', ids)
      .execute(),
  ]);

  const identityById = new Map(identityRows.map((row) => [row.user_id, row.identity as Identity]));
  const managersById = new Map<string, string[]>();
  for (const row of managerRows) {
    const list = managersById.get(row.user_id) ?? [];
    list.push(row.manager_user_id);
    managersById.set(row.user_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    status: row.status as UserStatus,
    identity: identityById.get(row.id) ?? 'member',
    managedByUserIds: (managersById.get(row.id) ?? []).sort(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

async function readUserSummary(db: Db, userId: string): Promise<UserSummaryView> {
  const row = await db
    .selectFrom('users')
    .select([
      'id',
      'username',
      'display_name',
      'email',
      'phone',
      'status',
      'created_at',
      'updated_at',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (row === undefined) throw new AppError('USER_NOT_FOUND', '目标用户不存在');
  const [summary] = await buildSummaries(db, [row]);
  if (summary === undefined) throw new AppError('USER_NOT_FOUND', '目标用户不存在');
  return summary;
}

/**
 * 校验可被指派的上级：必须存在且身份是 `user_admin`。
 * 「不得指派给所有者」由此自动覆盖（所有者身份不是 `user_admin`）。
 */
async function assertAssignableManagers(db: Db, managerIds: readonly string[]): Promise<void> {
  if (managerIds.length === 0) return;
  const ids = [...managerIds];
  const [userRows, identityRows] = await Promise.all([
    db.selectFrom('users').select('id').where('id', 'in', ids).execute(),
    db.selectFrom('user_identity').select(['user_id', 'identity']).where('user_id', 'in', ids).execute(),
  ]);
  const existing = new Set(userRows.map((row) => row.id));
  const identityById = new Map(identityRows.map((row) => [row.user_id, row.identity]));

  for (const managerId of managerIds) {
    if (!existing.has(managerId)) {
      throw new AppError('INVALID_ARGUMENT', '指定的管理者不存在', {
        fields: [{ path: '/managerIds', message: `用户 ${managerId} 不存在` }],
      });
    }
    if (identityById.get(managerId) !== 'user_admin') {
      throw new AppError('INVALID_ARGUMENT', '只能指派给用户管理员', {
        fields: [{ path: '/managerIds', message: `用户 ${managerId} 不是用户管理员` }],
      });
    }
  }
}

// ────────────────────────────── 列表 ──────────────────────────────

export async function listUsers(
  db: Db,
  ctx: RequestContext,
  query: ListUsersQuery,
  audit: UserAudit,
): Promise<ListUsersResult> {
  const target: AuditTarget = { targetType: 'user', targetId: null };
  return audited(db, ctx, 'user.list', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');

    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    const filter = (eb: ExpressionBuilder<Database, 'users'>): OperandExpression<SqlBool> => {
      const items: OperandExpression<SqlBool>[] = [];
      if (ctx.identity !== 'owner') {
        // 用户管理员只看「管理归属含自己」的普通用户：直接进 SQL，不做全表后置裁剪。
        items.push(
          eb(
            'users.id',
            'in',
            eb
              .selectFrom('user_managers')
              .select('user_managers.user_id')
              .where('user_managers.manager_user_id', '=', ctx.userId),
          ),
        );
        items.push(
          eb(
            'users.id',
            'in',
            eb
              .selectFrom('user_identity')
              .select('user_identity.user_id')
              .where('user_identity.identity', '=', 'member'),
          ),
        );
      }
      if (query.status !== undefined) {
        items.push(eb('users.status', '=', query.status));
      }
      if (query.identity !== undefined) {
        items.push(
          eb(
            'users.id',
            'in',
            eb
              .selectFrom('user_identity')
              .select('user_identity.user_id')
              .where('user_identity.identity', '=', query.identity),
          ),
        );
      }
      const keyword = query.keyword?.trim();
      if (keyword !== undefined && keyword !== '') {
        const pattern = `%${escapeLikePattern(keyword)}%`;
        items.push(
          eb.or([
            eb('users.username', 'ilike', pattern),
            eb('users.display_name', 'ilike', pattern),
          ]),
        );
      }
      return items.length === 0 ? sql<SqlBool>`true` : eb.and(items);
    };

    const [rows, totalRow] = await Promise.all([
      db
        .selectFrom('users')
        .select([
          'users.id',
          'users.username',
          'users.display_name',
          'users.email',
          'users.phone',
          'users.status',
          'users.created_at',
          'users.updated_at',
        ])
        .where(filter)
        .orderBy('users.created_at', 'asc')
        .orderBy('users.id', 'asc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute(),
      db
        .selectFrom('users')
        .select((eb) => eb.fn.countAll<number>().as('total'))
        .where(filter)
        .executeTakeFirst(),
    ]);

    return {
      items: await buildSummaries(db, rows),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
    };
  });
}

// ────────────────────────────── 创建 / 修改 / 停用 ──────────────────────────────

export async function createUser(
  db: Db,
  ctx: RequestContext,
  input: CreateUserRequest,
  audit: UserAudit,
): Promise<UserSummaryView> {
  const target: AuditTarget = { targetType: 'user', targetId: null };
  return audited(db, ctx, 'user.create', target, audit, async () => {
    // 契约 `users/create.json` 不含身份字段：HTTP 上新建一律 `member`，
    // 提升为 `user_admin` 只能走 `PUT /api/users/:id/identity`。
    const requestedIdentity: Identity = 'member';
    const requestedManagerIds = input.managedByUserIds ?? [];
    assertAuthorized(ctx, 'user.create', {
      kind: 'userCreate',
      requestedIdentity,
      requestedManagerIds,
    });

    assertAcceptablePassword(input.password);

    const username = input.username.trim();
    const displayName = input.displayName.trim();
    if (username === '' || displayName === '') {
      throw new AppError('INVALID_ARGUMENT', '用户名与显示名不能为空白', {
        fields: [{ path: '/username', message: '用户名与显示名不能为空白' }],
      });
    }

    // 用户管理员新建的用户自动归属自己（判定用的仍是用户「请求」的归属列表，越界会被策略拒绝）。
    const managerIds = ctx.identity === 'user_admin' ? [ctx.userId] : requestedManagerIds;
    if (ctx.identity === 'owner') {
      await assertAssignableManagers(db, managerIds);
    }
    const grants = dedupeScopes(input.viewGrants ?? []);
    // 初始查看授权也受可委派范围约束：契约 `users/create.json` 写明 viewGrants
    // 「不得超过操作者的可委派范围」，而策略的 `user.create` 判定（只接收
    // requestedIdentity / requestedManagerIds）看不到 grants，因此在这里补一次
    // 与 `grant.view.add` 完全同构的范围检查（S1：可委派范围 = 本人查看范围）。
    if (ctx.identity !== 'owner' && !isScopeSubset(grants, ctx.delegableScope)) {
      throw new AppError('DELEGATION_EXCEEDED', undefined, {
        reason: '授权目标超出你的可委派范围',
      });
    }
    const passwordHash = await hashPassword(input.password);
    const id = newId('usr');

    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('users')
          .values({
            id,
            username,
            display_name: displayName,
            email: optionalText(input.email) ?? null,
            phone: optionalText(input.phone) ?? null,
            status: 'active',
            password_hash: passwordHash,
            must_change_password: true,
            created_by_user_id: ctx.userId,
          })
          .execute();
        await trx
          .insertInto('user_identity')
          .values({ user_id: id, identity: requestedIdentity, granted_by: ctx.userId })
          .execute();
        for (const managerId of managerIds) {
          await trx
            .insertInto('user_managers')
            .values({ user_id: id, manager_user_id: managerId })
            .execute();
        }
        for (const grant of grants) {
          await trx
            .insertInto('view_grants')
            .values({
              id: newId('grn'),
              user_id: id,
              target_type: grant.targetType,
              target_id: grant.targetId,
              granted_by: ctx.userId,
            })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError('USERNAME_CONFLICT', '用户名已存在');
      }
      throw error;
    }

    target.targetId = id;
    return await readUserSummary(db, id);
  });
}

function buildUserPatch(patch: UpdateUserRequest): UserPatch {
  const changes: UserPatch = { updated_at: new Date() };
  let touched = 0;
  if (patch.displayName !== undefined) {
    changes.display_name = patch.displayName;
    touched += 1;
  }
  if (patch.email !== undefined) {
    changes.email = normalizeText(patch.email);
    touched += 1;
  }
  if (patch.phone !== undefined) {
    changes.phone = normalizeText(patch.phone);
    touched += 1;
  }
  if (patch.status !== undefined) {
    changes.status = patch.status;
    touched += 1;
  }
  if (touched === 0) {
    throw new AppError('INVALID_ARGUMENT', '至少需要提供一个可修改字段', {
      fields: [{ path: '/', message: 'displayName、email、phone、status 至少提供一个' }],
    });
  }
  return changes;
}

/** 修改用户资料 / 状态：按是否改状态分派 `user.disable`、`user.enable` 或 `user.update`。 */
export async function updateUser(
  db: Db,
  ctx: RequestContext,
  userId: string,
  patch: UpdateUserRequest,
  audit: UserAudit,
): Promise<UserSummaryView> {
  const action =
    patch.status === 'disabled' ? 'user.disable' : patch.status === 'active' ? 'user.enable' : 'user.update';
  const target: AuditTarget = { targetType: 'user', targetId: userId };

  return audited(db, ctx, action, target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);
    assertAuthorized(ctx, action, { kind: 'user', target: facts });
    const changes = buildUserPatch(patch);

    await db.updateTable('users').set(changes).where('id', '=', userId).execute();
    if (patch.status === 'disabled') {
      await revokeAllSessionsForUser(db, userId);
    }
    return await readUserSummary(db, userId);
  });
}

/** 重置密码：校验口令强度 → 落库 → 吊销目标用户的**全部**会话。 */
export async function resetUserPassword(
  db: Db,
  ctx: RequestContext,
  userId: string,
  input: ResetUserPasswordRequest,
  audit: UserAudit,
): Promise<UserSummaryView> {
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  return audited(db, ctx, 'user.resetPassword', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);
    assertAuthorized(ctx, 'user.resetPassword', { kind: 'user', target: facts });
    assertAcceptablePassword(input.password);

    const passwordHash = await hashPassword(input.password);
    await db
      .updateTable('users')
      .set({
        password_hash: passwordHash,
        must_change_password: input.mustChangePassword ?? true,
        updated_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();
    await revokeAllSessionsForUser(db, userId);
    return await readUserSummary(db, userId);
  });
}

/**
 * 硬删除用户：同一事务内清掉本人全部关联行，最后删 `users`；`audit_logs` 是文本列、无外键，保留。
 *
 * 除本人关联行外，还要处理**别人指向本行**的外键（都是 NO ACTION，不清理会让最后的
 * `delete from users` 直接 23503 失败）：`users.created_by_user_id` 与
 * `user_identity.granted_by` 置空（可空列），`view_grants.granted_by` /
 * `capabilities.granted_by` 是 NOT NULL，只能连带删除那些行。
 * M2 的 `blueprints.created_by_user_id` / `mcp_tokens.created_by_user_id` 不在本期处理范围。
 */
export async function deleteUser(
  db: Db,
  ctx: RequestContext,
  userId: string,
  audit: UserAudit,
): Promise<void> {
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  await audited(db, ctx, 'user.delete', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);
    assertAuthorized(ctx, 'user.delete', { kind: 'user', target: facts });

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('sessions').where('user_id', '=', userId).execute();
      await trx.deleteFrom('view_grants').where('user_id', '=', userId).execute();
      await trx.deleteFrom('capabilities').where('user_id', '=', userId).execute();
      await trx
        .deleteFrom('user_managers')
        .where((eb) => eb.or([eb('user_id', '=', userId), eb('manager_user_id', '=', userId)]))
        .execute();
      await trx.deleteFrom('user_identity').where('user_id', '=', userId).execute();
      await trx
        .updateTable('users')
        .set({ created_by_user_id: null })
        .where('created_by_user_id', '=', userId)
        .execute();
      await trx
        .updateTable('user_identity')
        .set({ granted_by: null })
        .where('granted_by', '=', userId)
        .execute();
      await trx.deleteFrom('view_grants').where('granted_by', '=', userId).execute();
      await trx.deleteFrom('capabilities').where('granted_by', '=', userId).execute();
      await trx.deleteFrom('users').where('id', '=', userId).execute();
    });
  });
}

// ────────────────────────────── 归属与身份（仅所有者） ──────────────────────────────

/** 整体替换管理归属（仅所有者）。 */
export async function setManagedBy(
  db: Db,
  ctx: RequestContext,
  userId: string,
  input: SetManagedByRequest,
  audit: UserAudit,
): Promise<UserSummaryView> {
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  return audited(db, ctx, 'user.setManagedBy', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);
    assertAuthorized(ctx, 'user.setManagedBy', { kind: 'user', target: facts });

    const managerIds = [...new Set(input.managerIds)];
    if (managerIds.includes(userId)) {
      throw new AppError('INVALID_ARGUMENT', '不能把用户指派给自己管理', {
        fields: [{ path: '/managerIds', message: '不能包含目标用户本人' }],
      });
    }
    await assertAssignableManagers(db, managerIds);

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('user_managers').where('user_id', '=', userId).execute();
      for (const managerId of managerIds) {
        await trx
          .insertInto('user_managers')
          .values({ user_id: userId, manager_user_id: managerId })
          .execute();
      }
    });
    return await readUserSummary(db, userId);
  });
}

/** 设置身份（仅所有者；不能经此接口把任何人设为 `owner`）。 */
export async function setUserIdentity(
  db: Db,
  ctx: RequestContext,
  userId: string,
  input: SetUserIdentityRequest,
  audit: UserAudit,
): Promise<UserSummaryView> {
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  return audited(db, ctx, 'user.setRole', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);
    assertAuthorized(ctx, 'user.setRole', { kind: 'user', target: facts });

    const next = input.identity as Identity;
    if (next !== 'member' && next !== 'user_admin') {
      throw new AppError('INVALID_ARGUMENT', '身份只能是 member 或 user_admin', {
        fields: [{ path: '/identity', message: '身份只能是 member 或 user_admin' }],
      });
    }

    // 任命为 user_admin 时写 user_identity（行已存在则就地更新）。
    await db
      .insertInto('user_identity')
      .values({ user_id: userId, identity: next, granted_by: ctx.userId })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({
          identity: next,
          granted_by: ctx.userId,
          granted_at: new Date(),
        }),
      )
      .execute();
    return await readUserSummary(db, userId);
  });
}

// ────────────────────────────── 查看授权（所有者 / 用户管理员） ──────────────────────────────

async function loadGrantItems(db: Db, userId: string, query: PageQuery): Promise<ListGrantsResult> {
  const page = clampPage(query.page);
  const pageSize = clampPageSize(query.pageSize);

  const [rows, totalRow] = await Promise.all([
    db
      .selectFrom('view_grants')
      .select(['target_type', 'target_id', 'granted_by', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('target_type', 'asc')
      .orderBy('target_id', 'asc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute(),
    db
      .selectFrom('view_grants')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('user_id', '=', userId)
      .executeTakeFirst(),
  ]);

  const granterIds = [...new Set(rows.map((row) => row.granted_by))];
  const granterRows =
    granterIds.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select(['id', 'display_name'])
          .where('id', 'in', granterIds)
          .execute();
  const nameById = new Map(granterRows.map((row) => [row.id, row.display_name]));

  return {
    items: rows.map((row) => ({
      targetType: row.target_type as TargetType,
      targetId: row.target_id,
      grantedByUserId: row.granted_by,
      grantedByDisplayName: nameById.get(row.granted_by) ?? DELETED_GRANTER_LABEL,
      grantedAt: row.created_at.toISOString(),
    })),
    page,
    pageSize,
    total: Number(totalRow?.total ?? 0),
  };
}

export async function listUserGrants(
  db: Db,
  ctx: RequestContext,
  userId: string,
  query: PageQuery,
  audit: UserAudit,
): Promise<ListGrantsResult> {
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  return audited(db, ctx, 'grant.view.read', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);
    assertAuthorized(ctx, 'grant.view.read', { kind: 'user', target: facts });
    return await loadGrantItems(db, userId, query);
  });
}

// ────────────────────────────── 增量授权 ──────────────────────────────

function readGrantList(value: unknown): ScopeRef[] {
  if (!Array.isArray(value)) return [];
  const out: ScopeRef[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as { targetType?: unknown; targetId?: unknown };
    if (candidate.targetType !== 'group' && candidate.targetType !== 'blueprint') continue;
    if (typeof candidate.targetId !== 'string' || candidate.targetId === '') continue;
    out.push({ targetType: candidate.targetType, targetId: candidate.targetId });
  }
  return dedupeScopes(out);
}

/**
 * 增量授予 / 撤销查看范围。
 * `add` 与 `remove` 都出现时两次判定都做（先 add 后 remove），全部通过后在同一事务里落库：
 * 撤销只删目标用户自己的那一行，添加用 `on conflict do nothing` 幂等。
 * 组 / 蓝图 id 在本期不做存在性校验（`blueprint_groups`、`blueprints` 的 M2 语义不在本期）。
 */
export async function changeUserGrants(
  db: Db,
  ctx: RequestContext,
  userId: string,
  input: UserGrantsChangeRequest,
  audit: UserAudit,
): Promise<ListGrantsResult> {
  const raw = input as { readonly add?: unknown; readonly remove?: unknown };
  const addItems = readGrantList(raw.add);
  const removeItems = readGrantList(raw.remove);
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  const actions = [
    ...(addItems.length > 0 ? ['grant.view.add'] : []),
    ...(removeItems.length > 0 ? ['grant.view.remove'] : []),
  ];

  return audited(db, ctx, actions.length > 0 ? actions : ['grant.view.add'], target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);

    if (addItems.length === 0 && removeItems.length === 0) {
      throw new AppError('INVALID_ARGUMENT', '增量授权不得为空', {
        fields: [{ path: '/', message: 'add 与 remove 不能同时为空' }],
      });
    }
    if (addItems.length > 0) {
      assertAuthorized(ctx, 'grant.view.add', { kind: 'grants', target: facts, change: addItems });
    }
    if (removeItems.length > 0) {
      assertAuthorized(ctx, 'grant.view.remove', {
        kind: 'grants',
        target: facts,
        change: removeItems,
      });
    }

    await db.transaction().execute(async (trx) => {
      for (const item of removeItems) {
        await trx
          .deleteFrom('view_grants')
          .where('user_id', '=', userId)
          .where('target_type', '=', item.targetType)
          .where('target_id', '=', item.targetId)
          .execute();
      }
      for (const item of addItems) {
        await trx
          .insertInto('view_grants')
          .values({
            id: newId('grn'),
            user_id: userId,
            target_type: item.targetType,
            target_id: item.targetId,
            granted_by: ctx.userId,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    });

    return await loadGrantItems(db, userId, { page: 1, pageSize: MAX_PAGE_SIZE });
  });
}

// ────────────────────────────── 能力（仅所有者，整体替换） ──────────────────────────────

export async function setUserCapabilities(
  db: Db,
  ctx: RequestContext,
  userId: string,
  input: SetUserCapabilitiesRequest,
  audit: UserAudit,
): Promise<CapabilityView[]> {
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  return audited(db, ctx, 'capability.set', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);

    const requested: CapabilityGrant[] = dedupeCapabilities(
      input.capabilities.map((cap) => ({
        capability: cap.capability as CapabilityName,
        targetType: cap.targetType,
        targetId: cap.targetId,
      })),
    );
    assertAuthorized(ctx, 'capability.set', { kind: 'capabilities', target: facts, requested });

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('capabilities').where('user_id', '=', userId).execute();
      for (const cap of requested) {
        await trx
          .insertInto('capabilities')
          .values({
            id: newId('cap'),
            user_id: userId,
            capability: cap.capability,
            target_type: cap.targetType,
            target_id: cap.targetId,
            granted_by: ctx.userId,
          })
          .execute();
      }
    });

    return requested.map((cap) => ({
      capability: cap.capability,
      targetType: cap.targetType,
      targetId: cap.targetId,
    }));
  });
}

// ────────────────────────────── 管辖（仅所有者，整体替换） ──────────────────────────────

/** 分组管辖视图（对齐契约 `users/jurisdiction.json`）。 */
export interface JurisdictionGroupView {
  readonly id: string;
  readonly name: string;
  readonly grantedByUserId: string;
  readonly grantedByDisplayName: string;
  readonly grantedAt: string;
}

/** 单蓝图管辖视图（对齐契约 `users/jurisdiction.json`）。 */
export interface JurisdictionBlueprintView {
  readonly id: string;
  readonly name: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly grantedByUserId: string;
  readonly grantedByDisplayName: string;
  readonly grantedAt: string;
}

export interface JurisdictionView {
  readonly groups: JurisdictionGroupView[];
  readonly blueprints: JurisdictionBlueprintView[];
}

/** `GET /api/users/:id/access` 的视图（对齐契约 `users/access.json`）。 */
export interface UserAccessView {
  /** 例外授权的原始行（不含管辖派生项）。 */
  readonly capabilities: CapabilityView[];
  /** 有效能力 = 管辖派生 ∪ 例外授权（判定依据）。 */
  readonly effectiveCapabilities: CapabilityView[];
  readonly jurisdiction: JurisdictionView;
}

const EMPTY_JURISDICTION: JurisdictionView = { groups: [], blueprints: [] };

function capabilityViews(caps: readonly CapabilityGrant[]): CapabilityView[] {
  return caps
    .map((cap) => ({
      capability: cap.capability,
      targetType: cap.targetType,
      targetId: cap.targetId,
    }))
    .sort((left, right) =>
      `${left.capability}:${left.targetType}:${left.targetId}`.localeCompare(
        `${right.capability}:${right.targetType}:${right.targetId}`,
      ),
    );
}

function capabilityGrantOfRows(
  rows: readonly { capability: string; target_type: string; target_id: string }[],
): CapabilityGrant[] {
  return dedupeCapabilities(
    rows.map((row) => ({
      capability: row.capability as CapabilityName,
      targetType: row.target_type as TargetType,
      targetId: row.target_id,
    })),
  );
}

/**
 * 读取管辖范围：原始行 + 资源名 + 划拨人。
 * `identity` 传入时会按身份过滤——管辖只对用户管理员生效，其它身份一律视为空。
 */
export async function loadJurisdictionView(
  db: Db,
  userId: string,
  identity?: Identity,
): Promise<JurisdictionView> {
  if (identity !== undefined && identity !== 'user_admin') return EMPTY_JURISDICTION;

  const [groupManagerRows, blueprintManagerRows] = await Promise.all([
    db.selectFrom('group_managers').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('blueprint_managers').selectAll().where('user_id', '=', userId).execute(),
  ]);
  if (groupManagerRows.length === 0 && blueprintManagerRows.length === 0) {
    return EMPTY_JURISDICTION;
  }

  const groupIds = [...new Set(groupManagerRows.map((row) => row.group_id))];
  const blueprintIds = [...new Set(blueprintManagerRows.map((row) => row.blueprint_id))];
  const managedBlueprints =
    blueprintIds.length === 0
      ? []
      : await db
          .selectFrom('blueprints')
          .select(['id', 'name', 'group_id'])
          .where('id', 'in', blueprintIds)
          .execute();

  // 蓝图所属分组可能不在管辖集合里，所以分组名从「管辖分组 ∪ 蓝图所属分组」一起取
  const relatedGroupIds = [
    ...new Set([...groupIds, ...managedBlueprints.map((row) => row.group_id)]),
  ];
  const relatedGroups =
    relatedGroupIds.length === 0
      ? []
      : await db
          .selectFrom('blueprint_groups')
          .select(['id', 'name'])
          .where('id', 'in', relatedGroupIds)
          .execute();
  const groupNameById = new Map(relatedGroups.map((row) => [row.id, row.name]));
  const blueprintById = new Map(managedBlueprints.map((row) => [row.id, row]));

  const granterIds = [
    ...new Set([
      ...groupManagerRows.map((row) => row.granted_by),
      ...blueprintManagerRows.map((row) => row.granted_by),
    ]),
  ];
  const granters =
    granterIds.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select(['id', 'display_name'])
          .where('id', 'in', granterIds)
          .execute();
  const granterNameById = new Map(granters.map((row) => [row.id, row.display_name]));

  return {
    groups: groupManagerRows
      .map((row) => ({
        id: row.group_id,
        name: groupNameById.get(row.group_id) ?? '（未知分组）',
        grantedByUserId: row.granted_by,
        grantedByDisplayName: granterNameById.get(row.granted_by) ?? DELETED_GRANTER_LABEL,
        grantedAt: row.created_at.toISOString(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN')),
    blueprints: blueprintManagerRows
      .map((row) => {
        const blueprint = blueprintById.get(row.blueprint_id);
        return {
          id: row.blueprint_id,
          name: blueprint?.name ?? '（未知蓝图）',
          groupId: blueprint?.group_id ?? '',
          groupName: groupNameById.get(blueprint?.group_id ?? '') ?? '（未知分组）',
          grantedByUserId: row.granted_by,
          grantedByDisplayName: granterNameById.get(row.granted_by) ?? DELETED_GRANTER_LABEL,
          grantedAt: row.created_at.toISOString(),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN')),
  };
}

/** 某位用户的完整写权限视图：例外授权、有效能力、管辖范围（仅所有者）。 */
export async function getUserAccess(
  db: Db,
  ctx: RequestContext,
  userId: string,
  audit: UserAudit,
): Promise<UserAccessView> {
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  return audited(db, ctx, 'jurisdiction.read', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);
    assertAuthorized(ctx, 'jurisdiction.read', { kind: 'jurisdiction', target: facts });

    const [capabilityRows, jurisdiction] = await Promise.all([
      db.selectFrom('capabilities').selectAll().where('user_id', '=', userId).execute(),
      loadJurisdictionView(db, userId, facts.identity),
    ]);
    const granted = capabilityGrantOfRows(capabilityRows);
    return {
      capabilities: capabilityViews(granted),
      effectiveCapabilities: capabilityViews(
        effectiveCapabilities(granted, {
          groupIds: jurisdiction.groups.map((group) => group.id),
          blueprintIds: jurisdiction.blueprints.map((blueprint) => blueprint.id),
        }),
      ),
      jurisdiction,
    };
  });
}

/**
 * 整体替换某位用户管理员的管辖范围（仅所有者）。
 *
 * 纪律：
 * - 管辖只对 `user_admin` 生效（策略层拦住其它身份），避免把「地盘」发给普通用户；
 * - 目标必须真实存在：填错 id 直接 `INVALID_ARGUMENT`，不静默落一条悬空管辖；
 * - 删旧插新同一事务，失败整体回滚；
 * - 这里**不**顺带写 `view_grants`：管辖只带来写权与可见，可委派范围仍由所有者显式给查看授权（§2.3）。
 */
export async function setUserJurisdiction(
  db: Db,
  ctx: RequestContext,
  userId: string,
  input: SetUserJurisdictionRequest,
  audit: UserAudit,
): Promise<JurisdictionView> {
  const target: AuditTarget = { targetType: 'user', targetId: userId };
  return audited(db, ctx, 'jurisdiction.set', target, audit, async () => {
    assertAuthorized(ctx, 'user.list');
    const facts = await requireUserFacts(db, userId);

    const groupIds = [...new Set(input.groupIds)].sort();
    const blueprintIds = [...new Set(input.blueprintIds)].sort();
    assertAuthorized(ctx, 'jurisdiction.set', {
      kind: 'jurisdiction',
      target: facts,
      requested: { groupIds, blueprintIds },
    });

    const [knownGroups, knownBlueprints] = await Promise.all([
      groupIds.length === 0
        ? []
        : db.selectFrom('blueprint_groups').select('id').where('id', 'in', groupIds).execute(),
      blueprintIds.length === 0
        ? []
        : db.selectFrom('blueprints').select('id').where('id', 'in', blueprintIds).execute(),
    ]);
    const knownGroupIds = new Set(knownGroups.map((row) => row.id));
    const knownBlueprintIds = new Set(knownBlueprints.map((row) => row.id));
    const missingGroups = groupIds.filter((id) => !knownGroupIds.has(id));
    const missingBlueprints = blueprintIds.filter((id) => !knownBlueprintIds.has(id));
    if (missingGroups.length > 0 || missingBlueprints.length > 0) {
      throw new AppError('INVALID_ARGUMENT', '管辖目标不存在', {
        fields: [
          ...missingGroups.map((id) => ({ path: '/groupIds', message: `分组不存在：${id}` })),
          ...missingBlueprints.map((id) => ({
            path: '/blueprintIds',
            message: `蓝图不存在：${id}`,
          })),
        ],
        missingGroups,
        missingBlueprints,
      });
    }

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('group_managers').where('user_id', '=', userId).execute();
      await trx.deleteFrom('blueprint_managers').where('user_id', '=', userId).execute();
      for (const groupId of groupIds) {
        await trx
          .insertInto('group_managers')
          .values({ group_id: groupId, user_id: userId, granted_by: ctx.userId })
          .execute();
      }
      for (const blueprintId of blueprintIds) {
        await trx
          .insertInto('blueprint_managers')
          .values({ blueprint_id: blueprintId, user_id: userId, granted_by: ctx.userId })
          .execute();
      }
    });

    return await loadJurisdictionView(db, userId);
  });
}
