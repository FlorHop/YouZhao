/**
 * 权限矩阵参数化测试（M1 验收：矩阵全绿 + 十二条不变量各有失败用例）。
 *
 * 这里只测策略层 `authorize()`——它不查库，因此用例是确定性的。
 * 不变量 1（身份互斥）与 2（所有者唯一）的结构性保证分别在
 * `db/migrations/0002_identity.sql` 的单行主键与 owner 部分唯一索引上，
 * 由 `test/identity-db.test.ts` 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../domain/policy.js';
import type {
  Action,
  CapabilityGrant,
  RequestContext,
  Resource,
  ScopeRef,
  UserFacts,
} from '../domain/entities.js';
import type { ErrorCode } from '../domain/errors.js';

const GROUPS = { g1: 'grp_g1', g2: 'grp_g2', g3: 'grp_g3' } as const;
const BP = { b1: 'bp_1', b2: 'bp_2' } as const;

function scope(targetType: 'group' | 'blueprint', targetId: string): ScopeRef {
  return { targetType, targetId };
}

function cap(
  capability: 'blueprint.manage' | 'blueprint.publish',
  targetType: 'group' | 'blueprint',
  targetId: string,
): CapabilityGrant {
  return { capability, targetType, targetId };
}

interface CtxOptions {
  readonly identity?: RequestContext['identity'];
  readonly userId?: string;
  readonly managedUserIds?: readonly string[];
  readonly viewScope?: readonly ScopeRef[];
  readonly capabilities?: readonly CapabilityGrant[];
  readonly actorType?: RequestContext['actorType'];
  readonly tokenScopes?: readonly ('read:blueprint' | 'publish:blueprint')[] | null;
}

function makeCtx(options: CtxOptions = {}): RequestContext {
  const identity = options.identity ?? 'member';
  const viewScope = options.viewScope ?? [];
  return {
    actorType: options.actorType ?? 'user',
    userId: options.userId ?? 'usr_self',
    identity,
    managedUserIds: options.managedUserIds ?? [],
    viewScope,
    // S1：用户管理员的可委派范围等于其查看范围
    delegableScope: identity === 'user_admin' ? viewScope : [],
    capabilities: options.capabilities ?? [],
    tokenScopes: options.tokenScopes ?? null,
  };
}

/** 只有用户事实（策略判定的输入）。 */
function facts(
  id: string,
  identity: RequestContext['identity'],
  managedByUserIds: readonly string[] = [],
): UserFacts {
  return { id, identity, status: 'active', managedByUserIds };
}

/** 用户类动作的资源包装。 */
function asUser(target: UserFacts): Resource {
  return { kind: 'user', target };
}

const ownerCtx = makeCtx({ identity: 'owner', userId: 'usr_owner' });
/** 用户管理员 A1：管理 m1、m2；自身查看范围是 g1 与 b1。 */
const adminCtx = makeCtx({
  identity: 'user_admin',
  userId: 'usr_a1',
  managedUserIds: ['usr_m1', 'usr_m2'],
  viewScope: [scope('group', GROUPS.g1), scope('blueprint', BP.b1)],
});
/** 另一位用户管理员，同时管理 m1（不变量 12）。 */
const admin2Ctx = makeCtx({
  identity: 'user_admin',
  userId: 'usr_a2',
  managedUserIds: ['usr_m1'],
  viewScope: [scope('group', GROUPS.g2)],
});
const memberCtx = makeCtx({
  identity: 'member',
  userId: 'usr_m1',
  viewScope: [scope('group', GROUPS.g1)],
});
/** 持有 g1 上 blueprint.manage 的普通用户。 */
const managerCtx = makeCtx({
  identity: 'member',
  userId: 'usr_m3',
  capabilities: [cap('blueprint.manage', 'group', GROUPS.g1)],
});

const m1 = facts('usr_m1', 'member', ['usr_a1', 'usr_a2']);
const m9 = facts('usr_m9', 'member', ['usr_a3']);
const otherAdmin = facts('usr_a3', 'user_admin');
const ownerFacts = facts('usr_owner', 'owner');

interface Case {
  readonly name: string;
  readonly ctx: RequestContext;
  readonly action: Action;
  readonly resource?: Resource;
  /** 期望允许；否则给期望错误码。 */
  readonly allow?: boolean;
  readonly code?: ErrorCode;
}

const cases: readonly Case[] = [
  // ── 账号管理：所有者 ────────────────────────────────────────────────────
  { name: '所有者可读用户列表', ctx: ownerCtx, action: 'user.list', allow: true },
  { name: '所有者可改他人资料', ctx: ownerCtx, action: 'user.update', resource: asUser(m1), allow: true },
  { name: '所有者可重置他人密码', ctx: ownerCtx, action: 'user.resetPassword', resource: asUser(m1), allow: true },
  { name: '所有者可停用他人', ctx: ownerCtx, action: 'user.disable', resource: asUser(m1), allow: true },
  { name: '所有者可删除用户', ctx: ownerCtx, action: 'user.delete', resource: asUser(m1), allow: true },
  { name: '所有者可改派归属', ctx: ownerCtx, action: 'user.setManagedBy', resource: asUser(m1), allow: true },
  { name: '所有者可任命用户管理员', ctx: ownerCtx, action: 'user.setRole', resource: asUser(m1), allow: true },
  { name: '所有者可设置业务能力', ctx: ownerCtx, action: 'capability.set', resource: asUser(m1), allow: true },
  { name: '不变量2：所有者不可被修改', ctx: ownerCtx, action: 'user.update', resource: asUser(ownerFacts), code: 'OWNER_PROTECTED' },
  { name: '不变量2：所有者不可被改派', ctx: ownerCtx, action: 'user.setManagedBy', resource: asUser(ownerFacts), code: 'OWNER_PROTECTED' },
  { name: '不变量5：A 不能提升自己为管理员', ctx: adminCtx, action: 'user.setRole', resource: asUser(facts('usr_a1', 'user_admin')), code: 'FORBIDDEN' },

  // ── 账号管理：用户管理员 ────────────────────────────────────────────────
  { name: 'A 可读用户列表', ctx: adminCtx, action: 'user.list', allow: true },
  { name: 'A 可改名下成员资料', ctx: adminCtx, action: 'user.update', resource: asUser(m1), allow: true },
  { name: '不变量12：多头归属下另一位 A 也能改', ctx: admin2Ctx, action: 'user.update', resource: asUser(m1), allow: true },
  { name: '不变量12：A 不能改派', ctx: adminCtx, action: 'user.setManagedBy', resource: asUser(m1), code: 'FORBIDDEN' },
  { name: '不变量12：A 不能删除（只能停用）', ctx: adminCtx, action: 'user.delete', resource: asUser(m1), code: 'PEER_MANAGE_DENIED' },
  { name: '不变量3：A 不能管别人的成员', ctx: adminCtx, action: 'user.update', resource: asUser(m9), code: 'OUT_OF_MANAGED_SCOPE' },
  { name: '不变量3：A 不能管同级管理员', ctx: adminCtx, action: 'user.update', resource: asUser(otherAdmin), code: 'PEER_MANAGE_DENIED' },
  { name: '不变量3：A 不能管自己（走我的账号）', ctx: adminCtx, action: 'user.update', resource: asUser(facts('usr_a1', 'user_admin')), code: 'SELF_MANAGE_DENIED' },
  { name: 'A 不能任命管理员', ctx: adminCtx, action: 'user.setRole', resource: asUser(m1), code: 'FORBIDDEN' },
  { name: 'A 不能设置业务能力', ctx: adminCtx, action: 'capability.set', resource: asUser(m1), code: 'FORBIDDEN' },
  { name: 'A 不能创建管理员', ctx: adminCtx, action: 'user.create', resource: { kind: 'userCreate', requestedIdentity: 'user_admin', requestedManagerIds: [] }, code: 'PEER_MANAGE_DENIED' },
  { name: 'A 建号自动归自己', ctx: adminCtx, action: 'user.create', resource: { kind: 'userCreate', requestedIdentity: 'member', requestedManagerIds: ['usr_a1'] }, allow: true },
  { name: 'A 建号不能挂到别人名下', ctx: adminCtx, action: 'user.create', resource: { kind: 'userCreate', requestedIdentity: 'member', requestedManagerIds: ['usr_a3'] }, code: 'OUT_OF_MANAGED_SCOPE' },
  { name: '所有者建号可指定身份与归属', ctx: ownerCtx, action: 'user.create', resource: { kind: 'userCreate', requestedIdentity: 'user_admin', requestedManagerIds: [] }, allow: true },

  // ── 不变量10：命名空间隔离 ─────────────────────────────────────────────
  { name: '不变量10：member 不能读用户列表', ctx: memberCtx, action: 'user.list', code: 'FORBIDDEN' },
  { name: '不变量10：member 不能改自己（走我的账号）', ctx: memberCtx, action: 'user.update', resource: asUser(facts('usr_m1', 'member')), code: 'SELF_MANAGE_DENIED' },
  { name: '不变量10：member 不能改他人', ctx: memberCtx, action: 'user.update', resource: asUser(m9), code: 'FORBIDDEN' },
  { name: '不变量10：member 不能读授权', ctx: memberCtx, action: 'grant.view.read', resource: asUser(m9), code: 'FORBIDDEN' },
  { name: '本人自助：member 可改自己资料', ctx: memberCtx, action: 'me.update', allow: true },
  { name: '本人自助：member 可改自己密码', ctx: memberCtx, action: 'me.password', allow: true },

  // ── 不变量4 / 7：可委派范围与增量授权 ─────────────────────────────────
  { name: 'A 可在委派范围内授权', ctx: adminCtx, action: 'grant.view.add', resource: { kind: 'grants', target: m1, change: [scope('group', GROUPS.g1)] }, allow: true },
  { name: 'A 可授权组内蓝图（原型按项勾选）', ctx: adminCtx, action: 'grant.view.add', resource: { kind: 'grants', target: m1, change: [{ targetType: 'blueprint', targetId: 'bp_x', groupId: GROUPS.g1 }] }, allow: true },
  { name: '不变量4：超出可委派范围被拒', ctx: adminCtx, action: 'grant.view.add', resource: { kind: 'grants', target: m1, change: [scope('group', GROUPS.g3)] }, code: 'DELEGATION_EXCEEDED' },
  { name: '不变量4：组外蓝图被拒', ctx: adminCtx, action: 'grant.view.add', resource: { kind: 'grants', target: m1, change: [{ targetType: 'blueprint', targetId: 'bp_y', groupId: GROUPS.g3 }] }, code: 'DELEGATION_EXCEEDED' },
  { name: '不变量4：A 不能撤销范围外授权', ctx: adminCtx, action: 'grant.view.remove', resource: { kind: 'grants', target: m1, change: [scope('group', GROUPS.g2)] }, code: 'OUT_OF_MANAGED_SCOPE' },
  { name: '不变量7：空增量被拒', ctx: ownerCtx, action: 'grant.view.add', resource: { kind: 'grants', target: m1, change: [] }, code: 'INVALID_ARGUMENT' },
  { name: 'A 不能给范围外的用户授权', ctx: adminCtx, action: 'grant.view.add', resource: { kind: 'grants', target: m9, change: [scope('group', GROUPS.g1)] }, code: 'OUT_OF_MANAGED_SCOPE' },
  { name: 'A 不能给自己授权', ctx: adminCtx, action: 'grant.view.add', resource: { kind: 'grants', target: facts('usr_a1', 'user_admin'), change: [scope('group', GROUPS.g1)] }, code: 'SELF_MANAGE_DENIED' },

  // ── 不变量6 / 8：业务能力与资源移动 ───────────────────────────────────
  { name: '不变量6：无能力不能归档分组', ctx: memberCtx, action: 'group.archive', resource: { kind: 'group', groupId: GROUPS.g1 }, code: 'CAPABILITY_REQUIRED' },
  { name: '不变量6：能力不覆盖该分组', ctx: managerCtx, action: 'group.archive', resource: { kind: 'group', groupId: GROUPS.g2 }, code: 'CAPABILITY_REQUIRED' },
  { name: '能力覆盖该分组则可归档', ctx: managerCtx, action: 'group.archive', resource: { kind: 'group', groupId: GROUPS.g1 }, allow: true },
  { name: '不变量11：恢复同样受能力门控', ctx: managerCtx, action: 'group.restore', resource: { kind: 'group', groupId: GROUPS.g1 }, allow: true },
  { name: '不变量11：恢复无能力被拒', ctx: memberCtx, action: 'blueprint.restore', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g1 }, code: 'CAPABILITY_REQUIRED' },
  // 建组 = 划新地盘，只有所有者能做，不由管辖/能力派生（permission-design §2.3）
  { name: '建组仅所有者：用户管理员即使持 manage 也被拒', ctx: managerCtx, action: 'group.create', code: 'FORBIDDEN' },
  { name: '普通成员不能建组', ctx: memberCtx, action: 'group.create', code: 'FORBIDDEN' },
  { name: '建蓝图需要 publish 而非 manage', ctx: managerCtx, action: 'blueprint.create', resource: { kind: 'group', groupId: GROUPS.g1 }, code: 'CAPABILITY_REQUIRED' },
  { name: '发布新版本需要 publish', ctx: managerCtx, action: 'version.publish', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g1 }, code: 'CAPABILITY_REQUIRED' },
  { name: '覆盖版本需要 manage', ctx: managerCtx, action: 'version.cover', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g1 }, allow: true },
  { name: '不变量8：移动蓝图需要源与目标两处能力', ctx: managerCtx, action: 'blueprint.move', resource: { kind: 'blueprintMove', blueprintId: BP.b1, fromGroupId: GROUPS.g1, toGroupId: GROUPS.g3 }, code: 'CAPABILITY_REQUIRED' },
  { name: '不变量8：源与目标都在范围内则允许', ctx: makeCtx({ identity: 'member', userId: 'usr_m4', capabilities: [cap('blueprint.manage', 'group', GROUPS.g1), cap('blueprint.manage', 'group', GROUPS.g3)] }), action: 'blueprint.move', resource: { kind: 'blueprintMove', blueprintId: BP.b1, fromGroupId: GROUPS.g1, toGroupId: GROUPS.g3 }, allow: true },
  { name: '蓝图级能力只覆盖自己', ctx: makeCtx({ identity: 'member', userId: 'usr_m5', capabilities: [cap('blueprint.manage', 'blueprint', BP.b2)] }), action: 'blueprint.archive', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g2 }, code: 'CAPABILITY_REQUIRED' },
  { name: '蓝图级能力正好覆盖', ctx: makeCtx({ identity: 'member', userId: 'usr_m5', capabilities: [cap('blueprint.manage', 'blueprint', BP.b1)] }), action: 'blueprint.archive', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g2 }, allow: true },
  { name: '所有者无需能力即可发布', ctx: ownerCtx, action: 'version.publish', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g2 }, allow: true },
  { name: 'A 的身份不带业务能力', ctx: adminCtx, action: 'version.publish', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g1 }, code: 'CAPABILITY_REQUIRED' },

  // ── 不变量9：Token 不越过绑定用户 ─────────────────────────────────────
  { name: '不变量9：Token 不能调用管理接口', ctx: makeCtx({ actorType: 'token', identity: 'owner', userId: 'usr_owner', tokenScopes: ['read:blueprint'] }), action: 'user.list', code: 'FORBIDDEN' },
  { name: '不变量9：发布需 publish scope', ctx: makeCtx({ actorType: 'token', identity: 'member', userId: 'usr_m3', tokenScopes: ['read:blueprint'], capabilities: [cap('blueprint.publish', 'group', GROUPS.g1)] }), action: 'version.publish', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g1 }, code: 'SCOPE_DENIED' },
  { name: '不变量9：scope 与绑定用户能力同时满足', ctx: makeCtx({ actorType: 'token', identity: 'member', userId: 'usr_m3', tokenScopes: ['publish:blueprint'], capabilities: [cap('blueprint.publish', 'group', GROUPS.g1)] }), action: 'version.publish', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g1 }, allow: true },
  { name: '不变量9：绑定用户无能力时 Token 也无', ctx: makeCtx({ actorType: 'token', identity: 'member', userId: 'usr_m3', tokenScopes: ['publish:blueprint'] }), action: 'version.publish', resource: { kind: 'blueprint', blueprintId: BP.b1, groupId: GROUPS.g1 }, code: 'CAPABILITY_REQUIRED' },
  { name: '自己创建只读 Token', ctx: memberCtx, action: 'token.create', resource: { kind: 'token', boundUserId: 'usr_m1', createdByUserId: 'usr_m1', scopes: ['read:blueprint'] }, allow: true },
  { name: '无 publish 能力不能建发布 Token', ctx: memberCtx, action: 'token.create', resource: { kind: 'token', boundUserId: 'usr_m1', createdByUserId: 'usr_m1', scopes: ['publish:blueprint'] }, code: 'SCOPE_DENIED' },
  { name: 'A 不能替他人建 Token', ctx: adminCtx, action: 'token.create', resource: { kind: 'token', boundUserId: 'usr_m1', createdByUserId: 'usr_a1', scopes: ['read:blueprint'] }, code: 'FORBIDDEN' },
  { name: '所有者可替他人建 Token', ctx: ownerCtx, action: 'token.create', resource: { kind: 'token', boundUserId: 'usr_m1', createdByUserId: 'usr_owner', scopes: ['read:blueprint', 'publish:blueprint'] }, allow: true },
  { name: 'Token 为空 scope 被拒', ctx: memberCtx, action: 'token.create', resource: { kind: 'token', boundUserId: 'usr_m1', createdByUserId: 'usr_m1', scopes: [] }, code: 'INVALID_ARGUMENT' },
  { name: '不能停用别人的 Token', ctx: adminCtx, action: 'token.disable', resource: { kind: 'token', boundUserId: 'usr_m2', createdByUserId: 'usr_owner', scopes: ['read:blueprint'] }, code: 'FORBIDDEN' },
  { name: '被绑定人可停用自己的 Token', ctx: adminCtx, action: 'token.disable', resource: { kind: 'token', boundUserId: 'usr_a1', createdByUserId: 'usr_owner', scopes: ['read:blueprint'] }, allow: true },
];

test('权限矩阵：逐条断言 allow / 错误码', () => {
  for (const item of cases) {
    const decision = authorize(item.ctx, item.action, item.resource ?? { kind: 'none' });
    if (item.allow === true) {
      assert.equal(decision.allow, true, `${item.name}：期望允许，实际被拒`);
      continue;
    }
    assert.equal(decision.allow, false, `${item.name}：期望被拒（${item.code}），实际允许`);
    if (!decision.allow) {
      assert.equal(decision.code, item.code, `${item.name}：错误码不符（原因：${decision.reason}）`);
    }
  }
});

test('十二条不变量：每一条都有覆盖用例', () => {
  const names = cases.map((item) => item.name).join('\n');
  const required = [
    '不变量2', '不变量3', '不变量4', '不变量5', '不变量6',
    '不变量7', '不变量8', '不变量9', '不变量10', '不变量11', '不变量12',
  ];
  for (const key of required) {
    assert.ok(names.includes(key), `缺少 ${key} 的失败用例`);
  }
});

test('拒绝时必带可区分的原因，允许时无附加字段', () => {
  const denied = authorize(memberCtx, 'user.list');
  assert.equal(denied.allow, false);
  if (!denied.allow) assert.ok(denied.reason.length > 0);

  const allowed = authorize(ownerCtx, 'user.list');
  assert.deepEqual(allowed, { allow: true });
});
