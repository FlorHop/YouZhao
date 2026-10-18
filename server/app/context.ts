/**
 * 从数据库装载一次请求的授权上下文（`RequestContext`）。
 *
 * 这是「数据库事实 → 策略输入」的**唯一**转换点：HTTP 层、用例层、将来的 MCP 层
 * 都调用它，因此权限判定永远基于同一份事实，不会出现两套范围算法。
 *
 * 纪律：
 * - 用户不存在或已停用 → 抛 `UNAUTHENTICATED`（失败关闭：宁可当作未登录，也不给一个空权限的幽灵身份）。
 * - 身份缺失（没有 `user_identity` 行）→ 按最小权限 `member` 处理，不隐式提权。
 * - 结果一律去重、排序，保证同一份数据每次产出同一个上下文（便于比对与测试）。
 */
import type {
  CapabilityGrant,
  Identity,
  RequestContext,
  ScopeRef,
  TargetType,
  TokenScope,
  UserFacts,
  UserStatus,
} from '../domain/entities.js';
import { AppError } from '../domain/errors.js';
import { dedupeCapabilities, dedupeScopes, delegableScope } from '../domain/scopes.js';
import type { CapabilityRow, Db, UserRow, ViewGrantRow } from '../db/types.js';

export interface UserAuthz {
  readonly user: UserRow;
  readonly facts: UserFacts;
  readonly grants: readonly ViewGrantRow[];
  readonly capabilities: readonly CapabilityRow[];
}

/** 读取用户本身、身份、管理归属、查看授权与业务能力；用户不存在/已停用返回 `null`。 */
export async function loadUserAuthz(db: Db, userId: string): Promise<UserAuthz | null> {
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user === undefined || user.status !== 'active') return null;

  const [identityRow, managerRows, grants, capabilities] = await Promise.all([
    db
      .selectFrom('user_identity')
      .select(['identity'])
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('user_managers')
      .select(['manager_user_id'])
      .where('user_id', '=', userId)
      .execute(),
    db.selectFrom('view_grants').selectAll().where('user_id', '=', userId).execute(),
    db.selectFrom('capabilities').selectAll().where('user_id', '=', userId).execute(),
  ]);

  const facts: UserFacts = {
    id: user.id,
    // 没有身份行属于数据异常：按最小权限当作 member，绝不隐式提权
    identity: (identityRow?.identity ?? 'member') as Identity,
    status: user.status as UserStatus,
    managedByUserIds: managerRows.map((row) => row.manager_user_id).sort(),
  };

  return { user, facts, grants, capabilities };
}

export function viewScopeOf(grants: readonly ViewGrantRow[]): ScopeRef[] {
  return dedupeScopes(
    grants.map((grant) => ({
      targetType: grant.target_type as TargetType,
      targetId: grant.target_id,
    })),
  );
}

export function capabilitiesOf(rows: readonly CapabilityRow[]): CapabilityGrant[] {
  return dedupeCapabilities(
    rows.map((row) => ({
      capability: row.capability as CapabilityGrant['capability'],
      targetType: row.target_type as TargetType,
      targetId: row.target_id,
    })),
  );
}

/** 「我管理的用户」：`user_managers` 里 manager 是我的那些行。 */
export async function loadManagedUserIds(db: Db, managerUserId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('user_managers')
    .select(['user_id'])
    .where('manager_user_id', '=', managerUserId)
    .execute();
  return rows.map((row) => row.user_id).sort();
}

export interface ContextOverrides {
  /** 默认 `'user'`（浏览器会话）。 */
  readonly actorType?: RequestContext['actorType'];
  /** MCP Token 的 scope；浏览器会话为 `null`。 */
  readonly tokenScopes?: readonly TokenScope[] | null;
}

/**
 * 构造请求上下文。用户不存在或已停用一律 `UNAUTHENTICATED`——
 * 这样「停用用户」无需逐个吊销会话：下一次请求就进不来。
 */
export async function buildUserContext(
  db: Db,
  userId: string,
  overrides: ContextOverrides = {},
): Promise<RequestContext> {
  const authz = await loadUserAuthz(db, userId);
  if (authz === null) throw new AppError('UNAUTHENTICATED');

  const viewScope = viewScopeOf(authz.grants);
  return {
    actorType: overrides.actorType ?? 'user',
    userId: authz.user.id,
    identity: authz.facts.identity,
    // 方向是「我管谁」而非「谁管我」：user_managers 里 manager 是我的那些行（D6 修复）。
    managedUserIds: await loadManagedUserIds(db, authz.user.id),
    viewScope,
    // S1 裁决：用户管理员的可委派范围等于其本人查看范围
    delegableScope: delegableScope(authz.facts.identity, viewScope),
    capabilities: capabilitiesOf(authz.capabilities),
    tokenScopes: overrides.tokenScopes ?? null,
  };
}
