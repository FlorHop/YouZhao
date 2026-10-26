/**
 * 权限策略——**唯一判定入口**（docs/architecture-design.md §3.5）。
 *
 * 纪律：
 * 1. 路由层与用例层**不得**自己写 if 判断权限；一律先调 `authorize()`（或 `assertAuthorized()`）。
 * 2. 判定只依赖 `RequestContext` 与调用方传入的资源事实，**不在策略里查库**，便于参数化测试。
 * 3. 拒绝原因（`details.reason`）不得泄露「目标资源是否存在」，避免探测。
 *
 * 明确裁决（写在设计文档之外的两条实现约定，需回写到 §3.5）：
 * - **所有者隐式拥有全部业务能力**：身份 `owner` 视为在所有资源上持有 `blueprint.manage` 与
 *   `blueprint.publish`，因此无需在 `capabilities` 里给自己授权（否则平台无法自举）。
 * - **`member` 使用 `/api/users/*` 一律 `FORBIDDEN`**（不变量 10 命名空间隔离），
 *   而「同级/上级」冲突用 `PEER_MANAGE_DENIED`、越界用 `OUT_OF_MANAGED_SCOPE`。
 * - **管辖不是权限，是地盘**：`group_managers` / `blueprint_managers` 由所有者划给用户管理员，
 *   派生出的业务能力在 `context.ts` 折算进 `ctx.capabilities`，策略层照旧只看能力与范围，
 *   不区分「能力来自管辖还是例外授权」。
 */
import { AppError } from './errors.js';
import {
  allow,
  deny,
  type Action,
  type CapabilityName,
  type Decision,
  type RequestContext,
  type Resource,
  type TokenScope,
  type UserFacts,
} from './entities.js';
import {
  hasAnyCapability,
  isCapabilityCovered,
  isScopeSubset,
  type ResourceLike,
} from './scopes.js';

const NO_USER_FACTS = '策略调用缺少目标用户事实（实现错误）';

/**
 * MCP 工具动作 → 所需 Token scope（docs/architecture-design.md §4.5）。
 * 不在表里的动作对 Token 一律拒绝：Token 只能走 MCP 工具集，不能调账号/授权接口。
 */
const TOKEN_TOOL_SCOPES: Partial<Record<Action, TokenScope>> = {
  'blueprint.create': 'publish:blueprint',
  'version.publish': 'publish:blueprint',
  'version.cover': 'publish:blueprint',
  'version.archive': 'publish:blueprint',
  'group.create': 'publish:blueprint',
};

/**
 * 读取类 MCP 工具的 scope 闸门：这类工具不做能力判定（可见范围在用例里按 `view_grants` 过滤），
 * 但仍必须持有 `read:blueprint`。浏览器会话（`actorType !== 'token'`）不受 Token scope 限制。
 */
export function assertToolScope(ctx: RequestContext, scope: TokenScope): void {
  if (ctx.actorType !== 'token') return;
  if (!ctx.tokenScopes?.includes(scope)) {
    throw new AppError('SCOPE_DENIED', `Token 缺少 ${scope} scope`);
  }
}

export function authorize(
  ctx: RequestContext,
  action: Action,
  resource: Resource = { kind: 'none' },
): Decision {
  if (ctx.actorType === 'token') {
    const scope = TOKEN_TOOL_SCOPES[action];
    if (scope === undefined) return deny('FORBIDDEN', 'MCP Token 只能调用 MCP 工具接口');
    if (!ctx.tokenScopes?.includes(scope)) {
      return deny('SCOPE_DENIED', `Token 缺少 ${scope} scope`);
    }
  }
  return judge(ctx, action, resource);
}

function judge(
  ctx: RequestContext,
  action: Action,
  resource: Resource = { kind: 'none' },
): Decision {
  switch (action) {
    // ── 账号管理（不变量 10：member 整体拒绝） ────────────────────────────────
    case 'user.list':
      return ctx.identity === 'owner' || ctx.identity === 'user_admin'
        ? allow()
        : deny('FORBIDDEN', '普通用户不能使用用户管理接口');
    case 'user.read':
    case 'user.update':
    case 'user.resetPassword':
    case 'user.disable':
    case 'user.enable':
    case 'user.delete': {
      if (resource.kind !== 'user') return deny('INTERNAL_ERROR', NO_USER_FACTS);
      return administerUser(ctx, action, resource.target);
    }
    case 'user.create': {
      if (resource.kind !== 'userCreate') return deny('INTERNAL_ERROR', '策略调用缺少创建参数');
      return createUser(ctx, resource.requestedIdentity, resource.requestedManagerIds);
    }
    // ── 身份、归属、能力：仅所有者（不变量 2、5、6） ─────────────────────────
    case 'user.setRole':
    case 'user.setManagedBy':
    case 'capability.set': {
      if (ctx.identity !== 'owner') return deny('FORBIDDEN', '仅平台所有者可执行该操作');
      const target = userTargetOf(resource);
      if (target === null) return deny('INTERNAL_ERROR', NO_USER_FACTS);
      if (target.identity === 'owner') return deny('OWNER_PROTECTED', '平台所有者不可被修改');
      if (target.id === ctx.userId) return deny('SELF_MANAGE_DENIED', '不能修改自己的身份或归属');
      return allow();
    }
    // ── 管辖：管理员的地盘，仅所有者可读写（docs/permission-design.md §2.3） ──────
    case 'jurisdiction.read': {
      if (ctx.identity !== 'owner') return deny('FORBIDDEN', '只有平台所有者可以查看管辖范围');
      if (userTargetOf(resource) === null) return deny('INTERNAL_ERROR', NO_USER_FACTS);
      return allow();
    }
    case 'jurisdiction.set': {
      if (ctx.identity !== 'owner') return deny('FORBIDDEN', '只有平台所有者可以设置管辖范围');
      const target = userTargetOf(resource);
      if (target === null) return deny('INTERNAL_ERROR', NO_USER_FACTS);
      // 管辖只对用户管理员有意义：所有者隐式全权，普通用户的写权走「业务能力」例外授权。
      if (target.identity !== 'user_admin') {
        return deny(
          'INVALID_ARGUMENT',
          '管辖只对用户管理员生效：所有者隐式全权，普通用户请使用业务能力授权',
        );
      }
      return allow();
    }
    // ── 查看授权：所有者，或用户管理员在可委派范围内（不变量 3、4、7、12） ──
    case 'grant.view.read': {
      if (resource.kind !== 'user') return deny('INTERNAL_ERROR', NO_USER_FACTS);
      return administerUser(ctx, action, resource.target);
    }
    case 'grant.view.add':
    case 'grant.view.remove': {
      if (resource.kind !== 'grants') return deny('INTERNAL_ERROR', NO_USER_FACTS);
      const gate = administerUser(ctx, action, resource.target);
      if (!gate.allow) return gate;
      if (resource.change.length === 0) return deny('INVALID_ARGUMENT', '增量授权不得为空');
      if (ctx.identity === 'owner') return allow();
      // 用户管理员：只能在可委派范围（= 本人查看范围，S1）内增删
      if (!isScopeSubset(resource.change, ctx.delegableScope)) {
        return action === 'grant.view.add'
          ? deny('DELEGATION_EXCEEDED', '授权目标超出你的可委派范围')
          : deny('OUT_OF_MANAGED_SCOPE', '不能撤销超出你可委派范围的授权');
      }
      return allow();
    }
    // ── 本人自助（/api/me/*）：命名空间由路由层保证 ──────────────────────────
    case 'me.update':
    case 'me.password':
      return ctx.identity === 'member' || ctx.identity === 'user_admin' || ctx.identity === 'owner'
        ? allow()
        : deny('FORBIDDEN', '未知身份');
    // ── MCP Token（S2、S3） ────────────────────────────────────────────────
    case 'token.list':
      return allow(); // 可见范围由用例裁剪：所有者看全部，其他人只看自己的
    case 'token.create': {
      if (resource.kind !== 'token') return deny('INTERNAL_ERROR', '策略调用缺少 Token 绑定信息');
      const forSelf = resource.boundUserId === ctx.userId;
      if (!forSelf && ctx.identity !== 'owner') {
        return deny('FORBIDDEN', '只能为自己创建 Token；为他人创建需要平台所有者');
      }
      const allowedScopes = allowedTokenScopes(ctx);
      const requested = resource.scopes;
      if (requested.length === 0) return deny('INVALID_ARGUMENT', 'Token 至少要有一个 scope');
      if (!requested.every((scope) => allowedScopes.includes(scope))) {
        return deny('SCOPE_DENIED', 'Token scope 超出你自身具备的能力');
      }
      return allow();
    }
    case 'token.disable':
    case 'token.delete':
    case 'token.verify': {
      if (resource.kind !== 'token') return deny('INTERNAL_ERROR', '策略调用缺少 Token 信息');
      if (ctx.identity === 'owner') return allow();
      if (resource.boundUserId === ctx.userId || resource.createdByUserId === ctx.userId) {
        return allow();
      }
      return deny('FORBIDDEN', '只能操作自己创建或被绑定到你名下的 Token');
    }
    // ── 分组：改既有分组要覆盖它；建新分组只有所有者（§2.3）────────────────
    case 'group.create':
      // 建组 = 划一块新地盘。管辖是所有者给定的边界，不能自己往前延伸：
      // 否则「管辖一个组」就能推出「可以无限建组并自动带发版权」（自我扩张）。
      // 管理员需要新分组时向所有者申请；所有者建组后用管辖把组交给他。
      return ctx.identity === 'owner'
        ? allow()
        : deny('FORBIDDEN', '只有平台所有者可以新建分组');
    case 'group.archive':
    case 'group.restore':
    case 'group.reorder':
      return requireCapability(ctx, 'blueprint.manage', resource);
    // ── 蓝图与版本 ─────────────────────────────────────────────────────────
    case 'blueprint.create':
      // 创建并发布首个版本 → 需要目标分组上的 blueprint.publish
      return requireCapability(ctx, 'blueprint.publish', resource);
    case 'blueprint.update':
    case 'blueprint.archive':
    case 'blueprint.restore':
    case 'version.cover':
    case 'version.archive':
    case 'version.restore':
      return requireCapability(ctx, 'blueprint.manage', resource);
    case 'blueprint.move': {
      // 不变量 8：资源移动视为授权变更，源与目标都要有 blueprint.manage
      if (resource.kind !== 'blueprintMove') return deny('INTERNAL_ERROR', '策略调用缺少移动参数');
      const from = requireCapability(ctx, 'blueprint.manage', {
        kind: 'blueprint',
        blueprintId: resource.blueprintId,
        groupId: resource.fromGroupId,
      });
      if (!from.allow) return from;
      return requireCapability(ctx, 'blueprint.manage', {
        kind: 'group',
        groupId: resource.toGroupId,
      });
    }
    case 'version.publish':
      return requireCapability(ctx, 'blueprint.publish', resource);
    default: {
      const unreachable: never = action;
      return deny('INTERNAL_ERROR', `未实现的动作：${String(unreachable)}`);
    }
  }
}

/** 授权失败即抛 `AppError`，供用例层使用；成功返回 `void`。 */
export function assertAuthorized(
  ctx: RequestContext,
  action: Action,
  resource: Resource = { kind: 'none' },
): void {
  const decision = authorize(ctx, action, resource);
  if (!decision.allow) {
    throw new AppError(decision.code, undefined, { reason: decision.reason });
  }
}

// ── 内部实现 ───────────────────────────────────────────────────────────────

/** 所有者隐式持有全部能力；其余按能力资源匹配（不变量 6）。 */
function requireCapability(
  ctx: RequestContext,
  capability: CapabilityName,
  resource: Resource,
): Decision {
  if (ctx.identity === 'owner') return allow();
  const target = resourceLikeOf(resource);
  if (target === null) return deny('CAPABILITY_REQUIRED', '该操作需要指定资源范围');
  if (isCapabilityCovered(ctx.capabilities, capability, target)) return allow();
  return deny('CAPABILITY_REQUIRED', `缺少覆盖该资源的 ${capability}`);
}

function resourceLikeOf(resource: Resource): ResourceLike | null {
  switch (resource.kind) {
    case 'group':
      return { kind: 'group', id: resource.groupId };
    case 'blueprint':
      return { kind: 'blueprint', id: resource.blueprintId, groupId: resource.groupId };
    case 'blueprintMove':
      return { kind: 'blueprint', id: resource.blueprintId, groupId: resource.toGroupId };
    default:
      return null;
  }
}

function userTargetOf(resource: Resource): UserFacts | null {
  return 'target' in resource ? resource.target : null;
}

/**
 * 用户管理员与所有者的分工（不变量 3、5、12）：
 * - 目标是自己 → `SELF_MANAGE_DENIED`（本人资料走 `/api/me/*`，避免侧门）。
 * - 所有者：可管理任何非所有者用户。
 * - 用户管理员：只能管理**身份为 member 且在自己名下**的用户；只能停用，不能删除。
 * - 普通用户：`FORBIDDEN`（命名空间隔离）。
 */
function administerUser(ctx: RequestContext, action: Action, target: UserFacts): Decision {
  if (target.identity === 'owner') {
    return deny('OWNER_PROTECTED', '平台所有者不可被修改');
  }
  if (target.id === ctx.userId) {
    return deny('SELF_MANAGE_DENIED', '本人资料请使用「我的账号」');
  }
  if (ctx.identity === 'owner') {
    return allow();
  }
  if (ctx.identity === 'user_admin') {
    if (target.identity !== 'member') return deny('PEER_MANAGE_DENIED', '只能管理普通用户');
    if (!ctx.managedUserIds.includes(target.id)) {
      return deny('OUT_OF_MANAGED_SCOPE', '目标用户不在你管理的用户中');
    }
    if (action === 'user.delete') {
      return deny('PEER_MANAGE_DENIED', '用户管理员只能停用用户，不能删除');
    }
    return allow();
  }
  return deny('FORBIDDEN', '普通用户不能使用用户管理接口');
}

/** 建号规则：所有者可指定身份与归属；用户管理员只能建 member 且自动归自己。 */
function createUser(
  ctx: RequestContext,
  requestedIdentity: UserFacts['identity'],
  requestedManagerIds: readonly string[],
): Decision {
  if (ctx.identity === 'owner') return allow();
  if (ctx.identity === 'user_admin') {
    if (requestedIdentity !== 'member') return deny('PEER_MANAGE_DENIED', '只能创建普通用户');
    const onlySelf =
      requestedManagerIds.length === 0 ||
      (requestedManagerIds.length === 1 && requestedManagerIds[0] === ctx.userId);
    if (!onlySelf) return deny('OUT_OF_MANAGED_SCOPE', '只能把自己管理范围内的人指派给自己');
    return allow();
  }
  return deny('FORBIDDEN', '普通用户不能创建用户');
}

/** 自建 Token 的 scope 上限（S2/S3）：只读人人可建；发布需自身具备 blueprint.publish。 */
function allowedTokenScopes(ctx: RequestContext): readonly string[] {
  if (ctx.identity === 'owner') return ['read:blueprint', 'publish:blueprint'];
  return hasAnyCapability(ctx.capabilities, 'blueprint.publish')
    ? ['read:blueprint', 'publish:blueprint']
    : ['read:blueprint'];
}
