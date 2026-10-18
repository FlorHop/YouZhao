<script setup lang="ts">
/**
 * P6 · MCP Token（docs/frontend-design.md §6 P6；docs/permission-design.md §3.4、§5.4、§6.3）。
 *
 * 三条产品裁决直接决定本页形态：
 * 1. Token 的实际能力 = 绑定用户的平台权限 ∩ Token 自身的 scope（permission-design §3.4 末、
 *    architecture-design §4.4 约束 S3）——页头与说明块必须把这句话讲出来，这是最容易误用的点。
 * 2. 普通成员只看得到自己的 Token（可自建只读 Token）；管理员创建 Token 只能绑定自己；
 *    只有平台所有者可为任意用户创建 Token，并看到全部 Token（§3.4 权限矩阵、§6.3 接口契约）。
 * 3. 只读 scope 看不到写工具（服务端按 scope 裁剪 tools/list）；明文只在创建成功那一刻出现一次。
 *
 * 数据出口只有 `@/services/endpoints` 的类型化函数，身份与可见范围全部来自 `useSessionStore()`
 * （architecture-design §5.6：session store 是权限 UI 判断的唯一来源）。越权操作不渲染入口，
 * 服务端仍会逐接口校验。
 */
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Select from 'primevue/select';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import PageHeader from '@/components/common/PageHeader.vue';
import StateBlock from '@/components/common/StateBlock.vue';
import CreateTokenDialog from '@/components/tokens/CreateTokenDialog.vue';
import McpClientSnippet from '@/components/tokens/McpClientSnippet.vue';
import TokenCell from '@/components/tokens/TokenCell.vue';
import TokenSecretDialog from '@/components/tokens/TokenSecretDialog.vue';
import { ApiError } from '@/services/api';
import { deleteToken, listTokens, listUsers, updateToken } from '@/services/endpoints';
import type { TokenRow, UserRow } from '@/services/endpoints';
import { useSessionStore } from '@/stores/session';

/** 列字段：与 `TokenRow` 的键一一对应，`actions` 是行操作伪列（frontend-rules §4.2：列集中为常量）。 */
type TokenColumnField = keyof TokenRow | 'actions';

/**
 * 列定义是全页唯一的列来源：表头与行单元格都从这一份常量生成（§5.7 修正「表头 7 列 / 单元格 6 个」）。
 * `ownerOnly` 的列见下方 `columns` 的可见性说明。
 */
const TOKEN_COLUMNS: readonly { field: TokenColumnField; header: string; ownerOnly?: true }[] = [
  { field: 'name', header: '名称' },
  { field: 'tokenPrefix', header: '标识' },
  { field: 'scopes', header: '能力' },
  { field: 'status', header: '状态' },
  { field: 'lastUsedAt', header: '最近使用' },
  // 仅所有者能查看他人的 Token 元数据（§3.4），所以「绑定用户」列只对所有者出现；
  // 其他身份的行全是他自己的，这一列恒等于本人。
  { field: 'boundUserDisplayName', header: '绑定用户', ownerOnly: true },
  { field: 'createdByDisplayName', header: '创建人' },
  { field: 'expiresAt', header: '有效期' },
  { field: 'createdAt', header: '创建时间' },
  { field: 'actions', header: '操作' },
];

const PAGE_SIZE = 20;
const USERS_PAGE_SIZE = 100;

const session = useSessionStore();
const toast = useToast();
const confirm = useConfirm();
const router = useRouter();

const rows = ref<TokenRow[]>([]);
const loading = ref(true);
const loadError = ref('');

/** 所有者可按绑定用户筛选（§3.4：查看全平台 Token 元数据仅所有者）。 */
const boundUserFilter = ref('');
const users = ref<UserRow[]>([]);

const createVisible = ref(false);
const secretVisible = ref(false);
/** 一次性明文：除这里和展示面板外，任何地方都不保留副本，关闭即置空。 */
const createdToken = ref<(TokenRow & { token: string }) | null>(null);

const columns = computed(() =>
  TOKEN_COLUMNS.filter((column) => column.ownerOnly !== true || session.isOwner),
);

const userFilterOptions = computed(() => [
  { label: '全部用户', value: '' },
  ...users.value.map((user) => ({
    label: `${user.displayName}（${user.username}）`,
    value: user.id,
  })),
]);

const selfUserId = computed(() => session.user?.id ?? '');

/** 三态（§3 状态块）：只有列表为空时才用状态块接管，重载时保留表格并走 DataTable 的 loading。 */
const regionState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (loading.value && rows.value.length === 0) return 'loading';
  if (loadError.value !== '' && rows.value.length === 0) return 'error';
  if (rows.value.length === 0) return 'empty';
  return 'ready';
});

const stateTitle = computed(() => {
  if (regionState.value !== 'empty') return '';
  if (boundUserFilter.value !== '') return '当前筛选下没有 Token';
  return session.isOwner ? '平台里还没有 Token' : '你还没有 Token';
});

const stateDescription = computed(() => {
  if (regionState.value === 'error') return loadError.value;
  if (regionState.value !== 'empty') return '';
  if (boundUserFilter.value !== '') return '换一个绑定用户，或清空筛选查看全部。';
  return session.isOwner
    ? '点右上角「创建 Token」，为某个用户签发一把；绑定用户选中谁，这把 Token 的实际能力就取决于谁。'
    : '点右上角「创建 Token」创建一把只读 Token，把明文填进 MCP 客户端配置即可调用。';
});

/** 统一把接口错误翻译成可操作的中文（§9 文案规范、§5.6 不静默失败）。 */
function describeError(caught: unknown, action: string): string {
  if (caught instanceof ApiError) {
    if (caught.isAuthError) return '会话已过期，请重新登录后再试。';
    if (caught.code === 'SCOPE_DENIED') {
      return 'Token scope 不足：请换用包含所需 scope 的 Token 再试（只读 Token 不能调用写工具）。';
    }
    if (caught.code === 'TOKEN_NOT_FOUND') return '这个 Token 已不存在，可能刚被删除；列表已刷新。';
    if (caught.isForbidden) {
      return `当前身份不能${action}这把 Token：本人的 Token 人人可管，他人的 Token 只有平台所有者能管。`;
    }
    return caught.message;
  }
  return '无法连接服务端，请检查网络后重试。';
}

/** 会话失效统一跳登录并保留返回地址（architecture-design §5.6）。 */
function redirectToLogin(): void {
  void router.push({ name: 'login', query: { next: router.currentRoute.value.fullPath } });
}

function showError(caught: unknown, action: string): void {
  toast.add({ severity: 'error', summary: `${action}失败`, detail: describeError(caught, action), life: 5000 });
  if (caught instanceof ApiError && caught.isAuthError) redirectToLogin();
}

async function loadUsers(): Promise<void> {
  if (!session.isOwner) return;
  try {
    const envelope = await listUsers({ pageSize: USERS_PAGE_SIZE });
    users.value = envelope.data.items;
  } catch (caught) {
    // 筛选是锦上添花：加载失败时降级为「不筛选」，不阻塞 Token 列表。
    users.value = [];
    showError(caught, '加载用户列表');
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const envelope = await listTokens(
      boundUserFilter.value === '' ? {} : { boundUserId: boundUserFilter.value },
    );
    rows.value = envelope.data.items;
    loadError.value = '';
  } catch (caught) {
    loadError.value = describeError(caught, '查看');
    if (caught instanceof ApiError && caught.isAuthError) redirectToLogin();
  } finally {
    loading.value = false;
  }
}

watch(
  () => session.isOwner,
  (isOwner) => {
    if (isOwner) void loadUsers();
  },
  { immediate: true },
);

void load();

function onCreateVisible(value: boolean): void {
  createVisible.value = value;
}

/** 创建成功：先接住明文交给一次性面板，再刷新列表（永远重新取数，不渲染陈旧数据，§5.7）。 */
function onCreated(token: TokenRow & { token: string }): void {
  createdToken.value = token;
  createVisible.value = false;
  secretVisible.value = true;
  toast.add({
    severity: 'success',
    summary: 'Token 已创建',
    detail: `「${token.name}」已加入列表；明文只在下一个窗口展示一次。`,
    life: 4000,
  });
  void load();
}

/** 关闭（含 Esc / 右上角）都视为放弃明文：立即丢弃，之后无法再取回。 */
function onSecretVisible(value: boolean): void {
  secretVisible.value = value;
  if (!value) createdToken.value = null;
}

async function toggleStatus(row: TokenRow): Promise<void> {
  const next = row.status === 'active' ? 'disabled' : 'active';
  try {
    await updateToken(row.id, { status: next });
    toast.add({
      severity: 'success',
      summary: next === 'active' ? 'Token 已启用' : 'Token 已停用',
      detail:
        next === 'active'
          ? `「${row.name}」已恢复可用，客户端配置不用改。`
          : `「${row.name}」立即失效，仍在用它的客户端会收到 401；需要时可再启用，不必重新创建。`,
      life: 5000,
    });
    await load();
  } catch (caught) {
    showError(caught, next === 'active' ? '启用' : '停用');
  }
}

async function remove(row: TokenRow): Promise<void> {
  try {
    await deleteToken(row.id);
    toast.add({
      severity: 'success',
      summary: 'Token 已删除',
      detail: `「${row.name}」已永久失效且无法恢复；要继续接入只能重新创建并更新客户端配置。`,
      life: 6000,
    });
    await load();
  } catch (caught) {
    showError(caught, '删除');
  }
}

/** 危险动作二次确认：写明对象、后果与是否可恢复（§5.7、§8）。 */
function confirmRemove(row: TokenRow): void {
  confirm.require({
    header: '删除 Token',
    message: `确认删除「${row.name}」（绑定用户：${row.boundUserDisplayName}）？删除后它立即失效且无法恢复——客户端会收到 401，只能重新创建一把并更新配置。只是暂时不用的话，请改用「停用」，停用可以再启用。`,
    acceptLabel: '删除',
    rejectLabel: '取消',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: () => {
      void remove(row);
    },
  });
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="MCP Token"
      lede="Token 的实际能力 = 绑定用户的平台权限 ∩ Token 自身的 scope：它只会以绑定用户的身份调用，不会获得超出该用户的能力；绑定用户被停用或降权后，Token 同步失效。"
    >
      <template #actions>
        <Button label="创建 Token" icon="pi pi-plus" @click="createVisible = true" />
      </template>
    </PageHeader>

    <p class="caption token-note">
      只读（<span class="mono">read:blueprint</span>）不含任何写工具，服务端按 scope 裁剪
      <span class="mono">tools/list</span>，只读 Token 在客户端里看不到写工具。明文
      <span class="mono">yz_mcp_…</span> 只在创建成功那一刻展示一次，之后任何接口都不返回；
      口令泄露了就停用或删除后重新创建。
      <template v-if="session.isOwner">
        作为平台所有者，你可以看到全部 Token、替任意用户创建，并停用或删除他人的 Token。
      </template>
      <template v-else>
        你只能看到和管理自己的 Token；停用、删除都只影响你自己。
      </template>
    </p>

    <div v-if="session.isOwner" class="toolbar">
      <label class="label" for="token-bound-user-filter">绑定用户</label>
      <Select
        v-model="boundUserFilter"
        input-id="token-bound-user-filter"
        class="user-filter"
        :options="userFilterOptions"
        option-label="label"
        option-value="value"
        :disabled="loading"
        @change="load"
      />
      <span class="toolbar-spacer" />
      <span class="caption">按绑定用户筛选；可见范围之外不存在可看的 Token。</span>
    </div>

    <StateBlock
      v-if="regionState !== 'ready'"
      :state="regionState"
      :title="stateTitle"
      :description="stateDescription"
      :on-retry="load"
    />

    <DataTable
      v-else
      :value="rows"
      data-key="id"
      :loading="loading"
      :paginator="rows.length > PAGE_SIZE"
      :rows="PAGE_SIZE"
      :rows-per-page-options="[10, 20, 50, 100]"
      table-style="min-width: 64rem"
    >
      <Column
        v-for="column in columns"
        :key="column.field"
        :field="column.field"
        :header="column.header"
      >
        <template #body="{ data }">
          <TokenCell
            :data="data"
            :field="column.field"
            :actor-id="selfUserId"
            :is-owner="session.isOwner"
            @toggle="toggleStatus"
            @remove="confirmRemove"
          />
        </template>
      </Column>
    </DataTable>

    <McpClientSnippet />

    <CreateTokenDialog
      :visible="createVisible"
      :is-owner="session.isOwner"
      :can-publish="session.canPublishAnywhere"
      :self-user-id="selfUserId"
      @update:visible="onCreateVisible"
      @created="onCreated"
    />

    <TokenSecretDialog
      :visible="secretVisible"
      :token="createdToken"
      @update:visible="onSecretVisible"
    />
  </div>
</template>

<style scoped>
.token-note {
  max-width: 62rem;
}

.user-filter {
  min-width: 18rem;
}
</style>
