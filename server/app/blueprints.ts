/**
 * 蓝图与分组用例（docs/permission-design.md §6.4）。
 *
 * 纪律：
 * - **权限判定只走 `assertAuthorized` / `authorize`**，本文件不写身份 if；唯一的例外是可见性公式，
 *   它按 `isResourceVisible` 计算，并补上「所有者隐式持有全部业务能力」这条 policy 裁决的对应分支
 *   （见 `canView`）——否则所有者会因为没有任何 `view_grants` 而「有权限却看不到」。
 * - **产物包只经 `storage/zip.ts` + `storage/artifacts.ts`**：这里不拼路径、不解压、不写文件。
 * - **归档不物理删除**：蓝图 / 版本 / 分组一律写 `archived_at`，产物留在磁盘上。
 * - 每个写操作都写审计：成功 `allow`；`AppError` 先记 `deny` + errorCode 再抛（`audited` 小助手）。
 */
import { rename, rm } from 'node:fs/promises';
import type {
  BlueprintDetailResponse,
  BlueprintGroupMutationResponse,
  BlueprintGroupsListResponse,
  BlueprintMutationResponse,
  BlueprintsListResponse,
  CreateBlueprintGroupRequest,
  CreateBlueprintRequest,
  PublishBlueprintVersionRequest,
  ReorderBlueprintGroupsRequest,
  UpdateBlueprintRequest,
} from '@youzhao/contracts/types';
import { writeAudit } from '../audit/audit.js';
import type { BlueprintGroupRow, BlueprintsTable, BlueprintVersionsTable, Db } from '../db/types.js';
import type { RequestContext } from '../domain/entities.js';
import { AppError } from '../domain/errors.js';
import { DEFAULT_GROUP_ID, newId } from '../domain/ids.js';
import { assertAuthorized, authorize } from '../domain/policy.js';
import { isResourceVisible, type ResourceLike } from '../domain/scopes.js';
import {
  artifactDirFor,
  MAX_ARTIFACT_BYTES,
  writeArtifactPackage,
  type PublishedArtifact,
} from '../storage/artifacts.js';
import { readZip, requireEntryHtml } from '../storage/zip.js';
import type { Selectable } from 'kysely';

// ── 视图类型：直接取自契约，保证响应与 schema 同形 ─────────────────────────────
type BlueprintSummary = BlueprintsListResponse['data']['items'][number];
type BlueprintVersionSummary = BlueprintDetailResponse['data']['versions'][number];
type BlueprintGroupSummary = BlueprintGroupsListResponse['data']['items'][number];
type BlueprintCardGroup = BlueprintsListResponse['data']['groups'][number];
type BlueprintRow = Selectable<BlueprintsTable>;
type BlueprintVersionRow = Selectable<BlueprintVersionsTable>;

export type BlueprintMutationData = BlueprintMutationResponse['data'];
export type BlueprintGroupMutationData = BlueprintGroupMutationResponse['data'];

export interface BlueprintListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly keyword?: string;
  readonly groupId?: string;
  readonly status?: 'active' | 'archived';
}

export interface BlueprintListData {
  readonly items: BlueprintSummary[];
  readonly groups: BlueprintCardGroup[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface BlueprintDetailData {
  readonly blueprint: BlueprintSummary;
  readonly versions: BlueprintVersionSummary[];
  readonly capabilities: { readonly canManage: boolean; readonly canPublish: boolean };
}

/** 调用方（路由层）能提供的事实：IP 与请求 id，只用于审计。 */
export interface CallerFacts {
  readonly ip: string | null;
  readonly requestId: string | null;
}

/** 产物写入类用例额外需要产物根目录（`config.preview.storagePath`）。 */
export interface ArtifactCall extends CallerFacts {
  readonly storageRoot: string;
}

// ── 通用小工具 ───────────────────────────────────────────────────────────────

const UNIQUE_VIOLATION = '23505';

/** Postgres 唯一约束冲突（靠约束捕获，而不是「先查后插」）。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function groupResource(groupId: string): ResourceLike {
  return { kind: 'group', id: groupId };
}

function blueprintResource(blueprintId: string, groupId: string): ResourceLike {
  return { kind: 'blueprint', id: blueprintId, groupId };
}

/**
 * `canView`：查看范围或业务能力覆盖即可见（`scopes.isResourceVisible`），
 * 外加「所有者隐式持有全部业务能力」——policy 的 `requireCapability` 对 owner 直接放行，
 * 可见性公式是纯 grants/capabilities 计算，这里必须补同一个分支，否则所有者看得见却列不出来。
 */
function canView(context: RequestContext, resource: ResourceLike): boolean {
  if (context.identity === 'owner') return true;
  return isResourceVisible(context.viewScope, context.capabilities, resource);
}

interface AuditTarget {
  readonly action: string;
  readonly targetType: 'group' | 'blueprint' | 'version';
  readonly targetId: string | null;
  readonly detail?: unknown;
}

/** 写操作外壳：成功记 `allow`，`AppError` 先记 `deny` + errorCode，其余记 `error`，然后原样抛出。 */
async function audited<T>(
  db: Db,
  context: RequestContext,
  target: AuditTarget,
  call: CallerFacts,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const value = await run();
    await writeAudit(db, {
      actorType: context.actorType,
      actorId: context.userId,
      requestId: call.requestId,
      action: target.action,
      targetType: target.targetType,
      targetId: target.targetId,
      result: 'allow',
      detail: target.detail,
      ip: call.ip,
    });
    return value;
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : null;
    await writeAudit(db, {
      actorType: context.actorType,
      actorId: context.userId,
      requestId: call.requestId,
      action: target.action,
      targetType: target.targetType,
      targetId: target.targetId,
      result: errorCode === null ? 'error' : 'deny',
      errorCode,
      detail: target.detail,
      ip: call.ip,
    });
    throw error;
  }
}

async function loadGroupOrThrow(db: Db, groupId: string): Promise<BlueprintGroupRow> {
  const group = await db
    .selectFrom('blueprint_groups')
    .selectAll()
    .where('id', '=', groupId)
    .executeTakeFirst();
  if (group === undefined) throw new AppError('GROUP_NOT_FOUND', '分组不存在');
  return group;
}

async function loadBlueprintOrThrow(db: Db, blueprintId: string): Promise<BlueprintRow> {
  const blueprint = await db
    .selectFrom('blueprints')
    .selectAll()
    .where('id', '=', blueprintId)
    .executeTakeFirst();
  if (blueprint === undefined) throw new AppError('BLUEPRINT_NOT_FOUND', '蓝图不存在');
  return blueprint;
}

async function loadVersions(db: Db, blueprintId: string): Promise<BlueprintVersionRow[]> {
  return db
    .selectFrom('blueprint_versions')
    .selectAll()
    .where('blueprint_id', '=', blueprintId)
    .orderBy('deployed_at', 'desc')
    .orderBy('id', 'asc')
    .execute();
}

function toVersionSummary(row: BlueprintVersionRow): BlueprintVersionSummary {
  return {
    version: row.version,
    isLatest: row.is_latest,
    status: row.status as BlueprintVersionSummary['status'],
    publishSource: row.publish_source as BlueprintVersionSummary['publishSource'],
    publishNote: row.publish_note,
    deployedAt: row.deployed_at.toISOString(),
    artifactBytes: row.artifact_bytes,
    archivedAt: iso(row.archived_at),
  };
}

function toBlueprintSummary(
  row: BlueprintRow,
  groupName: string,
  versions: readonly BlueprintVersionRow[],
): BlueprintSummary {
  const available = versions.filter((item) => item.archived_at === null);
  const latest = available.find((item) => item.is_latest) ?? null;
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    tags: [...row.tags],
    groupId: row.group_id,
    groupName,
    status: row.status as BlueprintSummary['status'],
    versionCount: available.length,
    latestVersion: latest === null ? null : toVersionSummary(latest),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: iso(row.archived_at),
  };
}

function toGroupSummary(row: BlueprintGroupRow, blueprintCount: number): BlueprintGroupSummary {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    sortOrder: row.sort_order,
    archivedAt: iso(row.archived_at),
    blueprintCount,
  };
}

/** 单蓝图变更响应（`blueprints/mutation.json`）。 */
async function mutationData(
  db: Db,
  blueprintId: string,
  version: string | null,
): Promise<BlueprintMutationData> {
  const row = await loadBlueprintOrThrow(db, blueprintId);
  const [group, versions] = await Promise.all([
    db
      .selectFrom('blueprint_groups')
      .select(['id', 'name'])
      .where('id', '=', row.group_id)
      .executeTakeFirst(),
    loadVersions(db, blueprintId),
  ]);
  const target = version === null ? null : (versions.find((item) => item.version === version) ?? null);
  return {
    blueprint: toBlueprintSummary(row, group?.name ?? '（未知分组）', versions),
    version: target === null ? null : toVersionSummary(target),
  };
}

// ── 产物包 ───────────────────────────────────────────────────────────────────

/** 上传体积上限：单包解压前后都不允许超过 `MAX_ARTIFACT_BYTES`。 */
function assertArtifactSize(bytes: number): void {
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', `产物包超出体积上限（${bytes} 字节）`);
  }
}

/** 解析产物包：缺文件、非 ZIP、含 `..` 穿越、缺根级 `index.html` 都在这里被拒。 */
function readArtifact(artifact: Buffer | null): ReturnType<typeof readZip> {
  if (artifact === null || artifact.length === 0) {
    throw new AppError('ARTIFACT_INVALID', '缺少产物包文件');
  }
  assertArtifactSize(artifact.length);
  const files = readZip(artifact);
  requireEntryHtml(files);
  return files;
}

/** 新建失败时清掉刚落盘的版本目录（保证「数据库没有，磁盘也没有」）。 */
async function removeArtifactDir(root: string, blueprintId: string, version: string): Promise<void> {
  await rm(artifactDirFor(root, blueprintId, version), { recursive: true, force: true });
}

/** 覆盖失败时尽力把旧产物改回来；改不回来就保留 `.bak-*` 供人工恢复。 */
async function restoreArtifactBackup(
  published: PublishedArtifact,
  root: string,
  blueprintId: string,
  version: string,
): Promise<void> {
  if (published.backupPath === null) return;
  try {
    await rm(artifactDirFor(root, blueprintId, version), { recursive: true, force: true });
    await rename(published.backupPath, artifactDirFor(root, blueprintId, version));
  } catch {
    // 保留 .bak 目录：产物永远不静默丢失
  }
}

// ── 分组用例 ─────────────────────────────────────────────────────────────────

/** `GET /api/blueprint-groups`：按可见性过滤；`blueprintCount` 只数该请求者可见的未归档蓝图。 */
export async function listBlueprintGroups(
  db: Db,
  context: RequestContext,
): Promise<BlueprintGroupSummary[]> {
  const [groups, blueprints] = await Promise.all([
    db
      .selectFrom('blueprint_groups')
      .selectAll()
      .orderBy('is_default', 'desc')
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute(),
    db.selectFrom('blueprints').select(['id', 'group_id', 'status']).execute(),
  ]);

  const counts = new Map<string, number>();
  for (const blueprint of blueprints) {
    if (blueprint.status !== 'active') continue;
    if (!canView(context, blueprintResource(blueprint.id, blueprint.group_id))) continue;
    counts.set(blueprint.group_id, (counts.get(blueprint.group_id) ?? 0) + 1);
  }

  return groups
    .filter((group) => canView(context, groupResource(group.id)))
    .map((group) => toGroupSummary(group, counts.get(group.id) ?? 0));
}

/**
 * `POST /api/blueprint-groups`。
 *
 * 建组后自动给「在本平台持有 `blueprint.manage` 的所有用户 + 操作者本人」补一条分组查看授权，
 * 对齐现状实现的 `grantGroupToBlueprintManagers` 语义：新分组不应该只对创建者可见。
 */
export async function createBlueprintGroup(
  db: Db,
  context: RequestContext,
  input: CreateBlueprintGroupRequest,
  call: CallerFacts,
): Promise<BlueprintGroupMutationData> {
  const groupId = newId('grp');
  return audited(
    db,
    context,
    { action: 'group.create', targetType: 'group', targetId: groupId, detail: { name: input.name } },
    call,
    async () => {
      assertAuthorized(context, 'group.create', { kind: 'group', groupId: 'new' });

      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const current = await db
          .selectFrom('blueprint_groups')
          .select(({ fn }) => fn.max('sort_order').as('max_order'))
          .executeTakeFirst();
        sortOrder = (current?.max_order ?? 0) + 10;
      }

      try {
        await db
          .insertInto('blueprint_groups')
          .values({ id: groupId, name: input.name, is_default: false, sort_order: sortOrder })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError('GROUP_CONFLICT', '分组名称已存在');
        throw error;
      }

      // 只给创建者本人一条查看授权。旧模型在新建分组时会把该分组授权给「所有持有
      // demo-preview:manage 的用户」——那既越出各人能力（blueprint.manage）自带的资源
      // 范围，也让「查看范围只能由 O/A 增量授权」失去意义，属于旧模型已被审计的缺陷，
      // 不带进 v2。所有者隐式可见全部分组，同样不写行。
      if (context.identity !== 'owner') {
        await db
          .insertInto('view_grants')
          .values({
            id: newId('grn'),
            user_id: context.userId,
            target_type: 'group',
            target_id: groupId,
            granted_by: context.userId,
          })
          .onConflict((oc) => oc.columns(['user_id', 'target_type', 'target_id']).doNothing())
          .execute();
      }

      const row = await db
        .selectFrom('blueprint_groups')
        .selectAll()
        .where('id', '=', groupId)
        .executeTakeFirstOrThrow();
      return { group: toGroupSummary(row, 0), movedBlueprintIds: [] };
    },
  );
}

/**
 * `PATCH /api/blueprint-groups/reorder`。
 *
 * `orderedIds` 必须与「全部未归档的非默认分组」完全一致（多、少、重复、含默认分组都拒绝），
 * 顺序写成 10/20/30…；默认分组恒为 0、永不被重排。
 */
export async function reorderBlueprintGroups(
  db: Db,
  context: RequestContext,
  input: ReorderBlueprintGroupsRequest,
  call: CallerFacts,
): Promise<BlueprintGroupSummary[]> {
  return audited(
    db,
    context,
    {
      action: 'group.reorder',
      targetType: 'group',
      targetId: null,
      detail: { orderedIds: input.orderedIds },
    },
    call,
    async () => {
      const rows = await db
        .selectFrom('blueprint_groups')
        .selectAll()
        .where('archived_at', 'is', null)
        .execute();
      const reorderable = rows.filter((row) => !row.is_default).map((row) => row.id);
      const expected = new Set(reorderable);
      const given = input.orderedIds;
      const complete =
        given.length === reorderable.length &&
        new Set(given).size === given.length &&
        given.every((id) => expected.has(id));
      if (!complete) {
        throw new AppError('INVALID_ARGUMENT', 'orderedIds 必须恰好包含全部未归档的非默认分组');
      }

      for (const id of given) {
        assertAuthorized(context, 'group.reorder', { kind: 'group', groupId: id });
      }

      await db.transaction().execute(async (trx) => {
        for (const [index, id] of given.entries()) {
          await trx
            .updateTable('blueprint_groups')
            .set({ sort_order: (index + 1) * 10 })
            .where('id', '=', id)
            .execute();
        }
      });

      return listBlueprintGroups(db, context);
    },
  );
}

/**
 * `DELETE /api/blueprint-groups/:id`：归档分组，并在**同一事务**里把它下面未归档的蓝图落回默认分组。
 * 授权记录保留（设计裁决 4），恢复分组后蓝图不会自动回来——由人工重新归位。
 */
export async function archiveBlueprintGroup(
  db: Db,
  context: RequestContext,
  groupId: string,
  call: CallerFacts,
): Promise<BlueprintGroupMutationData> {
  return audited(
    db,
    context,
    { action: 'group.archive', targetType: 'group', targetId: groupId },
    call,
    async () => {
      const group = await loadGroupOrThrow(db, groupId);
      assertAuthorized(context, 'group.archive', { kind: 'group', groupId });
      if (group.is_default) throw new AppError('INVALID_ARGUMENT', '默认分组不可归档');

      const now = new Date();
      const movedBlueprintIds = await db.transaction().execute(async (trx) => {
        const targets = await trx
          .selectFrom('blueprints')
          .select(['id'])
          .where('group_id', '=', groupId)
          .where('status', '=', 'active')
          .execute();
        await trx
          .updateTable('blueprint_groups')
          .set({ archived_at: now })
          .where('id', '=', groupId)
          .execute();
        if (targets.length > 0) {
          await trx
            .updateTable('blueprints')
            .set({ group_id: DEFAULT_GROUP_ID, updated_at: now })
            .where(
              'id',
              'in',
              targets.map((row) => row.id),
            )
            .execute();
        }
        return targets.map((row) => row.id);
      });

      const row = await db
        .selectFrom('blueprint_groups')
        .selectAll()
        .where('id', '=', groupId)
        .executeTakeFirstOrThrow();
      return { group: toGroupSummary(row, movedBlueprintIds.length), movedBlueprintIds };
    },
  );
}

/** `POST /api/blueprint-groups/:id/restore`：只恢复分组本身，不把蓝图移回来。 */
export async function restoreBlueprintGroup(
  db: Db,
  context: RequestContext,
  groupId: string,
  call: CallerFacts,
): Promise<BlueprintGroupMutationData> {
  return audited(
    db,
    context,
    { action: 'group.restore', targetType: 'group', targetId: groupId },
    call,
    async () => {
      await loadGroupOrThrow(db, groupId);
      assertAuthorized(context, 'group.restore', { kind: 'group', groupId });
      await db
        .updateTable('blueprint_groups')
        .set({ archived_at: null })
        .where('id', '=', groupId)
        .execute();
      const row = await db
        .selectFrom('blueprint_groups')
        .selectAll()
        .where('id', '=', groupId)
        .executeTakeFirstOrThrow();
      return { group: toGroupSummary(row, 0), movedBlueprintIds: [] };
    },
  );
}

// ── 蓝图列表 / 详情 ──────────────────────────────────────────────────────────

/** `keyword` 里的 LIKE 元字符按 Postgres 默认转义符 `\` 转义。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listBlueprints(
  db: Db,
  context: RequestContext,
  query: BlueprintListQuery,
): Promise<BlueprintListData> {
  const page = Math.max(1, Math.trunc(query.page));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize)));
  const status = query.status ?? 'active';

  const [groups, candidates] = await Promise.all([
    db
      .selectFrom('blueprint_groups')
      .selectAll()
      .orderBy('is_default', 'desc')
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute(),
    db.selectFrom('blueprints').select(['id', 'group_id', 'status']).execute(),
  ]);
  const groupNameById = new Map(groups.map((group) => [group.id, group.name]));

  // 分组卡片：只给「你能看到的分组」——分组本身在查看范围/能力范围内，**或**该分组下至少有一个
  // 你能看到的蓝图（单蓝图授权的场景：分组本身未授权，但卡片仍需存在，否则列表里的条目没有归属）。
  // 计数只算可见且未归档的蓝图；默认分组由排序规则（is_default desc）恒首位。
  const counts = new Map<string, number>();
  const visibleIds: string[] = [];
  const visibleGroupIds = new Set<string>();
  for (const candidate of candidates) {
    if (!canView(context, blueprintResource(candidate.id, candidate.group_id))) continue;
    visibleIds.push(candidate.id);
    visibleGroupIds.add(candidate.group_id);
    if (candidate.status !== 'active') continue;
    counts.set(candidate.group_id, (counts.get(candidate.group_id) ?? 0) + 1);
  }
  const groupCards: BlueprintCardGroup[] = groups
    .filter((group) => visibleGroupIds.has(group.id) || canView(context, groupResource(group.id)))
    .map((group) => ({
      id: group.id,
      name: group.name,
      isDefault: group.is_default,
      sortOrder: group.sort_order,
      blueprintCount: counts.get(group.id) ?? 0,
    }));

  if (visibleIds.length === 0) {
    return { items: [], groups: groupCards, page, pageSize, total: 0 };
  }

  let base = db
    .selectFrom('blueprints')
    .where('id', 'in', visibleIds)
    .where('status', '=', status);
  base = status === 'active' ? base.where('archived_at', 'is', null) : base.where('archived_at', 'is not', null);
  if (query.groupId !== undefined) base = base.where('group_id', '=', query.groupId);
  const keyword = query.keyword?.trim() ?? '';
  if (keyword.length > 0) {
    const pattern = `%${escapeLike(keyword)}%`;
    base = base.where((eb) =>
      eb.or([eb('name', 'ilike', pattern), eb('summary', 'ilike', pattern)]),
    );
  }

  const [rows, totalRow] = await Promise.all([
    base
      .selectAll()
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'asc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute(),
    base.select(({ fn }) => fn.countAll().as('count')).executeTakeFirstOrThrow(),
  ]);

  const pageIds = rows.map((row) => row.id);
  const versions =
    pageIds.length === 0
      ? []
      : await db
          .selectFrom('blueprint_versions')
          .selectAll()
          .where('blueprint_id', 'in', pageIds)
          .execute();
  const versionsByBlueprint = new Map<string, BlueprintVersionRow[]>();
  for (const version of versions) {
    const bucket = versionsByBlueprint.get(version.blueprint_id);
    if (bucket === undefined) versionsByBlueprint.set(version.blueprint_id, [version]);
    else bucket.push(version);
  }

  const items = rows
    .filter((row) => canView(context, blueprintResource(row.id, row.group_id)))
    .map((row) =>
      toBlueprintSummary(
        row,
        groupNameById.get(row.group_id) ?? '（未知分组）',
        versionsByBlueprint.get(row.id) ?? [],
      ),
    );

  return { items, groups: groupCards, page, pageSize, total: Number(totalRow.count) };
}

/**
 * `GET /api/blueprints/:id`：不可见与不存在都返回 `BLUEPRINT_NOT_FOUND`，
 * 不给出 403——否则可以靠错误码枚举库里有哪些蓝图。
 */
export async function getBlueprintDetail(
  db: Db,
  context: RequestContext,
  blueprintId: string,
): Promise<BlueprintDetailData> {
  const row = await db
    .selectFrom('blueprints')
    .selectAll()
    .where('id', '=', blueprintId)
    .executeTakeFirst();
  if (row === undefined || !canView(context, blueprintResource(row.id, row.group_id))) {
    throw new AppError('BLUEPRINT_NOT_FOUND', '蓝图不存在');
  }

  const [group, versions] = await Promise.all([
    db
      .selectFrom('blueprint_groups')
      .select(['id', 'name'])
      .where('id', '=', row.group_id)
      .executeTakeFirst(),
    loadVersions(db, blueprintId),
  ]);

  return {
    blueprint: toBlueprintSummary(row, group?.name ?? '（未知分组）', versions),
    versions: versions.map(toVersionSummary),
    capabilities: {
      canManage: authorize(context, 'blueprint.update', {
        kind: 'blueprint',
        blueprintId: row.id,
        groupId: row.group_id,
      }).allow,
      canPublish: authorize(context, 'version.publish', {
        kind: 'blueprint',
        blueprintId: row.id,
        groupId: row.group_id,
      }).allow,
    },
  };
}

// ── 蓝图写用例 ───────────────────────────────────────────────────────────────

/**
 * `POST /api/blueprints`：建蓝图 + 发布首个版本（`blueprint.publish` 覆盖目标分组）。
 *
 * 顺序按 §6.4：先校验产物包（非法包一律 `ARTIFACT_INVALID`），再判权，最后落盘 + 落库；
 * 数据库写失败时删掉刚落盘的目录，**不留「库里有、盘上没有」的幽灵版本**。
 */
export async function createBlueprint(
  db: Db,
  context: RequestContext,
  input: CreateBlueprintRequest,
  artifact: Buffer | null,
  call: ArtifactCall,
): Promise<BlueprintMutationData> {
  const blueprintId = newId('bp');
  const versionId = newId('ver');
  return audited(
    db,
    context,
    {
      action: 'blueprint.create',
      targetType: 'blueprint',
      targetId: blueprintId,
      detail: { name: input.name, version: input.version },
    },
    call,
    async () => {
      const files = readArtifact(artifact);
      const groupId = input.groupId ?? DEFAULT_GROUP_ID;
      assertAuthorized(context, 'blueprint.create', { kind: 'group', groupId });

      const group = await loadGroupOrThrow(db, groupId);
      if (group.archived_at !== null) {
        throw new AppError('INVALID_ARGUMENT', '目标分组已归档，不能在其中新建蓝图');
      }

      const published = await writeArtifactPackage({
        root: call.storageRoot,
        blueprintId,
        version: input.version,
        files,
        replace: false,
      });
      const now = new Date();
      try {
        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto('blueprints')
            .values({
              id: blueprintId,
              name: input.name,
              summary: input.summary ?? '',
              tags: input.tags ?? [],
              group_id: groupId,
              status: 'active',
              created_by_user_id: context.userId,
              created_at: now,
              updated_at: now,
            })
            .execute();
          await trx
            .insertInto('blueprint_versions')
            .values({
              id: versionId,
              blueprint_id: blueprintId,
              version: input.version,
              is_latest: true,
              status: 'available',
              entry_path: 'index.html',
              artifact_path: published.artifactPath,
              artifact_hash: published.hash,
              artifact_bytes: published.bytes,
              publish_source: 'web',
              publish_note: input.publishNote ?? '',
              deployed_at: now,
            })
            .execute();
          // 创建者本人也要一条蓝图查看授权（能力随分组走，移动出去后仍看得到自己建的）。
          // 所有者隐式可见全部蓝图，不写行。
          if (context.identity !== 'owner') {
            await trx
              .insertInto('view_grants')
              .values({
                id: newId('grn'),
                user_id: context.userId,
                target_type: 'blueprint',
                target_id: blueprintId,
                granted_by: context.userId,
              })
              .onConflict((oc) => oc.columns(['user_id', 'target_type', 'target_id']).doNothing())
              .execute();
          }
        });
      } catch (error) {
        await removeArtifactDir(call.storageRoot, blueprintId, input.version);
        if (isUniqueViolation(error)) throw new AppError('VERSION_CONFLICT', '版本号已存在');
        throw error;
      }

      return mutationData(db, blueprintId, input.version);
    },
  );
}

/** `POST /api/blueprints/:id/versions`：发布新版本（`version.publish`）。 */
export async function publishBlueprintVersion(
  db: Db,
  context: RequestContext,
  blueprintId: string,
  input: PublishBlueprintVersionRequest,
  artifact: Buffer | null,
  call: ArtifactCall,
): Promise<BlueprintMutationData> {
  const versionId = newId('ver');
  return audited(
    db,
    context,
    {
      action: 'version.publish',
      targetType: 'version',
      targetId: versionId,
      detail: { blueprintId, version: input.version, makeLatest: input.makeLatest ?? true },
    },
    call,
    async () => {
      const blueprint = await loadBlueprintOrThrow(db, blueprintId);
      assertAuthorized(context, 'version.publish', {
        kind: 'blueprint',
        blueprintId,
        groupId: blueprint.group_id,
      });

      const files = readArtifact(artifact);
      const existing = await db
        .selectFrom('blueprint_versions')
        .select(['id', 'archived_at'])
        .where('blueprint_id', '=', blueprintId)
        .where('version', '=', input.version)
        .executeTakeFirst();
      if (existing !== undefined) {
        throw new AppError('VERSION_CONFLICT', `版本 ${input.version} 已存在；覆盖请走覆盖接口`);
      }

      const published = await writeArtifactPackage({
        root: call.storageRoot,
        blueprintId,
        version: input.version,
        files,
        replace: false,
      });
      const makeLatest = input.makeLatest ?? true;
      const now = new Date();
      try {
        await db.transaction().execute(async (trx) => {
          if (makeLatest) {
            await trx
              .updateTable('blueprint_versions')
              .set({ is_latest: false })
              .where('blueprint_id', '=', blueprintId)
              .where('is_latest', '=', true)
              .execute();
          }
          await trx
            .insertInto('blueprint_versions')
            .values({
              id: versionId,
              blueprint_id: blueprintId,
              version: input.version,
              is_latest: makeLatest,
              status: 'available',
              entry_path: 'index.html',
              artifact_path: published.artifactPath,
              artifact_hash: published.hash,
              artifact_bytes: published.bytes,
              publish_source: 'web',
              publish_note: input.publishNote ?? '',
              deployed_at: now,
            })
            .execute();
          await trx
            .updateTable('blueprints')
            .set({ updated_at: now })
            .where('id', '=', blueprintId)
            .execute();
        });
      } catch (error) {
        await removeArtifactDir(call.storageRoot, blueprintId, input.version);
        if (isUniqueViolation(error)) {
          throw new AppError('VERSION_CONFLICT', `版本 ${input.version} 已存在；覆盖请走覆盖接口`);
        }
        throw error;
      }

      return mutationData(db, blueprintId, input.version);
    },
  );
}

/**
 * `PUT /api/blueprints/:id/versions/:version`：覆盖已有版本的产物（`version.cover`）。
 *
 * 版本号、`deployed_at`、`is_latest` 一律不动；`publish_source` 记为 `web-cover`。
 * 落盘是原子的（旧目录先改名为 `.bak-*`）；数据库写失败时尽力把旧产物改回来。
 */
export async function coverBlueprintVersion(
  db: Db,
  context: RequestContext,
  blueprintId: string,
  version: string,
  input: { readonly publishNote?: string },
  artifact: Buffer | null,
  call: ArtifactCall,
): Promise<BlueprintMutationData> {
  return audited(
    db,
    context,
    {
      action: 'version.cover',
      targetType: 'version',
      targetId: `${blueprintId}:${version}`,
      detail: { blueprintId, version },
    },
    call,
    async () => {
      const blueprint = await loadBlueprintOrThrow(db, blueprintId);
      const target = await db
        .selectFrom('blueprint_versions')
        .selectAll()
        .where('blueprint_id', '=', blueprintId)
        .where('version', '=', version)
        .executeTakeFirst();
      if (target === undefined || target.archived_at !== null) {
        throw new AppError('VERSION_NOT_FOUND', `版本 ${version} 不存在或已归档`);
      }
      assertAuthorized(context, 'version.cover', {
        kind: 'blueprint',
        blueprintId,
        groupId: blueprint.group_id,
      });

      const files = readArtifact(artifact);
      const published = await writeArtifactPackage({
        root: call.storageRoot,
        blueprintId,
        version,
        files,
        replace: true,
      });

      try {
        await db
          .updateTable('blueprint_versions')
          .set({
            artifact_path: published.artifactPath,
            artifact_hash: published.hash,
            artifact_bytes: published.bytes,
            publish_source: 'web-cover',
            publish_note: input.publishNote ?? target.publish_note,
          })
          .where('id', '=', target.id)
          .execute();
      } catch (error) {
        await restoreArtifactBackup(published, call.storageRoot, blueprintId, version);
        throw error;
      }

      return mutationData(db, blueprintId, version);
    },
  );
}

/**
 * `DELETE /api/blueprints/:id/versions/:version`：归档版本（`version.archive`），产物留在磁盘上。
 * 最后一个未归档版本受保护；被归档的是最新版本时，把 `is_latest` 转给剩下最新的未归档版本。
 */
export async function archiveBlueprintVersion(
  db: Db,
  context: RequestContext,
  blueprintId: string,
  version: string,
  call: CallerFacts,
): Promise<BlueprintMutationData> {
  return audited(
    db,
    context,
    {
      action: 'version.archive',
      targetType: 'version',
      targetId: `${blueprintId}:${version}`,
      detail: { blueprintId, version },
    },
    call,
    async () => {
      const blueprint = await loadBlueprintOrThrow(db, blueprintId);
      const versions = await loadVersions(db, blueprintId);
      const target = versions.find((item) => item.version === version);
      if (target === undefined || target.archived_at !== null) {
        throw new AppError('VERSION_NOT_FOUND', `版本 ${version} 不存在或已归档`);
      }
      assertAuthorized(context, 'version.archive', {
        kind: 'blueprint',
        blueprintId,
        groupId: blueprint.group_id,
      });
      if (versions.filter((item) => item.archived_at === null).length <= 1) {
        throw new AppError('LAST_VERSION_PROTECTED', '不能归档蓝图的最后一个可用版本');
      }

      const now = new Date();
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('blueprint_versions')
          .set({ archived_at: now })
          .where('id', '=', target.id)
          .execute();
        if (target.is_latest) {
          await trx
            .updateTable('blueprint_versions')
            .set({ is_latest: false })
            .where('blueprint_id', '=', blueprintId)
            .where('is_latest', '=', true)
            .execute();
          const next = await trx
            .selectFrom('blueprint_versions')
            .select(['id'])
            .where('blueprint_id', '=', blueprintId)
            .where('archived_at', 'is', null)
            .orderBy('deployed_at', 'desc')
            .orderBy('id', 'asc')
            .limit(1)
            .executeTakeFirst();
          if (next !== undefined) {
            await trx
              .updateTable('blueprint_versions')
              .set({ is_latest: true })
              .where('id', '=', next.id)
              .execute();
          }
        }
      });

      return mutationData(db, blueprintId, version);
    },
  );
}

/** `POST /api/blueprints/:id/versions/:version/restore`：只清 `archived_at`，不自动置最新。 */
export async function restoreBlueprintVersion(
  db: Db,
  context: RequestContext,
  blueprintId: string,
  version: string,
  call: CallerFacts,
): Promise<BlueprintMutationData> {
  return audited(
    db,
    context,
    {
      action: 'version.restore',
      targetType: 'version',
      targetId: `${blueprintId}:${version}`,
      detail: { blueprintId, version },
    },
    call,
    async () => {
      const blueprint = await loadBlueprintOrThrow(db, blueprintId);
      const target = await db
        .selectFrom('blueprint_versions')
        .select(['id', 'archived_at'])
        .where('blueprint_id', '=', blueprintId)
        .where('version', '=', version)
        .executeTakeFirst();
      if (target === undefined || target.archived_at === null) {
        throw new AppError('VERSION_NOT_FOUND', `版本 ${version} 不存在或未归档`);
      }
      assertAuthorized(context, 'version.restore', {
        kind: 'blueprint',
        blueprintId,
        groupId: blueprint.group_id,
      });
      await db
        .updateTable('blueprint_versions')
        .set({ archived_at: null })
        .where('id', '=', target.id)
        .execute();
      return mutationData(db, blueprintId, version);
    },
  );
}

/**
 * `PATCH /api/blueprints/:id`：改元数据、移动分组、归档 / 恢复。
 *
 * 判定按字段分派（§6.4）：移动 → `blueprint.move`（源与目标都要 `blueprint.manage`，
 * 不变量 8：移动视为授权变更）；元数据 → `blueprint.update`；`status` → `blueprint.archive`
 * 或 `blueprint.restore`。空请求体（没有任何可改字段）一律 `INVALID_ARGUMENT`。
 */
export async function updateBlueprint(
  db: Db,
  context: RequestContext,
  blueprintId: string,
  input: UpdateBlueprintRequest,
  call: CallerFacts,
): Promise<BlueprintMutationData> {
  const action =
    input.groupId !== undefined && input.groupId !== '' ? 'blueprint.move' : 'blueprint.update';
  return audited(
    db,
    context,
    {
      action,
      targetType: 'blueprint',
      targetId: blueprintId,
      detail: { fields: Object.keys(input) },
    },
    call,
    async () => {
      const blueprint = await loadBlueprintOrThrow(db, blueprintId);
      const hasField =
        input.name !== undefined ||
        input.summary !== undefined ||
        input.tags !== undefined ||
        input.groupId !== undefined ||
        input.status !== undefined;
      if (!hasField) throw new AppError('INVALID_ARGUMENT', '请求体没有任何可修改字段');

      const movesGroup = input.groupId !== undefined && input.groupId !== blueprint.group_id;
      const metadata =
        input.name !== undefined ||
        input.summary !== undefined ||
        input.tags !== undefined ||
        (input.groupId !== undefined && !movesGroup);

      if (metadata) {
        assertAuthorized(context, 'blueprint.update', {
          kind: 'blueprint',
          blueprintId,
          groupId: blueprint.group_id,
        });
      }
      if (movesGroup && input.groupId !== undefined) {
        assertAuthorized(context, 'blueprint.move', {
          kind: 'blueprintMove',
          blueprintId,
          fromGroupId: blueprint.group_id,
          toGroupId: input.groupId,
        });
      }
      if (input.status === 'archived') {
        assertAuthorized(context, 'blueprint.archive', {
          kind: 'blueprint',
          blueprintId,
          groupId: blueprint.group_id,
        });
      }
      if (input.status === 'active') {
        assertAuthorized(context, 'blueprint.restore', {
          kind: 'blueprint',
          blueprintId,
          groupId: blueprint.group_id,
        });
      }

      const now = new Date();
      let targetGroupId: string | undefined;
      if (movesGroup && input.groupId !== undefined) {
        const target = await loadGroupOrThrow(db, input.groupId);
        if (target.archived_at !== null) {
          throw new AppError('INVALID_ARGUMENT', '目标分组已归档，不能移入');
        }
        targetGroupId = target.id;
      }

      const patch: {
        name?: string;
        summary?: string;
        tags?: string[];
        group_id?: string;
        status?: 'active' | 'archived';
        archived_at?: Date | null;
        updated_at: Date;
      } = { updated_at: now };
      if (input.name !== undefined) patch.name = input.name;
      if (input.summary !== undefined) patch.summary = input.summary;
      if (input.tags !== undefined) patch.tags = [...input.tags];
      if (targetGroupId !== undefined) patch.group_id = targetGroupId;
      if (input.status !== undefined) {
        patch.status = input.status;
        patch.archived_at = input.status === 'archived' ? now : null;
      }

      await db.transaction().execute(async (trx) => {
        await trx.updateTable('blueprints').set(patch).where('id', '=', blueprintId).execute();
        // 归档 / 恢复蓝图时版本跟着走，避免出现「蓝图已归档、版本还可用」的中间态
        if (input.status !== undefined) {
          await trx
            .updateTable('blueprint_versions')
            .set({ archived_at: input.status === 'archived' ? now : null })
            .where('blueprint_id', '=', blueprintId)
            .execute();
        }
      });

      return mutationData(db, blueprintId, null);
    },
  );
}

/** `DELETE /api/blueprints/:id`：归档蓝图与其全部版本（不物理删除产物，可恢复）。 */
export async function archiveBlueprint(
  db: Db,
  context: RequestContext,
  blueprintId: string,
  call: CallerFacts,
): Promise<BlueprintMutationData> {
  return audited(
    db,
    context,
    { action: 'blueprint.archive', targetType: 'blueprint', targetId: blueprintId },
    call,
    async () => {
      const blueprint = await loadBlueprintOrThrow(db, blueprintId);
      assertAuthorized(context, 'blueprint.archive', {
        kind: 'blueprint',
        blueprintId,
        groupId: blueprint.group_id,
      });

      const now = new Date();
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('blueprints')
          .set({ status: 'archived', archived_at: now, updated_at: now })
          .where('id', '=', blueprintId)
          .execute();
        await trx
          .updateTable('blueprint_versions')
          .set({ archived_at: now })
          .where('blueprint_id', '=', blueprintId)
          .where('archived_at', 'is', null)
          .execute();
      });

      return mutationData(db, blueprintId, null);
    },
  );
}

/** `POST /api/blueprints/:id/restore`：蓝图与全部版本一起恢复。 */
export async function restoreBlueprint(
  db: Db,
  context: RequestContext,
  blueprintId: string,
  call: CallerFacts,
): Promise<BlueprintMutationData> {
  return audited(
    db,
    context,
    { action: 'blueprint.restore', targetType: 'blueprint', targetId: blueprintId },
    call,
    async () => {
      const blueprint = await loadBlueprintOrThrow(db, blueprintId);
      assertAuthorized(context, 'blueprint.restore', {
        kind: 'blueprint',
        blueprintId,
        groupId: blueprint.group_id,
      });

      const now = new Date();
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('blueprints')
          .set({ status: 'active', archived_at: null, updated_at: now })
          .where('id', '=', blueprintId)
          .execute();
        await trx
          .updateTable('blueprint_versions')
          .set({ archived_at: null })
          .where('blueprint_id', '=', blueprintId)
          .execute();
      });

      return mutationData(db, blueprintId, null);
    },
  );
}
