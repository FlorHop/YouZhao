/**
 * 领域形状与请求上下文（docs/architecture-design.md §3.3、§3.5）。
 *
 * 这里只放**权限判定所需的事实**：身份、范围、能力、操作者是谁。
 * 数据库行的完整映射在 `server/db/types.ts`——两者刻意分开，领域层不依赖 Kysely。
 */
import type { ErrorCode } from './errors.js';
import type { ScopedTarget } from './scopes.js';

/** 互斥身份（不变量 1）：一人只有一个。 */
export type Identity = 'owner' | 'user_admin' | 'member';
export type UserStatus = 'active' | 'disabled';

/** 授权目标类型：分组（覆盖组内全部蓝图）或单个蓝图。 */
export type TargetType = 'group' | 'blueprint';

/** 业务能力（与身份正交，S4）；每项必须带资源范围（不变量 6）。 */
export type CapabilityName = 'blueprint.manage' | 'blueprint.publish';

/** MCP Token 的 scope；最终能力 = 绑定用户能力 ∩ scope（S3）。 */
export type TokenScope = 'read:blueprint' | 'publish:blueprint';

export interface ScopeRef {
  readonly targetType: TargetType;
  readonly targetId: string;
}

export interface CapabilityGrant {
  readonly capability: CapabilityName;
  readonly targetType: TargetType;
  readonly targetId: string;
}

/** 判定「用户类动作」时必须知道的目标事实。 */
export interface UserFacts {
  readonly id: string;
  readonly identity: Identity;
  readonly status: UserStatus;
  /** 管理该用户的用户管理员集合（`user_managers` 中的行），可多位（不变量 12）。 */
  readonly managedByUserIds: readonly string[];
}

/**
 * 一次请求的授权上下文：浏览器会话、MCP Token 或系统任务都能产出它。
 * 只读，避免策略层意外修改上下文。
 */
export interface RequestContext {
  readonly actorType: 'user' | 'token' | 'system';
  /** 操作者本人；Token 场景下是**绑定用户**。 */
  readonly userId: string;
  readonly identity: Identity;
  /** 我管理的用户（`user_managers.manager_user_id = 我`）。 */
  readonly managedUserIds: readonly string[];
  /** 有效查看范围（`view_grants`）。 */
  readonly viewScope: readonly ScopeRef[];
  /** 可委派范围；S1 裁决：等于本人的查看范围。 */
  readonly delegableScope: readonly ScopeRef[];
  readonly capabilities: readonly CapabilityGrant[];
  /** MCP Token 的 scope；浏览器会话为 `null`。 */
  readonly tokenScopes: readonly TokenScope[] | null;
}

export type Action =
  // 账号管理（/api/users/*，member 一律拒绝，不变量 10）
  | 'user.list'
  | 'user.read'
  | 'user.create'
  | 'user.update'
  | 'user.resetPassword'
  | 'user.disable'
  | 'user.enable'
  | 'user.delete'
  | 'user.setRole'
  | 'user.setManagedBy'
  // 授权与能力
  | 'grant.view.read'
  | 'grant.view.add'
  | 'grant.view.remove'
  | 'capability.set'
  // 本人自助（/api/me/*）
  | 'me.update'
  | 'me.password'
  // MCP Token（M3）
  | 'token.list'
  | 'token.create'
  | 'token.disable'
  | 'token.delete'
  // 分组与蓝图
  | 'group.create'
  | 'group.archive'
  | 'group.restore'
  | 'group.reorder'
  | 'blueprint.create'
  | 'blueprint.update'
  | 'blueprint.archive'
  | 'blueprint.restore'
  | 'blueprint.move'
  | 'version.publish'
  | 'version.cover'
  | 'version.archive'
  | 'version.restore';

/** 判定所需资源事实；不需要资源时传 `{ kind: 'none' }`。 */
export type Resource =
  | { readonly kind: 'none' }
  | { readonly kind: 'user'; readonly target: UserFacts }
  | {
      readonly kind: 'userCreate';
      readonly requestedIdentity: Identity;
      readonly requestedManagerIds: readonly string[];
    }
  | {
      readonly kind: 'grants';
      readonly target: UserFacts;
      /** 本次增量涉及的授权目标；蓝图目标需带 `groupId` 才能判定是否落在可委派范围内。 */
      readonly change: readonly ScopedTarget[];
    }
  | {
      readonly kind: 'capabilities';
      readonly target: UserFacts;
      readonly requested: readonly CapabilityGrant[];
    }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'blueprint'; readonly blueprintId: string; readonly groupId: string }
  | {
      readonly kind: 'blueprintMove';
      readonly blueprintId: string;
      readonly fromGroupId: string;
      readonly toGroupId: string;
    }
  | {
      readonly kind: 'token';
      readonly boundUserId: string;
      readonly createdByUserId: string;
      readonly scopes: readonly TokenScope[];
    };

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly code: ErrorCode; readonly reason: string };

export function allow(): Decision {
  return { allow: true };
}

export function deny(code: ErrorCode, reason: string): Decision {
  return { allow: false, code, reason };
}

export function isOwner(ctx: RequestContext): boolean {
  return ctx.identity === 'owner';
}
