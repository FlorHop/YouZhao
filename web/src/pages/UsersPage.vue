<script setup lang="ts">
/**
 * 用户（设计 P4，`docs/frontend-design.md` §6；权限矩阵 `docs/permission-design.md` §3.1）。
 *
 * 准入是**身份级**：路由 `meta.management` 已把普通成员挡在 /403（§11）。
 * 可见数据范围与可执行动作全部由服务端裁剪：
 *   - 平台所有者看到全平台账号；用户管理员只拿到 `managedByUserIds` 含自己的普通用户。
 *   - `改派管理员` / `任命·降级` / `删除` 仅所有者渲染入口；用户管理员对名下用户只能停用。
 * 前端只负责不渲染越权入口，**不是安全边界**（§11、permission-design §4）。
 */
import type { UserRow, UserStatus } from '@/services/endpoints';

import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import MetricRow from '@/components/common/MetricRow.vue';
import PageHeader from '@/components/common/PageHeader.vue';
import StateBlock from '@/components/common/StateBlock.vue';
import UserCreateDialog, {
  type ManagerOption,
  type UserCreatePayload,
} from '@/components/users/UserCreateDialog.vue';
import UserEditDialog, { type UserEditPayload } from '@/components/users/UserEditDialog.vue';
import UserManagersDialog from '@/components/users/UserManagersDialog.vue';
import UserPasswordDialog from '@/components/users/UserPasswordDialog.vue';
import UserRowActions from '@/components/users/UserRowActions.vue';
import { ApiError } from '@/services/api';
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  setManagedBy,
  setUserIdentity,
  updateUser,
  type ListUsersQuery,
} from '@/services/endpoints';
import { formatDateTime } from '@/services/format';
import { identityLabel, useSessionStore } from '@/stores/session';

const session = useSessionStore();
const router = useRouter();
const toast = useToast();
const confirm = useConfirm();

const BULK_PAGE_SIZE = 100;
const BULK_MAX_PAGES = 20;

const rows = ref<UserRow[]>([]);
const total = ref(0);
const loading = ref(true);
const loaded = ref(false);
const loadError = ref('');
const page = ref(1);
const pageSize = ref(20);
const keyword = ref('');
const statusFilter = ref<'all' | UserStatus>('all');
const managerFilter = ref('all');
const nameById = ref<Map<string, string>>(new Map());
const adminOptions = ref<ManagerOption[]>([]);
const metrics = ref<{ label: string; value: string | number }[]>([]);
const createdUser = ref<UserRow | null>(null);

const createVisible = ref(false);
const editVisible = ref(false);
const passwordVisible = ref(false);
const managersVisible = ref(false);
const activeUser = ref<UserRow | null>(null);
const dialogSubmitting = ref(false);
const dialogError = ref('');
const dialogFieldErrors = ref<Record<string, string>>({});

const meId = computed(() => session.user?.id ?? '');

const lede = computed(() =>
  session.isOwner
    ? '管理全平台账号与管理归属'
    : '你只能管理平台所有者指派给你的用户，以及由你创建且尚未改派的用户',
);

const statusOptions: { label: string; value: 'all' | UserStatus }[] = [
  { label: '全部状态', value: 'all' },
  { label: '正常', value: 'active' },
  { label: '已停用', value: 'disabled' },
];

const managerFilterOptions = computed(() => [
  { label: '全部管理归属', value: 'all' },
  ...adminOptions.value,
]);

interface UsersColumn {
  field: 'displayName' | 'username' | 'identity' | 'managers' | 'status' | 'createdAt' | 'actions';
  header: string;
}

/** 列定义是常量：设计 §6 的列序（姓名 · 用户名 · 管理归属 · 状态 · 创建时间 · 操作）。 */
const OWNER_COLUMNS: readonly UsersColumn[] = [
  { field: 'displayName', header: '姓名' },
  { field: 'username', header: '用户名' },
  { field: 'identity', header: '身份' },
  { field: 'managers', header: '管理归属' },
  { field: 'status', header: '状态' },
  { field: 'createdAt', header: '创建时间' },
  { field: 'actions', header: '操作' },
];

/** 用户管理员视角不出现身份列（设计 §6）。 */
const columns = computed<readonly UsersColumn[]>(() =>
  session.isOwner ? OWNER_COLUMNS : OWNER_COLUMNS.filter((column) => column.field !== 'identity'),
);

const first = computed(() => (page.value - 1) * pageSize.value);

const initialLoading = computed(() => loading.value && !loaded.value && loadError.value === '');

const emptyTitle = computed(() => {
  if (
    !session.isOwner &&
    keyword.value.trim() === '' &&
    statusFilter.value === 'all' &&
    total.value === 0
  ) {
    return '还没有归你管理的用户';
  }
  return '没有匹配的用户';
});

const emptyDescription = computed(() => {
  if (
    !session.isOwner &&
    keyword.value.trim() === '' &&
    statusFilter.value === 'all' &&
    total.value === 0
  ) {
    return '需要由平台所有者把你指派为这些用户的管理员，之后你才能管理他们。';
  }
  return '换个关键字，或清空筛选条件再试。';
});

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * 就地字段错误：服务端的 `details.fields` 是 `[{ path, message }]` 数组，
 * 而冻结的 `ApiError.fieldErrors` 只认对象形式，因此这里自己读一次。
 */
function toFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = { ...error.fieldErrors };
  const raw: unknown = error.details?.fields;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record: Record<string, unknown> = entry;
      const path = record.path;
      const message = record.message;
      if (typeof path === 'string' && typeof message === 'string') {
        out[path.replace(/^\//, '')] = message;
      }
    }
  }
  return out;
}

function asUser(value: unknown): UserRow {
  return value as UserRow;
}

function statusLabel(status: UserStatus): string {
  return status === 'active' ? '正常' : '已停用';
}

function managerLabel(ids: readonly string[]): string {
  if (ids.length === 0) return '暂未指派';
  return ids
    .map((id) => {
      const known = nameById.value.get(id);
      if (known !== undefined) return known;
      return id === meId.value ? '你' : '其他管理员';
    })
    .join('，');
}

async function fetchAllUsers(query: ListUsersQuery = {}): Promise<UserRow[]> {
  const collected: UserRow[] = [];
  for (let current = 1; current <= BULK_MAX_PAGES; current += 1) {
    const envelope = await listUsers({ ...query, page: current, pageSize: BULK_PAGE_SIZE });
    collected.push(...envelope.data.items);
    if (collected.length >= envelope.meta.total || envelope.data.items.length === 0) break;
  }
  return collected;
}

async function loadRows(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    if (session.isOwner && managerFilter.value !== 'all') {
      // 冻结的 GET /api/users 不接受按管理归属筛选（见回报中的冻结契约缺口），
      // 因此这条筛选在前端对当前可见集合求值，并在页面上注明。
      const all = await fetchAllUsers();
      const filtered = all.filter((item) => item.managedByUserIds.includes(managerFilter.value));
      total.value = filtered.length;
      rows.value = filtered.slice(first.value, first.value + pageSize.value);
    } else {
      const envelope = await listUsers({
        page: page.value,
        pageSize: pageSize.value,
        keyword: keyword.value.trim() === '' ? undefined : keyword.value.trim(),
        status: statusFilter.value === 'all' ? undefined : statusFilter.value,
      });
      rows.value = envelope.data.items;
      total.value = envelope.meta.total;
    }
    loaded.value = true;
  } catch (error) {
    loadError.value = messageOf(error, '无法加载用户列表，请检查网络或稍后重试。');
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

async function loadMetrics(): Promise<void> {
  try {
    if (session.isOwner) {
      const [all, admins, disabled] = await Promise.all([
        listUsers({ page: 1, pageSize: 1 }),
        listUsers({ page: 1, pageSize: 1, identity: 'user_admin' }),
        listUsers({ page: 1, pageSize: 1, status: 'disabled' }),
      ]);
      metrics.value = [
        { label: '用户总数', value: all.meta.total },
        { label: '用户管理员数', value: admins.meta.total },
        { label: '已停用数', value: disabled.meta.total },
      ];
    } else {
      const [mine, disabled] = await Promise.all([
        listUsers({ page: 1, pageSize: 1 }),
        listUsers({ page: 1, pageSize: 1, status: 'disabled' }),
      ]);
      metrics.value = [
        { label: '我管理的用户数', value: mine.meta.total },
        { label: '其中已停用数', value: disabled.meta.total },
      ];
    }
  } catch {
    metrics.value = [];
  }
}

async function loadLookups(): Promise<void> {
  const map = new Map<string, string>();
  if (meId.value !== '') map.set(meId.value, session.displayName);
  nameById.value = map;
  adminOptions.value = [];
  if (!session.isOwner) return;
  try {
    const all = await fetchAllUsers();
    const next = new Map<string, string>();
    for (const item of all) next.set(item.id, item.displayName);
    nameById.value = next;
    adminOptions.value = all
      .filter((item) => item.identity === 'user_admin')
      .map((item) => ({ label: item.displayName, value: item.id }));
  } catch {
    adminOptions.value = [];
  }
}

async function reload(): Promise<void> {
  await Promise.all([loadRows(), loadMetrics(), loadLookups()]);
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onKeywordInput(): void {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    void loadRows();
  }, 300);
}

function onFilterChange(): void {
  page.value = 1;
  void loadRows();
}

function onPage(event: { first: number; rows: number }): void {
  if (event.rows <= 0) return;
  pageSize.value = event.rows;
  page.value = Math.floor(event.first / event.rows) + 1;
  void loadRows();
}

function resetDialogState(): void {
  dialogError.value = '';
  dialogFieldErrors.value = {};
}

function openCreate(): void {
  resetDialogState();
  createVisible.value = true;
}

function openEdit(user: UserRow): void {
  resetDialogState();
  activeUser.value = user;
  editVisible.value = true;
}

function openPassword(user: UserRow): void {
  resetDialogState();
  activeUser.value = user;
  passwordVisible.value = true;
}

function openManagers(user: UserRow): void {
  resetDialogState();
  activeUser.value = user;
  managersVisible.value = true;
}

function goToPermissions(userId: string): void {
  void router.push({ name: 'permissions', query: { userId } });
}

const managersDialogOptions = computed<ManagerOption[]>(() =>
  adminOptions.value.filter((option) => option.value !== activeUser.value?.id),
);

async function submitCreate(payload: UserCreatePayload): Promise<void> {
  dialogSubmitting.value = true;
  resetDialogState();
  try {
    const envelope = await createUser({
      username: payload.username,
      displayName: payload.displayName,
      email: payload.email,
      phone: payload.phone,
      password: payload.password,
      managedByUserIds: payload.managedByUserIds,
    });
    createVisible.value = false;
    createdUser.value = envelope.data;
    toast.add({
      severity: 'success',
      summary: '用户已创建',
      detail: `「${envelope.data.displayName}」已创建，可以继续为其分配查看范围。`,
      life: 6000,
    });
    page.value = 1;
    await Promise.all([loadRows(), loadMetrics(), loadLookups()]);
  } catch (error) {
    dialogError.value = messageOf(error, '创建用户失败，请稍后重试。');
    dialogFieldErrors.value = toFieldErrors(error);
  } finally {
    dialogSubmitting.value = false;
  }
}

async function submitEdit(payload: UserEditPayload): Promise<void> {
  const target = activeUser.value;
  if (target === null) return;
  dialogSubmitting.value = true;
  resetDialogState();
  try {
    await updateUser(target.id, {
      displayName: payload.displayName,
      email: payload.email,
      phone: payload.phone,
    });
    editVisible.value = false;
    toast.add({
      severity: 'success',
      summary: '资料已保存',
      detail: `「${payload.displayName}」的资料已更新。`,
      life: 4000,
    });
    await Promise.all([loadRows(), loadLookups()]);
  } catch (error) {
    dialogError.value = messageOf(error, '保存资料失败，请稍后重试。');
    dialogFieldErrors.value = toFieldErrors(error);
  } finally {
    dialogSubmitting.value = false;
  }
}

async function performResetPassword(target: UserRow, password: string): Promise<void> {
  dialogSubmitting.value = true;
  resetDialogState();
  try {
    await resetUserPassword(target.id, password);
    passwordVisible.value = false;
    toast.add({
      severity: 'success',
      summary: '密码已重置',
      detail: `「${target.displayName}」需要用新密码重新登录，请通过安全渠道告知本人。`,
      life: 6000,
    });
  } catch (error) {
    dialogError.value = messageOf(error, '重置密码失败，请稍后重试。');
    dialogFieldErrors.value = toFieldErrors(error);
  } finally {
    dialogSubmitting.value = false;
  }
}

function requestResetPassword(password: string): void {
  const target = activeUser.value;
  if (target === null) return;
  confirm.require({
    header: '重置密码',
    message: `确定要重置「${target.displayName}」的密码吗？重置后该用户当前的所有登录会话会立即失效，需要用新密码重新登录；此操作不可撤销。`,
    acceptLabel: '重置密码',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { outlined: true },
    accept: () => {
      void performResetPassword(target, password);
    },
  });
}

async function performSetManagedBy(target: UserRow, managerIds: string[]): Promise<void> {
  dialogSubmitting.value = true;
  resetDialogState();
  try {
    await setManagedBy(target.id, managerIds);
    managersVisible.value = false;
    toast.add({
      severity: 'success',
      summary: '管理归属已更新',
      detail:
        managerIds.length === 0
          ? `「${target.displayName}」现在暂不归属任何用户管理员，只有平台所有者能管理。`
          : `「${target.displayName}」的归属管理员已整体替换。`,
      life: 6000,
    });
    await Promise.all([loadRows(), loadLookups()]);
  } catch (error) {
    dialogError.value = messageOf(error, '保存管理归属失败，请稍后重试。');
    dialogFieldErrors.value = toFieldErrors(error);
  } finally {
    dialogSubmitting.value = false;
  }
}

function requestSetManagedBy(managerIds: string[]): void {
  const target = activeUser.value;
  if (target === null) return;
  confirm.require({
    header: '改派管理员',
    message: `确定要把「${target.displayName}」的管理归属整体替换为这 ${managerIds.length} 位管理员吗？原管理员将立即失去管理权，该用户已有的查看权不会自动清除。`,
    acceptLabel: '改派',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { outlined: true },
    accept: () => {
      void performSetManagedBy(target, managerIds);
    },
  });
}

async function performStatus(target: UserRow, status: UserStatus): Promise<void> {
  dialogSubmitting.value = true;
  try {
    // 冻结的 `updateUser` 类型漏了 `status`（服务端 users/update.json 明确接受它）。
    // endpoints.ts 不允许修改，因此这里用「参数类型 ∩ { status }」调用同一个类型化函数。
    const patch: Parameters<typeof updateUser>[1] & { status: UserStatus } = { status };
    await updateUser(target.id, patch);
    toast.add({
      severity: 'success',
      summary: status === 'disabled' ? '账号已停用' : '账号已启用',
      detail:
        status === 'disabled'
          ? `「${target.displayName}」已无法登录；账号与授权都保留，可随时重新启用。`
          : `「${target.displayName}」已恢复正常登录。`,
      life: 5000,
    });
    await Promise.all([loadRows(), loadMetrics()]);
  } catch (error) {
    toast.add({
      severity: 'error',
      summary: '操作未完成',
      detail: messageOf(error, '无法更新账号状态，请稍后重试。'),
      life: 8000,
    });
  } finally {
    dialogSubmitting.value = false;
  }
}

function requestToggleStatus(user: UserRow): void {
  if (user.status === 'disabled') {
    void performStatus(user, 'active');
    return;
  }
  confirm.require({
    header: '停用用户',
    message: `停用后「${user.displayName}」将无法登录，其所有登录会话与 MCP Token 会立即失效。账号、查看授权与业务能力都会保留，之后可以随时重新启用。`,
    acceptLabel: '停用',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { outlined: true },
    accept: () => {
      void performStatus(user, 'disabled');
    },
  });
}

function requestDelete(user: UserRow): void {
  confirm.require({
    header: '删除用户',
    message: `删除后「${user.displayName}」的账号、查看授权与业务能力都会被移除，无法恢复；由其创建或授予的记录会保留，但不再标注来源。`,
    acceptLabel: '删除',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { outlined: true },
    accept: () => {
      void (async () => {
        dialogSubmitting.value = true;
        try {
          await deleteUser(user.id);
          toast.add({
            severity: 'success',
            summary: '用户已删除',
            detail: `「${user.displayName}」的账号已删除。`,
            life: 5000,
          });
          await Promise.all([loadRows(), loadMetrics(), loadLookups()]);
        } catch (error) {
          toast.add({
            severity: 'error',
            summary: '删除未完成',
            detail: messageOf(error, '无法删除该用户，请稍后重试。'),
            life: 8000,
          });
        } finally {
          dialogSubmitting.value = false;
        }
      })();
    },
  });
}

async function performIdentity(target: UserRow, identity: 'user_admin' | 'member'): Promise<void> {
  dialogSubmitting.value = true;
  try {
    await setUserIdentity(target.id, identity);
    toast.add({
      severity: 'success',
      summary: identity === 'user_admin' ? '已任命为用户管理员' : '已降级为普通用户',
      detail:
        identity === 'user_admin'
          ? `请到权限页为「${target.displayName}」分配查看范围：该范围同时决定他能委派给名下用户的范围。`
          : `「${target.displayName}」已失去管理权，请在「改派管理员」中为其名下用户重新指派管理员。`,
      life: 8000,
    });
    await Promise.all([loadRows(), loadMetrics(), loadLookups()]);
  } catch (error) {
    toast.add({
      severity: 'error',
      summary: '身份变更未完成',
      detail: messageOf(error, '无法变更该用户的身份，请稍后重试。'),
      life: 8000,
    });
  } finally {
    dialogSubmitting.value = false;
  }
}

function requestPromote(user: UserRow): void {
  confirm.require({
    header: '任命用户管理员',
    message: `任命「${user.displayName}」为用户管理员后，他可以管理平台所有者指派给他的普通用户，并能从其查看范围内委派授权。他的可委派范围等于自己在权限页被授予的查看范围；此操作可以撤销。`,
    acceptLabel: '任命管理员',
    rejectLabel: '取消',
    rejectProps: { outlined: true },
    accept: () => {
      void performIdentity(user, 'user_admin');
    },
  });
}

function requestDemote(user: UserRow): void {
  confirm.require({
    header: '降级为普通用户',
    message: `降级后「${user.displayName}」将立即失去全部管理权，他名下的用户会变成暂不归属任何管理员（需要重新指派），但他已有的查看授权与业务能力不会被清除。`,
    acceptLabel: '降级',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { outlined: true },
    accept: () => {
      void performIdentity(user, 'member');
    },
  });
}

onMounted(() => {
  void reload();
});
</script>

<template>
  <div>
    <PageHeader title="用户" :lede="lede" />

    <MetricRow v-if="metrics.length > 0" :metrics="metrics" />

    <div class="toolbar">
      <InputText
        v-model="keyword"
        placeholder="搜索姓名或用户名"
        aria-label="搜索姓名或用户名"
        @input="onKeywordInput"
      />
      <Select
        v-model="statusFilter"
        :options="statusOptions"
        option-label="label"
        option-value="value"
        aria-label="按状态筛选"
        @change="onFilterChange"
      />
      <Select
        v-if="session.isOwner"
        v-model="managerFilter"
        :options="managerFilterOptions"
        option-label="label"
        option-value="value"
        filter
        aria-label="按管理归属筛选"
        @change="onFilterChange"
      />
      <span class="toolbar-spacer" />
      <Button label="新建用户" icon="pi pi-plus" @click="openCreate" />
    </div>

    <p v-if="session.isOwner && managerFilter !== 'all'" class="caption filter-note">
      按管理归属筛选是在当前已加载的可见用户集合上求值：列表接口只支持关键字与状态查询，
      因此这里的「共 N 条」反映的是筛选后的数量。
    </p>

    <div v-if="createdUser" class="create-notice inline">
      <span>刚创建「{{ createdUser.displayName }}」。</span>
      <Button
        label="去分配查看范围"
        text
        size="small"
        icon="pi pi-arrow-right"
        @click="goToPermissions(createdUser.id)"
      />
      <span class="toolbar-spacer" />
      <Button
        label="知道了"
        text
        size="small"
        severity="secondary"
        @click="createdUser = null"
      />
    </div>

    <StateBlock v-if="initialLoading" state="loading" />
    <StateBlock v-else-if="loadError !== ''" state="error" :description="loadError" @retry="reload" />
    <DataTable
      v-else
      :value="rows"
      data-key="id"
      lazy
      paginator
      :rows="pageSize"
      :first="first"
      :total-records="total"
      :loading="loading"
      :rows-per-page-options="[10, 20, 50, 100]"
      table-style="min-width: 64rem"
      @page="onPage"
    >
      <Column v-for="column in columns" :key="column.field" :header="column.header">
        <template #body="slotProps">
          <span v-if="column.field === 'displayName'">{{ asUser(slotProps.data).displayName }}</span>
          <span v-else-if="column.field === 'username'" class="mono">
            {{ asUser(slotProps.data).username }}
          </span>
          <Tag
            v-else-if="column.field === 'identity'"
            :value="identityLabel(asUser(slotProps.data).identity)"
            severity="secondary"
          />
          <span v-else-if="column.field === 'managers'">
            {{ managerLabel(asUser(slotProps.data).managedByUserIds) }}
          </span>
          <Tag
            v-else-if="column.field === 'status'"
            :value="statusLabel(asUser(slotProps.data).status)"
            :severity="asUser(slotProps.data).status === 'active' ? 'success' : 'secondary'"
          />
          <span v-else-if="column.field === 'createdAt'" class="meta">
            {{ formatDateTime(asUser(slotProps.data).createdAt) }}
          </span>
          <UserRowActions
            v-else-if="column.field === 'actions'"
            :user="asUser(slotProps.data)"
            :is-owner="session.isOwner"
            @edit="openEdit(asUser(slotProps.data))"
            @managers="openManagers(asUser(slotProps.data))"
            @permissions="goToPermissions(asUser(slotProps.data).id)"
            @toggle-status="requestToggleStatus(asUser(slotProps.data))"
            @reset-password="openPassword(asUser(slotProps.data))"
            @remove="requestDelete(asUser(slotProps.data))"
            @promote="requestPromote(asUser(slotProps.data))"
            @demote="requestDemote(asUser(slotProps.data))"
          />
        </template>
      </Column>

      <template #empty>
        <StateBlock state="empty" :title="emptyTitle" :description="emptyDescription" />
      </template>
    </DataTable>

    <UserCreateDialog
      v-model:visible="createVisible"
      :is-owner="session.isOwner"
      :manager-options="adminOptions"
      :submitting="dialogSubmitting"
      :error-text="dialogError"
      :field-errors="dialogFieldErrors"
      @submit="submitCreate"
    />

    <UserEditDialog
      v-model:visible="editVisible"
      :user="activeUser"
      :submitting="dialogSubmitting"
      :error-text="dialogError"
      :field-errors="dialogFieldErrors"
      @submit="submitEdit"
    />

    <UserPasswordDialog
      v-model:visible="passwordVisible"
      :user="activeUser"
      :submitting="dialogSubmitting"
      :error-text="dialogError"
      :field-errors="dialogFieldErrors"
      @submit="requestResetPassword"
    />

    <UserManagersDialog
      v-model:visible="managersVisible"
      :user="activeUser"
      :manager-options="managersDialogOptions"
      :submitting="dialogSubmitting"
      :error-text="dialogError"
      @submit="requestSetManagedBy"
    />
  </div>
</template>

<style scoped>
.filter-note {
  margin: calc(-1 * var(--space-4)) 0 var(--space-4);
}

.create-notice {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-4);
}
</style>
