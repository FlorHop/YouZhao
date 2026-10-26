<script setup lang="ts">
/**
 * P2 蓝图页（`/blueprints`，frontend-design §P2）。
 *
 * 两级结构：分组区段 → 蓝图卡片；「全部蓝图」就是不筛选时的分组视图。
 * 数据一律来自服务端：搜索、分组筛选、状态筛选都作为查询参数发给后端，前端不做二次过滤，
 * 也不为未返回的内容渲染占位或计数（避免泄露资源存在性）。
 *
 * 权限口径：入口按能力装配——无权时**不渲染**按钮，而不是渲染一个禁用后的死路；
 * 服务端仍会逐接口校验，前端判定只决定「显示什么」。
 */
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import PageHeader from '@/components/common/PageHeader.vue';
import StateBlock from '@/components/common/StateBlock.vue';
import BlueprintCard from '@/components/blueprints/BlueprintCard.vue';
import BlueprintGroupSection from '@/components/blueprints/BlueprintGroupSection.vue';
import CoverVersionDialog from '@/components/blueprints/CoverVersionDialog.vue';
import type { CoverVersionPayload } from '@/components/blueprints/CoverVersionDialog.vue';
import CreateBlueprintDialog from '@/components/blueprints/CreateBlueprintDialog.vue';
import type { CreateBlueprintPayload } from '@/components/blueprints/CreateBlueprintDialog.vue';
import CreateGroupDialog from '@/components/blueprints/CreateGroupDialog.vue';
import EditBlueprintDialog from '@/components/blueprints/EditBlueprintDialog.vue';
import type { EditBlueprintPayload } from '@/components/blueprints/EditBlueprintDialog.vue';
import ManageVersionsDialog from '@/components/blueprints/ManageVersionsDialog.vue';
import PublishVersionDialog from '@/components/blueprints/PublishVersionDialog.vue';
import type { PublishVersionPayload } from '@/components/blueprints/PublishVersionDialog.vue';
import { ApiError } from '@/services/api';
import {
  archiveBlueprint,
  archiveBlueprintGroup,
  archiveBlueprintVersion,
  coverBlueprintVersion,
  createBlueprintGroup,
  createBlueprintWithArtifact,
  getBlueprint,
  listBlueprintGroups,
  listBlueprintsWithGroups,
  publishBlueprintVersion,
  reorderBlueprintGroups,
  restoreBlueprint,
  restoreBlueprintGroup,
  restoreBlueprintVersion,
  updateBlueprint,
} from '@/services/endpoints';
import type {
  BlueprintCapabilities,
  BlueprintCard as BlueprintCardRow,
  BlueprintGroup,
  BlueprintVersion,
} from '@/services/endpoints';
import { useSessionStore } from '@/stores/session';

/** 与契约一致的单页大小；服务端单次返回有上限，超出必须靠「加载更多」而不是静默截断。 */
const PAGE_SIZE = 20;

interface StatusOption {
  label: string;
  value: 'active' | 'archived';
}

const STATUS_OPTIONS: StatusOption[] = [
  { label: '未归档', value: 'active' },
  { label: '已归档', value: 'archived' },
];

interface GroupView {
  id: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  blueprintCount: number;
  archivedAt: string | null;
}

interface Section extends GroupView {
  cards: BlueprintCardRow[];
}

const session = useSessionStore();
const router = useRouter();
const route = useRoute();
const confirm = useConfirm();
const toast = useToast();

const keyword = ref('');
const groupFilter = ref('');
const statusFilter = ref<'active' | 'archived'>('active');
const page = ref(1);
const items = ref<BlueprintCardRow[]>([]);
const responseGroups = ref<GroupView[]>([]);
const managedGroups = ref<BlueprintGroup[]>([]);
const total = ref(0);
const listState = ref<'loading' | 'ready' | 'error'>('loading');
const listError = ref('');
const loadingMore = ref(false);
const refreshing = ref(false);
const lastLoadedAt = ref(0);

const selectedVersions = ref<Record<string, string>>({});
const versionCache = ref<Record<string, BlueprintVersion[]>>({});
const versionLoading = ref<Record<string, boolean>>({});
const capsCache = ref<Record<string, BlueprintCapabilities>>({});
const busy = ref(false);

const createDialogVisible = ref(false);
const createSubmitting = ref(false);
const createError = ref('');
const createIdempotencyKey = ref('');

const publishDialogVisible = ref(false);
const publishTarget = ref<BlueprintCardRow | null>(null);
const publishSubmitting = ref(false);
const publishError = ref('');

const coverDialogVisible = ref(false);
const coverTarget = ref<{ card: BlueprintCardRow; version: string } | null>(null);
const coverSubmitting = ref(false);
const coverError = ref('');

const editDialogVisible = ref(false);
const editTarget = ref<BlueprintCardRow | null>(null);
const editSubmitting = ref(false);
const editError = ref('');

const versionsDialogVisible = ref(false);
const versionsTarget = ref<BlueprintCardRow | null>(null);
const versionsData = ref<BlueprintVersion[] | null>(null);
const versionsCaps = ref<BlueprintCapabilities | null>(null);
const versionsLoading = ref(false);
const versionsError = ref('');
const versionBusy = ref('');

const groupDialogVisible = ref(false);
const groupSubmitting = ref(false);
const groupError = ref('');

const dialogOpen = computed(
  () =>
    createDialogVisible.value ||
    publishDialogVisible.value ||
    coverDialogVisible.value ||
    editDialogVisible.value ||
    versionsDialogVisible.value ||
    groupDialogVisible.value,
);

const canManageAnywhere = computed(() => session.hasCapability('blueprint.manage'));
/** 建组 = 划新地盘，只有所有者能做（docs/permission-design.md §2.3） */
const canCreateGroup = computed(() => session.isOwner);
const canPublishAnywhere = computed(() => session.canPublishAnywhere);
const filtersActive = computed(
  () => keyword.value.trim() !== '' || groupFilter.value !== '' || statusFilter.value !== 'active',
);

function compareGroups(a: GroupView, b: GroupView): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

const visibleGroups = computed<GroupView[]>(() => {
  const map = new Map<string, GroupView>();
  for (const group of responseGroups.value) map.set(group.id, group);
  for (const group of managedGroups.value) {
    const existing = map.get(group.id);
    map.set(group.id, {
      id: group.id,
      name: group.name,
      isDefault: group.isDefault,
      sortOrder: group.sortOrder,
      blueprintCount: existing?.blueprintCount ?? group.blueprintCount,
      archivedAt: group.archivedAt,
    });
  }
  return [...map.values()].sort(compareGroups);
});

const activeGroups = computed(() =>
  visibleGroups.value.filter((group) => group.archivedAt === null),
);
const archivedGroups = computed(() =>
  visibleGroups.value.filter((group) => group.archivedAt !== null),
);
const sortableGroups = computed(() => activeGroups.value.filter((group) => !group.isDefault));

const sections = computed<Section[]>(() => {
  const visible =
    groupFilter.value === ''
      ? activeGroups.value
      : activeGroups.value.filter((group) => group.id === groupFilter.value);
  const result: Section[] = visible.map((group) => ({
    ...group,
    cards: items.value.filter((card) => card.groupId === group.id),
  }));
  // 兜底：卡片落在了一个不在分组列表里的分组上——仍然显示出来，不能让服务端已判为
  // 可见的蓝图凭空消失。仅在未按分组筛选时兜底，否则会把筛选外的卡片漏进来。
  if (groupFilter.value === '') {
    const known = new Set(result.map((section) => section.id));
    const orphans = new Map<string, BlueprintCardRow[]>();
    for (const card of items.value) {
      if (known.has(card.groupId)) continue;
      const bucket = orphans.get(card.groupId) ?? [];
      bucket.push(card);
      orphans.set(card.groupId, bucket);
    }
    for (const [groupId, cards] of orphans) {
      result.push({
        id: groupId,
        name: cards[0]?.groupName ?? '未命名分组',
        isDefault: false,
        sortOrder: Number.MAX_SAFE_INTEGER,
        blueprintCount: cards.length,
        archivedAt: null,
        cards,
      });
    }
  }
  return result;
});

const hasMore = computed(() => items.value.length < total.value);
const groupFilterOptions = computed(() => [
  { label: '全部分组', value: '' },
  ...activeGroups.value.map((group) => ({ label: group.name, value: group.id })),
]);
const showGroupFilter = computed(() => activeGroups.value.length > 1);
const defaultGroupId = computed(() => activeGroups.value.find((group) => group.isDefault)?.id ?? '');
const publishableGroups = computed(() =>
  activeGroups.value.filter((group) => canPublishInGroup(group.id)),
);
const movableGroups = computed(() => activeGroups.value.filter((group) => canManageGroup(group.id)));
const showReorder = computed(
  () =>
    keyword.value.trim() === '' &&
    groupFilter.value === '' &&
    managedGroups.value.length > 0,
);
const showNoScopeState = computed(
  () => items.value.length === 0 && !session.isOwner && session.viewGrants.length === 0,
);
const versionsCanManage = computed(() => {
  if (versionsCaps.value !== null) return versionsCaps.value.canManage;
  const card = versionsTarget.value;
  return card === null ? false : capsFor(card).canManage;
});

const ledeText = computed(() => {
  if (listState.value === 'loading') return '正在加载可见蓝图…';
  if (listState.value === 'error') return '可见蓝图数量暂时无法获取。';
  const scope = filtersActive.value ? `筛选结果 ${total.value} 项` : `可见蓝图 ${total.value} 项`;
  return `${scope}。你能看到这里列出的全部内容；新建、发布与归档入口只在你被授权的范围内出现，服务端会逐项校验。`;
});

function canManageGroup(groupId: string): boolean {
  return session.hasCapability('blueprint.manage', { type: 'group', id: groupId, groupId });
}

function canPublishInGroup(groupId: string): boolean {
  return session.hasCapability('blueprint.publish', { type: 'group', id: groupId, groupId });
}

/** 卡片操作区口径：优先用已加载到的服务端能力，否则用会话里的能力范围（两者都只决定显示）。 */
function capsFor(card: BlueprintCardRow): BlueprintCapabilities {
  return capsCache.value[card.id] ?? session.blueprintCapabilities(card);
}

function selectedVersionFor(card: BlueprintCardRow): string {
  return selectedVersions.value[card.id] ?? card.latestVersion?.version ?? '';
}

function explainError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'PAYLOAD_TOO_LARGE' || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return '压缩包超出部署允许的体积上限，请精简产物后重试（服务端不会写入半成品）。';
    }
    const message = error.message.trim();
    if (message !== '') return message;
  }
  return fallback;
}

async function redirectIfSessionExpired(error: unknown): Promise<boolean> {
  if (error instanceof ApiError && error.isAuthError) {
    await session.load();
    await router.push({ name: 'login', query: { next: route.fullPath } });
    return true;
  }
  return false;
}

function toastOk(detail: string): void {
  toast.add({ severity: 'success', summary: detail, life: 3000 });
}

function toastFail(detail: string): void {
  toast.add({ severity: 'error', summary: '操作未完成', detail, life: 6000 });
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `blueprint-create-${crypto.randomUUID()}`;
  }
  return `blueprint-create-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clearFilters(): void {
  keyword.value = '';
  groupFilter.value = '';
  statusFilter.value = 'active';
}

async function loadList(append: boolean): Promise<void> {
  if (append) {
    if (loadingMore.value) return;
    loadingMore.value = true;
  } else if (listState.value === 'ready') {
    refreshing.value = true;
  } else {
    listState.value = 'loading';
    listError.value = '';
  }
  const nextPage = append ? page.value + 1 : 1;
  try {
    const envelope = await listBlueprintsWithGroups({
      page: nextPage,
      pageSize: PAGE_SIZE,
      keyword: keyword.value.trim() === '' ? undefined : keyword.value.trim(),
      groupId: groupFilter.value === '' ? undefined : groupFilter.value,
      status: statusFilter.value,
    });
    items.value = append ? [...items.value, ...envelope.items] : envelope.items;
    page.value = nextPage;
    total.value = envelope.meta.total;
    responseGroups.value = envelope.groups.map((group) => ({
      id: group.id,
      name: group.name,
      isDefault: group.isDefault,
      sortOrder: group.sortOrder,
      blueprintCount: group.blueprintCount,
      archivedAt: managedGroups.value.find((item) => item.id === group.id)?.archivedAt ?? null,
    }));
    pruneCaches();
    listState.value = 'ready';
    listError.value = '';
    lastLoadedAt.value = Date.now();
  } catch (error) {
    if (append) {
      toastFail(explainError(error, '加载更多失败，请稍后重试。'));
    } else if (await redirectIfSessionExpired(error)) {
      return;
    } else {
      listState.value = 'error';
      listError.value = explainError(error, '无法加载蓝图列表，请检查网络后重试。');
    }
  } finally {
    loadingMore.value = false;
    refreshing.value = false;
  }
}

async function loadGroups(): Promise<void> {
  try {
    const envelope = await listBlueprintGroups();
    managedGroups.value = envelope.data.items;
  } catch {
    // 分组管理信息（默认分组标记、归档状态、排序）拿不到时列表本身仍然可用：
    // 区段回落到列表接口返回的分组，分组管理入口自动收起，不把一个可浏览的页面变成错误页。
    managedGroups.value = [];
  }
}

/** 服务端结果才是权威：本地缓存的版本明细与能力只保留当前列表里仍然存在的蓝图。 */
function pruneCaches(): void {
  const alive = new Set(items.value.map((card) => card.id));
  const nextVersions: Record<string, BlueprintVersion[]> = {};
  for (const [id, versions] of Object.entries(versionCache.value)) {
    if (alive.has(id)) nextVersions[id] = versions;
  }
  versionCache.value = nextVersions;
  const nextCaps: Record<string, BlueprintCapabilities> = {};
  for (const [id, caps] of Object.entries(capsCache.value)) {
    if (alive.has(id)) nextCaps[id] = caps;
  }
  capsCache.value = nextCaps;
}

function invalidateVersions(blueprintId: string): void {
  const nextVersions = { ...versionCache.value };
  delete nextVersions[blueprintId];
  versionCache.value = nextVersions;
  const nextCaps = { ...capsCache.value };
  delete nextCaps[blueprintId];
  capsCache.value = nextCaps;
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadGroups(), loadList(false)]);
}

function onWindowFocus(): void {
  if (dialogOpen.value || busy.value) return;
  // 权限被撤销、蓝图被归档之后不得继续渲染本地缓存内容，所以重新聚焦时以服务端结果为准。
  if (Date.now() - lastLoadedAt.value < 3000) return;
  void loadGroups();
  void loadList(false);
}

let searchTimer: number | undefined;

watch(keyword, () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    void loadList(false);
  }, 300);
});

watch([groupFilter, statusFilter], () => {
  void loadList(false);
});

onMounted(() => {
  void loadGroups();
  void loadList(false);
  window.addEventListener('focus', onWindowFocus);
});

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer);
  window.removeEventListener('focus', onWindowFocus);
});

function openCreateDialog(): void {
  createError.value = '';
  createIdempotencyKey.value = newIdempotencyKey();
  createDialogVisible.value = true;
}

async function submitCreateBlueprint(payload: CreateBlueprintPayload): Promise<void> {
  createSubmitting.value = true;
  createError.value = '';
  busy.value = true;
  try {
    await createBlueprintWithArtifact(
      {
        name: payload.name,
        version: payload.version,
        ...(payload.summary === '' ? {} : { summary: payload.summary }),
        ...(payload.tags.length === 0 ? {} : { tags: payload.tags }),
        ...(payload.groupId === '' ? {} : { groupId: payload.groupId }),
        ...(payload.publishNote === '' ? {} : { publishNote: payload.publishNote }),
        idempotencyKey: createIdempotencyKey.value,
      },
      payload.artifact,
    );
    createDialogVisible.value = false;
    createIdempotencyKey.value = '';
    toastOk(`已创建蓝图「${payload.name}」并发布 v${payload.version}`);
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    createError.value = explainError(error, '创建失败，请检查已填内容后重试。');
  } finally {
    createSubmitting.value = false;
    busy.value = false;
  }
}

async function submitCreateGroup(name: string): Promise<void> {
  groupSubmitting.value = true;
  groupError.value = '';
  busy.value = true;
  try {
    await createBlueprintGroup({ name });
    groupDialogVisible.value = false;
    toastOk(`已新建分组「${name}」`);
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    groupError.value = explainError(error, '新建分组失败，请稍后重试。');
  } finally {
    groupSubmitting.value = false;
    busy.value = false;
  }
}

function confirmArchiveGroup(section: Section): void {
  confirm.require({
    header: '归档分组',
    message: `归档分组「${section.name}」后：其下的蓝图会回落到「默认分组」；该分组的授权会同时被移除，相关账号将立即失去通过这个分组获得的查看权。产物不会物理删除，之后可以恢复这个分组。`,
    acceptLabel: '归档分组',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: () => {
      void doArchiveGroup(section);
    },
  });
}

async function doArchiveGroup(section: Section): Promise<void> {
  busy.value = true;
  try {
    await archiveBlueprintGroup(section.id);
    toastOk(`已归档分组「${section.name}」，其下蓝图已回落到默认分组`);
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    toastFail(explainError(error, '归档分组失败，请稍后重试。'));
  } finally {
    busy.value = false;
  }
}

async function restoreGroup(group: { id: string; name: string }): Promise<void> {
  busy.value = true;
  try {
    await restoreBlueprintGroup(group.id);
    toastOk(`已恢复分组「${group.name}」`);
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    toastFail(explainError(error, '恢复分组失败，请稍后重试。'));
  } finally {
    busy.value = false;
  }
}

async function moveGroup(section: Section, delta: number): Promise<void> {
  const order = sortableGroups.value.map((group) => group.id);
  const index = order.indexOf(section.id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return;
  const moved = order[index];
  const replaced = order[target];
  if (moved === undefined || replaced === undefined) return;
  const next = [...order];
  next[index] = replaced;
  next[target] = moved;
  busy.value = true;
  try {
    await reorderBlueprintGroups({ orderedIds: next });
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    toastFail(explainError(error, '调整分组顺序失败，请稍后重试。'));
  } finally {
    busy.value = false;
  }
}

function openPublishDialog(card: BlueprintCardRow): void {
  publishTarget.value = card;
  publishError.value = '';
  publishDialogVisible.value = true;
}

async function submitPublishVersion(payload: PublishVersionPayload): Promise<void> {
  const card = publishTarget.value;
  if (card === null) return;
  publishSubmitting.value = true;
  publishError.value = '';
  busy.value = true;
  try {
    await publishBlueprintVersion(
      card.id,
      {
        version: payload.version,
        makeLatest: true,
        ...(payload.publishNote === '' ? {} : { publishNote: payload.publishNote }),
      },
      payload.artifact,
    );
    publishDialogVisible.value = false;
    invalidateVersions(card.id);
    toastOk(`已发布新版本 v${payload.version}，并设为最新`);
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    publishError.value = explainError(error, '发布新版本失败，请稍后重试。');
  } finally {
    publishSubmitting.value = false;
    busy.value = false;
  }
}

function openCoverDialog(card: BlueprintCardRow, version: string): void {
  coverTarget.value = { card, version };
  coverError.value = '';
  coverDialogVisible.value = true;
}

function submitCoverVersion(payload: CoverVersionPayload): void {
  const target = coverTarget.value;
  if (target === null) return;
  confirm.require({
    header: '覆盖已有版本',
    message: `将替换 v${target.version} 的产物，版本号与发布记录保持不变，原产物无法恢复。`,
    acceptLabel: '确认覆盖',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: () => {
      void doCoverVersion(target.card, payload);
    },
  });
}

async function doCoverVersion(card: BlueprintCardRow, payload: CoverVersionPayload): Promise<void> {
  coverSubmitting.value = true;
  coverError.value = '';
  busy.value = true;
  try {
    await coverBlueprintVersion(card.id, payload.version, payload.artifact, payload.publishNote);
    coverDialogVisible.value = false;
    invalidateVersions(card.id);
    toastOk(`已用新产物覆盖 v${payload.version}，版本号与发布记录未变`);
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    coverError.value = explainError(error, '覆盖未完成，原产物未被替换，请稍后重试。');
  } finally {
    coverSubmitting.value = false;
    busy.value = false;
  }
}

function openEditDialog(card: BlueprintCardRow): void {
  editTarget.value = card;
  editError.value = '';
  editDialogVisible.value = true;
}

async function submitEditBlueprint(payload: EditBlueprintPayload): Promise<void> {
  const card = editTarget.value;
  if (card === null) return;
  const input = {
    ...(payload.name === card.name ? {} : { name: payload.name }),
    ...(payload.summary === card.summary ? {} : { summary: payload.summary }),
    ...(payload.tags.join('\u0000') === card.tags.join('\u0000') ? {} : { tags: payload.tags }),
    ...(payload.groupId === card.groupId ? {} : { groupId: payload.groupId }),
  };
  if (Object.keys(input).length === 0) {
    editDialogVisible.value = false;
    toastOk('没有需要保存的改动');
    return;
  }
  editSubmitting.value = true;
  editError.value = '';
  busy.value = true;
  try {
    await updateBlueprint(card.id, input);
    editDialogVisible.value = false;
    toastOk('蓝图信息已保存');
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    editError.value = explainError(error, '保存失败，已保留你填写的内容，请重试。');
  } finally {
    editSubmitting.value = false;
    busy.value = false;
  }
}

function confirmArchiveBlueprint(card: BlueprintCardRow): void {
  confirm.require({
    header: '归档蓝图',
    message: `归档蓝图「${card.name}」会连同它的全部版本一并归档，相关账号将立即失去查看入口。产物不会物理删除，之后可以在「已归档」视图里恢复。`,
    acceptLabel: '归档蓝图',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: () => {
      void doArchiveBlueprint(card);
    },
  });
}

async function doArchiveBlueprint(card: BlueprintCardRow): Promise<void> {
  busy.value = true;
  try {
    await archiveBlueprint(card.id);
    invalidateVersions(card.id);
    toastOk(`已归档蓝图「${card.name}」`);
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    toastFail(explainError(error, '归档蓝图失败，请稍后重试。'));
  } finally {
    busy.value = false;
  }
}

async function restoreBlueprintCard(card: BlueprintCardRow): Promise<void> {
  busy.value = true;
  try {
    await restoreBlueprint(card.id);
    toastOk(`已恢复蓝图「${card.name}」`);
    await reloadAll();
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    toastFail(explainError(error, '恢复蓝图失败，请稍后重试。'));
  } finally {
    busy.value = false;
  }
}

async function onRequestVersions(card: BlueprintCardRow): Promise<void> {
  if (versionCache.value[card.id] !== undefined || versionLoading.value[card.id] === true) return;
  versionLoading.value = { ...versionLoading.value, [card.id]: true };
  try {
    const data = await getBlueprint(card.id);
    versionCache.value = { ...versionCache.value, [card.id]: data.versions };
    capsCache.value = { ...capsCache.value, [card.id]: data.capabilities };
    ensureSelectedVersion(card, data.versions);
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    toastFail(explainError(error, '无法加载版本列表，请稍后重试。'));
  } finally {
    versionLoading.value = { ...versionLoading.value, [card.id]: false };
  }
}

function ensureSelectedVersion(card: BlueprintCardRow, versions: readonly BlueprintVersion[]): void {
  const current = selectedVersions.value[card.id];
  if (
    current !== undefined &&
    versions.some((item) => item.version === current && item.archivedAt === null)
  ) {
    return;
  }
  const latest =
    versions.find((item) => item.isLatest && item.archivedAt === null) ??
    versions.find((item) => item.archivedAt === null);
  if (latest === undefined) return;
  selectedVersions.value = { ...selectedVersions.value, [card.id]: latest.version };
}

function onSelectVersion(card: BlueprintCardRow, version: string): void {
  selectedVersions.value = { ...selectedVersions.value, [card.id]: version };
}

async function openVersionsDialog(card: BlueprintCardRow): Promise<void> {
  versionsTarget.value = card;
  versionsData.value = versionCache.value[card.id] ?? null;
  versionsCaps.value = capsCache.value[card.id] ?? null;
  versionsError.value = '';
  versionsDialogVisible.value = true;
  await loadVersions(card.id);
}

async function loadVersions(blueprintId: string): Promise<void> {
  versionsLoading.value = true;
  versionsError.value = '';
  try {
    const data = await getBlueprint(blueprintId);
    if (versionsTarget.value?.id !== blueprintId) return;
    versionsData.value = data.versions;
    versionsCaps.value = data.capabilities;
    versionCache.value = { ...versionCache.value, [blueprintId]: data.versions };
    capsCache.value = { ...capsCache.value, [blueprintId]: data.capabilities };
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    versionsError.value = explainError(error, '无法加载版本列表，请重试。');
  } finally {
    versionsLoading.value = false;
  }
}

function reloadVersions(): void {
  const card = versionsTarget.value;
  if (card === null) return;
  void loadVersions(card.id);
}

function confirmArchiveVersion(version: string): void {
  const card = versionsTarget.value;
  if (card === null || versionBusy.value !== '') return;
  confirm.require({
    header: '归档版本',
    message: `归档版本 v${version} 后，这个版本不能再被预览；产物保留，随时可以恢复。蓝图必须至少保留一个可用版本。`,
    acceptLabel: '归档版本',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: () => {
      void doArchiveVersion(card, version);
    },
  });
}

async function doArchiveVersion(card: BlueprintCardRow, version: string): Promise<void> {
  versionBusy.value = version;
  try {
    await archiveBlueprintVersion(card.id, version);
    toastOk(`已归档版本 v${version}`);
    invalidateVersions(card.id);
    await reloadAll();
    await loadVersions(card.id);
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    versionsError.value = explainError(error, '归档版本失败，请稍后重试。');
  } finally {
    versionBusy.value = '';
  }
}

async function restoreVersion(version: string): Promise<void> {
  const card = versionsTarget.value;
  if (card === null || versionBusy.value !== '') return;
  versionBusy.value = version;
  try {
    await restoreBlueprintVersion(card.id, version);
    toastOk(`已恢复版本 v${version}`);
    invalidateVersions(card.id);
    await reloadAll();
    await loadVersions(card.id);
  } catch (error) {
    if (await redirectIfSessionExpired(error)) return;
    versionsError.value = explainError(error, '恢复版本失败，请稍后重试。');
  } finally {
    versionBusy.value = '';
  }
}

function openPreview(card: BlueprintCardRow, version: string): void {
  if (version === '') return;
  void router.push({ name: 'blueprint-preview', params: { id: card.id }, query: { version } });
}
</script>

<template>
  <div class="stack">
    <PageHeader title="蓝图" :lede="ledeText">
      <template #actions>
        <Button v-if="canPublishAnywhere" label="新建蓝图" icon="pi pi-plus" @click="openCreateDialog" />
      </template>
    </PageHeader>

    <div class="toolbar">
      <span class="inline search-field">
        <i class="pi pi-search" aria-hidden="true" />
        <InputText v-model="keyword" placeholder="搜索蓝图名称或概述" aria-label="搜索蓝图" />
      </span>
      <Select
        v-if="showGroupFilter"
        v-model="groupFilter"
        :options="groupFilterOptions"
        option-label="label"
        option-value="value"
        aria-label="按分组筛选"
      />
      <Select
        v-if="canManageAnywhere"
        v-model="statusFilter"
        :options="STATUS_OPTIONS"
        option-label="label"
        option-value="value"
        aria-label="按状态筛选"
      />
      <span class="toolbar-spacer" />
      <span v-if="refreshing" class="caption">正在刷新…</span>
      <Button
        v-if="canCreateGroup"
        label="新建分组"
        icon="pi pi-folder"
        outlined
        size="small"
        @click="groupDialogVisible = true"
      />
    </div>

    <div v-if="listState === 'loading'" class="card-grid">
      <div v-for="index in 6" :key="index" class="skeleton-block skeleton-card" />
    </div>

    <StateBlock
      v-else-if="listState === 'error'"
      state="error"
      :description="listError"
      @retry="() => loadList(false)"
    />

    <div v-else-if="showNoScopeState" class="empty-state">
      <i class="pi pi-lock" aria-hidden="true" />
      <p class="section-title">没有可查看的蓝图范围</p>
      <p class="caption reject-text">
        你的账号还没有被授予任何蓝图查看范围，因此这里不会显示任何内容。请联系平台所有者或管理员，把你的账号加入对应的分组或蓝图。
      </p>
    </div>

    <StateBlock
      v-else-if="items.length === 0 && filtersActive"
      state="empty"
      title="没有符合条件的蓝图"
      description="试试调整关键词、分组或状态筛选；清空筛选可以看到你能查看的全部蓝图。"
      action-label="清空筛选"
      @action="clearFilters"
    />

    <StateBlock
      v-else-if="items.length === 0 && canPublishAnywhere"
      state="empty"
      title="还没有蓝图"
      description="创建第一个蓝图，同时发布它的首个版本；之后可以在卡片上发布新版本或调整分组。"
      action-label="新建蓝图"
      @action="openCreateDialog"
    />

    <StateBlock
      v-else-if="items.length === 0"
      state="empty"
      title="你还没有可查看的蓝图"
      description="请联系管理员为你分配查看范围；分配完成后这里会显示你可查看的蓝图。"
    />

    <template v-else>
      <BlueprintGroupSection
        v-for="(section, index) in sections"
        :key="section.id"
        :group="section"
        :rendered-count="section.cards.length"
        :reorderable="showReorder"
        :can-move-up="index > 0"
        :can-move-down="index < sections.length - 1"
        :can-archive="!section.isDefault && canManageGroup(section.id)"
        @move-up="moveGroup(section, -1)"
        @move-down="moveGroup(section, 1)"
        @archive="confirmArchiveGroup(section)"
      >
        <div class="card-grid">
          <BlueprintCard
            v-for="card in section.cards"
            :key="card.id"
            :card="card"
            :caps="capsFor(card)"
            :versions="versionCache[card.id] ?? null"
            :versions-loading="versionLoading[card.id] === true"
            :selected-version="selectedVersionFor(card)"
            :busy="busy"
            @preview="(version: string) => openPreview(card, version)"
            @request-versions="onRequestVersions(card)"
            @update:selected-version="(version: string) => onSelectVersion(card, version)"
            @edit="openEditDialog(card)"
            @publish="openPublishDialog(card)"
            @cover="(version: string) => openCoverDialog(card, version)"
            @manage-versions="openVersionsDialog(card)"
            @archive="confirmArchiveBlueprint(card)"
            @restore="restoreBlueprintCard(card)"
          />
        </div>
      </BlueprintGroupSection>

      <BlueprintGroupSection
        v-for="group in groupFilter === '' ? archivedGroups : []"
        :key="`archived-${group.id}`"
        :group="group"
        :archived="true"
        :can-restore="canManageGroup(group.id)"
        @restore="restoreGroup(group)"
      />

      <div class="load-more-row">
        <span class="caption">已显示 {{ items.length }} / 共 {{ total }} 项</span>
        <Button
          v-if="hasMore"
          label="加载更多"
          outlined
          size="small"
          :loading="loadingMore"
          @click="loadList(true)"
        />
        <span v-else class="caption">已显示全部</span>
      </div>
    </template>

    <CreateBlueprintDialog
      v-model:visible="createDialogVisible"
      :groups="publishableGroups"
      :default-group-id="defaultGroupId"
      :submitting="createSubmitting"
      :error-text="createError"
      @submit="submitCreateBlueprint"
    />

    <CreateGroupDialog
      v-model:visible="groupDialogVisible"
      :submitting="groupSubmitting"
      :error-text="groupError"
      @submit="submitCreateGroup"
    />

    <PublishVersionDialog
      v-model:visible="publishDialogVisible"
      :blueprint-name="publishTarget?.name ?? ''"
      :submitting="publishSubmitting"
      :error-text="publishError"
      @submit="submitPublishVersion"
    />

    <CoverVersionDialog
      v-model:visible="coverDialogVisible"
      :blueprint-name="coverTarget?.card.name ?? ''"
      :version="coverTarget?.version ?? ''"
      :submitting="coverSubmitting"
      :error-text="coverError"
      @submit="submitCoverVersion"
    />

    <EditBlueprintDialog
      v-model:visible="editDialogVisible"
      :blueprint="editTarget"
      :groups="movableGroups"
      :submitting="editSubmitting"
      :error-text="editError"
      @submit="submitEditBlueprint"
    />

    <ManageVersionsDialog
      v-model:visible="versionsDialogVisible"
      :blueprint-name="versionsTarget?.name ?? ''"
      :versions="versionsData"
      :loading="versionsLoading"
      :error-text="versionsError"
      :can-manage="versionsCanManage"
      :busy-version="versionBusy"
      @archive="confirmArchiveVersion"
      @restore="restoreVersion"
      @reload="reloadVersions"
    />
  </div>
</template>

<style scoped>
.search-field {
  align-items: center;
  gap: var(--space-2);
}

.skeleton-card {
  height: 168px;
}

.reject-text {
  max-width: 34rem;
}

.load-more-row {
  align-items: center;
  display: flex;
  gap: var(--space-3);
  justify-content: center;
}
</style>
