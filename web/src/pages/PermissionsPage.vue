<script setup lang="ts">
/**
 * 权限（设计 P5，`docs/frontend-design.md` §6 / §7；权限模型 `docs/permission-design.md` §2–§5）。
 *
 * 页面分四段，可见性与可执行动作全部按身份与接口返回裁剪：
 *   区段一「查看范围授权」   所有者与用户管理员可见；用户管理员的**可调整范围等于本人查看范围**（裁决 S1），
 *                            他人授予的授权只读展示、不提供勾选框（§3.2）。
 *   区段二「管理员与可委派范围」仅所有者；可委派范围**不单独设置**，等于该管理员自己在区段一被授予的查看范围，
 *                            因此行内操作是「查看其范围」（`docs/architecture-design.md` §3.5）。
 *   区段三「业务能力」       仅所有者；能力必须带资源范围，没有「全部分组」默认值。
 *   区段四「权限矩阵说明」   纯静态文案（§9 文案规范）。
 *
 * 前端只负责不渲染越权入口，**不是安全边界**：每个请求仍由服务端逐条判定（设计 §11）。
 */
import type {
  BlueprintCard,
  BlueprintGroup,
  CapabilityName,
  CapabilityRef,
  ScopeRef,
  UserRow,
  ViewGrant,
} from '@/services/endpoints';

import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import MetricRow, { type Metric } from '@/components/common/MetricRow.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import StateBlock from '@/components/common/StateBlock.vue';
import AddAdminDialog from '@/components/permissions/AddAdminDialog.vue';
import AdminDelegationSection from '@/components/permissions/AdminDelegationSection.vue';
import CapabilityGrantDialog from '@/components/permissions/CapabilityGrantDialog.vue';
import CapabilitySection from '@/components/permissions/CapabilitySection.vue';
import GrantChangeBar from '@/components/permissions/GrantChangeBar.vue';
import PermissionMatrix from '@/components/permissions/PermissionMatrix.vue';
import ScopeGrantPanel from '@/components/permissions/ScopeGrantPanel.vue';
import { ApiError } from '@/services/api';
import {
  changeUserGrants,
  listBlueprintGroups,
  listBlueprintsWithGroups,
  listUserGrants,
  listUsers,
  setUserCapabilities,
  setUserIdentity,
} from '@/services/endpoints';
import { formatDateTime } from '@/services/format';
import { capabilityLabel, identityLabel, useSessionStore } from '@/stores/session';

const session = useSessionStore();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const confirm = useConfirm();

const BULK_PAGE_SIZE = 100;
const BULK_MAX_PAGES = 20;

/** 区段一左栏的列（用户管理员视角不出现身份列）。 */
interface SubjectColumn {
  field: 'displayName' | 'username' | 'identity';
  header: string;
}

const SUBJECT_COLUMNS: readonly SubjectColumn[] = [
  { field: 'displayName', header: '姓名' },
  { field: 'username', header: '用户名' },
  { field: 'identity', header: '身份' },
];

const subjectColumns = computed<readonly SubjectColumn[]>(() =>
  session.isOwner ? SUBJECT_COLUMNS : SUBJECT_COLUMNS.filter((column) => column.field !== 'identity'),
);

// ── 基础数据 ──────────────────────────────────────────────────────────────

const users = ref<UserRow[]>([]);
const groups = ref<BlueprintGroup[]>([]);
const blueprints = ref<BlueprintCard[]>([]);
const loading = ref(true);
const loaded = ref(false);
const loadError = ref('');

const adminScope = ref<Map<string, ViewGrant[]>>(new Map());

// ── 区段一 ────────────────────────────────────────────────────────────────

const selectedUserId = ref('');
const selectedGrants = ref<ViewGrant[]>([]);
const grantsLoading = ref(false);
const grantsError = ref('');
const pendingAdd = ref<Set<string>>(new Set());
const pendingRemove = ref<Set<string>>(new Set());
const applying = ref(false);
const conflictNotice = ref('');

const sectionOne = ref<HTMLElement | null>(null);

// ── 区段二 / 区段三 ───────────────────────────────────────────────────────

const addAdminVisible = ref(false);
const addAdminSubmitting = ref(false);
const addAdminError = ref('');

const capabilityDialogVisible = ref(false);
const capabilitySubmitting = ref(false);
const capabilityError = ref('');
const capabilityState = ref<Map<string, CapabilityRef[]>>(new Map());

interface LocalCapabilityRecord {
  id: string;
  userId: string;
  userName: string;
  capabilityLabel: string;
  scopeLabel: string;
  grantedAt: string;
  ref: CapabilityRef;
}

const capabilityRecords = ref<LocalCapabilityRecord[]>([]);

// ── 派生数据 ──────────────────────────────────────────────────────────────

const meId = computed(() => session.user?.id ?? '');

const lede = computed(() =>
  session.isOwner
    ? '为账号分配查看范围与业务能力；可委派范围由查看范围决定'
    : '只管理平台所有者指派给你的用户，也只能在自己获准的范围内授权',
);

const userById = computed(() => new Map(users.value.map((user) => [user.id, user])));

const labelByKey = computed(() => {
  const map = new Map<string, string>();
  for (const group of groups.value) map.set(`group:${group.id}`, group.name);
  for (const item of blueprints.value) map.set(`blueprint:${item.id}`, item.name);
  return map;
});

/** 区段一的可调整对象：所有者=全部可见分组与蓝图；用户管理员=本人可委派范围（S1）。 */
const editableTargets = computed(() => {
  if (session.isOwner) {
    return {
      groups: groups.value.map((group) => ({ key: `group:${group.id}`, label: group.name })),
      blueprints: blueprints.value.map((item) => ({ key: `blueprint:${item.id}`, label: item.name })),
    };
  }
  const groupKeys: { key: string; label: string }[] = [];
  const blueprintKeys: { key: string; label: string }[] = [];
  for (const scope of session.delegableScopes) {
    const key = keyOf(scope.targetType, scope.targetId);
    const label = labelByKey.value.get(key) ?? scope.targetId;
    if (scope.targetType === 'group') groupKeys.push({ key, label });
    else blueprintKeys.push({ key, label });
  }
  groupKeys.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  blueprintKeys.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  return { groups: groupKeys, blueprints: blueprintKeys };
});

/** 只能切换本人授予的授权：他人授予的项只读（设计 §3.2）。 */
const myGrantKeys = computed(
  () =>
    new Set(
      selectedGrants.value
        .filter((grant) => grant.grantedByUserId === meId.value)
        .map((grant) => keyOf(grant.targetType, grant.targetId)),
    ),
);

const groupTargets = computed(() =>
  editableTargets.value.groups.map((target) => ({ ...target, checked: isChecked(target.key) })),
);

const blueprintTargets = computed(() =>
  editableTargets.value.blueprints.map((target) => ({ ...target, checked: isChecked(target.key) })),
);

const readonlyGrants = computed(() =>
  selectedGrants.value
    .filter((grant) => grant.grantedByUserId !== meId.value)
    .map((grant) => {
      const key = keyOf(grant.targetType, grant.targetId);
      return {
        key,
        label: labelByKey.value.get(key) ?? grant.targetId,
        grantedByDisplayName: grant.grantedByDisplayName,
        grantedAt: grant.grantedAt,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN')),
);

const addLabels = computed(() => [...pendingAdd.value].map(labelOfKey));
const removeLabels = computed(() => [...pendingRemove.value].map(labelOfKey));

const editableHint = computed(() =>
  session.isOwner
    ? '你可以为任意用户调整任意分组与单个蓝图的查看权。'
    : '你可以调整的范围等于你自己的查看范围；超出范围的授权会被服务端拒绝。',
);

const readonlyHint = computed(() =>
  session.isOwner
    ? '这些授权来自你本人或其他管理员的直接授予，不受本页勾选影响。'
    : '由其他人授予的授权在当前模型中不可取消，这里只做展示。',
);

const selectedUser = computed(() => userById.value.get(selectedUserId.value) ?? null);

const selectableUsers = computed(() =>
  users.value
    .filter((user) => user.identity !== 'owner' && user.id !== meId.value)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')),
);

const metrics = computed<Metric[]>(() => [
  { label: '可选用户', value: selectableUsers.value.length },
  { label: '可调整分组', value: editableTargets.value.groups.length },
  { label: '可调整蓝图', value: editableTargets.value.blueprints.length },
]);

const adminRows = computed(() =>
  users.value
    .filter((user) => user.identity === 'user_admin')
    .map((user) => {
      const grants = adminScope.value.get(user.id) ?? [];
      const groupCount = grants.filter((grant) => grant.targetType === 'group').length;
      const blueprintCount = grants.length - groupCount;
      return {
        id: user.id,
        displayName: user.displayName,
        managedCount: users.value.filter((item) => item.managedByUserIds.includes(user.id)).length,
        scopeSummary:
          grants.length === 0 ? '尚未授予查看范围' : `${groupCount} 个分组 · ${blueprintCount} 个蓝图`,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')),
);

const adminCandidates = computed(() =>
  users.value
    .filter((user) => user.identity === 'member' && user.status === 'active')
    .map((user) => ({ label: `${user.displayName}（${user.username}）`, value: user.id })),
);

const userOptions = computed(() =>
  users.value
    .filter((user) => user.identity !== 'owner' && user.id !== meId.value)
    .map((user) => ({ label: `${user.displayName}（${user.username}）`, value: user.id })),
);

const groupOptions = computed(() =>
  groups.value.map((group) => ({ label: group.name, value: group.id })),
);

const blueprintOptions = computed(() =>
  blueprints.value.map((item) => ({ label: item.name, value: item.id })),
);

const usersEmpty = computed(
  () => loaded.value && loadError.value === '' && selectableUsers.value.length === 0,
);

// ── 工具函数 ──────────────────────────────────────────────────────────────

function keyOf(targetType: string, targetId: string): string {
  return `${targetType}:${targetId}`;
}

function labelOfKey(key: string): string {
  return labelByKey.value.get(key) ?? key;
}

function refOfKey(key: string): ScopeRef {
  const separator = key.indexOf(':');
  return {
    targetType: key.slice(0, separator) as ScopeRef['targetType'],
    targetId: key.slice(separator + 1),
  };
}

function sameTarget(
  left: { targetType: string; targetId: string },
  right: { targetType: string; targetId: string },
): boolean {
  return left.targetType === right.targetType && left.targetId === right.targetId;
}

function isChecked(key: string): boolean {
  if (pendingAdd.value.has(key)) return true;
  if (pendingRemove.value.has(key)) return false;
  return myGrantKeys.value.has(key);
}

function hasPending(): boolean {
  return pendingAdd.value.size > 0 || pendingRemove.value.size > 0;
}

function scopeLabelOf(ref: ScopeRef): string {
  return labelByKey.value.get(keyOf(ref.targetType, ref.targetId)) ?? ref.targetId;
}

function apiCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

function apiMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return fallback;
}

function rowClass(user: UserRow): string {
  return user.id === selectedUserId.value ? 'is-selected' : '';
}

// ── 区段一动作 ────────────────────────────────────────────────────────────

async function loadGrants(userId: string): Promise<void> {
  grantsLoading.value = true;
  grantsError.value = '';
  try {
    const result = await listUserGrants(userId);
    if (selectedUserId.value !== userId) return;
    selectedGrants.value = result.data.items;
  } catch (error) {
    if (selectedUserId.value !== userId) return;
    selectedGrants.value = [];
    grantsError.value = apiMessage(error, '这个用户的查看范围没能加载出来');
  } finally {
    if (selectedUserId.value === userId) grantsLoading.value = false;
  }
}

async function openSubject(userId: string): Promise<void> {
  selectedUserId.value = userId;
  conflictNotice.value = '';
  discardPending();
  await loadGrants(userId);
}

/** 有未提交变更时先确认，避免静默丢改动（设计 §7）。 */
function selectUser(user: UserRow): void {
  if (user.id === selectedUserId.value) return;
  if (!hasPending()) {
    void openSubject(user.id);
    return;
  }
  confirm.require({
    header: '放弃未提交的变更？',
    message: '切换用户会丢弃当前未应用的授权变更。',
    acceptLabel: '放弃并切换',
    rejectLabel: '留在当前用户',
    accept: () => {
      discardPending();
      void openSubject(user.id);
    },
  });
}

/** 勾选只改待提交集合，不直接落库（增量提交，设计 §7）。 */
function toggle(key: string): void {
  if (applying.value) return;
  const nextAdd = new Set(pendingAdd.value);
  const nextRemove = new Set(pendingRemove.value);
  if (nextAdd.has(key)) nextAdd.delete(key);
  else if (nextRemove.has(key)) nextRemove.delete(key);
  else if (myGrantKeys.value.has(key)) nextRemove.add(key);
  else nextAdd.add(key);
  pendingAdd.value = nextAdd;
  pendingRemove.value = nextRemove;
}

function discardPending(): void {
  pendingAdd.value = new Set();
  pendingRemove.value = new Set();
}

async function applyChanges(): Promise<void> {
  const userId = selectedUserId.value;
  if (userId === '' || !hasPending()) return;
  applying.value = true;
  conflictNotice.value = '';
  try {
    await changeUserGrants(userId, {
      add: [...pendingAdd.value].map(refOfKey),
      remove: [...pendingRemove.value].map(refOfKey),
    });
    discardPending();
    await loadGrants(userId);
    toast.add({ severity: 'success', summary: '已保存', detail: '查看范围已更新。', life: 3000 });
  } catch (error) {
    if (apiCode(error) === 'STALE_PERMISSION_STATE') {
      discardPending();
      await loadGrants(userId);
      conflictNotice.value = '查看范围在别处被改动，已为你刷新；未提交的变更已清除，请确认后重试。';
      return;
    }
    toast.add({
      severity: 'error',
      summary: '保存失败',
      detail: apiMessage(error, '查看范围没能保存'),
      life: 5000,
    });
  } finally {
    applying.value = false;
  }
}

// ── 区段二动作 ────────────────────────────────────────────────────────────

function viewScope(adminId: string): void {
  void openSubject(adminId);
  void nextTick(() => sectionOne.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function openAddAdmin(): void {
  addAdminError.value = '';
  addAdminVisible.value = true;
}

async function submitAddAdmin(userId: string): Promise<void> {
  addAdminSubmitting.value = true;
  addAdminError.value = '';
  try {
    await setUserIdentity(userId, 'user_admin');
    addAdminVisible.value = false;
    await load();
    toast.add({ severity: 'success', summary: '已任命', detail: '该用户已成为用户管理员。', life: 3000 });
  } catch (error) {
    addAdminError.value = apiMessage(error, '任命失败');
  } finally {
    addAdminSubmitting.value = false;
  }
}

// ── 区段三动作 ────────────────────────────────────────────────────────────

function openCapabilityDialog(): void {
  capabilityError.value = '';
  capabilityDialogVisible.value = true;
}

function recordIdOf(userId: string, ref: CapabilityRef): string {
  return `${userId}:${ref.capability}:${ref.targetType}:${ref.targetId}`;
}

/**
 * 契约现状：本期没有「读取他人业务能力」的接口，`PUT /api/users/:id/capabilities`
 * 又是**整体替换**语义，因此当本地不知道该用户已有能力时，提交前必须先说明会覆盖。
 */
function submitCapability(userId: string, capability: CapabilityName, target: ScopeRef): void {
  const known = capabilityState.value.get(userId) ?? [];
  if (known.length > 0) {
    void commitCapability(userId, capability, target);
    return;
  }
  confirm.require({
    header: '整体替换该用户的业务能力？',
    message: '本期没有读取他人已有能力的接口。提交后，该用户的业务能力集合将被替换为你在本页维护的内容。',
    acceptLabel: '继续提交',
    rejectLabel: '取消',
    accept: () => {
      void commitCapability(userId, capability, target);
    },
  });
}

async function commitCapability(
  userId: string,
  capability: CapabilityName,
  target: ScopeRef,
): Promise<void> {
  const next: CapabilityRef[] = (capabilityState.value.get(userId) ?? [])
    .filter((item) => !(item.capability === capability && sameTarget(item, target)))
    .concat([{ capability, targetType: target.targetType, targetId: target.targetId }]);

  capabilitySubmitting.value = true;
  capabilityError.value = '';
  try {
    await setUserCapabilities(userId, next);
    capabilityState.value = new Map(capabilityState.value).set(userId, next);
    capabilityDialogVisible.value = false;
    rebuildCapabilityRecords();
    toast.add({ severity: 'success', summary: '已授予', detail: '业务能力已更新。', life: 3000 });
  } catch (error) {
    capabilityError.value = apiMessage(error, '授予失败');
  } finally {
    capabilitySubmitting.value = false;
  }
}

async function revokeCapability(recordId: string): Promise<void> {
  const record = capabilityRecords.value.find((item) => item.id === recordId);
  if (record === undefined) return;
  const next = (capabilityState.value.get(record.userId) ?? []).filter(
    (item) => !(item.capability === record.ref.capability && sameTarget(item, record.ref)),
  );
  capabilitySubmitting.value = true;
  try {
    await setUserCapabilities(record.userId, next);
    capabilityState.value = new Map(capabilityState.value).set(record.userId, next);
    rebuildCapabilityRecords();
    toast.add({ severity: 'success', summary: '已撤销', detail: '业务能力已更新。', life: 3000 });
  } catch (error) {
    toast.add({
      severity: 'error',
      summary: '撤销失败',
      detail: apiMessage(error, '业务能力没能更新'),
      life: 5000,
    });
  } finally {
    capabilitySubmitting.value = false;
  }
}

function rebuildCapabilityRecords(): void {
  const grantedAt = formatDateTime(new Date().toISOString());
  const records: LocalCapabilityRecord[] = [];
  for (const [userId, refs] of capabilityState.value) {
    const userName = userById.value.get(userId)?.displayName ?? userId;
    for (const ref of refs) {
      records.push({
        id: recordIdOf(userId, ref),
        userId,
        userName,
        capabilityLabel: capabilityLabel(ref.capability),
        scopeLabel: scopeLabelOf(ref),
        grantedAt,
        ref,
      });
    }
  }
  capabilityRecords.value = records;
}

// ── 加载 ──────────────────────────────────────────────────────────────────

async function loadAllUsers(): Promise<UserRow[]> {
  const collected: UserRow[] = [];
  let page = 1;
  for (;;) {
    const result = await listUsers({ page, pageSize: BULK_PAGE_SIZE });
    collected.push(...result.data.items);
    const total = result.meta.total;
    if (collected.length >= total || page >= BULK_MAX_PAGES || result.data.items.length === 0) break;
    page += 1;
  }
  return collected;
}

/** 区段二的「可委派范围摘要」来自各管理员自己的查看范围（没有单独设置入口）。 */
async function loadAdminScope(list: UserRow[]): Promise<void> {
  const admins = list.filter((user) => user.identity === 'user_admin');
  const entries = await Promise.all(
    admins.map(async (admin): Promise<[string, ViewGrant[]]> => {
      try {
        const result = await listUserGrants(admin.id);
        return [admin.id, result.data.items];
      } catch {
        return [admin.id, []];
      }
    }),
  );
  adminScope.value = new Map(entries);
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const [userList, groupList, blueprintList] = await Promise.all([
      loadAllUsers(),
      listBlueprintGroups(),
      listBlueprintsWithGroups({ pageSize: BULK_PAGE_SIZE }),
    ]);
    users.value = userList;
    groups.value = groupList.data.items;
    blueprints.value = blueprintList.items;
    rebuildCapabilityRecords();
    if (session.isOwner) void loadAdminScope(userList);
    loaded.value = true;
  } catch (error) {
    loadError.value = apiMessage(error, '权限数据没能加载出来');
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  const preselect = route.query.userId;
  if (typeof preselect === 'string' && preselect !== '') {
    if (userById.value.has(preselect)) {
      await openSubject(preselect);
      void nextTick(() => sectionOne.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
    await router.replace({ name: 'permissions' });
    return;
  }
  const first = selectableUsers.value[0];
  if (first !== undefined) await openSubject(first.id);
});
</script>

<template>
  <section class="page">
    <PageHeader title="权限" :lede="lede" />

    <StateBlock
      v-if="loadError !== ''"
      state="error"
      title="权限数据加载失败"
      :description="loadError"
      :on-retry="load"
    />

    <template v-else>
      <MetricRow :metrics="metrics" />

      <StateBlock
        v-if="usersEmpty"
        state="empty"
        title="还没有可以配置权限的用户"
        description="先到「用户」页创建账号；用户管理员只能看到平台所有者指派给自己的用户。"
      />

      <!-- 区段一：查看范围授权 -->
      <section ref="sectionOne" class="section-block">
        <div class="section-head">
          <h2 class="section-title">查看范围授权</h2>
          <p class="caption">
            授权决定一位用户能看到哪些分组与蓝图；用户管理员自己的可委派范围就是其本人被授予的查看范围。
          </p>
        </div>

        <div v-if="selectableUsers.length > 0" class="split">
          <div class="split-left">
            <DataTable
              :value="selectableUsers"
              data-key="id"
              size="small"
              scrollable
              scroll-height="420px"
              :loading="loading"
              :row-class="rowClass"
              @row-click="(event: { data: UserRow }) => selectUser(event.data)"
            >
              <Column
                v-for="column in subjectColumns"
                :key="column.field"
                :field="column.field"
                :header="column.header"
              >
                <template #body="{ data }">
                  <span v-if="column.field === 'identity'">
                    <Tag :value="identityLabel(data.identity)" severity="secondary" />
                  </span>
                  <span v-else>{{ data[column.field] }}</span>
                </template>
              </Column>
            </DataTable>
          </div>

          <div class="split-right">
            <ScopeGrantPanel
              :user="selectedUser"
              :group-targets="groupTargets"
              :blueprint-targets="blueprintTargets"
              :readonly-grants="readonlyGrants"
              :loading="grantsLoading"
              :error-text="grantsError"
              :disabled="applying"
              :editable-hint="editableHint"
              :readonly-hint="readonlyHint"
              @toggle="toggle"
              @retry="() => loadGrants(selectedUserId)"
            />
          </div>
        </div>

        <p v-if="conflictNotice !== ''" class="notice">{{ conflictNotice }}</p>

        <GrantChangeBar
          :additions="addLabels"
          :removals="removeLabels"
          :applying="applying"
          :blocked="selectedUserId === ''"
          @apply="applyChanges"
          @discard="discardPending"
        />
      </section>

      <!-- 区段二 / 区段三：仅平台所有者 -->
      <template v-if="session.isOwner">
        <AdminDelegationSection
          :rows="adminRows"
          :submitting="addAdminSubmitting"
          @view-scope="viewScope"
          @add="openAddAdmin"
        />

        <CapabilitySection
          :records="capabilityRecords"
          :submitting="capabilitySubmitting"
          @add="openCapabilityDialog"
          @revoke="revokeCapability"
        />
      </template>

      <PermissionMatrix />
    </template>

    <AddAdminDialog
      v-model:visible="addAdminVisible"
      :candidates="adminCandidates"
      :submitting="addAdminSubmitting"
      :error-text="addAdminError"
      @submit="submitAddAdmin"
    />

    <CapabilityGrantDialog
      v-model:visible="capabilityDialogVisible"
      :user-options="userOptions"
      :group-options="groupOptions"
      :blueprint-options="blueprintOptions"
      :submitting="capabilitySubmitting"
      :error-text="capabilityError"
      @submit="submitCapability"
    />
  </section>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: minmax(280px, 4fr) minmax(360px, 6fr);
  gap: var(--space-4);
  align-items: start;
}

.split-left :deep(.p-datatable-tbody > tr) {
  cursor: pointer;
}

.split-left :deep(.p-datatable-tbody > tr.is-selected) {
  background: var(--app-primary-weak);
}

.notice {
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--app-warning);
  border-radius: var(--radius-md);
  background: var(--app-panel);
  color: var(--app-text);
}

@media (max-width: 1200px) {
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
