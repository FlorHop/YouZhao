/**
 * 管辖范围（`group_managers` / `blueprint_managers`）的端到端行为。
 *
 * 锁的是 `docs/permission-design.md` §2.3 的派生规则：
 *   1. 分组管辖 ⇒ 该组上发布 + 维护，并能看到该组；可在组内新建蓝图；
 *   2. 单蓝图管辖 ⇒ 只得到该蓝图的维护权，**不**能在这个分组下新建；
 *   3. 管辖只对用户管理员生效；设置管辖只有所有者可以做；
 *   4. 管辖与能力是并集：只给 manage 的用户管理员依旧建不了蓝图（「只维护不发版」）；
 *   5. 建组自授不越过「只维护不发版」——只会维护的人建完组仍然没有发版权。
 *
 * 全部走真实迁移后的 PGlite + Fastify `inject`（`test/http-helpers.ts`）。
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { buildUserContext } from '../app/context.js';
import type { Action, Resource } from '../domain/entities.js';
import { AppError } from '../domain/errors.js';
import { assertAuthorized } from '../domain/policy.js';
import { ALLOWED_ORIGIN } from './helpers.js';
import {
  ADMIN_PASSWORD,
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  createTestContext,
  expectErrorCode,
  login,
  seedWorld,
  type TestContext,
} from './http-helpers.js';

const G_INVEST = 'group_invest';
const G_OPS = 'group_ops';
const BP_OPS = 'bp_ops';

interface Actor {
  readonly id: string;
  readonly cookie: string;
}

interface Harness {
  readonly context: TestContext;
  readonly owner: Actor;
  readonly admin: Actor;
  readonly member: Actor;
}

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function makeHarness(): Promise<Harness> {
  const context = await createTestContext();
  cleanups.push(async () => {
    await context.close();
  });
  const world = await seedWorld(context.db);

  const [ownerCookie, adminCookie, memberCookie] = await Promise.all([
    login(context.app, 'owner', OWNER_PASSWORD),
    login(context.app, 'zhou', ADMIN_PASSWORD),
    login(context.app, 'chen', MEMBER_PASSWORD),
  ]);

  for (const [id, name, sortOrder] of [
    [G_INVEST, '投资研究', 10],
    [G_OPS, '运营', 20],
  ] as const) {
    await context.db
      .insertInto('blueprint_groups')
      .values({ id, name, is_default: false, sort_order: sortOrder })
      .execute();
  }
  await context.db
    .insertInto('blueprints')
    .values({
      id: BP_OPS,
      name: '运营日报',
      summary: '',
      tags: [],
      group_id: G_OPS,
      status: 'active',
      created_by_user_id: world.ownerId,
    })
    .execute();

  return {
    context,
    owner: { id: world.ownerId, cookie: ownerCookie },
    admin: { id: world.adminId, cookie: adminCookie },
    member: { id: world.memberId, cookie: memberCookie },
  };
}

async function call(
  harness: Harness,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
) {
  return await harness.context.app.inject({
    method,
    url,
    headers: { origin: ALLOWED_ORIGIN, cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function setJurisdiction(
  harness: Harness,
  userId: string,
  body: { groupIds: string[]; blueprintIds: string[] },
) {
  return await call(harness, 'PUT', `/api/users/${userId}/jurisdiction`, harness.owner.cookie, body);
}

/**
 * 判权结论（不走 multipart 上传，只问策略层）：`allow` 或拒绝的错误码。
 * 建蓝图要真实产物包才能落库，所以「能不能建」这一层在这里问，产物链路另有 blueprint-routes 用例覆盖。
 */
async function decisionFor(
  harness: Harness,
  userId: string,
  action: Extract<Action, 'blueprint.create' | 'version.publish' | 'blueprint.update'>,
  resource: Resource,
): Promise<string> {
  const context = await buildUserContext(harness.context.db, userId);
  try {
    assertAuthorized(context, action, resource);
    return 'allow';
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
}

async function meOf(harness: Harness, actor: Actor) {
  const response = await call(harness, 'GET', '/api/me', actor.cookie);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as {
    data: {
      capabilities: { capability: string; targetType: string; targetId: string }[];
      jurisdiction: { groupIds: string[]; blueprintIds: string[] };
    };
  };
}

test('分组管辖：可在组内建蓝图、可维护组内蓝图，并写入会话的管辖与有效能力', async () => {
  const harness = await makeHarness();
  const response = await setJurisdiction(harness, harness.admin.id, {
    groupIds: [G_OPS],
    blueprintIds: [],
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { data: { groups: { id: string; name: string }[] } };
  assert.deepEqual(
    body.data.groups.map((group) => group.id),
    [G_OPS],
  );

  const me = await meOf(harness, harness.admin);
  assert.deepEqual(me.data.jurisdiction.groupIds, [G_OPS]);
  assert.ok(
    me.data.capabilities.some(
      (item) =>
        item.capability === 'blueprint.publish' && item.targetType === 'group' && item.targetId === G_OPS,
    ),
    '分组管辖应派生 blueprint.publish',
  );
  assert.ok(
    me.data.capabilities.some(
      (item) =>
        item.capability === 'blueprint.manage' && item.targetType === 'group' && item.targetId === G_OPS,
    ),
    '分组管辖应派生 blueprint.manage',
  );

  assert.equal(
    await decisionFor(harness, harness.admin.id, 'blueprint.create', {
      kind: 'group',
      groupId: G_OPS,
    }),
    'allow',
  );
  // 管辖之外的分组不受影响
  assert.equal(
    await decisionFor(harness, harness.admin.id, 'blueprint.create', {
      kind: 'group',
      groupId: G_INVEST,
    }),
    'CAPABILITY_REQUIRED',
  );
});

test('单蓝图管辖：能改那一张，但不能在该分组下新建', async () => {
  const harness = await makeHarness();
  assert.equal(
    (await setJurisdiction(harness, harness.admin.id, { groupIds: [], blueprintIds: [BP_OPS] }))
      .statusCode,
    200,
  );

  const patched = await call(harness, 'PATCH', `/api/blueprints/${BP_OPS}`, harness.admin.cookie, {
    name: '运营日报（改名）',
  });
  assert.equal(patched.statusCode, 200, patched.body);

  assert.equal(
    await decisionFor(harness, harness.admin.id, 'blueprint.create', {
      kind: 'group',
      groupId: G_OPS,
    }),
    'CAPABILITY_REQUIRED',
    '单蓝图管辖不派生「在组内新建」',
  );
});

test('管辖的准入：只有所有者能设置，且只对用户管理员生效，目标必须存在', async () => {
  const harness = await makeHarness();

  const byAdmin = await call(
    harness,
    'PUT',
    `/api/users/${harness.member.id}/jurisdiction`,
    harness.admin.cookie,
    { groupIds: [], blueprintIds: [] },
  );
  await expectErrorCode(byAdmin, 403, 'FORBIDDEN');

  const forMember = await setJurisdiction(harness, harness.member.id, {
    groupIds: [G_OPS],
    blueprintIds: [],
  });
  await expectErrorCode(forMember, 400, 'INVALID_ARGUMENT');

  const missing = await setJurisdiction(harness, harness.admin.id, {
    groupIds: ['group_not_exist'],
    blueprintIds: [],
  });
  await expectErrorCode(missing, 400, 'INVALID_ARGUMENT');
});

test('「只维护不发版」：能力表只给 manage 时建不了蓝图，也拿不到发布 Token', async () => {
  const harness = await makeHarness();
  const granted = await call(
    harness,
    'PUT',
    `/api/users/${harness.admin.id}/capabilities`,
    harness.owner.cookie,
    {
      capabilities: [{ capability: 'blueprint.manage', targetType: 'group', targetId: G_OPS }],
    },
  );
  assert.equal(granted.statusCode, 200, granted.body);

  const patched = await call(harness, 'PATCH', `/api/blueprints/${BP_OPS}`, harness.admin.cookie, {
    name: '只维护也能改名',
  });
  assert.equal(patched.statusCode, 200, patched.body);

  assert.equal(
    await decisionFor(harness, harness.admin.id, 'blueprint.create', {
      kind: 'group',
      groupId: G_OPS,
    }),
    'CAPABILITY_REQUIRED',
    '只维护不发版：manage 不够',
  );

  const adminContext = await buildUserContext(harness.context.db, harness.admin.id);
  assert.equal(
    adminContext.capabilities.some((item) => item.capability === 'blueprint.publish'),
    false,
    '只维护的人不应有发布能力（发布 Token 也随之不可建）',
  );

  const token = await call(harness, 'POST', '/api/mcp-tokens', harness.admin.cookie, {
    name: '只维护不该有发布 scope',
  });
  // 只维护的人可以持有只读 Token；发布 scope 必须被拒或不在返回里
  if (token.statusCode === 200) {
    const body = token.json() as { data: { scopes?: string[] } };
    assert.ok(
      !(body.data.scopes ?? []).includes('publish:blueprint'),
      '只维护的管理员不应拿到发布 scope',
    );
  }
});

test('建组自授：只会维护的人建完组仍无发版权；建组者拿到的管辖/能力写到本人名下', async () => {
  const harness = await makeHarness();
  await call(harness, 'PUT', `/api/users/${harness.admin.id}/capabilities`, harness.owner.cookie, {
    capabilities: [{ capability: 'blueprint.manage', targetType: 'group', targetId: G_OPS }],
  });

  const created = await call(harness, 'POST', '/api/blueprint-groups', harness.admin.cookie, {
    name: '周予安新建的分组',
  });
  assert.equal(created.statusCode, 200, created.body);
  const groupId = (created.json() as { data: { group: { id: string } } }).data.group.id;

  const me = await meOf(harness, harness.admin);
  assert.deepEqual(me.data.jurisdiction.groupIds, []);
  assert.ok(
    me.data.capabilities.some(
      (item) =>
        item.capability === 'blueprint.manage' && item.targetType === 'group' && item.targetId === groupId,
    ),
    '只会维护的人建组后应得到该组的 blueprint.manage 例外授权',
  );

  assert.equal(
    await decisionFor(harness, harness.admin.id, 'blueprint.create', { kind: 'group', groupId }),
    'CAPABILITY_REQUIRED',
    '建了组也不能发版',
  );

  const capabilityRows = await harness.context.db
    .selectFrom('capabilities')
    .selectAll()
    .where('user_id', '=', harness.admin.id)
    .where('target_id', '=', groupId)
    .execute();
  assert.equal(capabilityRows.length, 1);
  assert.equal(capabilityRows[0]?.granted_by, harness.admin.id);

  const managerRows = await harness.context.db
    .selectFrom('group_managers')
    .selectAll()
    .where('user_id', '=', harness.admin.id)
    .execute();
  assert.equal(managerRows.length, 0, '没有发版权时不应落管辖');
});
