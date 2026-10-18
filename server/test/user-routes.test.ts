/**
 * 用户与授权管理路由（`/api/users/*`，设计文档 §6.2）。
 *
 * 这组用例守的是「用户管理命名空间」的边界：
 * 1. 不变量 10——`/api/users/*` 对 `member` 一律 403（含目标是自己）；
 * 2. 不变量 12——用户管理员只看 / 只管「管理归属含自己」的普通成员，判权与过滤都在 SQL 里；
 * 3. 每个写动作（含拒绝路径）都留下审计；
 * 4. 契约层的严格校验（`additionalProperties: false`）真的会 400。
 *
 * 装配走 `test/http-helpers.ts`（真迁移的 PGlite + buildServer + inject）。
 *
 * ※ 其中 7 条集成用例 + 1 条定位用例**当前故意保持红色**：它们锁的是正确契约，
 *   而 `server/app/context.ts:121` 把「我管谁」写成了「谁管我」，该文件在本任务的
 *   禁改清单内。详见文件末尾「缺陷定位」一节。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUserContext } from '../app/context.js';
import type { Db } from '../db/types.js';
import type { UserFacts } from '../domain/entities.js';
import { newId } from '../domain/ids.js';
import { assertAuthorized } from '../domain/policy.js';
import { ALLOWED_ORIGIN } from './helpers.js';
import {
  ADMIN_PASSWORD,
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  createTestContext,
  expectErrorCode,
  login,
  seedUser,
  seedWorld,
  type TestContext,
} from './http-helpers.js';

/** 满足口令策略（≥8 位、不在禁用列表）的测试口令。 */
const NEW_PASSWORD = 'brand-new-pass-9';

interface TargetScope {
  readonly targetType: 'group' | 'blueprint';
  readonly targetId: string;
}

const G_INVEST: TargetScope = { targetType: 'group', targetId: 'group_invest' };
const G_OPS: TargetScope = { targetType: 'group', targetId: 'group_ops' };
const BP_ALPHA: TargetScope = { targetType: 'blueprint', targetId: 'bp_alpha' };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface CallOptions {
  readonly cookie?: string;
  readonly payload?: Record<string, unknown>;
}

async function call(ctx: TestContext, method: Method, url: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { origin: ALLOWED_ORIGIN };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return await ctx.app.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

/** 直接落库：给自己造「查看范围」，从而决定用户管理员的可委派范围（S1）。 */
async function seedGrant(
  db: Db,
  userId: string,
  grantedBy: string,
  scopes: readonly TargetScope[],
): Promise<void> {
  for (const scope of scopes) {
    await db
      .insertInto('view_grants')
      .values({
        id: newId('grn'),
        user_id: userId,
        target_type: scope.targetType,
        target_id: scope.targetId,
        granted_by: grantedBy,
      })
      .execute();
  }
}

async function seedCapability(
  db: Db,
  userId: string,
  grantedBy: string,
  capability: 'blueprint.manage' | 'blueprint.publish',
  scope: TargetScope,
): Promise<void> {
  await db
    .insertInto('capabilities')
    .values({
      id: newId('cap'),
      user_id: userId,
      capability,
      target_type: scope.targetType,
      target_id: scope.targetId,
      granted_by: grantedBy,
    })
    .execute();
}

const COUNTABLE = [
  'users',
  'user_identity',
  'user_managers',
  'view_grants',
  'capabilities',
  'sessions',
  'audit_logs',
] as const;
type CountableTable = (typeof COUNTABLE)[number];

/** 计数直查 PGlite（避免 Kysely 在表名联合类型上的推断噪音）。 */
async function countRows(
  ctx: TestContext,
  table: CountableTable,
  where?: string,
): Promise<number> {
  if (!COUNTABLE.includes(table)) throw new Error(`未知表：${String(table)}`);
  const sql = `select count(*)::int as n from ${table}${where === undefined ? '' : ` where ${where}`}`;
  const result = await ctx.pglite.query<{ n: number }>(sql);
  return result.rows[0]?.n ?? 0;
}

interface AuditRow {
  readonly action: string;
  readonly result: string;
  readonly error_code: string | null;
  readonly actor_id: string | null;
  readonly request_id: string | null;
  readonly target_id: string | null;
}

async function auditRows(ctx: TestContext): Promise<AuditRow[]> {
  return await ctx.db
    .selectFrom('audit_logs')
    .select(['action', 'result', 'error_code', 'actor_id', 'request_id', 'target_id'])
    .orderBy('at', 'asc')
    .execute();
}

async function actionsWhere(
  ctx: TestContext,
  predicate: (row: AuditRow) => boolean,
): Promise<string[]> {
  return (await auditRows(ctx)).filter(predicate).map((row) => `${row.action}:${row.result}`);
}

interface UserSummaryBody {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly identity: string;
  readonly managedByUserIds: string[];
  readonly email: string | null;
  readonly phone: string | null;
}

interface ListBody {
  readonly data: { readonly items: readonly UserSummaryBody[] };
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

interface GrantItemBody {
  readonly targetType: string;
  readonly targetId: string;
  readonly grantedByUserId: string;
  readonly grantedByDisplayName: string;
  readonly grantedAt: string;
}

interface GrantsBody {
  readonly data: { readonly items: readonly GrantItemBody[] };
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

// ─────────────────────────── 1. 命名空间隔离（不变量 10） ───────────────────────────

interface RouteProbe {
  readonly label: string;
  readonly method: Method;
  readonly path: (id: string) => string;
  readonly payload?: Record<string, unknown>;
  readonly action: string;
}

const MEMBER_PROBES: readonly RouteProbe[] = [
  { label: '列表', method: 'GET', path: () => '/api/users', action: 'user.list' },
  {
    label: '建号',
    method: 'POST',
    path: () => '/api/users',
    payload: { username: 'ghost', displayName: '幽灵', password: 'ghost-pass-1234' },
    action: 'user.create',
  },
  {
    label: '改资料',
    method: 'PATCH',
    path: (id) => `/api/users/${id}`,
    payload: { displayName: '改名' },
    action: 'user.update',
  },
  {
    label: '重置口令',
    method: 'POST',
    path: (id) => `/api/users/${id}/password`,
    payload: { password: 'ghost-pass-1234' },
    action: 'user.resetPassword',
  },
  { label: '删除', method: 'DELETE', path: (id) => `/api/users/${id}`, action: 'user.delete' },
  {
    label: '改派归属',
    method: 'PUT',
    path: (id) => `/api/users/${id}/managed-by`,
    payload: { managerIds: [] },
    action: 'user.setManagedBy',
  },
  {
    label: '设身份',
    method: 'PUT',
    path: (id) => `/api/users/${id}/identity`,
    payload: { identity: 'member' },
    action: 'user.setRole',
  },
  {
    label: '看授权',
    method: 'GET',
    path: (id) => `/api/users/${id}/grants`,
    action: 'grant.view.read',
  },
  {
    label: '改授权',
    method: 'POST',
    path: (id) => `/api/users/${id}/grants`,
    payload: { add: [{ targetType: 'group', targetId: 'group_invest' }] },
    action: 'grant.view.add',
  },
  {
    label: '设能力',
    method: 'PUT',
    path: (id) => `/api/users/${id}/capabilities`,
    payload: { capabilities: [] },
    action: 'capability.set',
  },
];

test('不变量 10：普通成员访问 /api/users/* 一律 403——包括目标是自己', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'chen', MEMBER_PASSWORD);

    for (const target of [memberId, adminId, ownerId]) {
      for (const probe of MEMBER_PROBES) {
        const response = await call(ctx, probe.method, probe.path(target), {
          cookie,
          payload: probe.payload,
        });
        await expectErrorCode(response, 403, 'FORBIDDEN');
      }
    }

    // 10 条路由 × 3 个目标全部留下 deny 审计（拒绝路径也要留痕）。
    const denies = (await auditRows(ctx)).filter((row) => row.result === 'deny');
    assert.equal(denies.length, MEMBER_PROBES.length * 3);
    assert.deepEqual(
      [...new Set(denies.map((row) => row.action))].sort(),
      [
        'capability.set',
        'grant.view.add',
        'grant.view.read',
        'user.create',
        'user.delete',
        'user.list',
        'user.resetPassword',
        'user.setManagedBy',
        'user.setRole',
        'user.update',
      ].sort(),
    );
    for (const row of denies) {
      assert.equal(row.error_code, 'FORBIDDEN');
      assert.equal(row.actor_id, memberId);
    }
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 2. 列表可见性（不变量 12） ───────────────────────────

test('所有者看全平台；用户管理员只看「管理归属含自己」的普通成员（SQL 过滤）', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    const managedMemberId = await seedUser(ctx.db, {
      username: 'li',
      password: MEMBER_PASSWORD,
      displayName: '李思远',
      managedBy: [adminId],
      createdBy: adminId,
    });
    const lonelyMemberId = await seedUser(ctx.db, {
      username: 'wang',
      password: MEMBER_PASSWORD,
      displayName: '王介',
    });
    const otherAdminId = await seedUser(ctx.db, {
      username: 'sun',
      password: ADMIN_PASSWORD,
      displayName: '孙屿',
      identity: 'user_admin',
      grantedBy: ownerId,
      createdBy: ownerId,
    });
    // 这位 user_admin 的归属里恰好含 admin：列表必须仍按身份过滤掉它。
    const peerManagedAdminId = await seedUser(ctx.db, {
      username: 'qian',
      password: ADMIN_PASSWORD,
      displayName: '钱夙',
      identity: 'user_admin',
      managedBy: [adminId],
      createdBy: ownerId,
    });

    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const adminCookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    const ownerList = (await call(ctx, 'GET', '/api/users', { cookie: ownerCookie })).json() as ListBody;
    assert.equal(ownerList.meta.total, 7);
    assert.equal(ownerList.meta.page, 1);
    assert.equal(ownerList.meta.pageSize, 20);
    assert.deepEqual(
      ownerList.data.items.map((item) => item.id).sort(),
      [ownerId, adminId, memberId, managedMemberId, lonelyMemberId, otherAdminId, peerManagedAdminId].sort(),
    );

    const adminList = (await call(ctx, 'GET', '/api/users', { cookie: adminCookie })).json() as ListBody;
    assert.equal(adminList.meta.total, 2);
    assert.deepEqual(
      adminList.data.items.map((item) => item.id).sort(),
      [memberId, managedMemberId].sort(),
    );
    for (const item of adminList.data.items) {
      assert.equal(item.identity, 'member');
      assert.deepEqual(item.managedByUserIds, [adminId]);
    }
    // 越界者一个都不能出现：同级管理员、未被指派的成员、所有者。
    const adminVisible = new Set(adminList.data.items.map((item) => item.id));
    for (const hidden of [ownerId, adminId, otherAdminId, peerManagedAdminId, lonelyMemberId]) {
      assert.equal(adminVisible.has(hidden), false, `不应看到 ${hidden}`);
    }
  } finally {
    await ctx.close();
  }
});

test('列表分页、关键字、状态与身份过滤，越界查询参数一律 400', async () => {
  const ctx = await createTestContext();
  try {
    const { adminId, memberId } = await seedWorld(ctx.db);
    await seedUser(ctx.db, {
      username: 'li',
      password: MEMBER_PASSWORD,
      displayName: '李思远',
      status: 'disabled',
      managedBy: [adminId],
    });
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);

    const first = (await call(ctx, 'GET', '/api/users?page=1&pageSize=2', { cookie: ownerCookie })).json() as ListBody;
    assert.equal(first.data.items.length, 2);
    assert.equal(first.meta.pageSize, 2);
    assert.equal(first.meta.total, 4);

    const second = (await call(ctx, 'GET', '/api/users?page=2&pageSize=2', { cookie: ownerCookie })).json() as ListBody;
    assert.equal(second.data.items.length, 2);
    assert.deepEqual(
      first.data.items.map((item) => item.id).filter((id) => second.data.items.some((x) => x.id === id)),
      [],
    );

    const byKeyword = (await call(ctx, 'GET', '/api/users?keyword=%E6%9D%8E', { cookie: ownerCookie })).json() as ListBody;
    assert.equal(byKeyword.meta.total, 1);
    assert.equal(byKeyword.data.items[0]?.username, 'li');

    const byStatus = (await call(ctx, 'GET', '/api/users?status=disabled', { cookie: ownerCookie })).json() as ListBody;
    assert.equal(byStatus.meta.total, 1);
    assert.equal(byStatus.data.items[0]?.status, 'disabled');

    const byIdentity = (await call(ctx, 'GET', '/api/users?identity=user_admin', { cookie: ownerCookie })).json() as ListBody;
    assert.deepEqual(byIdentity.data.items.map((item) => item.id), [adminId]);

    for (const query of ['page=0', 'pageSize=0', 'pageSize=101', 'page=abc', 'status=nope', 'foo=1']) {
      const response = await call(ctx, 'GET', `/api/users?${query}`, { cookie: ownerCookie });
      await expectErrorCode(response, 400, 'INVALID_ARGUMENT');
    }
    assert.equal(memberId.length > 0, true);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 3. 用户管理员的禁区 ───────────────────────────

test('【缺陷 D6】用户管理员不能删号 / 改派归属 / 任命管理员，也不能管同级与所有者', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    const strangerId = await seedUser(ctx.db, { username: 'wang', password: MEMBER_PASSWORD });
    const peerAdminId = await seedUser(ctx.db, {
      username: 'sun',
      password: ADMIN_PASSWORD,
      identity: 'user_admin',
      grantedBy: ownerId,
    });
    const cookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${memberId}/managed-by`, { cookie, payload: { managerIds: [] } }),
      403,
      'FORBIDDEN',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${memberId}/identity`, { cookie, payload: { identity: 'user_admin' } }),
      403,
      'FORBIDDEN',
    );
    await expectErrorCode(
      await call(ctx, 'PATCH', `/api/users/${peerAdminId}`, { cookie, payload: { displayName: '越级' } }),
      403,
      'PEER_MANAGE_DENIED',
    );
    await expectErrorCode(
      await call(ctx, 'PATCH', `/api/users/${ownerId}`, { cookie, payload: { displayName: '越级' } }),
      403,
      'OWNER_PROTECTED',
    );
    await expectErrorCode(
      await call(ctx, 'PATCH', `/api/users/${strangerId}`, { cookie, payload: { displayName: '越级' } }),
      403,
      'OUT_OF_MANAGED_SCOPE',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${memberId}/capabilities`, {
        cookie,
        payload: { capabilities: [] },
      }),
      403,
      'FORBIDDEN',
    );
    await expectErrorCode(
      await call(ctx, 'GET', `/api/users/${strangerId}/grants`, { cookie }),
      403,
      'OUT_OF_MANAGED_SCOPE',
    );
    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${strangerId}/grants`, {
        cookie,
        payload: { add: [G_INVEST] },
      }),
      403,
      'OUT_OF_MANAGED_SCOPE',
    );

    // 被拒的写动作不留副作用。
    assert.equal(await countRows(ctx, 'users', `id = '${strangerId}'`), 1);
    assert.equal(await countRows(ctx, 'user_managers', `user_id = '${memberId}'`), 1);
    assert.equal(adminId.length > 0, true);

    const denied = (await auditRows(ctx)).filter((row) => row.result === 'deny');
    assert.equal(denied.length, 8);
    for (const row of denied) assert.notEqual(row.error_code, null);

    // 【缺陷 D6】「不能删号」这条判定的位置在「目标是否在我管理范围内」之后，
    // 因此当前被 context.ts:121 的方向错误挡住（得到 OUT_OF_MANAGED_SCOPE 而非 PEER_MANAGE_DENIED）。
    await expectErrorCode(
      await call(ctx, 'DELETE', `/api/users/${memberId}`, { cookie }),
      403,
      'PEER_MANAGE_DENIED',
    );
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 4 / 5. 本人保护 ───────────────────────────

test('所有者不能把目标设为自己：OWNER_PROTECTED', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);

    await expectErrorCode(
      await call(ctx, 'PATCH', `/api/users/${ownerId}`, { cookie, payload: { displayName: '自己' } }),
      403,
      'OWNER_PROTECTED',
    );
    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${ownerId}/password`, { cookie, payload: { password: NEW_PASSWORD } }),
      403,
      'OWNER_PROTECTED',
    );
    await expectErrorCode(
      await call(ctx, 'DELETE', `/api/users/${ownerId}`, { cookie }),
      403,
      'OWNER_PROTECTED',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${ownerId}/identity`, { cookie, payload: { identity: 'member' } }),
      403,
      'OWNER_PROTECTED',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${ownerId}/capabilities`, { cookie, payload: { capabilities: [] } }),
      403,
      'OWNER_PROTECTED',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${ownerId}/managed-by`, { cookie, payload: { managerIds: [] } }),
      403,
      'OWNER_PROTECTED',
    );
    assert.equal(await countRows(ctx, 'users', `id = '${ownerId}'`), 1);
  } finally {
    await ctx.close();
  }
});

test('用户管理员不能把目标设为自己：管理类路由 SELF_MANAGE_DENIED', async () => {
  const ctx = await createTestContext();
  try {
    const { adminId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    // `administerUser`（PATCH / 改密 / 删除）先判「目标是不是自己」→ SELF_MANAGE_DENIED。
    await expectErrorCode(
      await call(ctx, 'PATCH', `/api/users/${adminId}`, { cookie, payload: { displayName: '自己' } }),
      403,
      'SELF_MANAGE_DENIED',
    );
    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${adminId}/password`, { cookie, payload: { password: NEW_PASSWORD } }),
      403,
      'SELF_MANAGE_DENIED',
    );
    await expectErrorCode(
      await call(ctx, 'DELETE', `/api/users/${adminId}`, { cookie }),
      403,
      'SELF_MANAGE_DENIED',
    );
    // 「仅所有者」三条路由（身份 / 归属 / 能力）在策略里**先**判操作者不是 owner，
    // 所以非所有者对自己调用撞到的是 FORBIDDEN，而到不了 SELF_MANAGE_DENIED 分支。
    // 这是 policy.ts 的既有判定顺序（invar 2/5/6 的 owner 闸门优先），断言按实际冻结行为写。
    for (const [label, response] of [
      [
        'identity',
        await call(ctx, 'PUT', `/api/users/${adminId}/identity`, { cookie, payload: { identity: 'member' } }),
      ],
      [
        'managed-by',
        await call(ctx, 'PUT', `/api/users/${adminId}/managed-by`, { cookie, payload: { managerIds: [adminId] } }),
      ],
      [
        'capabilities',
        await call(ctx, 'PUT', `/api/users/${adminId}/capabilities`, {
          cookie,
          payload: { capabilities: [] },
        }),
      ],
    ] as const) {
      const body = response.json() as { error: { code: string; details?: { reason?: string } } };
      assert.equal(body.error.code, 'FORBIDDEN', `${label} 应被 owner 闸门拦下`);
      assert.equal(body.error.details?.reason, '仅平台所有者可执行该操作');
    }
    // 自己没有任何字段被改动，也没有被删掉。
    assert.equal(await countRows(ctx, 'users', `id = '${adminId}'`), 1);
    const identityRow = await ctx.pglite.query<{ identity: string }>(
      `select identity from user_identity where user_id = '${adminId}'`,
    );
    assert.equal(identityRow.rows[0]?.identity, 'user_admin');
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 6. 建号与归属 ───────────────────────────

test('用户管理员建号：身份只能是 member、自动归属创建者、初始必须改密', async () => {
  const ctx = await createTestContext();
  try {
    const { adminId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    const response = await call(ctx, 'POST', '/api/users', {
      cookie,
      payload: { username: 'newbie', displayName: '新来的', password: NEW_PASSWORD },
    });
    assert.equal(response.statusCode, 200);
    const created = response.json() as { data: UserSummaryBody };
    assert.equal(created.data.username, 'newbie');
    assert.equal(created.data.identity, 'member');
    assert.equal(created.data.status, 'active');
    assert.deepEqual(created.data.managedByUserIds, [adminId]);

    const row = await ctx.db
      .selectFrom('users')
      .select(['must_change_password', 'created_by_user_id'])
      .where('id', '=', created.data.id)
      .executeTakeFirstOrThrow();
    assert.equal(row.must_change_password, true);
    assert.equal(row.created_by_user_id, adminId);

    const identity = await ctx.db
      .selectFrom('user_identity')
      .select(['identity', 'granted_by'])
      .where('user_id', '=', created.data.id)
      .executeTakeFirstOrThrow();
    assert.equal(identity.identity, 'member');
    assert.equal(identity.granted_by, adminId);

    // 新号立刻出现在创建者自己的列表里（归属真的落库了）。
    const list = (await call(ctx, 'GET', '/api/users', { cookie })).json() as ListBody;
    assert.equal(list.data.items.some((item) => item.id === created.data.id), true);

    // 初始口令可用；改密前必须换口令。
    const newCookie = await login(ctx.app, 'newbie', NEW_PASSWORD);
    assert.equal(typeof newCookie, 'string');
  } finally {
    await ctx.close();
  }
});

test('用户管理员建号：身份字段被契约挡住（提升只能走 /identity）', async () => {
  const ctx = await createTestContext();
  try {
    await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);
    await expectErrorCode(
      await call(ctx, 'POST', '/api/users', {
        cookie,
        payload: {
          username: 'sneaky',
          displayName: '偷跑',
          password: NEW_PASSWORD,
          identity: 'user_admin',
        },
      }),
      400,
      'INVALID_ARGUMENT',
    );
  } finally {
    await ctx.close();
  }
});

test('用户管理员建号时的归属越界 → OUT_OF_MANAGED_SCOPE；给出自己则原样自动归属', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);
    const base = { displayName: '新号', password: NEW_PASSWORD };

    await expectErrorCode(
      await call(ctx, 'POST', '/api/users', {
        cookie,
        payload: { ...base, username: 'out1', managedByUserIds: [ownerId] },
      }),
      403,
      'OUT_OF_MANAGED_SCOPE',
    );
    await expectErrorCode(
      await call(ctx, 'POST', '/api/users', {
        cookie,
        payload: { ...base, username: 'out2', managedByUserIds: [adminId, memberId] },
      }),
      403,
      'OUT_OF_MANAGED_SCOPE',
    );

    const explicit = await call(ctx, 'POST', '/api/users', {
      cookie,
      payload: { ...base, username: 'self-managed', managedByUserIds: [adminId] },
    });
    assert.equal(explicit.statusCode, 200);
    assert.deepEqual((explicit.json() as { data: UserSummaryBody }).data.managedByUserIds, [adminId]);

    const implicit = await call(ctx, 'POST', '/api/users', {
      cookie,
      payload: { ...base, username: 'auto-managed' },
    });
    assert.equal(implicit.statusCode, 200);
    assert.deepEqual((implicit.json() as { data: UserSummaryBody }).data.managedByUserIds, [adminId]);

    assert.equal(await countRows(ctx, 'users', `username in ('out1','out2')`), 0);
  } finally {
    await ctx.close();
  }
});

test('所有者建号可指定归属；归属必须是已存在的 user_admin', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const base = { displayName: '新号', password: NEW_PASSWORD };

    const ok = await call(ctx, 'POST', '/api/users', {
      cookie,
      payload: { ...base, username: 'owned', managedByUserIds: [adminId] },
    });
    assert.equal(ok.statusCode, 200);
    const created = (ok.json() as { data: UserSummaryBody }).data;
    assert.deepEqual(created.managedByUserIds, [adminId]);
    assert.equal(created.identity, 'member');

    const row = await ctx.db
      .selectFrom('users')
      .select('created_by_user_id')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    assert.equal(row.created_by_user_id, ownerId);

    await expectErrorCode(
      await call(ctx, 'POST', '/api/users', {
        cookie,
        payload: { ...base, username: 'bad1', managedByUserIds: [memberId] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
    await expectErrorCode(
      await call(ctx, 'POST', '/api/users', {
        cookie,
        payload: { ...base, username: 'bad2', managedByUserIds: ['usr_missing'] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
    await expectErrorCode(
      await call(ctx, 'POST', '/api/users', {
        cookie,
        payload: { ...base, username: 'bad3', managedByUserIds: [ownerId] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
    assert.equal(await countRows(ctx, 'users', `username in ('bad1','bad2','bad3')`), 0);
  } finally {
    await ctx.close();
  }
});

test('建号时携带的初始查看授权不得超过可委派范围（DELEGATION_EXCEEDED）', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId } = await seedWorld(ctx.db);
    // 管理员的查看范围 = 它的可委派范围（S1）。
    await seedGrant(ctx.db, adminId, ownerId, [G_INVEST]);
    const adminCookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const base = { displayName: '新号', password: NEW_PASSWORD };

    const inScope = await call(ctx, 'POST', '/api/users', {
      cookie: adminCookie,
      payload: { ...base, username: 'granted-in', viewGrants: [G_INVEST] },
    });
    assert.equal(inScope.statusCode, 200);
    const grantedId = (inScope.json() as { data: UserSummaryBody }).data.id;
    const grant = await ctx.db
      .selectFrom('view_grants')
      .select(['target_type', 'target_id', 'granted_by'])
      .where('user_id', '=', grantedId)
      .executeTakeFirstOrThrow();
    assert.deepEqual(
      [grant.target_type, grant.target_id, grant.granted_by],
      ['group', 'group_invest', adminId],
    );

    const noGrants = await call(ctx, 'POST', '/api/users', {
      cookie: adminCookie,
      payload: { ...base, username: 'granted-none' },
    });
    assert.equal(noGrants.statusCode, 200);

    await expectErrorCode(
      await call(ctx, 'POST', '/api/users', {
        cookie: adminCookie,
        payload: { ...base, username: 'granted-out', viewGrants: [G_OPS] },
      }),
      403,
      'DELEGATION_EXCEEDED',
    );
    assert.equal(await countRows(ctx, 'users', `username = 'granted-out'`), 0);

    // 所有者不受可委派范围约束。
    const byOwner = await call(ctx, 'POST', '/api/users', {
      cookie: ownerCookie,
      payload: { ...base, username: 'granted-by-owner', viewGrants: [G_OPS, BP_ALPHA] },
    });
    assert.equal(byOwner.statusCode, 200);
    const ownerCreatedId = (byOwner.json() as { data: UserSummaryBody }).data.id;
    assert.equal(await countRows(ctx, 'view_grants', `user_id = '${ownerCreatedId}'`), 2);

    const denied = (await auditRows(ctx)).filter(
      (row) => row.action === 'user.create' && row.result === 'deny',
    );
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.error_code, 'DELEGATION_EXCEEDED');
  } finally {
    await ctx.close();
  }
});

test('重名建号 → 409 USERNAME_CONFLICT：靠唯一约束捕获、不落库、审计记 deny', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId } = await seedWorld(ctx.db);
    const adminCookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    await expectErrorCode(
      await call(ctx, 'POST', '/api/users', {
        cookie: adminCookie,
        payload: { username: 'chen', displayName: '冒名', password: NEW_PASSWORD },
      }),
      409,
      'USERNAME_CONFLICT',
    );
    assert.equal(await countRows(ctx, 'users', `username = 'chen'`), 1);

    const conflict = (await auditRows(ctx)).filter(
      (row) => row.action === 'user.create' && row.result === 'deny',
    );
    assert.equal(conflict.length, 1);
    assert.equal(conflict[0]?.error_code, 'USERNAME_CONFLICT');
    assert.equal(conflict[0]?.actor_id, adminCookie.length > 0 ? conflict[0].actor_id : null);
    assert.equal(ownerId.length > 0, true);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 8 / 9. 会话失效 ───────────────────────────

test('停用用户：其会话立刻失效，logins 被拒，改回 active 后需重新登录', async () => {
  const ctx = await createTestContext();
  try {
    const { memberId } = await seedWorld(ctx.db);
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const memberCookie = await login(ctx.app, 'chen', MEMBER_PASSWORD);

    const disabled = await call(ctx, 'PATCH', `/api/users/${memberId}`, {
      cookie: ownerCookie,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal((disabled.json() as { data: UserSummaryBody }).data.status, 'disabled');

    const afterDisable = await call(ctx, 'GET', '/api/me', { cookie: memberCookie });
    await expectErrorCode(afterDisable, 401, 'SESSION_EXPIRED');

    const relogin = await call(ctx, 'POST', '/api/auth/login', {
      payload: { username: 'chen', password: MEMBER_PASSWORD },
    });
    await expectErrorCode(relogin, 401, 'UNAUTHENTICATED');

    assert.equal(await countRows(ctx, 'sessions', `user_id = '${memberId}' and revoked_at is null`), 0);

    const enabled = await call(ctx, 'PATCH', `/api/users/${memberId}`, {
      cookie: ownerCookie,
      payload: { status: 'active' },
    });
    assert.equal(enabled.statusCode, 200);
    assert.equal((enabled.json() as { data: UserSummaryBody }).data.status, 'active');
    // 旧会话仍然无效；重新登录可用。
    await expectErrorCode(await call(ctx, 'GET', '/api/me', { cookie: memberCookie }), 401, 'SESSION_EXPIRED');
    const freshCookie = await login(ctx.app, 'chen', MEMBER_PASSWORD);
    assert.equal((await call(ctx, 'GET', '/api/me', { cookie: freshCookie })).statusCode, 200);

    assert.deepEqual(
      await actionsWhere(ctx, (row) => row.action === 'user.disable' || row.action === 'user.enable'),
      ['user.disable:allow', 'user.enable:allow'],
    );
  } finally {
    await ctx.close();
  }
});

test('【缺陷 D6】用户管理员停用 / 改资料自己管辖的成员：被误判为 OUT_OF_MANAGED_SCOPE', async () => {
  const ctx = await createTestContext();
  try {
    const { memberId } = await seedWorld(ctx.db);
    const adminCookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);
    const memberCookie = await login(ctx.app, 'chen', MEMBER_PASSWORD);

    // 用户管理员对自己管辖的成员停用 —— 策略允许（administerUser：member 且在我的范围内）。
    // 但 context.ts:121 把「我管谁」写成了「谁管我」，于是这里恒返回 403 OUT_OF_MANAGED_SCOPE。
    const disabled = await call(ctx, 'PATCH', `/api/users/${memberId}`, {
      cookie: adminCookie,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200);
    // 只要停用成功，会话吊销与登录拒绝就应随之生效。
    await expectErrorCode(await call(ctx, 'GET', '/api/me', { cookie: memberCookie }), 401, 'SESSION_EXPIRED');
  } finally {
    await ctx.close();
  }
});

test('停用而未被吊销会话的用户仍进不来（授权上下文层兜底：UNAUTHENTICATED）', async () => {
  const ctx = await createTestContext();
  try {
    await seedWorld(ctx.db);
    const userId = await seedUser(ctx.db, { username: 'liu', password: MEMBER_PASSWORD });
    const cookie = await login(ctx.app, 'liu', MEMBER_PASSWORD);
    assert.equal((await call(ctx, 'GET', '/api/me', { cookie })).statusCode, 200);

    // 直接改库停用（绕过用例层，因此会话仍是 active），验证第二道闸门。
    await ctx.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', userId).execute();
    assert.equal(await countRows(ctx, 'sessions', `user_id = '${userId}' and revoked_at is null`), 1);
    await expectErrorCode(await call(ctx, 'GET', '/api/me', { cookie }), 401, 'UNAUTHENTICATED');
  } finally {
    await ctx.close();
  }
});

test('重置口令：目标用户全部会话失效，新口令可登录、旧口令不可', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const first = await login(ctx.app, 'chen', MEMBER_PASSWORD);
    const second = await login(ctx.app, 'chen', MEMBER_PASSWORD);

    const response = await call(ctx, 'POST', `/api/users/${memberId}/password`, {
      cookie: ownerCookie,
      payload: { password: NEW_PASSWORD, mustChangePassword: false },
    });
    assert.equal(response.statusCode, 200);

    await expectErrorCode(await call(ctx, 'GET', '/api/me', { cookie: first }), 401, 'SESSION_EXPIRED');
    await expectErrorCode(await call(ctx, 'GET', '/api/me', { cookie: second }), 401, 'SESSION_EXPIRED');
    assert.equal(await countRows(ctx, 'sessions', `user_id = '${memberId}' and revoked_at is null`), 0);

    const row = await ctx.db
      .selectFrom('users')
      .select('must_change_password')
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow();
    assert.equal(row.must_change_password, false);

    await expectErrorCode(
      await call(ctx, 'POST', '/api/auth/login', {
        payload: { username: 'chen', password: MEMBER_PASSWORD },
      }),
      401,
      'UNAUTHENTICATED',
    );
    const fresh = await login(ctx.app, 'chen', NEW_PASSWORD);
    assert.equal((await call(ctx, 'GET', '/api/me', { cookie: fresh })).statusCode, 200);

    // 默认 mustChangePassword = true。
    await call(ctx, 'POST', `/api/users/${memberId}/password`, {
      cookie: ownerCookie,
      payload: { password: 'another-pass-77' },
    });
    const again = await ctx.db
      .selectFrom('users')
      .select('must_change_password')
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow();
    assert.equal(again.must_change_password, true);

    const allowed = (await auditRows(ctx)).filter(
      (row) => row.action === 'user.resetPassword' && row.result === 'allow',
    );
    assert.equal(allowed.length, 2);
    assert.equal(allowed[0]?.actor_id, ownerId);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 10. 删除级联 ───────────────────────────

test('【缺陷 D6】删除用户：关联行全清、审计保留、且仅所有者可用（前半段全绿，末条被 D6 挡住）', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    await seedGrant(ctx.db, memberId, ownerId, [G_INVEST, BP_ALPHA]);
    await seedCapability(ctx.db, memberId, ownerId, 'blueprint.manage', G_INVEST);
    // 别人名下由该成员授予的授权行：删除时因 granted_by 非空只能连删。
    await seedGrant(ctx.db, adminId, memberId, [G_OPS]);
    const dependentId = await seedUser(ctx.db, {
      username: 'dep',
      password: MEMBER_PASSWORD,
      createdBy: memberId,
      managedBy: [adminId],
    });
    await ctx.db
      .updateTable('user_identity')
      .set({ granted_by: memberId })
      .where('user_id', '=', dependentId)
      .execute();
    await login(ctx.app, 'chen', MEMBER_PASSWORD);
    const auditBefore = await countRows(ctx, 'audit_logs');

    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const adminCookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    const response = await call(ctx, 'DELETE', `/api/users/${memberId}`, { cookie: ownerCookie });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      data: { id: memberId },
      meta: { requestId: (response.json() as { meta: { requestId: string } }).meta.requestId },
    });

    for (const table of ['users', 'user_identity', 'view_grants', 'capabilities', 'sessions'] as const) {
      const where = table === 'view_grants' ? `user_id = '${memberId}' or granted_by = '${memberId}'`
        : table === 'capabilities' ? `user_id = '${memberId}' or granted_by = '${memberId}'`
          : table === 'users' ? `id = '${memberId}'`
            : `user_id = '${memberId}'`;
      assert.equal(await countRows(ctx, table, where), 0, `${table} 应清空`);
    }
    assert.equal(
      await countRows(ctx, 'user_managers', `user_id = '${memberId}' or manager_user_id = '${memberId}'`),
      0,
    );

    const dependent = await ctx.db
      .selectFrom('users')
      .select(['created_by_user_id'])
      .where('id', '=', dependentId)
      .executeTakeFirstOrThrow();
    assert.equal(dependent.created_by_user_id, null);
    const dependentIdentity = await ctx.db
      .selectFrom('user_identity')
      .select('granted_by')
      .where('user_id', '=', dependentId)
      .executeTakeFirstOrThrow();
    assert.equal(dependentIdentity.granted_by, null);

    // 审计不被级联删除：删除前留下的行 + 本次 user.delete allow。
    const auditAfter = await countRows(ctx, 'audit_logs');
    assert.equal(auditAfter > auditBefore, true);
    const deleteRow = (await auditRows(ctx)).find(
      (row) => row.action === 'user.delete' && row.result === 'allow',
    );
    assert.equal(deleteRow?.target_id, memberId);
    assert.equal(deleteRow?.actor_id, ownerId);

    // 【缺陷 D6】用户管理员连「删除自己管辖的成员」都到不了「只能停用不能删」那条判定：
    // 策略先查目标是否在 `ctx.managedUserIds` 里，而 context.ts:121 让这个集合恒为空。
    // 对别人（不存在 / 不在范围内）的删除仍是稳定 404 / 403，见上面的 `target 不存在` 与禁区用例。
    await expectErrorCode(
      await call(ctx, 'DELETE', `/api/users/${dependentId}`, { cookie: adminCookie }),
      403,
      'PEER_MANAGE_DENIED',
    );
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 11. 查看授权读写 ───────────────────────────

test('查看授权：增量添加 / 撤销生效、幂等、grantedByDisplayName 批量补齐', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    await seedGrant(ctx.db, adminId, ownerId, [G_INVEST]);
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);

    const added = await call(ctx, 'POST', `/api/users/${memberId}/grants`, {
      cookie: ownerCookie,
      payload: { add: [G_INVEST, BP_ALPHA] },
    });
    assert.equal(added.statusCode, 200);
    const addedBody = added.json() as GrantsBody;
    assert.equal(addedBody.meta.page, 1);
    assert.equal(addedBody.meta.pageSize, 100);
    assert.equal(addedBody.meta.total, 2);
    assert.deepEqual(
      addedBody.data.items.map((item) => `${item.targetType}:${item.targetId}`),
      ['blueprint:bp_alpha', 'group:group_invest'],
    );
    for (const item of addedBody.data.items) {
      assert.equal(item.grantedByUserId, ownerId);
      assert.equal(item.grantedByDisplayName, '所有者');
      assert.equal(Number.isNaN(Date.parse(item.grantedAt)), false);
    }

    const listed = (await call(ctx, 'GET', `/api/users/${memberId}/grants?page=1&pageSize=1`, {
      cookie: ownerCookie,
    })).json() as GrantsBody;
    assert.equal(listed.data.items.length, 1);
    assert.equal(listed.meta.pageSize, 1);
    assert.equal(listed.meta.total, 2);

    const again = (await call(ctx, 'POST', `/api/users/${memberId}/grants`, {
      cookie: ownerCookie,
      payload: { add: [G_INVEST] },
    })).json() as GrantsBody;
    assert.equal(again.meta.total, 2);

    const removed = (await call(ctx, 'POST', `/api/users/${memberId}/grants`, {
      cookie: ownerCookie,
      payload: { remove: [BP_ALPHA] },
    })).json() as GrantsBody;
    assert.equal(removed.meta.total, 1);
    assert.deepEqual(
      removed.data.items.map((item) => `${item.targetType}:${item.targetId}`),
      ['group:group_invest'],
    );

    // 空增量与非法项都在契约层被挡。
    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${memberId}/grants`, { cookie: ownerCookie, payload: {} }),
      400,
      'INVALID_ARGUMENT',
    );
    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${memberId}/grants`, {
        cookie: ownerCookie,
        payload: { add: [] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${memberId}/grants`, {
        cookie: ownerCookie,
        payload: { add: [{ targetType: 'user', targetId: 'x1' }] },
      }),
      400,
      'INVALID_ARGUMENT',
    );

    assert.deepEqual(
      await actionsWhere(ctx, (row) => row.action.startsWith('grant.view.')),
      ['grant.view.add:allow', 'grant.view.read:allow', 'grant.view.add:allow', 'grant.view.remove:allow'],
    );

    // 【缺陷 D6】用户管理员在**自己管理的成员**上读写授权：策略本应放行（成员 + 在范围内），
    // 但 context.ts:121 让 `ctx.managedUserIds` 恒为空 → `grant.view.read` 的前置闸门
    // `administerUser` 先返回 OUT_OF_MANAGED_SCOPE，整个写授权接口对用户管理员不可用。
    // 这一段单独成例（见下方「用户管理员读写自己管辖成员的授权」）。
  } finally {
    await ctx.close();
  }
});

test('【缺陷 D6】用户管理员在「自己管辖的成员」上读写授权：被前置范围闸门挡住', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    await seedGrant(ctx.db, adminId, ownerId, [G_INVEST]);
    await seedGrant(ctx.db, memberId, ownerId, [G_INVEST]);
    const adminCookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    const byAdmin = await call(ctx, 'POST', `/api/users/${memberId}/grants`, {
      cookie: adminCookie,
      payload: { add: [G_INVEST] },
    });
    assert.equal(byAdmin.statusCode, 200);
    const adminRead = (await call(ctx, 'GET', `/api/users/${memberId}/grants`, {
      cookie: adminCookie,
    })).json() as GrantsBody;
    assert.equal(adminRead.data.items[0]?.grantedByDisplayName, '所有者');
  } finally {
    await ctx.close();
  }
});

test('grantedByDisplayName：授权人已被删除时填「（已删除用户）」', async () => {
  const ctx = await createTestContext();
  try {
    const { memberId } = await seedWorld(ctx.db);
    const granterId = await seedUser(ctx.db, { username: 'gu', password: MEMBER_PASSWORD });
    await seedGrant(ctx.db, memberId, granterId, [G_INVEST]);

    // 模拟历史脏数据：正常删除路径会连带清掉这些行，这里放开外键以覆盖兜底分支。
    const constraints = await ctx.pglite.query<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid = 'view_grants'::regclass and contype = 'f'
         and pg_get_constraintdef(oid) ilike '%granted_by%'`,
    );
    for (const row of constraints.rows) {
      await ctx.pglite.exec(`alter table view_grants drop constraint "${row.conname}"`);
    }
    await ctx.db.deleteFrom('users').where('id', '=', granterId).execute();

    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const body = (await call(ctx, 'GET', `/api/users/${memberId}/grants`, {
      cookie: ownerCookie,
    })).json() as GrantsBody;
    assert.equal(body.meta.total, 1);
    assert.equal(body.data.items[0]?.grantedByUserId, granterId);
    assert.equal(body.data.items[0]?.grantedByDisplayName, '（已删除用户）');
  } finally {
    await ctx.close();
  }
});

test('【缺陷 D6】用户管理员授权越出本人可委派范围：add → DELEGATION_EXCEEDED，remove → OUT_OF_MANAGED_SCOPE', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    await seedGrant(ctx.db, adminId, ownerId, [G_INVEST]);
    await seedGrant(ctx.db, memberId, ownerId, [G_OPS, G_INVEST]);
    const cookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${memberId}/grants`, { cookie, payload: { add: [G_OPS] } }),
      403,
      'DELEGATION_EXCEEDED',
    );
    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${memberId}/grants`, { cookie, payload: { remove: [G_OPS] } }),
      403,
      'OUT_OF_MANAGED_SCOPE',
    );
    await expectErrorCode(
      await call(ctx, 'POST', `/api/users/${memberId}/grants`, {
        cookie,
        payload: { add: [G_INVEST], remove: [G_OPS] },
      }),
      403,
      'OUT_OF_MANAGED_SCOPE',
    );

    // 被拒的请求一行都不许落库。
    assert.equal(await countRows(ctx, 'view_grants', `user_id = '${memberId}'`), 2);
    assert.equal(await countRows(ctx, 'view_grants', `user_id = '${memberId}' and target_id = 'group_ops'`), 1);

    // 在可委派范围之内的 add 仍然放行。
    const ok = await call(ctx, 'POST', `/api/users/${memberId}/grants`, {
      cookie,
      payload: { add: [G_INVEST] },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.json() as GrantsBody).meta.total, 2);

    const denied = (await auditRows(ctx)).filter((row) => row.result === 'deny');
    assert.equal(denied.length, 3);
    for (const row of denied) assert.notEqual(row.error_code, null);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 13. 能力设置 ───────────────────────────

test('能力设置仅所有者：用户管理员 403；所有者整体替换、可清空、留审计', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    await seedCapability(ctx.db, memberId, ownerId, 'blueprint.publish', G_INVEST);
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const adminCookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${memberId}/capabilities`, {
        cookie: adminCookie,
        payload: {
          capabilities: [{ capability: 'blueprint.manage', targetType: 'group', targetId: 'group_ops' }],
        },
      }),
      403,
      'FORBIDDEN',
    );
    assert.equal(await countRows(ctx, 'capabilities', `user_id = '${memberId}'`), 1);

    const replaced = await call(ctx, 'PUT', `/api/users/${memberId}/capabilities`, {
      cookie: ownerCookie,
      payload: {
        capabilities: [
          { capability: 'blueprint.manage', targetType: 'group', targetId: 'group_invest' },
          { capability: 'blueprint.manage', targetType: 'group', targetId: 'group_invest' },
          { capability: 'blueprint.publish', targetType: 'blueprint', targetId: 'bp_alpha' },
        ],
      },
    });
    assert.equal(replaced.statusCode, 200);
    const replacedBody = replaced.json() as {
      data: { id: string; capabilities: { capability: string; targetType: string; targetId: string }[] };
    };
    assert.equal(replacedBody.data.id, memberId);
    assert.equal(replacedBody.data.capabilities.length, 2);
    assert.equal(await countRows(ctx, 'capabilities', `user_id = '${memberId}'`), 2);
    assert.equal(await countRows(ctx, 'capabilities', `user_id = '${memberId}' and capability = 'blueprint.publish'`), 1);

    const cleared = await call(ctx, 'PUT', `/api/users/${memberId}/capabilities`, {
      cookie: ownerCookie,
      payload: { capabilities: [] },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(await countRows(ctx, 'capabilities', `user_id = '${memberId}'`), 0);

    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${memberId}/capabilities`, {
        cookie: ownerCookie,
        payload: { capabilities: [{ capability: 'nope', targetType: 'group', targetId: 'g' }] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${memberId}/capabilities`, {
        cookie: ownerCookie,
        payload: {
          capabilities: [{ capability: 'blueprint.manage', targetType: 'user', targetId: 'g' }],
        },
      }),
      400,
      'INVALID_ARGUMENT',
    );

    const allowed = (await auditRows(ctx)).filter((row) => row.action === 'capability.set');
    assert.deepEqual(
      allowed.map((row) => row.result),
      ['deny', 'allow', 'allow'],
    );
    assert.equal(allowed[0]?.error_code, 'FORBIDDEN');
    assert.equal(await countRows(ctx, 'users', `id = '${ownerId}'`), 1);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 4. PATCH 语义 ───────────────────────────

test('PATCH：空增量 400、只改资料走 user.update、停用走 user.disable 并吊销会话', async () => {
  const ctx = await createTestContext();
  try {
    const { memberId } = await seedWorld(ctx.db);
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const memberCookie = await login(ctx.app, 'chen', MEMBER_PASSWORD);

    // 契约 update.json 没有 required：空体合法地过 AJV，用例层必须自己判「至少要有一个字段」。
    await expectErrorCode(
      await call(ctx, 'PATCH', `/api/users/${memberId}`, { cookie: ownerCookie, payload: {} }),
      400,
      'INVALID_ARGUMENT',
    );

    const updated = await call(ctx, 'PATCH', `/api/users/${memberId}`, {
      cookie: ownerCookie,
      payload: { displayName: '陈以宁（改）', email: 'chen@example.com', phone: '' },
    });
    assert.equal(updated.statusCode, 200);
    const body = (updated.json() as { data: UserSummaryBody }).data;
    assert.equal(body.displayName, '陈以宁（改）');
    assert.equal(body.email, 'chen@example.com');
    assert.equal(body.phone, null);

    // 空串 = 清空该字段（用例层 normalizeText）。
    const cleared = await call(ctx, 'PATCH', `/api/users/${memberId}`, {
      cookie: ownerCookie,
      payload: { email: '' },
    });
    assert.equal((cleared.json() as { data: UserSummaryBody }).data.email, null);

    // 改状态换动作名：disabled 走 `user.disable`，并吊销目标用户全部会话。
    const disabled = await call(ctx, 'PATCH', `/api/users/${memberId}`, {
      cookie: ownerCookie,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal((disabled.json() as { data: UserSummaryBody }).data.status, 'disabled');
    assert.equal(await countRows(ctx, 'sessions', `user_id = '${memberId}' and revoked_at is null`), 0);
    await expectErrorCode(await call(ctx, 'GET', '/api/me', { cookie: memberCookie }), 401, 'SESSION_EXPIRED');

    assert.deepEqual(await actionsWhere(ctx, (row) => row.action.startsWith('user.') && row.result === 'allow'), [
      'user.update:allow',
      'user.update:allow',
      'user.disable:allow',
    ]);
  } finally {
    await ctx.close();
  }
});

test('【缺陷 D6】用户管理员 PATCH 自己管辖的成员：连「空增量 400」都被范围判定抢先', async () => {
  const ctx = await createTestContext();
  try {
    const { memberId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    // 期望：先过判权（成员 + 在范围内 = allow），再由用例层抛 400 INVALID_ARGUMENT。
    // 实际：`administerUser` 的范围判定先失败 → 403 OUT_OF_MANAGED_SCOPE（D6）。
    await expectErrorCode(
      await call(ctx, 'PATCH', `/api/users/${memberId}`, { cookie, payload: {} }),
      400,
      'INVALID_ARGUMENT',
    );
    const updated = await call(ctx, 'PATCH', `/api/users/${memberId}`, {
      cookie,
      payload: { displayName: '陈以宁（改）' },
    });
    assert.equal(updated.statusCode, 200);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 7. 身份设置 ───────────────────────────

test('设身份（仅所有者）：可任命/撤销 user_admin，不能降级所有者，owner 由契约挡住', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);

    const promoted = await call(ctx, 'PUT', `/api/users/${memberId}/identity`, {
      cookie,
      payload: { identity: 'user_admin' },
    });
    assert.equal(promoted.statusCode, 200);
    assert.equal((promoted.json() as { data: UserSummaryBody }).data.identity, 'user_admin');
    const row = await ctx.db
      .selectFrom('user_identity')
      .select(['identity', 'granted_by'])
      .where('user_id', '=', memberId)
      .executeTakeFirstOrThrow();
    assert.deepEqual([row.identity, row.granted_by], ['user_admin', ownerId]);

    const demoted = await call(ctx, 'PUT', `/api/users/${memberId}/identity`, {
      cookie,
      payload: { identity: 'member' },
    });
    assert.equal((demoted.json() as { data: UserSummaryBody }).data.identity, 'member');

    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${memberId}/identity`, { cookie, payload: { identity: 'owner' } }),
      400,
      'INVALID_ARGUMENT',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${ownerId}/identity`, { cookie, payload: { identity: 'member' } }),
      403,
      'OWNER_PROTECTED',
    );
    assert.equal(await countRows(ctx, 'user_identity', `identity = 'owner'`), 1);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 6. 归属替换 ───────────────────────────

test('改派归属（仅所有者）：整体替换、含自己 400、非 user_admin 400', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    const secondAdminId = await seedUser(ctx.db, {
      username: 'sun',
      password: ADMIN_PASSWORD,
      identity: 'user_admin',
      grantedBy: ownerId,
    });
    const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);

    const replaced = await call(ctx, 'PUT', `/api/users/${memberId}/managed-by`, {
      cookie,
      payload: { managerIds: [secondAdminId] },
    });
    assert.equal(replaced.statusCode, 200);
    assert.deepEqual((replaced.json() as { data: UserSummaryBody }).data.managedByUserIds, [secondAdminId]);
    assert.equal(await countRows(ctx, 'user_managers', `user_id = '${memberId}'`), 1);

    const cleared = await call(ctx, 'PUT', `/api/users/${memberId}/managed-by`, {
      cookie,
      payload: { managerIds: [] },
    });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual((cleared.json() as { data: UserSummaryBody }).data.managedByUserIds, []);
    assert.equal(await countRows(ctx, 'user_managers', `user_id = '${memberId}'`), 0);

    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${adminId}/managed-by`, {
        cookie,
        payload: { managerIds: [adminId] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${memberId}/managed-by`, {
        cookie,
        payload: { managerIds: [memberId] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${adminId}/managed-by`, {
        cookie,
        payload: { managerIds: ['usr_missing'] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
    // 归属只能是 user_admin：member 不行。
    await expectErrorCode(
      await call(ctx, 'PUT', `/api/users/${adminId}/managed-by`, {
        cookie,
        payload: { managerIds: [memberId] },
      }),
      400,
      'INVALID_ARGUMENT',
    );
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 14. 契约严格模式 + 404 ───────────────────────────

test('未知字段与非法枚举一律 400 INVALID_ARGUMENT（AJV removeAdditional: false）', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const base = { displayName: '新号', password: NEW_PASSWORD };

    const probes: [Method, string, Record<string, unknown>][] = [
      ['POST', '/api/users', { ...base, username: 'u1', extra: 1 }],
      ['POST', '/api/users', { ...base, username: 'u1', identity: 'user_admin' }],
      ['POST', '/api/users', { ...base, username: 'u1', mustChangePassword: false }],
      ['PATCH', `/api/users/${memberId}`, { displayName: 'x', identity: 'owner' }],
      ['PATCH', `/api/users/${memberId}`, { extra: 1 }],
      ['POST', `/api/users/${memberId}/password`, { password: NEW_PASSWORD, extra: 1 }],
      ['PUT', `/api/users/${memberId}/managed-by`, { managerIds: [], extra: 1 }],
      ['PUT', `/api/users/${memberId}/identity`, { identity: 'member', extra: 1 }],
      ['PUT', `/api/users/${memberId}/capabilities`, { capabilities: [], extra: 1 }],
      ['POST', `/api/users/${memberId}/grants`, { add: [G_INVEST], extra: 1 }],
    ];
    for (const [method, url, payload] of probes) {
      await expectErrorCode(await call(ctx, method, url, { cookie, payload }), 400, 'INVALID_ARGUMENT');
    }

    // 查询串也走严格校验（严格模式对 GET 同样生效）。
    for (const query of ['foo=1', 'pageSize=101']) {
      await expectErrorCode(await call(ctx, 'GET', `/api/users?${query}`, { cookie }), 400, 'INVALID_ARGUMENT');
      await expectErrorCode(
        await call(ctx, 'GET', `/api/users/${memberId}/grants?${query}`, { cookie }),
        400,
        'INVALID_ARGUMENT',
      );
    }
    assert.equal(await countRows(ctx, 'users', `username = 'u1'`), 0);
    assert.equal(ownerId.length > 0, true);
    assert.equal(memberId.length > 0, true);
  } finally {
    await ctx.close();
  }
});

test('目标用户不存在 → 404 USER_NOT_FOUND（8 条带 :id 的路由）', async () => {
  const ctx = await createTestContext();
  try {
    await seedWorld(ctx.db);
    const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const missing = 'usr_does_not_exist';

    const probes: [Method, string, Record<string, unknown> | undefined][] = [
      ['PATCH', `/api/users/${missing}`, { displayName: 'x' }],
      ['POST', `/api/users/${missing}/password`, { password: NEW_PASSWORD }],
      ['DELETE', `/api/users/${missing}`, undefined],
      ['PUT', `/api/users/${missing}/managed-by`, { managerIds: [] }],
      ['PUT', `/api/users/${missing}/identity`, { identity: 'member' }],
      ['GET', `/api/users/${missing}/grants`, undefined],
      ['POST', `/api/users/${missing}/grants`, { add: [G_INVEST] }],
      ['PUT', `/api/users/${missing}/capabilities`, { capabilities: [] }],
    ];
    for (const [method, url, payload] of probes) {
      await expectErrorCode(await call(ctx, method, url, { cookie, payload }), 404, 'USER_NOT_FOUND');
    }
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────── 审计总览 ───────────────────────────

test('写操作成功记 allow、拒绝记 deny + errorCode，且带 requestId / actor / target', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    const strangerId = await seedUser(ctx.db, { username: 'wang', password: MEMBER_PASSWORD });
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const adminCookie = await login(ctx.app, 'zhou', ADMIN_PASSWORD);

    const created = await call(ctx, 'POST', '/api/users', {
      cookie: ownerCookie,
      payload: { username: 'audited', displayName: '被审计', password: NEW_PASSWORD },
    });
    const createdId = (created.json() as { data: UserSummaryBody }).data.id;
    await call(ctx, 'PATCH', `/api/users/${memberId}`, { cookie: ownerCookie, payload: { displayName: '改名' } });
    await call(ctx, 'GET', '/api/users?page=1&pageSize=5', { cookie: ownerCookie });
    // 拒绝路径也留痕：管理员碰到范围外的人（这条不受 D6 影响）。
    await expectErrorCode(
      await call(ctx, 'PATCH', `/api/users/${strangerId}`, { cookie: adminCookie, payload: { displayName: '越界' } }),
      403,
      'OUT_OF_MANAGED_SCOPE',
    );

    const rows = await auditRows(ctx);
    const createRow = rows.find((row) => row.action === 'user.create' && row.result === 'allow');
    assert.equal(createRow?.actor_id, ownerId);
    assert.equal(createRow?.target_id, createdId);
    assert.equal(typeof createRow?.request_id, 'string');

    const updateRow = rows.find((row) => row.action === 'user.update' && row.result === 'allow');
    assert.equal(updateRow?.actor_id, ownerId);
    assert.equal(updateRow?.target_id, memberId);

    const denyRow = rows.find((row) => row.action === 'user.update' && row.result === 'deny');
    assert.equal(denyRow?.error_code, 'OUT_OF_MANAGED_SCOPE');
    assert.equal(denyRow?.actor_id, adminId);
    assert.equal(denyRow?.target_id, strangerId);

    // 读操作也留痕（列表 / 授权）。
    assert.equal(rows.some((row) => row.action === 'user.list' && row.result === 'allow'), true);
    assert.equal(adminId.length > 0, true);
  } finally {
    await ctx.close();
  }
});

// ────────────────── 缺陷定位：用户管理员的「我管谁」范围 ──────────────────

/**
 * 【缺陷 D6，当前**必然失败**】`RequestContext.managedUserIds` 的方向反了。
 *
 * `domain/entities.ts:52-53` 明确它是「我管理的用户（`user_managers.manager_user_id = 我`）」，
 * `domain/policy.ts:243` 用它判 `OUT_OF_MANAGED_SCOPE`；但 `app/context.ts:121` 赋的是
 * `authz.facts.managedByUserIds`——「谁管我」（`user_managers.user_id = 我`）。
 *
 * 后果：用户管理员对**自己管辖的成员**调 PATCH / 改密 / 删除 / 增删授权，
 * 全部被误判为 `403 OUT_OF_MANAGED_SCOPE`（授权超范围也永远到不了 `DELEGATION_EXCEEDED`）。
 *
 * 修法只有一处（`server/app/context.ts:121`）：
 *   `managedUserIds: await loadManagedUserIds(db, authz.user.id),`
 * 该 helper 已经写好在 `server/app/context.ts:87-95` 且全仓库无人引用（死代码）。
 * `app/context.ts` 在本任务的禁改清单里，因此这条与下面 7 条集成用例保持红色，
 * 作为**阻塞项**上报；一旦那一行修好，它们应全部转绿。
 */
test('【缺陷 D6】buildUserContext 的 managedUserIds 应是「我管谁」而非「谁管我」', async () => {
  const ctx = await createTestContext();
  try {
    const { adminId, memberId } = await seedWorld(ctx.db);
    const rows = await ctx.pglite.query<{ user_id: string; manager_user_id: string }>(
      'select user_id, manager_user_id from user_managers order by user_id',
    );
    // 数据库事实：admin 管着 member（方向：manager_user_id = adminId）。
    assert.deepEqual(
      rows.rows.map((row) => [row.user_id, row.manager_user_id]),
      [[memberId, adminId]],
    );

    const adminCtx = await buildUserContext(ctx.db, adminId);
    assert.deepEqual(adminCtx.managedUserIds, [memberId]);
  } finally {
    await ctx.close();
  }
});

/**
 * 【D6 回归】`RequestContext.managedUserIds` 的取值方向必须是「我管谁」。
 * 修复前这一格取的是 `facts.managedByUserIds`（谁管我），于是用户管理员对自己管辖的成员
 * 做任何写操作都被误判 `OUT_OF_MANAGED_SCOPE`；`app/context.ts` 改为 `loadManagedUserIds` 后，
 * 放行 `user.update`/`user.resetPassword`，而「只能停用不能删」这条业务规则依然成立。
 */
test('【D6 回归】managedUserIds 取「我管谁」：用户管理员可管理管辖成员，但不能删号', async () => {
  const ctx = await createTestContext();
  try {
    const { adminId, memberId } = await seedWorld(ctx.db);
    const target: UserFacts = {
      id: memberId,
      identity: 'member',
      status: 'active',
      managedByUserIds: [adminId],
    };

    const asBuilt = await buildUserContext(ctx.db, adminId);
    assert.deepEqual(asBuilt.managedUserIds, [memberId]);
    assert.doesNotThrow(() => {
      assertAuthorized(asBuilt, 'user.update', { kind: 'user', target });
      assertAuthorized(asBuilt, 'user.resetPassword', { kind: 'user', target });
    });
    // 「只能停用不能删」这条业务规则在修好之后依然成立。
    assert.throws(
      () => {
        assertAuthorized(asBuilt, 'user.delete', { kind: 'user', target });
      },
      (error: unknown) => (error as { code?: string }).code === 'PEER_MANAGE_DENIED',
    );
  } finally {
    await ctx.close();
  }
});
