/**
 * M2「蓝图与产物」路由级端到端测试（docs/permission-design.md §6.4）。
 *
 * 这一层补齐此前**从未有过路由级验证**的部分：
 * - `server/http/routes/blueprints.ts`（含自研 multipart parser）
 * - `server/http/routes/blueprint-groups.ts`
 *
 * 断言策略：
 * - 判权结果只认「实测到的 HTTP 状态码 + 错误码 + 响应字段」，不抄注释；
 * - 上传链路一律走真实 multipart 请求体 + 真实 ZIP 字节（`zip-builder`），
 *   因此产物包校验、边界解析、错误码映射都是端到端事实；
 * - 直插 DB 只用 0003 已定义的列，产物走 `writeArtifactPackage` 落真盘。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { newId } from '../domain/ids.js';
import { writeArtifactPackage } from '../storage/artifacts.js';
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
import { SAMPLE_INDEX_HTML, buildZip } from './zip-builder.js';

const DEFAULT_GROUP_ID = 'group_default';
const BOUNDARY = '----YouzhaoBlueprintTestBoundary7d3f19';

// ── 装配 ─────────────────────────────────────────────────────────────────────

interface Actor {
  readonly id: string;
  readonly cookie: string;
}

interface Harness {
  readonly context: TestContext;
  /** 该用例独占的产物根目录（每个用例一个临时目录，避免产物互相踩） */
  readonly root: string;
  readonly owner: Actor;
  readonly admin: Actor;
  readonly member: Actor;
}

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function makeHarness(overrides: Record<string, string | undefined> = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'youzhao-blueprints-'));
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root, ...overrides });
  cleanups.push(async () => {
    await context.close();
    await rm(root, { recursive: true, force: true });
  });

  const world = await seedWorld(context.db);
  const [ownerCookie, adminCookie, memberCookie] = await Promise.all([
    login(context.app, 'owner', OWNER_PASSWORD),
    login(context.app, 'zhou', ADMIN_PASSWORD),
    login(context.app, 'chen', MEMBER_PASSWORD),
  ]);
  return {
    context,
    root,
    owner: { id: world.ownerId, cookie: ownerCookie },
    admin: { id: world.adminId, cookie: adminCookie },
    member: { id: world.memberId, cookie: memberCookie },
  };
}

type JsonPayload = Record<string, unknown>;

interface CallInput {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly cookie?: string;
  readonly payload?: JsonPayload | string | Buffer;
  readonly headers?: Record<string, string>;
}

async function inject(
  context: TestContext,
  input: CallInput,
): Promise<Awaited<ReturnType<TestContext['app']['inject']>>> {
  const headers: Record<string, string> = { origin: ALLOWED_ORIGIN, ...input.headers };
  if (input.cookie !== undefined) headers.cookie = input.cookie;
  return context.app.inject({
    method: input.method,
    url: input.url,
    headers,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
}

function expectStatus(response: { statusCode: number; body: string }, status: number): void {
  assert.equal(response.statusCode, status, `期望 ${status}，实际 ${response.statusCode}：${response.body}`);
}

function dataOf<T>(response: { json(): unknown }): T {
  return (response.json() as { data: T }).data;
}

function metaOf<T>(response: { json(): unknown }): T {
  return (response.json() as { meta: T }).meta;
}

/** 只保留错误码与消息：`requestId` 每次请求都不同，不参与「是否泄露存在性」的比较。 */
function errorOf(response: { json(): unknown }): { code: string; message: string } {
  const error = (response.json() as { error: { code: string; message: string } }).error;
  return { code: error.code, message: error.message };
}

// ── DB / 产物 seed ───────────────────────────────────────────────────────────

async function seedGroup(
  context: TestContext,
  input: { id: string; name: string; sortOrder?: number; archivedAt?: Date | null },
): Promise<void> {
  await context.db
    .insertInto('blueprint_groups')
    .values({
      id: input.id,
      name: input.name,
      is_default: false,
      sort_order: input.sortOrder ?? 10,
      archived_at: input.archivedAt ?? null,
    })
    .execute();
}

async function grantView(
  context: TestContext,
  userId: string,
  targetType: 'group' | 'blueprint',
  targetId: string,
  grantedBy: string,
): Promise<void> {
  await context.db
    .insertInto('view_grants')
    .values({
      id: newId('grn'),
      user_id: userId,
      target_type: targetType,
      target_id: targetId,
      granted_by: grantedBy,
    })
    .execute();
}

async function grantCapability(
  context: TestContext,
  userId: string,
  capability: 'blueprint.manage' | 'blueprint.publish',
  targetType: 'group' | 'blueprint',
  targetId: string,
  grantedBy: string,
): Promise<void> {
  await context.db
    .insertInto('capabilities')
    .values({
      id: newId('cap'),
      user_id: userId,
      capability,
      target_type: targetType,
      target_id: targetId,
      granted_by: grantedBy,
    })
    .execute();
}

interface SeedVersion {
  readonly version: string;
  readonly isLatest?: boolean;
  readonly archivedAt?: Date | null;
  readonly deployedAt?: Date;
  readonly indexHtml?: string;
}

interface SeedBlueprintInput {
  readonly id?: string;
  readonly name?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly groupId?: string;
  readonly status?: 'active' | 'archived';
  readonly createdByUserId?: string;
  readonly versions?: readonly SeedVersion[];
}

/** 直插一行蓝图 + 若干版本，并把真实产物落到该用例的临时根目录下。 */
async function seedBlueprint(harness: Harness, input: SeedBlueprintInput = {}): Promise<string> {
  const id = input.id ?? newId('bp');
  const status = input.status ?? 'active';
  await harness.context.db
    .insertInto('blueprints')
    .values({
      id,
      name: input.name ?? '示例蓝图',
      summary: input.summary ?? '',
      tags: [...(input.tags ?? [])],
      group_id: input.groupId ?? DEFAULT_GROUP_ID,
      status,
      created_by_user_id: input.createdByUserId ?? harness.owner.id,
      archived_at: status === 'archived' ? new Date() : null,
    })
    .execute();

  const versions = input.versions ?? [{ version: 'v1.0.0' }];
  for (const spec of versions) {
    const published = await writeArtifactPackage({
      root: harness.root,
      blueprintId: id,
      version: spec.version,
      files: [{ path: 'index.html', bytes: Buffer.from(spec.indexHtml ?? SAMPLE_INDEX_HTML) }],
      replace: false,
    });
    await harness.context.db
      .insertInto('blueprint_versions')
      .values({
        id: newId('ver'),
        blueprint_id: id,
        version: spec.version,
        is_latest: spec.isLatest ?? true,
        status: 'available',
        entry_path: 'index.html',
        artifact_path: published.artifactPath,
        artifact_hash: published.hash,
        artifact_bytes: published.bytes,
        publish_source: 'web',
        publish_note: '',
        deployed_at: spec.deployedAt ?? new Date(),
        archived_at: spec.archivedAt ?? null,
      })
      .execute();
  }
  return id;
}

// ── multipart 组装 ───────────────────────────────────────────────────────────

interface MultipartPart {
  readonly name: string;
  readonly value?: string;
  readonly filename?: string;
  readonly bytes?: Buffer;
}

function multipartBody(boundary: string, parts: readonly MultipartPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `Content-Disposition: form-data; name="${part.name}"`
        : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}\r\n\r\n`, 'utf8'));
    chunks.push(part.bytes ?? Buffer.from(part.value ?? '', 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

async function postBlueprintMultipart(
  harness: Harness,
  parts: readonly MultipartPart[],
  cookie: string,
  url = '/api/blueprints',
): Promise<Awaited<ReturnType<TestContext['app']['inject']>>> {
  return inject(harness.context, {
    method: 'POST',
    url,
    cookie,
    payload: multipartBody(BOUNDARY, parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
}

function sampleZip(): Buffer {
  return buildZip([{ path: 'index.html', data: SAMPLE_INDEX_HTML }]);
}

// ── 场景 1：GET /api/blueprints ──────────────────────────────────────────────

test('场景1a：GET /api/blueprints —— 所有者可见全部，status 筛选生效', async () => {
  const harness = await makeHarness();
  await seedGroup(harness.context, { id: 'grp_a', name: '产品组', sortOrder: 10 });
  const inDefault = await seedBlueprint(harness, { name: '默认组蓝图' });
  const inGroupA = await seedBlueprint(harness, { name: '产品组蓝图', groupId: 'grp_a' });
  const archived = await seedBlueprint(harness, { name: '已归档蓝图', groupId: 'grp_a', status: 'archived' });

  const active = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprints',
    cookie: harness.owner.cookie,
  });
  expectStatus(active, 200);
  const activeData = dataOf<{ items: Array<{ id: string }> }>(active);
  assert.deepEqual(new Set(activeData.items.map((item) => item.id)), new Set([inDefault, inGroupA]));
  assert.equal(metaOf<{ total: number }>(active).total, 2);

  const archivedList = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprints?status=archived',
    cookie: harness.owner.cookie,
  });
  expectStatus(archivedList, 200);
  const archivedData = dataOf<{ items: Array<{ id: string; status: string }> }>(archivedList);
  assert.deepEqual(archivedData.items.map((item) => item.id), [archived]);
  assert.equal(archivedData.items[0]?.status, 'archived');
  assert.equal(metaOf<{ total: number }>(archivedList).total, 1);

  // 分页元信息由路由按用例层返回值回填
  const meta = (active.json() as { meta: { page: number; pageSize: number; total: number } }).meta;
  assert.equal(meta.page, 1);
  assert.equal(meta.total, 2);
});

test('场景1b：GET /api/blueprints —— 成员只有授权范围才可见，无授权得到空列表', async () => {
  const harness = await makeHarness();
  await seedGroup(harness.context, { id: 'grp_a', name: '产品组', sortOrder: 10 });
  await seedGroup(harness.context, { id: 'grp_b', name: '运营组', sortOrder: 20 });
  const inGroupA = await seedBlueprint(harness, { name: '产品组蓝图', groupId: 'grp_a' });
  await seedBlueprint(harness, { name: '运营组蓝图', groupId: 'grp_b' });
  await seedBlueprint(harness, { name: '默认组蓝图' });

  await grantView(harness.context, harness.member.id, 'group', 'grp_a', harness.owner.id);

  const scoped = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprints',
    cookie: harness.member.cookie,
  });
  expectStatus(scoped, 200);
  const scopedData = dataOf<{ items: Array<{ id: string }> }>(scoped);
  assert.deepEqual(scopedData.items.map((item) => item.id), [inGroupA]);
  assert.equal(metaOf<{ total: number }>(scoped).total, 1);

  // 分组卡片不得泄露未授权分组名：成员只拿到自己被授权分组（grp_a）的卡片。
  const scopedGroups = dataOf<{ groups: Array<{ id: string }> }>(scoped).groups;
  assert.deepEqual(scopedGroups.map((group) => group.id), ['grp_a']);

  const outsiderId = await seedUser(harness.context.db, {
    username: 'song',
    password: 'song-pass-1234',
    displayName: '宋某',
  });
  const outsiderCookie = await login(harness.context.app, 'song', 'song-pass-1234');
  assert.equal(outsiderId.startsWith('usr_'), true);

  const empty = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprints',
    cookie: outsiderCookie,
  });
  expectStatus(empty, 200);
  const emptyData = dataOf<{ items: unknown[] }>(empty);
  assert.deepEqual(emptyData.items, []);
  assert.equal(metaOf<{ total: number }>(empty).total, 0);

  // 无任何授权者：items 为空，groups 也必须为空 —— 曾经这里回全量分组（默认/产品/运营），
  // 等于把「存在哪些分组」这种组织信息泄露给无权限成员；现按 canView 过滤，故断言空集。
  const emptyGroups = dataOf<{ groups: Array<{ id: string }> }>(empty).groups;
  assert.deepEqual(emptyGroups, []);
});

// ── 场景 2：GET /api/blueprints/:id ─────────────────────────────────────────

test('场景2：GET /api/blueprints/:id —— 不可见与不存在都返回 404 BLUEPRINT_NOT_FOUND', async () => {
  const harness = await makeHarness();
  await seedGroup(harness.context, { id: 'grp_a', name: '产品组', sortOrder: 10 });
  const hidden = await seedBlueprint(harness, { groupId: 'grp_a' });

  const invisible = await inject(harness.context, {
    method: 'GET',
    url: `/api/blueprints/${hidden}`,
    cookie: harness.member.cookie,
  });
  await expectErrorCode(invisible, 404, 'BLUEPRINT_NOT_FOUND');

  const missing = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprints/bp_does_not_exist',
    cookie: harness.member.cookie,
  });
  await expectErrorCode(missing, 404, 'BLUEPRINT_NOT_FOUND');

  // 不得靠错误体区分「有但看不见」与「不存在」：只比较错误码与消息
  assert.deepEqual(errorOf(invisible), errorOf(missing));
  assert.deepEqual(errorOf(missing), { code: 'BLUEPRINT_NOT_FOUND', message: '蓝图不存在' });

  const ownerMissing = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprints/bp_does_not_exist',
    cookie: harness.owner.cookie,
  });
  await expectErrorCode(ownerMissing, 404, 'BLUEPRINT_NOT_FOUND');

  const ownerVisible = await inject(harness.context, {
    method: 'GET',
    url: `/api/blueprints/${hidden}`,
    cookie: harness.owner.cookie,
  });
  expectStatus(ownerVisible, 200);
  const detail = dataOf<{
    blueprint: { id: string };
    capabilities: { canManage: boolean; canPublish: boolean };
  }>(ownerVisible);
  assert.equal(detail.blueprint.id, hidden);
  assert.equal(detail.capabilities.canManage, true);
  assert.equal(detail.capabilities.canPublish, true);

  // 授权之后成员才看得到（证明上一步是「不可见」而不是「不存在」）
  await grantView(harness.context, harness.member.id, 'group', 'grp_a', harness.owner.id);
  const afterGrant = await inject(harness.context, {
    method: 'GET',
    url: `/api/blueprints/${hidden}`,
    cookie: harness.member.cookie,
  });
  expectStatus(afterGrant, 200);
  const memberDetail = dataOf<{ capabilities: { canManage: boolean; canPublish: boolean } }>(afterGrant);
  assert.equal(memberDetail.capabilities.canManage, false);
  assert.equal(memberDetail.capabilities.canPublish, false);
});

// ── 场景 3：GET /api/blueprint-groups ───────────────────────────────────────

test('场景3：GET /api/blueprint-groups —— 只返回授权范围内的分组，blueprintCount 准确', async () => {
  const harness = await makeHarness();
  await seedGroup(harness.context, { id: 'grp_a', name: '产品组', sortOrder: 10 });
  await seedGroup(harness.context, { id: 'grp_b', name: '运营组', sortOrder: 20 });
  await seedGroup(harness.context, { id: 'grp_archived', name: '已归档组', sortOrder: 30, archivedAt: new Date() });
  await seedBlueprint(harness, { name: 'A1', groupId: 'grp_a' });
  await seedBlueprint(harness, { name: 'A2', groupId: 'grp_a' });
  await seedBlueprint(harness, { name: 'A-已归档', groupId: 'grp_a', status: 'archived' });
  await seedBlueprint(harness, { name: 'B1', groupId: 'grp_b' });
  await seedBlueprint(harness, { name: 'C1', groupId: 'grp_archived' });

  const ownerList = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprint-groups',
    cookie: harness.owner.cookie,
  });
  expectStatus(ownerList, 200);
  const ownerItems = dataOf<{
    items: Array<{ id: string; isDefault: boolean; blueprintCount: number }>;
  }>(ownerList).items;
  const ownerCounts = new Map(ownerItems.map((item) => [item.id, item.blueprintCount]));
  assert.equal(ownerItems[0]?.id, DEFAULT_GROUP_ID);
  assert.equal(ownerItems[0]?.isDefault, true);
  assert.equal(ownerCounts.get(DEFAULT_GROUP_ID), 0);
  assert.equal(ownerCounts.get('grp_a'), 2); // 归档蓝图不计入
  assert.equal(ownerCounts.get('grp_b'), 1);
  assert.equal(ownerCounts.get('grp_archived'), 1);

  await grantView(harness.context, harness.member.id, 'group', 'grp_a', harness.owner.id);
  const memberList = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprint-groups',
    cookie: harness.member.cookie,
  });
  expectStatus(memberList, 200);
  const memberItems = dataOf<{
    items: Array<{ id: string; name: string; blueprintCount: number }>;
  }>(memberList).items;
  assert.deepEqual(memberItems.map((item) => item.id), ['grp_a']);
  assert.equal(memberItems[0]?.blueprintCount, 2);
  assert.equal(memberItems[0]?.name, '产品组');

  const outsiderId = await seedUser(harness.context.db, {
    username: 'song',
    password: 'song-pass-1234',
  });
  assert.equal(outsiderId.startsWith('usr_'), true);
  const outsiderCookie = await login(harness.context.app, 'song', 'song-pass-1234');
  const outsiderList = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprint-groups',
    cookie: outsiderCookie,
  });
  expectStatus(outsiderList, 200);
  assert.deepEqual(dataOf<{ items: unknown[] }>(outsiderList).items, []);
});

// ── 场景 4：POST /api/blueprint-groups ──────────────────────────────────────

test('场景4：POST /api/blueprint-groups —— 缺能力 403、重名 409、成功建组并补授权', async () => {
  const harness = await makeHarness();

  const denied = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprint-groups',
    cookie: harness.member.cookie,
    payload: { name: '成员想建的组' },
  });
  await expectErrorCode(denied, 403, 'CAPABILITY_REQUIRED');

  const created = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprint-groups',
    cookie: harness.owner.cookie,
    payload: { name: '研发组' },
  });
  expectStatus(created, 200);
  const group = dataOf<{ group: { id: string; name: string; isDefault: boolean; sortOrder: number } }>(
    created,
  ).group;
  assert.equal(group.name, '研发组');
  assert.equal(group.isDefault, false);
  assert.equal(group.sortOrder, 10); // 默认分组 0 → 下一个 10

  const duplicate = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprint-groups',
    cookie: harness.owner.cookie,
    payload: { name: '研发组' },
  });
  await expectErrorCode(duplicate, 409, 'GROUP_CONFLICT');

  // 所有者隐式可见全部分组，不写授权行（见 docs/architecture-design.md）
  const grants = await harness.context.db
    .selectFrom('view_grants')
    .selectAll()
    .where('target_type', '=', 'group')
    .where('target_id', '=', group.id)
    .execute();
  assert.deepEqual(
    grants.map((row) => row.user_id),
    [],
  );

  // 只持 blueprint.manage 的用户也能建组（group.create 判的是「是否持有该能力」）
  await grantCapability(harness.context, harness.admin.id, 'blueprint.manage', 'group', DEFAULT_GROUP_ID, harness.owner.id);
  const adminCreated = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprint-groups',
    cookie: harness.admin.cookie,
    payload: { name: '市场组', sortOrder: 30 },
  });
  expectStatus(adminCreated, 200);
  const adminGroup = dataOf<{ group: { id: string; sortOrder: number } }>(adminCreated).group;
  assert.equal(adminGroup.sortOrder, 30);
  const adminGrants = await harness.context.db
    .selectFrom('view_grants')
    .selectAll()
    .where('target_type', '=', 'group')
    .where('target_id', '=', adminGroup.id)
    .execute();
  assert.deepEqual(adminGrants.map((row) => row.user_id), [harness.admin.id]);
});

// ── 场景 5：PATCH /api/blueprint-groups/reorder ─────────────────────────────

test('场景5：PATCH /api/blueprint-groups/reorder —— 全集不一致 400，默认分组恒在首位', async () => {
  const harness = await makeHarness();
  await seedGroup(harness.context, { id: 'grp_a', name: '产品组', sortOrder: 10 });
  await seedGroup(harness.context, { id: 'grp_b', name: '运营组', sortOrder: 20 });

  const incomplete = await inject(harness.context, {
    method: 'PATCH',
    url: '/api/blueprint-groups/reorder',
    cookie: harness.owner.cookie,
    payload: { orderedIds: ['grp_a'] },
  });
  await expectErrorCode(incomplete, 400, 'INVALID_ARGUMENT');

  const withDefault = await inject(harness.context, {
    method: 'PATCH',
    url: '/api/blueprint-groups/reorder',
    cookie: harness.owner.cookie,
    payload: { orderedIds: [DEFAULT_GROUP_ID, 'grp_b', 'grp_a'] },
  });
  await expectErrorCode(withDefault, 400, 'INVALID_ARGUMENT');

  const duplicated = await inject(harness.context, {
    method: 'PATCH',
    url: '/api/blueprint-groups/reorder',
    cookie: harness.owner.cookie,
    payload: { orderedIds: ['grp_a', 'grp_a'] },
  });
  await expectErrorCode(duplicated, 400, 'INVALID_ARGUMENT');

  const denied = await inject(harness.context, {
    method: 'PATCH',
    url: '/api/blueprint-groups/reorder',
    cookie: harness.member.cookie,
    payload: { orderedIds: ['grp_b', 'grp_a'] },
  });
  await expectErrorCode(denied, 403, 'CAPABILITY_REQUIRED');

  // 「全集一致」是入参校验，先于判权：无权限者传错集合也先得 400，而不是 403
  const deniedIncomplete = await inject(harness.context, {
    method: 'PATCH',
    url: '/api/blueprint-groups/reorder',
    cookie: harness.member.cookie,
    payload: { orderedIds: ['grp_a'] },
  });
  await expectErrorCode(deniedIncomplete, 400, 'INVALID_ARGUMENT');

  const reordered = await inject(harness.context, {
    method: 'PATCH',
    url: '/api/blueprint-groups/reorder',
    cookie: harness.owner.cookie,
    payload: { orderedIds: ['grp_b', 'grp_a'] },
  });
  expectStatus(reordered, 200);
  const items = dataOf<{ items: Array<{ id: string; isDefault: boolean }> }>(reordered).items;
  assert.equal(items[0]?.id, DEFAULT_GROUP_ID);
  assert.equal(items[0]?.isDefault, true);
  assert.deepEqual(
    items.map((item) => item.id),
    [DEFAULT_GROUP_ID, 'grp_b', 'grp_a'],
  );

  const rows = await harness.context.db
    .selectFrom('blueprint_groups')
    .select(['id', 'sort_order'])
    .execute();
  const sortOrder = new Map(rows.map((row) => [row.id, row.sort_order]));
  assert.equal(sortOrder.get(DEFAULT_GROUP_ID), 0);
  assert.equal(sortOrder.get('grp_b'), 10);
  assert.equal(sortOrder.get('grp_a'), 20);
});

// ── 场景 6：DELETE /api/blueprint-groups/:id ────────────────────────────────

test('场景6：DELETE /api/blueprint-groups/:id —— 蓝图回落默认分组，默认分组不可归档', async () => {
  const harness = await makeHarness();
  await seedGroup(harness.context, { id: 'grp_a', name: '产品组', sortOrder: 10 });
  const active1 = await seedBlueprint(harness, { name: 'A1', groupId: 'grp_a' });
  const active2 = await seedBlueprint(harness, { name: 'A2', groupId: 'grp_a' });
  const archivedBp = await seedBlueprint(harness, { name: 'A-已归档', groupId: 'grp_a', status: 'archived' });
  await grantView(harness.context, harness.member.id, 'group', 'grp_a', harness.owner.id);
  await grantCapability(harness.context, harness.admin.id, 'blueprint.manage', 'group', 'grp_a', harness.owner.id);

  const denied = await inject(harness.context, {
    method: 'DELETE',
    url: '/api/blueprint-groups/grp_a',
    cookie: harness.member.cookie,
  });
  await expectErrorCode(denied, 403, 'CAPABILITY_REQUIRED');

  const defaultProtected = await inject(harness.context, {
    method: 'DELETE',
    url: `/api/blueprint-groups/${DEFAULT_GROUP_ID}`,
    cookie: harness.owner.cookie,
  });
  await expectErrorCode(defaultProtected, 400, 'INVALID_ARGUMENT');

  const archivedGroup = await inject(harness.context, {
    method: 'DELETE',
    url: '/api/blueprint-groups/grp_a',
    cookie: harness.owner.cookie,
  });
  expectStatus(archivedGroup, 200);
  const mutation = dataOf<{
    group: { id: string; archivedAt: string | null };
    movedBlueprintIds: string[];
  }>(archivedGroup);
  assert.equal(mutation.group.archivedAt === null, false);
  assert.deepEqual(new Set(mutation.movedBlueprintIds), new Set([active1, active2]));

  const moved = await harness.context.db
    .selectFrom('blueprints')
    .select(['id', 'group_id'])
    .where('id', 'in', [active1, active2, archivedBp])
    .execute();
  const groupOf = new Map(moved.map((row) => [row.id, row.group_id]));
  assert.equal(groupOf.get(active1), DEFAULT_GROUP_ID);
  assert.equal(groupOf.get(active2), DEFAULT_GROUP_ID);
  // 已归档蓝图不在回落范围内（只动 status = 'active' 的行）
  assert.equal(groupOf.get(archivedBp), 'grp_a');

  // 任务描述里写的是「该分组的 view_grants 被移除」，但本仓设计裁决 4
  // （docs/permission-design.md:399）与不变量 11 明确要求「授权记录保留、整体可恢复」，
  // 源码注释（server/app/blueprints.ts:470）也照此实现 —— 这里以设计文档为准断言保留。
  const grants = await harness.context.db
    .selectFrom('view_grants')
    .selectAll()
    .where('target_type', '=', 'group')
    .where('target_id', '=', 'grp_a')
    .execute();
  assert.deepEqual(grants.map((row) => row.user_id), [harness.member.id]);

  const capabilityRows = await harness.context.db
    .selectFrom('capabilities')
    .selectAll()
    .where('target_type', '=', 'group')
    .where('target_id', '=', 'grp_a')
    .execute();
  assert.deepEqual(capabilityRows.map((row) => row.user_id), [harness.admin.id]);
});

// ── 场景 7：POST /api/blueprint-groups/:id/restore ──────────────────────────

test('场景7：POST /api/blueprint-groups/:id/restore —— 恢复分组与授权', async () => {
  const harness = await makeHarness();
  await seedGroup(harness.context, { id: 'grp_a', name: '产品组', sortOrder: 10 });
  const blueprintId = await seedBlueprint(harness, { groupId: 'grp_a' });
  await grantView(harness.context, harness.member.id, 'group', 'grp_a', harness.owner.id);

  const archived = await inject(harness.context, {
    method: 'DELETE',
    url: '/api/blueprint-groups/grp_a',
    cookie: harness.owner.cookie,
  });
  expectStatus(archived, 200);
  assert.equal(dataOf<{ group: { archivedAt: string | null } }>(archived).group.archivedAt === null, false);

  const denied = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprint-groups/grp_a/restore',
    cookie: harness.member.cookie,
  });
  await expectErrorCode(denied, 403, 'CAPABILITY_REQUIRED');

  const restored = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprint-groups/grp_a/restore',
    cookie: harness.owner.cookie,
  });
  expectStatus(restored, 200);
  const group = dataOf<{ group: { id: string; archivedAt: string | null }; movedBlueprintIds: string[] }>(
    restored,
  );
  assert.equal(group.group.id, 'grp_a');
  assert.equal(group.group.archivedAt, null);

  // 授权随分组一起恢复可见；蓝图不回迁（设计裁决 4：由人工重新归位）
  const memberGroups = await inject(harness.context, {
    method: 'GET',
    url: '/api/blueprint-groups',
    cookie: harness.member.cookie,
  });
  expectStatus(memberGroups, 200);
  assert.deepEqual(
    dataOf<{ items: Array<{ id: string }> }>(memberGroups).items.map((item) => item.id),
    ['grp_a'],
  );

  const blueprintRow = await harness.context.db
    .selectFrom('blueprints')
    .select(['group_id'])
    .where('id', '=', blueprintId)
    .executeTakeFirstOrThrow();
  assert.equal(blueprintRow.group_id, DEFAULT_GROUP_ID);

  const missing = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprint-groups/grp_missing/restore',
    cookie: harness.owner.cookie,
  });
  await expectErrorCode(missing, 404, 'GROUP_NOT_FOUND');
});

// ── 场景 8：POST /api/blueprints（multipart） ───────────────────────────────

test('场景8a：POST /api/blueprints —— multipart 上传成功，publish_source=web 且创建者获得查看授权', async () => {
  const harness = await makeHarness();
  await grantCapability(
    harness.context,
    harness.admin.id,
    'blueprint.publish',
    'group',
    DEFAULT_GROUP_ID,
    harness.owner.id,
  );

  const response = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '上传的蓝图' },
      { name: 'summary', value: '通过 multipart 创建' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'tags', value: JSON.stringify(['上传', '测试']) },
      { name: 'artifact', filename: 'bundle.zip', bytes: sampleZip() },
    ],
    harness.admin.cookie,
  );
  expectStatus(response, 200);
  const data = dataOf<{
    blueprint: { id: string; name: string; groupId: string; status: string; tags: string[] };
    version: { version: string; isLatest: boolean; publishSource: string };
  }>(response);
  assert.equal(data.blueprint.name, '上传的蓝图');
  assert.equal(data.blueprint.groupId, DEFAULT_GROUP_ID);
  assert.equal(data.blueprint.status, 'active');
  assert.deepEqual(data.blueprint.tags, ['上传', '测试']);
  assert.equal(data.version.version, 'v1.0.0');
  assert.equal(data.version.isLatest, true);
  assert.equal(data.version.publishSource, 'web');

  const grants = await harness.context.db
    .selectFrom('view_grants')
    .selectAll()
    .where('target_type', '=', 'blueprint')
    .where('target_id', '=', data.blueprint.id)
    .execute();
  assert.deepEqual(grants.map((row) => row.user_id), [harness.admin.id]);

  // 缺 blueprint.publish 的成员不能建蓝图
  const denied = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '越权蓝图' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: sampleZip() },
    ],
    harness.member.cookie,
  );
  await expectErrorCode(denied, 403, 'CAPABILITY_REQUIRED');
});

test('场景8b：POST /api/blueprints —— 缺 zip 文件 → 400 ARTIFACT_INVALID', async () => {
  const harness = await makeHarness();
  const response = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '没有产物' },
      { name: 'version', value: 'v1.0.0' },
    ],
    harness.owner.cookie,
  );
  await expectErrorCode(response, 400, 'ARTIFACT_INVALID');
});

test('场景8c：POST /api/blueprints —— 包内没有根级 index.html → 400 ARTIFACT_INVALID', async () => {
  const harness = await makeHarness();
  const zip = buildZip([{ path: 'site/index.html', data: SAMPLE_INDEX_HTML }]);
  const response = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '入口不在根' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: zip },
    ],
    harness.owner.cookie,
  );
  await expectErrorCode(response, 400, 'ARTIFACT_INVALID');
});

test('场景8d：POST /api/blueprints —— 包内 .. 穿越或绝对路径 → 400 ARTIFACT_INVALID', async () => {
  const harness = await makeHarness();
  const traversal = buildZip([
    { path: 'index.html', data: SAMPLE_INDEX_HTML },
    { path: '../escape.html', data: '<p>escape</p>' },
  ]);
  const traversalResponse = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '穿越包' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: traversal },
    ],
    harness.owner.cookie,
  );
  await expectErrorCode(traversalResponse, 400, 'ARTIFACT_INVALID');

  const absolute = buildZip([
    { path: 'index.html', data: SAMPLE_INDEX_HTML },
    { path: '/etc/passwd', data: 'root:x:0:0' },
  ]);
  const absoluteResponse = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '绝对路径包' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: absolute },
    ],
    harness.owner.cookie,
  );
  await expectErrorCode(absoluteResponse, 400, 'ARTIFACT_INVALID');

  // 失败不留半成品：库里没有蓝图
  const rows = await harness.context.db.selectFrom('blueprints').select(['id']).execute();
  assert.deepEqual(rows, []);
});

// ── 场景 9：POST /api/blueprints/:id/versions ───────────────────────────────

test('场景9：POST /api/blueprints/:id/versions —— 重复版本号 409，成功后旧版本不再是 latest', async () => {
  const harness = await makeHarness();
  const blueprintId = await seedBlueprint(harness, { versions: [{ version: 'v1.0.0', isLatest: true }] });
  const versionsUrl = `/api/blueprints/${blueprintId}/versions`;

  const duplicate = await postBlueprintMultipart(
    harness,
    [
      { name: 'version', value: 'v1.0.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: sampleZip() },
    ],
    harness.owner.cookie,
    versionsUrl,
  );
  await expectErrorCode(duplicate, 409, 'VERSION_CONFLICT');

  const published = await postBlueprintMultipart(
    harness,
    [
      { name: 'version', value: 'v1.1.0' },
      { name: 'publishNote', value: '第二版' },
      { name: 'artifact', filename: 'bundle.zip', bytes: sampleZip() },
    ],
    harness.owner.cookie,
    versionsUrl,
  );
  expectStatus(published, 200);
  const publishedData = dataOf<{ version: { version: string; isLatest: boolean; publishSource: string } }>(
    published,
  );
  assert.equal(publishedData.version.version, 'v1.1.0');
  assert.equal(publishedData.version.isLatest, true);
  assert.equal(publishedData.version.publishSource, 'web');

  // version.publish 需要 blueprint.publish 覆盖该蓝图所在分组
  const denied = await postBlueprintMultipart(
    harness,
    [
      { name: 'version', value: 'v1.2.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: sampleZip() },
    ],
    harness.member.cookie,
    versionsUrl,
  );
  await expectErrorCode(denied, 403, 'CAPABILITY_REQUIRED');

  const detail = await inject(harness.context, {
    method: 'GET',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.owner.cookie,
  });
  expectStatus(detail, 200);
  const versions = dataOf<{ versions: Array<{ version: string; isLatest: boolean }> }>(detail).versions;
  const latestOf = new Map(versions.map((item) => [item.version, item.isLatest]));
  assert.equal(latestOf.get('v1.1.0'), true);
  assert.equal(latestOf.get('v1.0.0'), false);
});

// ── 场景 10：PUT /api/blueprints/:id/versions/:version ──────────────────────

test('场景10：PUT /api/blueprints/:id/versions/:version —— 覆盖：版本号不变、publish_source=web-cover、产物被替换', async () => {
  const harness = await makeHarness();
  const original = '<!doctype html><html><body>原始内容</body></html>';
  const covered = '<!doctype html><html><body>覆盖后的内容</body></html>';
  const blueprintId = await seedBlueprint(harness, {
    versions: [{ version: 'v1.0.0', isLatest: true, indexHtml: original }],
  });

  const response = await inject(harness.context, {
    method: 'PUT',
    url: `/api/blueprints/${blueprintId}/versions/v1.0.0`,
    cookie: harness.owner.cookie,
    payload: { publishNote: '运维覆盖' },
    headers: { 'content-type': 'application/json' },
  });
  // 覆盖接口没有 multipart 变体（路由只挂 JSON body schema），因此这里走的是「缺产物包」
  await expectErrorCode(response, 400, 'ARTIFACT_INVALID');

  const coveredResponse = await inject(harness.context, {
    method: 'PUT',
    url: `/api/blueprints/${blueprintId}/versions/v1.0.0`,
    cookie: harness.owner.cookie,
    payload: multipartBody(BOUNDARY, [
      { name: 'publishNote', value: '运维覆盖' },
      {
        name: 'artifact',
        filename: 'bundle.zip',
        bytes: buildZip([{ path: 'index.html', data: covered }]),
      },
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
  expectStatus(coveredResponse, 200);
  const data = dataOf<{
    version: { version: string; isLatest: boolean; publishSource: string; publishNote: string; artifactBytes: number };
  }>(coveredResponse);
  assert.equal(data.version.version, 'v1.0.0');
  assert.equal(data.version.isLatest, true);
  assert.equal(data.version.publishSource, 'web-cover');
  assert.equal(data.version.publishNote, '运维覆盖');

  // 产物确实被替换（读盘比对）
  const onDisk = await readFile(path.join(harness.root, blueprintId, 'v1.0.0', 'index.html'), 'utf8');
  assert.equal(onDisk, covered);

  const memberDenied = await inject(harness.context, {
    method: 'PUT',
    url: `/api/blueprints/${blueprintId}/versions/v1.0.0`,
    cookie: harness.member.cookie,
    payload: multipartBody(BOUNDARY, [
      { name: 'artifact', filename: 'bundle.zip', bytes: buildZip([{ path: 'index.html', data: covered }]) },
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
  await expectErrorCode(memberDenied, 403, 'CAPABILITY_REQUIRED');

  const missingVersion = await inject(harness.context, {
    method: 'PUT',
    url: `/api/blueprints/${blueprintId}/versions/v9.9.9`,
    cookie: harness.owner.cookie,
    payload: multipartBody(BOUNDARY, [
      { name: 'artifact', filename: 'bundle.zip', bytes: sampleZip() },
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
  await expectErrorCode(missingVersion, 404, 'VERSION_NOT_FOUND');
});

// ── 场景 11：DELETE /api/blueprints/:id/versions/:version ───────────────────

test('场景11：DELETE /api/blueprints/:id/versions/:version —— 最后一个版本受保护，删非最后版本转移 is_latest', async () => {
  const harness = await makeHarness();
  const older = new Date(Date.now() - 60_000);
  const blueprintId = await seedBlueprint(harness, {
    versions: [
      { version: 'v1.0.0', isLatest: false, deployedAt: older },
      { version: 'v2.0.0', isLatest: true },
    ],
  });

  const removed = await inject(harness.context, {
    method: 'DELETE',
    url: `/api/blueprints/${blueprintId}/versions/v2.0.0`,
    cookie: harness.owner.cookie,
  });
  expectStatus(removed, 200);
  const removedData = dataOf<{ version: { version: string; archivedAt: string | null } }>(removed);
  assert.equal(removedData.version.version, 'v2.0.0');
  assert.equal(removedData.version.archivedAt === null, false);

  const detail = await inject(harness.context, {
    method: 'GET',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.owner.cookie,
  });
  expectStatus(detail, 200);
  const versions = dataOf<{ versions: Array<{ version: string; isLatest: boolean }> }>(detail).versions;
  const latestOf = new Map(versions.map((item) => [item.version, item.isLatest]));
  assert.equal(latestOf.get('v1.0.0'), true);
  assert.equal(latestOf.get('v2.0.0'), false);

  const lastOne = await inject(harness.context, {
    method: 'DELETE',
    url: `/api/blueprints/${blueprintId}/versions/v1.0.0`,
    cookie: harness.owner.cookie,
  });
  await expectErrorCode(lastOne, 409, 'LAST_VERSION_PROTECTED');

  const denied = await inject(harness.context, {
    method: 'DELETE',
    url: `/api/blueprints/${blueprintId}/versions/v1.0.0`,
    cookie: harness.member.cookie,
  });
  await expectErrorCode(denied, 403, 'CAPABILITY_REQUIRED');

  const missing = await inject(harness.context, {
    method: 'DELETE',
    url: `/api/blueprints/${blueprintId}/versions/v9.9.9`,
    cookie: harness.owner.cookie,
  });
  await expectErrorCode(missing, 404, 'VERSION_NOT_FOUND');
});

// ── 场景 12：PATCH /api/blueprints/:id ──────────────────────────────────────

test('场景12a：PATCH /api/blueprints/:id —— 改元数据；空请求体 400', async () => {
  const harness = await makeHarness();
  const blueprintId = await seedBlueprint(harness, { name: '旧名字', summary: '旧摘要' });

  const empty = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.owner.cookie,
    payload: {},
  });
  await expectErrorCode(empty, 400, 'INVALID_ARGUMENT');

  const updated = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.owner.cookie,
    payload: { name: '新名字', summary: '新摘要', tags: ['一班', '二班'] },
  });
  expectStatus(updated, 200);
  const blueprint = dataOf<{
    blueprint: { id: string; name: string; summary: string; tags: string[]; status: string };
  }>(updated).blueprint;
  assert.equal(blueprint.name, '新名字');
  assert.equal(blueprint.summary, '新摘要');
  assert.deepEqual(blueprint.tags, ['一班', '二班']);
  assert.equal(blueprint.status, 'active');
});

test('场景12b：PATCH /api/blueprints/:id —— 移动分组需源与目标都有 blueprint.manage', async () => {
  const harness = await makeHarness();
  await seedGroup(harness.context, { id: 'grp_a', name: '源组', sortOrder: 10 });
  await seedGroup(harness.context, { id: 'grp_b', name: '目标组', sortOrder: 20 });
  await seedGroup(harness.context, { id: 'grp_c', name: '未授权源组', sortOrder: 30 });
  const inGroupA = await seedBlueprint(harness, { name: 'A 里的蓝图', groupId: 'grp_a' });
  const inGroupC = await seedBlueprint(harness, { name: 'C 里的蓝图', groupId: 'grp_c' });

  // 只有源组能力 → 拒绝（目标缺能力）
  await grantCapability(harness.context, harness.admin.id, 'blueprint.manage', 'group', 'grp_a', harness.owner.id);
  const deniedTarget = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${inGroupA}`,
    cookie: harness.admin.cookie,
    payload: { groupId: 'grp_b' },
  });
  await expectErrorCode(deniedTarget, 403, 'CAPABILITY_REQUIRED');

  // 只有目标组能力 → 拒绝（源缺能力）
  await grantCapability(harness.context, harness.admin.id, 'blueprint.manage', 'group', 'grp_b', harness.owner.id);
  const deniedSource = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${inGroupC}`,
    cookie: harness.admin.cookie,
    payload: { groupId: 'grp_b' },
  });
  await expectErrorCode(deniedSource, 403, 'CAPABILITY_REQUIRED');

  // 源与目标都有 → 放行
  const moved = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${inGroupA}`,
    cookie: harness.admin.cookie,
    payload: { groupId: 'grp_b' },
  });
  expectStatus(moved, 200);
  const blueprint = dataOf<{ blueprint: { groupId: string; groupName: string } }>(moved).blueprint;
  assert.equal(blueprint.groupId, 'grp_b');
  assert.equal(blueprint.groupName, '目标组');

  // 移入已归档分组 → 400
  const archivedGroup = await inject(harness.context, {
    method: 'DELETE',
    url: '/api/blueprint-groups/grp_c',
    cookie: harness.owner.cookie,
  });
  expectStatus(archivedGroup, 200);
  const intoArchived = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${inGroupA}`,
    cookie: harness.owner.cookie,
    payload: { groupId: 'grp_c' },
  });
  await expectErrorCode(intoArchived, 400, 'INVALID_ARGUMENT');
});

test('场景12c：PATCH /api/blueprints/:id —— 归档与恢复（版本跟随）', async () => {
  const harness = await makeHarness();
  const blueprintId = await seedBlueprint(harness, { versions: [{ version: 'v1.0.0' }] });

  const archived = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.owner.cookie,
    payload: { status: 'archived' },
  });
  expectStatus(archived, 200);
  const archivedData = dataOf<{ blueprint: { status: string; archivedAt: string | null } }>(archived);
  assert.equal(archivedData.blueprint.status, 'archived');
  assert.equal(archivedData.blueprint.archivedAt === null, false);

  const versionRows = await harness.context.db
    .selectFrom('blueprint_versions')
    .select(['archived_at'])
    .where('blueprint_id', '=', blueprintId)
    .execute();
  assert.equal(versionRows.length, 1);
  assert.equal(versionRows[0]?.archived_at === null, false);

  const denied = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.member.cookie,
    payload: { status: 'active' },
  });
  await expectErrorCode(denied, 403, 'CAPABILITY_REQUIRED');

  const restored = await inject(harness.context, {
    method: 'PATCH',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.owner.cookie,
    payload: { status: 'active' },
  });
  expectStatus(restored, 200);
  const restoredData = dataOf<{ blueprint: { status: string; archivedAt: string | null } }>(restored);
  assert.equal(restoredData.blueprint.status, 'active');
  assert.equal(restoredData.blueprint.archivedAt, null);
});

// ── 场景 13：multipart 健壮性 ──────────────────────────────────────────────

test('场景13a：multipart 损坏输入一律 400 INVALID_ARGUMENT（tags 非法 JSON 不再回落 500）', async () => {
  const harness = await makeHarness();

  const badTags = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '坏 tags' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'tags', value: '{不是合法 JSON' },
      { name: 'artifact', filename: 'bundle.zip', bytes: sampleZip() },
    ],
    harness.owner.cookie,
  );
  await expectErrorCode(badTags, 400, 'INVALID_ARGUMENT');

  const unknownField = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '多处一个字段' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: sampleZip() },
      { name: 'bogus', value: '不该被接受' },
    ],
    harness.owner.cookie,
  );
  await expectErrorCode(unknownField, 400, 'INVALID_ARGUMENT');

  // 缺 boundary 参数
  const noBoundary = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprints',
    cookie: harness.owner.cookie,
    payload: 'whatever',
    headers: { 'content-type': 'multipart/form-data' },
  });
  await expectErrorCode(noBoundary, 400, 'INVALID_ARGUMENT');

  // 整体不以 --boundary 开头
  const notMultipart = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprints',
    cookie: harness.owner.cookie,
    payload: Buffer.from('this is definitely not a multipart body'),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
  await expectErrorCode(notMultipart, 400, 'INVALID_ARGUMENT');

  // 分段头部未闭合（没有 CRLFCRLF）
  const truncated = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprints',
    cookie: harness.owner.cookie,
    payload: Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="name"\r\n`),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
  await expectErrorCode(truncated, 400, 'INVALID_ARGUMENT');

  // 没有任何分段：整体合法但字段缺失 → 契约校验仍是 400
  const empty = await inject(harness.context, {
    method: 'POST',
    url: '/api/blueprints',
    cookie: harness.owner.cookie,
    payload: Buffer.from(`--${BOUNDARY}--\r\n`),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
  await expectErrorCode(empty, 400, 'INVALID_ARGUMENT');
});

test('场景13b：文件字节内含 --boundary 不产生伪分段', async () => {
  const harness = await makeHarness();
  const payload = `x--${BOUNDARY}x`;
  const zip = buildZip([
    { path: 'index.html', data: SAMPLE_INDEX_HTML },
    { path: 'payload.txt', data: payload, method: 0 },
  ]);

  const response = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '边界伪造' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: zip },
    ],
    harness.owner.cookie,
  );
  expectStatus(response, 200);
  const data = dataOf<{ version: { artifactBytes: number } }>(response);
  // 若被文件字节里的 `--boundary` 截断，ZIP 会残缺并退化为 400 ARTIFACT_INVALID；
  // 这里字节总数与完整包一致，说明分段边界只在行首（`\r\n--boundary`）生效。
  // 注意 SAMPLE_INDEX_HTML 含中文，比较的是 UTF-8 字节数而不是 JS 字符串长度。
  assert.equal(
    data.version.artifactBytes,
    Buffer.byteLength(SAMPLE_INDEX_HTML, 'utf8') + Buffer.byteLength(payload, 'utf8'),
  );
});

test('场景14：multipart 体积超限 → 413 PAYLOAD_TOO_LARGE', async () => {
  const harness = await makeHarness({ API_JSON_BODY_LIMIT_BYTES: '2048' });
  const big = Buffer.alloc(4096, 0x41);
  const zip = buildZip([
    { path: 'index.html', data: SAMPLE_INDEX_HTML },
    { path: 'big.bin', data: big, method: 0 },
  ]);

  const response = await postBlueprintMultipart(
    harness,
    [
      { name: 'name', value: '超限蓝图' },
      { name: 'version', value: 'v1.0.0' },
      { name: 'artifact', filename: 'bundle.zip', bytes: zip },
    ],
    harness.owner.cookie,
  );
  await expectErrorCode(response, 413, 'PAYLOAD_TOO_LARGE');
});

// ── 场景 15：§6.4 表里剩余的写端点 ──────────────────────────────────────────

test('场景15：蓝图归档/恢复与版本恢复；未注册的产物下载端点返回 404', async () => {
  const harness = await makeHarness();
  const blueprintId = await seedBlueprint(harness, {
    versions: [
      { version: 'v1.0.0', isLatest: false },
      { version: 'v2.0.0', isLatest: true },
    ],
  });
  const versionUrl = (version: string): string => `/api/blueprints/${blueprintId}/versions/${version}`;

  // 未归档的版本不能「恢复」：VERSION_NOT_FOUND（且在判权之前，所以无权限者也拿 404）
  const notArchived = await inject(harness.context, {
    method: 'POST',
    url: `${versionUrl('v1.0.0')}/restore`,
    cookie: harness.owner.cookie,
  });
  await expectErrorCode(notArchived, 404, 'VERSION_NOT_FOUND');

  const archivedVersion = await inject(harness.context, {
    method: 'DELETE',
    url: versionUrl('v2.0.0'),
    cookie: harness.owner.cookie,
  });
  expectStatus(archivedVersion, 200);

  // 已归档版本：无 blueprint.manage 的成员 403，所有者可恢复
  const memberDenied = await inject(harness.context, {
    method: 'POST',
    url: `${versionUrl('v2.0.0')}/restore`,
    cookie: harness.member.cookie,
  });
  await expectErrorCode(memberDenied, 403, 'CAPABILITY_REQUIRED');

  const restoredVersion = await inject(harness.context, {
    method: 'POST',
    url: `${versionUrl('v2.0.0')}/restore`,
    cookie: harness.owner.cookie,
  });
  expectStatus(restoredVersion, 200);
  const restoredData = dataOf<{ version: { version: string; archivedAt: string | null } }>(restoredVersion);
  assert.equal(restoredData.version.version, 'v2.0.0');
  assert.equal(restoredData.version.archivedAt, null);

  // 蓝图归档：DELETE /api/blueprints/:id，版本跟随归档
  const memberArchive = await inject(harness.context, {
    method: 'DELETE',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.member.cookie,
  });
  await expectErrorCode(memberArchive, 403, 'CAPABILITY_REQUIRED');

  const archived = await inject(harness.context, {
    method: 'DELETE',
    url: `/api/blueprints/${blueprintId}`,
    cookie: harness.owner.cookie,
  });
  expectStatus(archived, 200);
  const archivedBlueprint = dataOf<{ blueprint: { status: string; archivedAt: string | null } }>(
    archived,
  ).blueprint;
  assert.equal(archivedBlueprint.status, 'archived');
  assert.equal(archivedBlueprint.archivedAt === null, false);

  const versionRows = await harness.context.db
    .selectFrom('blueprint_versions')
    .select(['archived_at'])
    .where('blueprint_id', '=', blueprintId)
    .execute();
  assert.equal(versionRows.length, 2);
  assert.equal(
    versionRows.every((row) => row.archived_at !== null),
    true,
  );

  // 蓝图恢复
  const restored = await inject(harness.context, {
    method: 'POST',
    url: `/api/blueprints/${blueprintId}/restore`,
    cookie: harness.owner.cookie,
  });
  expectStatus(restored, 200);
  const restoredBlueprint = dataOf<{ blueprint: { status: string; archivedAt: string | null } }>(
    restored,
  ).blueprint;
  assert.equal(restoredBlueprint.status, 'active');
  assert.equal(restoredBlueprint.archivedAt, null);

  // 文档 §6.4 列出的产物下载端点当前未注册 → 404 NOT_FOUND（不是 403/404 BLUEPRINT_NOT_FOUND）
  const artifact = await inject(harness.context, {
    method: 'GET',
    url: `/api/blueprints/${blueprintId}/artifact`,
    cookie: harness.owner.cookie,
  });
  await expectErrorCode(artifact, 404, 'NOT_FOUND');
});
