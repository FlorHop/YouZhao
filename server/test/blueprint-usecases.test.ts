/**
 * 蓝图 / 分组用例层测试（`server/app/blueprints.ts`）。
 *
 * 直接调用例函数、直接查库断言，不经过 HTTP——HTTP 层的行为在 `blueprint-routes.test.ts`。
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildUserContext } from '../app/context.js';
import {
  archiveBlueprint,
  archiveBlueprintGroup,
  archiveBlueprintVersion,
  coverBlueprintVersion,
  createBlueprint,
  createBlueprintGroup,
  getBlueprintDetail,
  listBlueprintGroups,
  listBlueprints,
  publishBlueprintVersion,
  reorderBlueprintGroups,
  restoreBlueprint,
  restoreBlueprintGroup,
  restoreBlueprintVersion,
  updateBlueprint,
  type CallerFacts,
} from '../app/blueprints.js';
import type { Db } from '../db/types.js';
import type { RequestContext } from '../domain/entities.js';
import { AppError } from '../domain/errors.js';
import { DEFAULT_GROUP_ID, newId } from '../domain/ids.js';
import { resolveArtifactPath } from '../storage/artifacts.js';
import { createTestContext, seedWorld } from './http-helpers.js';
import { buildZip, SAMPLE_INDEX_HTML } from './zip-builder.js';

const FACTS: CallerFacts = { ip: null, requestId: 'test-request' };

const INDEX_HTML = SAMPLE_INDEX_HTML;

function packageZip(html: string = INDEX_HTML): Buffer {
  return buildZip([
    { path: 'index.html', data: html },
    { path: 'assets/app.js', data: 'export const answer = 42;' },
  ]);
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'youzhao-blueprint-usecases-'));
}

/** 断言用例抛出的 AppError 错误码。 */
async function expectAppError(code: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError && error.code === code) return;
    const actual = error instanceof AppError ? error.code : String(error);
    throw new Error(`期望 ${code}，实际 ${actual}`);
  }
  throw new Error(`期望抛出 ${code}，但调用成功了`);
}

async function grantCapability(
  db: Db,
  userId: string,
  capability: 'blueprint.manage' | 'blueprint.publish',
  targetType: 'group' | 'blueprint',
  targetId: string,
  grantedBy: string,
): Promise<void> {
  await db
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

async function grantView(
  db: Db,
  userId: string,
  targetType: 'group' | 'blueprint',
  targetId: string,
  grantedBy: string,
): Promise<void> {
  await db
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

// ── 分组 ─────────────────────────────────────────────────────────────────────

test('分组：新建分组取最大 sortOrder +10，只给创建者本人授权（所有者不写行、其他管理者不被自动授权）', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);
    await grantCapability(db, memberId, 'blueprint.manage', 'group', DEFAULT_GROUP_ID, ownerId);
    // 授权之后再造当事人上下文，否则快照里没有 capabilities
    const member = await buildUserContext(db, memberId);

    const grantsOf = async (groupTargetId: string) =>
      db
        .selectFrom('view_grants')
        .selectAll()
        .where('target_type', '=', 'group')
        .where('target_id', '=', groupTargetId)
        .execute();

    // 所有者建组：隐式可见全部分组，不写授权行
    const byOwner = await createBlueprintGroup(db, owner, { name: '设计基线' }, FACTS);
    if (byOwner.group.sortOrder !== 10) {
      throw new Error(`期望 sortOrder 10，实际 ${byOwner.group.sortOrder}`);
    }
    if (byOwner.group.archivedAt !== null) throw new Error('新分组不应带归档时间');
    const ownerGrants = await grantsOf(byOwner.group.id);
    if (ownerGrants.length !== 0) {
      throw new Error(`所有者建组不应写授权行，实际 ${ownerGrants.length} 行`);
    }

    // 非所有者建组：只授权创建者本人；别的管理者（member 对本组没有能力范围）不被顺手授权
    const byMember = await createBlueprintGroup(db, member, { name: '研发' }, FACTS);
    const memberGrants = await grantsOf(byMember.group.id);
    const userIds = memberGrants.map((row) => row.user_id);
    if (userIds.length !== 1 || userIds[0] !== memberId) {
      throw new Error(`只应授权创建者，实际 [${userIds.join(', ')}]`);
    }
    if (memberGrants[0]?.granted_by !== memberId) throw new Error('granted_by 应为创建者');
  } finally {
    await context.close();
  }
});

test('分组：名称重复返回 GROUP_CONFLICT，无 blueprint.manage 的成员建组返回 CAPABILITY_REQUIRED', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);
    const member = await buildUserContext(db, memberId);

    await createBlueprintGroup(db, owner, { name: '研发' }, FACTS);
    await expectAppError('GROUP_CONFLICT', () =>
      createBlueprintGroup(db, owner, { name: '研发' }, FACTS),
    );
    await expectAppError('CAPABILITY_REQUIRED', () =>
      createBlueprintGroup(db, member, { name: '运营' }, FACTS),
    );

    const audit = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'group.create')
      .where('result', '=', 'deny')
      .execute();
    const denied = audit.filter((row) => row.error_code === 'CAPABILITY_REQUIRED');
    if (denied.length !== 1) throw new Error(`期望 1 条 CAPABILITY_REQUIRED 拒绝审计，实际 ${denied.length}`);
    const conflicted = audit.filter((row) => row.error_code === 'GROUP_CONFLICT');
    if (conflicted.length !== 1) throw new Error('重名冲突也应留下一条拒绝审计');
  } finally {
    await context.close();
  }
});

test('分组：列表按可见性过滤，blueprintCount 只数该请求者可见的未归档蓝图', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupA = (await createBlueprintGroup(db, owner, { name: '分组甲' }, FACTS)).group.id;
    const groupB = (await createBlueprintGroup(db, owner, { name: '分组乙' }, FACTS)).group.id;
    await createBlueprint(
      db,
      owner,
      { name: '甲蓝图一', version: '1.0.0', groupId: groupA },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const second = await createBlueprint(
      db,
      owner,
      { name: '甲蓝图二', version: '1.0.0', groupId: groupA },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    await createBlueprint(
      db,
      owner,
      { name: '乙蓝图', version: '1.0.0', groupId: groupB },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    await archiveBlueprint(db, owner, second.blueprint.id, FACTS);

    const ownerGroups = await listBlueprintGroups(db, owner);
    const ownerA = ownerGroups.find((group) => group.id === groupA);
    if (ownerA?.blueprintCount !== 1) throw new Error(`期望甲分组计数 1，实际 ${ownerA?.blueprintCount}`);
    if (ownerGroups[0]?.id !== DEFAULT_GROUP_ID) throw new Error('默认分组应恒为首位');

    // 成员只被授权了甲分组：只看到甲，计数也只算甲（且已归档的不计）
    await grantView(db, memberId, 'group', groupA, ownerId);
    const memberGroups = await listBlueprintGroups(db, await buildUserContext(db, memberId));
    const memberIds = memberGroups.map((group) => group.id);
    if (memberIds.length !== 1 || memberIds[0] !== groupA) {
      throw new Error(`成员应只看到甲分组，实际 ${JSON.stringify(memberIds)}`);
    }
    const memberA = memberGroups[0];
    if (memberA?.blueprintCount !== 1) throw new Error(`成员视角甲分组应为 1，实际 ${memberA?.blueprintCount}`);
  } finally {
    await context.close();
  }
});

test('分组：归档把未归档蓝图移回默认分组，默认分组不可归档，恢复不把蓝图移回来', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupId = (await createBlueprintGroup(db, owner, { name: '临时分组' }, FACTS)).group.id;
    const created = await createBlueprint(
      db,
      owner,
      { name: '要搬走的蓝图', version: '1.0.0', groupId },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;

    const archived = await archiveBlueprintGroup(db, owner, groupId, FACTS);
    if (archived.movedBlueprintIds.length !== 1 || archived.movedBlueprintIds[0] !== blueprintId) {
      throw new Error(`movedBlueprintIds 应含该蓝图，实际 ${JSON.stringify(archived.movedBlueprintIds)}`);
    }
    if (archived.group.archivedAt === null) throw new Error('归档后应带回archivedAt');
    const moved = await db
      .selectFrom('blueprints')
      .select(['group_id'])
      .where('id', '=', blueprintId)
      .executeTakeFirstOrThrow();
    if (moved.group_id !== DEFAULT_GROUP_ID) throw new Error('蓝图应落回默认分组');

    await expectAppError('INVALID_ARGUMENT', () => archiveBlueprintGroup(db, owner, DEFAULT_GROUP_ID, FACTS));
    await expectAppError('GROUP_NOT_FOUND', () => archiveBlueprintGroup(db, owner, 'grp_missing', FACTS));

    const restored = await restoreBlueprintGroup(db, owner, groupId, FACTS);
    if (restored.group.archivedAt !== null) throw new Error('恢复后不应带归档时间');
    const stillMoved = await db
      .selectFrom('blueprints')
      .select(['group_id'])
      .where('id', '=', blueprintId)
      .executeTakeFirstOrThrow();
    if (stillMoved.group_id !== DEFAULT_GROUP_ID) throw new Error('恢复分组不应把蓝图移回来');
  } finally {
    await context.close();
  }
});

test('分组：重排必须精确匹配「未归档非默认分组」集合，成功后按 10/20/30 写入', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupA = (await createBlueprintGroup(db, owner, { name: '甲' }, FACTS)).group.id;
    const groupB = (await createBlueprintGroup(db, owner, { name: '乙' }, FACTS)).group.id;

    await expectAppError('INVALID_ARGUMENT', () =>
      reorderBlueprintGroups(db, owner, { orderedIds: [groupA] }, FACTS),
    );
    await expectAppError('INVALID_ARGUMENT', () =>
      reorderBlueprintGroups(db, owner, { orderedIds: [groupA, groupA, groupB] }, FACTS),
    );
    await expectAppError('INVALID_ARGUMENT', () =>
      reorderBlueprintGroups(db, owner, { orderedIds: [groupA, groupB, DEFAULT_GROUP_ID] }, FACTS),
    );
    await expectAppError('INVALID_ARGUMENT', () =>
      reorderBlueprintGroups(db, owner, { orderedIds: [groupA, groupB, 'grp_missing'] }, FACTS),
    );

    const reordered = await reorderBlueprintGroups(db, owner, { orderedIds: [groupB, groupA] }, FACTS);
    const order = new Map(reordered.map((group) => [group.id, group.sortOrder]));
    if (order.get(groupB) !== 10 || order.get(groupA) !== 20) {
      throw new Error(`期望 乙=10/甲=20，实际 乙=${order.get(groupB)}/甲=${order.get(groupA)}`);
    }
    if (order.get(DEFAULT_GROUP_ID) !== 0) throw new Error('默认分组排序不应被改动');
  } finally {
    await context.close();
  }
});

test('分组：重排需要被移动分组的 blueprint.manage', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupA = (await createBlueprintGroup(db, owner, { name: '甲' }, FACTS)).group.id;
    const groupB = (await createBlueprintGroup(db, owner, { name: '乙' }, FACTS)).group.id;
    await grantView(db, memberId, 'group', groupA, ownerId);
    await grantView(db, memberId, 'group', groupB, ownerId);
    await grantCapability(db, memberId, 'blueprint.manage', 'group', groupA, ownerId);
    const member = await buildUserContext(db, memberId);

    // 只持有甲分组能力：乙分组也要有 manage 才允许整体重排
    await expectAppError('CAPABILITY_REQUIRED', () =>
      reorderBlueprintGroups(db, member, { orderedIds: [groupB, groupA] }, FACTS),
    );
    await grantCapability(db, memberId, 'blueprint.manage', 'group', groupB, ownerId);
    const ok = await reorderBlueprintGroups(
      db,
      await buildUserContext(db, memberId),
      { orderedIds: [groupA, groupB] },
      FACTS,
    );
    const order = new Map(ok.map((group) => [group.id, group.sortOrder]));
    if (order.get(groupA) !== 10 || order.get(groupB) !== 20) throw new Error('重排未生效');
  } finally {
    await context.close();
  }
});

// ── 可见性 ───────────────────────────────────────────────────────────────────

test('可见性：所有者隐式可见全部蓝图，未授权成员既不在列表里、直接读取也是 BLUEPRINT_NOT_FOUND', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);
    const member = await buildUserContext(db, memberId);

    const created = await createBlueprint(
      db,
      owner,
      { name: '内部蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;

    const ownerList = await listBlueprints(db, owner, { page: 1, pageSize: 20 });
    if (ownerList.items.length !== 1) throw new Error('所有者应看到 1 条蓝图（无需任何 view_grants）');
    const ownerGroups = ownerList.groups.filter((group) => group.blueprintCount > 0);
    if (ownerGroups.length !== 1 || ownerGroups[0]?.id !== DEFAULT_GROUP_ID) {
      throw new Error('所有者视角的默认分组计数应为 1');
    }

    const memberList = await listBlueprints(db, member, { page: 1, pageSize: 20 });
    if (memberList.items.length !== 0) throw new Error('未授权成员不应看到蓝图');
    if (memberList.groups.some((group) => group.blueprintCount > 0)) {
      throw new Error('未授权成员的计数应全为 0');
    }
    await expectAppError('BLUEPRINT_NOT_FOUND', () => getBlueprintDetail(db, member, blueprintId));
    await expectAppError('BLUEPRINT_NOT_FOUND', () => getBlueprintDetail(db, owner, 'bp_missing'));
  } finally {
    await context.close();
  }
});

test('可见性：被授予分组查看权的成员能看到该分组下的蓝图（列表 + 详情）', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupId = (await createBlueprintGroup(db, owner, { name: '共享分组' }, FACTS)).group.id;
    const created = await createBlueprint(
      db,
      owner,
      { name: '共享蓝图', version: '1.0.0', groupId },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    await createBlueprint(
      db,
      owner,
      { name: '私有蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );

    await grantView(db, memberId, 'group', groupId, ownerId);
    const member = await buildUserContext(db, memberId);
    const list = await listBlueprints(db, member, { page: 1, pageSize: 20 });
    if (list.items.length !== 1 || list.items[0]?.name !== '共享蓝图') {
      throw new Error(`成员应只看到共享蓝图，实际 ${JSON.stringify(list.items.map((item) => item.name))}`);
    }
    if (list.items[0]?.groupName !== '共享分组') throw new Error('卡片应带分组名');

    const detail = await getBlueprintDetail(db, member, created.blueprint.id);
    if (detail.versions.length !== 1) throw new Error('详情应含 1 个版本');
    if (detail.capabilities.canManage || detail.capabilities.canPublish) {
      throw new Error('只有查看权的成员不应有管理/发布能力');
    }
  } finally {
    await context.close();
  }
});

test('可见性：详情返回 canManage/canPublish，与能力范围一致', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, adminId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const created = await createBlueprint(
      db,
      owner,
      { name: '能力蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;

    const ownerDetail = await getBlueprintDetail(db, owner, blueprintId);
    if (!ownerDetail.capabilities.canManage || !ownerDetail.capabilities.canPublish) {
      throw new Error('所有者应同时具备管理与发布能力');
    }

    await grantView(db, memberId, 'group', DEFAULT_GROUP_ID, ownerId);
    await grantCapability(db, memberId, 'blueprint.publish', 'group', DEFAULT_GROUP_ID, ownerId);
    const publisherMember = await buildUserContext(db, memberId);
    const memberDetail = await getBlueprintDetail(db, publisherMember, blueprintId);
    if (memberDetail.capabilities.canManage) throw new Error('只有 publish 的成员不应有管理能力');
    if (!memberDetail.capabilities.canPublish) throw new Error('只有 publish 的成员应有发布能力');

    // 用户管理员身份本身不带可见性、也不带业务能力
    await expectAppError('BLUEPRINT_NOT_FOUND', async () => {
      await getBlueprintDetail(db, await buildUserContext(db, adminId), blueprintId);
    });
    await grantView(db, adminId, 'group', DEFAULT_GROUP_ID, ownerId);
    const adminDetail = await getBlueprintDetail(db, await buildUserContext(db, adminId), blueprintId);
    if (adminDetail.capabilities.canManage || adminDetail.capabilities.canPublish) {
      throw new Error('用户管理员身份本身不应带来业务能力');
    }
  } finally {
    await context.close();
  }
});

// ── 能力矩阵 ─────────────────────────────────────────────────────────────────

test('能力：只有 blueprint.manage 的成员可改元数据、可覆盖版本，但不能创建蓝图', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const created = await createBlueprint(
      db,
      owner,
      { name: '旧名字', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;

    await grantView(db, memberId, 'group', DEFAULT_GROUP_ID, ownerId);
    await grantCapability(db, memberId, 'blueprint.manage', 'group', DEFAULT_GROUP_ID, ownerId);
    const member = await buildUserContext(db, memberId);

    const updated = await updateBlueprint(db, member, blueprintId, { name: '新名字' }, FACTS);
    if (updated.blueprint.name !== '新名字') throw new Error('改元数据失败');

    await expectAppError('CAPABILITY_REQUIRED', () =>
      createBlueprint(db, member, { name: '无权创建', version: '1.0.0' }, packageZip(), {
        ...FACTS,
        storageRoot: root,
      }),
    );

    const covered = await coverBlueprintVersion(
      db,
      member,
      blueprintId,
      '1.0.0',
      { publishNote: '覆盖说明' },
      packageZip('<html><body>覆盖后的产物</body></html>'),
      { ...FACTS, storageRoot: root },
    );
    if (covered.version?.publishSource !== 'web-cover') throw new Error('覆盖后 publishSource 应为 web-cover');
    if (covered.version?.publishNote !== '覆盖说明') throw new Error('覆盖应更新 publishNote');

    await expectAppError('CAPABILITY_REQUIRED', () =>
      publishBlueprintVersion(db, member, blueprintId, { version: '2.0.0' }, packageZip(), {
        ...FACTS,
        storageRoot: root,
      }),
    );
  } finally {
    await context.close();
  }
});

test('能力：只有 blueprint.publish 的成员可创建与发布，但不能改元数据', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);

    await grantView(db, memberId, 'group', DEFAULT_GROUP_ID, ownerId);
    await grantCapability(db, memberId, 'blueprint.publish', 'group', DEFAULT_GROUP_ID, ownerId);
    const member = await buildUserContext(db, memberId);

    const created = await createBlueprint(
      db,
      member,
      { name: '发布者蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;
    if (created.blueprint.createdAt === undefined) throw new Error('创建响应应带 createdAt');

    const published = await publishBlueprintVersion(
      db,
      member,
      blueprintId,
      { version: '1.1.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    if (published.blueprint.versionCount !== 2) throw new Error('发布后应有 2 个可用版本');
    if (published.blueprint.latestVersion?.version !== '1.1.0') throw new Error('makeLatest 默认应为 true');
    if (published.version?.publishSource !== 'web') throw new Error('发布来源应为 web');

    await expectAppError('CAPABILITY_REQUIRED', () =>
      updateBlueprint(db, member, blueprintId, { name: '改名' }, FACTS),
    );
    await expectAppError('CAPABILITY_REQUIRED', () =>
      archiveBlueprint(db, member, blueprintId, FACTS),
    );
  } finally {
    await context.close();
  }
});

test('能力：token 身份不能走蓝图管理动作（只允许 version.publish）', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);
    const created = await createBlueprint(
      db,
      owner,
      { name: 'Token 蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const tokenContext: RequestContext = {
      ...owner,
      actorType: 'token',
      tokenScopes: ['publish:blueprint'],
    };
    await expectAppError('FORBIDDEN', () =>
      updateBlueprint(db, tokenContext, created.blueprint.id, { name: '改名' }, FACTS),
    );
    const published = await publishBlueprintVersion(
      db,
      tokenContext,
      created.blueprint.id,
      { version: '1.0.1' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    if (published.blueprint.versionCount !== 2) throw new Error('Token 应能发布版本');
  } finally {
    await context.close();
  }
});

// ── 版本 ─────────────────────────────────────────────────────────────────────

test('版本：重复版本号返回 VERSION_CONFLICT，覆盖不改版本号与部署时间但换掉产物内容', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const created = await createBlueprint(
      db,
      owner,
      { name: '版本蓝图', version: '1.0.0' },
      packageZip('<html><body>初版</body></html>'),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;
    const deployedAt = created.version?.deployedAt;

    await expectAppError('VERSION_CONFLICT', () =>
      publishBlueprintVersion(db, owner, blueprintId, { version: '1.0.0' }, packageZip(), {
        ...FACTS,
        storageRoot: root,
      }),
    );

    const covered = await coverBlueprintVersion(
      db,
      owner,
      blueprintId,
      '1.0.0',
      {},
      packageZip('<html><body>覆盖版</body></html>'),
      { ...FACTS, storageRoot: root },
    );
    if (covered.version?.version !== '1.0.0') throw new Error('覆盖不应改版本号');
    if (covered.version?.deployedAt !== deployedAt) throw new Error('覆盖不应改 deployedAt');
    if (covered.version?.publishSource !== 'web-cover') throw new Error('覆盖后应为 web-cover');
    if (covered.version?.isLatest !== true) throw new Error('覆盖不应改 is_latest');

    const artifact = await readFile(
      resolveArtifactPath({ root, blueprintId, version: '1.0.0', relPath: 'index.html' }),
      'utf8',
    );
    if (!artifact.includes('覆盖版')) throw new Error('磁盘产物应被覆盖');

    await expectAppError('VERSION_NOT_FOUND', () =>
      coverBlueprintVersion(db, owner, blueprintId, '9.9.9', {}, packageZip(), {
        ...FACTS,
        storageRoot: root,
      }),
    );
  } finally {
    await context.close();
  }
});

test('版本：归档最后一个可用版本被拒，归档最新版本后 is_latest 转给剩下最新的未归档版本', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const created = await createBlueprint(
      db,
      owner,
      { name: '多版本蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;
    await publishBlueprintVersion(db, owner, blueprintId, { version: '1.1.0' }, packageZip(), {
      ...FACTS,
      storageRoot: root,
    });

    await publishBlueprintVersion(db, owner, blueprintId, { version: '1.2.0' }, packageZip(), {
      ...FACTS,
      storageRoot: root,
    });

    // 归档当前最新版本：is_latest 交给剩下最新的未归档版本
    const archivedLatest = await archiveBlueprintVersion(db, owner, blueprintId, '1.2.0', FACTS);
    if (archivedLatest.version?.archivedAt === null) throw new Error('被归档版本应带 archivedAt');
    if (archivedLatest.blueprint.versionCount !== 2) throw new Error('归档后应剩 2 个可用版本');
    if (archivedLatest.blueprint.latestVersion?.version !== '1.1.0') {
      throw new Error(`归档最新版本后 is_latest 应转给 1.1.0，实际 ${archivedLatest.blueprint.latestVersion?.version}`);
    }

    const archived = await archiveBlueprintVersion(db, owner, blueprintId, '1.1.0', FACTS);
    if (archived.blueprint.versionCount !== 1) throw new Error('归档后应剩 1 个可用版本');
    if (archived.blueprint.latestVersion?.version !== '1.0.0') throw new Error('最新版本应转给 1.0.0');
    await expectAppError('LAST_VERSION_PROTECTED', () =>
      archiveBlueprintVersion(db, owner, blueprintId, '1.0.0', FACTS),
    );
    await expectAppError('VERSION_NOT_FOUND', () =>
      archiveBlueprintVersion(db, owner, blueprintId, '1.2.0', FACTS),
    );
    const detail = await getBlueprintDetail(db, owner, blueprintId);
    if (detail.versions.length !== 3) throw new Error('详情应包含已归档版本');
  } finally {
    await context.close();
  }
});

test('版本：恢复版本只清归档时间、不自动置最新', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const created = await createBlueprint(
      db,
      owner,
      { name: '恢复版本蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;
    await publishBlueprintVersion(db, owner, blueprintId, { version: '1.1.0' }, packageZip(), {
      ...FACTS,
      storageRoot: root,
    });
    await archiveBlueprintVersion(db, owner, blueprintId, '1.0.0', FACTS);

    const restored = await restoreBlueprintVersion(db, owner, blueprintId, '1.0.0', FACTS);
    if (restored.blueprint.versionCount !== 2) throw new Error('恢复后应有 2 个可用版本');
    if (restored.blueprint.latestVersion?.version !== '1.1.0') throw new Error('恢复不应改动 is_latest');
    await expectAppError('VERSION_NOT_FOUND', () =>
      restoreBlueprintVersion(db, owner, blueprintId, '1.0.0', FACTS),
    );
  } finally {
    await context.close();
  }
});

// ── 蓝图生命周期 ─────────────────────────────────────────────────────────────

test('蓝图：归档后默认列表不含它、产物仍在磁盘、status=archived 能查到、恢复后又可见', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const created = await createBlueprint(
      db,
      owner,
      { name: '待归档蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;
    const archived = await archiveBlueprint(db, owner, blueprintId, FACTS);
    if (archived.blueprint.status !== 'archived' || archived.blueprint.archivedAt === null) {
      throw new Error('归档响应应体现归档状态');
    }
    if (archived.blueprint.versionCount !== 0) throw new Error('归档蓝图时版本应一起归档');

    const defaults = await listBlueprints(db, owner, { page: 1, pageSize: 20 });
    if (defaults.items.some((item) => item.id === blueprintId)) throw new Error('默认列表不应含已归档蓝图');
    const archivedList = await listBlueprints(db, owner, { page: 1, pageSize: 20, status: 'archived' });
    if (!archivedList.items.some((item) => item.id === blueprintId)) throw new Error('status=archived 应能查到');
    if (archivedList.groups.find((group) => group.id === DEFAULT_GROUP_ID)?.blueprintCount !== 0) {
      throw new Error('分组计数不应包含已归档蓝图');
    }

    const artifact = await readFile(
      resolveArtifactPath({ root, blueprintId, version: '1.0.0', relPath: 'index.html' }),
      'utf8',
    );
    if (artifact.length === 0) throw new Error('归档不应删除产物');

    await expectAppError('VERSION_NOT_FOUND', () =>
      coverBlueprintVersion(db, owner, blueprintId, '1.0.0', {}, packageZip(), {
        ...FACTS,
        storageRoot: root,
      }),
    );

    await restoreBlueprint(db, owner, blueprintId, FACTS);
    const restoredList = await listBlueprints(db, owner, { page: 1, pageSize: 20 });
    if (!restoredList.items.some((item) => item.id === blueprintId)) throw new Error('恢复后应重新可见');
    if (restoredList.items[0]?.versionCount !== 1) throw new Error('恢复蓝图应恢复其版本');
  } finally {
    await context.close();
  }
});

test('蓝图：关键字与分组筛选、分页元数据', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupId = (await createBlueprintGroup(db, owner, { name: '筛选分组' }, FACTS)).group.id;
    await createBlueprint(
      db,
      owner,
      { name: '数据看板', version: '1.0.0', summary: '营收与订单', tags: ['看板'] },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    await createBlueprint(
      db,
      owner,
      { name: '报表中心', version: '1.0.0', summary: '月度报表', groupId },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );

    const byKeyword = await listBlueprints(db, owner, { page: 1, pageSize: 20, keyword: '数据' });
    if (byKeyword.items.length !== 1 || byKeyword.items[0]?.name !== '数据看板') {
      throw new Error('keyword 应匹配名称');
    }
    const bySummary = await listBlueprints(db, owner, { page: 1, pageSize: 20, keyword: '月度' });
    if (bySummary.items.length !== 1 || bySummary.items[0]?.name !== '报表中心') {
      throw new Error('keyword 应匹配简介');
    }
    const byGroup = await listBlueprints(db, owner, { page: 1, pageSize: 20, groupId });
    if (byGroup.items.length !== 1 || byGroup.items[0]?.name !== '报表中心') {
      throw new Error('groupId 筛选未生效');
    }
    const paged = await listBlueprints(db, owner, { page: 2, pageSize: 1 });
    if (paged.total !== 2) throw new Error(`期望 total 2，实际 ${paged.total}`);
    if (paged.items.length !== 1) throw new Error('第二页应有 1 条');
    if (byKeyword.items[0]?.tags[0] !== '看板') throw new Error('卡片应带 tags');
    if (byKeyword.items[0]?.latestVersion?.version !== '1.0.0') throw new Error('卡片应带最新版本');
  } finally {
    await context.close();
  }
});

test('蓝图：移动分组需要源与目标分组的 blueprint.manage，成功后 group_id 变更', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupA = (await createBlueprintGroup(db, owner, { name: '源分组' }, FACTS)).group.id;
    const groupB = (await createBlueprintGroup(db, owner, { name: '目标分组' }, FACTS)).group.id;
    const created = await createBlueprint(
      db,
      owner,
      { name: '要移动的蓝图', version: '1.0.0', groupId: groupA },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;

    await grantView(db, memberId, 'group', groupA, ownerId);
    await grantView(db, memberId, 'group', groupB, ownerId);
    await grantCapability(db, memberId, 'blueprint.manage', 'group', groupA, ownerId);
    const member = await buildUserContext(db, memberId);

    await expectAppError('CAPABILITY_REQUIRED', () =>
      updateBlueprint(db, member, blueprintId, { groupId: groupB }, FACTS),
    );

    await grantCapability(db, memberId, 'blueprint.manage', 'group', groupB, ownerId);
    const moved = await updateBlueprint(
      db,
      await buildUserContext(db, memberId),
      blueprintId,
      { groupId: groupB },
      FACTS,
    );
    if (moved.blueprint.groupId !== groupB) throw new Error('move 未生效');
    if (moved.blueprint.groupName !== '目标分组') throw new Error('响应应带新分组名');
  } finally {
    await context.close();
  }
});

test('蓝图：空请求体与移入已归档分组一律 INVALID_ARGUMENT', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupId = (await createBlueprintGroup(db, owner, { name: '将被归档' }, FACTS)).group.id;
    const created = await createBlueprint(
      db,
      owner,
      { name: '空体蓝图', version: '1.0.0' },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;

    await expectAppError('INVALID_ARGUMENT', () => updateBlueprint(db, owner, blueprintId, {}, FACTS));
    await archiveBlueprintGroup(db, owner, groupId, FACTS);
    await expectAppError('INVALID_ARGUMENT', () =>
      updateBlueprint(db, owner, blueprintId, { groupId }, FACTS),
    );
    await expectAppError('BLUEPRINT_NOT_FOUND', () => updateBlueprint(db, owner, 'bp_missing', { name: 'x' }, FACTS));
    await expectAppError('GROUP_NOT_FOUND', () =>
      updateBlueprint(db, owner, blueprintId, { groupId: 'grp_missing' }, FACTS),
    );
  } finally {
    await context.close();
  }
});

test('蓝图：移动到新分组后原本地可见性不变（能力随分组走，显式的蓝图授权仍然有效）', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    const groupA = (await createBlueprintGroup(db, owner, { name: '甲组' }, FACTS)).group.id;
    const groupB = (await createBlueprintGroup(db, owner, { name: '乙组' }, FACTS)).group.id;
    const created = await createBlueprint(
      db,
      owner,
      { name: '搬走的蓝图', version: '1.0.0', groupId: groupA },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );
    const blueprintId = created.blueprint.id;
    await grantView(db, memberId, 'blueprint', blueprintId, ownerId);

    const before = await listBlueprints(db, await buildUserContext(db, memberId), { page: 1, pageSize: 20 });
    if (before.items.length !== 1) throw new Error('蓝图级授权应可见');

    await updateBlueprint(db, owner, blueprintId, { groupId: groupB }, FACTS);
    const after = await listBlueprints(db, await buildUserContext(db, memberId), { page: 1, pageSize: 20 });
    if (after.items.length !== 1 || after.items[0]?.groupId !== groupB) {
      throw new Error('移动后蓝图级授权仍应可见');
    }
  } finally {
    await context.close();
  }
});

// ── 产物包 ───────────────────────────────────────────────────────────────────

test('产物：非法包被拒，失败时不留下任何目录（数据库里也没有行）', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);

    await expectAppError('ARTIFACT_INVALID', () =>
      createBlueprint(db, owner, { name: '穿越包', version: '1.0.0' }, buildZip([
        { path: 'index.html', data: INDEX_HTML },
        { path: '../evil.html', data: 'bad' },
      ]), { ...FACTS, storageRoot: root }),
    );
    await expectAppError('ARTIFACT_INVALID', () =>
      createBlueprint(db, owner, { name: '缺首页', version: '1.0.0' }, buildZip([
        { path: 'sub/index.html', data: INDEX_HTML },
      ]), { ...FACTS, storageRoot: root }),
    );
    await expectAppError('ARTIFACT_INVALID', () =>
      createBlueprint(db, owner, { name: '不是 ZIP', version: '1.0.0' }, Buffer.from('not-a-zip'), {
        ...FACTS,
        storageRoot: root,
      }),
    );
    await expectAppError('ARTIFACT_INVALID', () =>
      createBlueprint(db, owner, { name: '没有文件', version: '1.0.0' }, null, {
        ...FACTS,
        storageRoot: root,
      }),
    );

    const rows = await db.selectFrom('blueprints').select(['id']).execute();
    if (rows.length !== 0) throw new Error('失败的上传不应留下蓝图行');
    const dirs = await readdir(root);
    if (dirs.length !== 0) throw new Error(`失败的上传不应留下产物目录，实际 ${JSON.stringify(dirs)}`);
  } finally {
    await context.close();
  }
});

test('产物：超过体积上限返回 PAYLOAD_TOO_LARGE', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);
    // 32MB + 1 字节的「包」在体积校验就应被拒，不需要是合法 ZIP
    const huge = Buffer.alloc(32 * 1024 * 1024 + 1);
    await expectAppError('PAYLOAD_TOO_LARGE', () =>
      createBlueprint(db, owner, { name: '超大包', version: '1.0.0' }, huge, {
        ...FACTS,
        storageRoot: root,
      }),
    );
  } finally {
    await context.close();
  }
});

// ── 分组：可见性补充 ─────────────────────────────────────────────────────────

test('分组：分组查看权不泄漏到其它分组，成员看不到未授权分组', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);
    const groupA = (await createBlueprintGroup(db, owner, { name: '可见' }, FACTS)).group.id;
    await createBlueprintGroup(db, owner, { name: '不可见' }, FACTS);
    await grantView(db, memberId, 'group', groupA, ownerId);

    const groups = await listBlueprintGroups(db, await buildUserContext(db, memberId));
    if (groups.length !== 1 || groups[0]?.name !== '可见') {
      throw new Error(`成员应只看到 1 个分组，实际 ${JSON.stringify(groups.map((g) => g.name))}`);
    }
  } finally {
    await context.close();
  }
});

test('分组：归档分组的蓝图不计入分组计数，恢复分组计数归位', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);
    const groupId = (await createBlueprintGroup(db, owner, { name: '计数分组' }, FACTS)).group.id;
    await createBlueprint(
      db,
      owner,
      { name: '计数蓝图', version: '1.0.0', groupId },
      packageZip(),
      { ...FACTS, storageRoot: root },
    );

    const before = await listBlueprintGroups(db, owner);
    if (before.find((group) => group.id === groupId)?.blueprintCount !== 1) {
      throw new Error('归档前计数应为 1');
    }
    await archiveBlueprintGroup(db, owner, groupId, FACTS);
    const after = await listBlueprintGroups(db, owner);
    if (after.find((group) => group.id === groupId)?.blueprintCount !== 0) {
      throw new Error('归档后分组计数应归零');
    }
  } finally {
    await context.close();
  }
});

test('审计：成功的写操作记录 allow，被拒的操作记录 deny 与错误码', async () => {
  const root = await tempRoot();
  const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
  try {
    const { db } = context;
    const { ownerId, memberId } = await seedWorld(db);
    const owner = await buildUserContext(db, ownerId);
    const member = await buildUserContext(db, memberId);

    const created = await createBlueprintGroup(db, owner, { name: '审计分组' }, FACTS);
    await expectAppError('CAPABILITY_REQUIRED', () =>
      archiveBlueprintGroup(db, member, created.group.id, FACTS),
    );

    const allow = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'group.create')
      .execute();
    if (allow.length !== 1 || allow[0]?.result !== 'allow') throw new Error('缺少 group.create 的允许审计');
    if (allow[0]?.target_type !== 'group' || allow[0]?.target_id !== created.group.id) {
      throw new Error('审计目标应为新分组');
    }
    const deny = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'group.archive')
      .execute();
    if (deny.length !== 1 || deny[0]?.result !== 'deny' || deny[0]?.error_code !== 'CAPABILITY_REQUIRED') {
      throw new Error(`拒绝审计不正确：${JSON.stringify(deny)}`);
    }
    if (deny[0]?.actor_id !== memberId) throw new Error('审计应记录被拒操作者');
  } finally {
    await context.close();
  }
});
