<script setup lang="ts">
/**
 * P6 Token 表的单元格渲染（docs/frontend-design.md §6 P6）。
 *
 * 为什么需要一个独立组件：PrimeVue 4.5 的 `ColumnSlots.body` 把行数据标注为 `any`
 * （`node_modules/primevue/column/index.d.ts` 的 `body(scope: { data: any; ... })`）。
 * 与其在页面模板里散落类型断言，不如把「DataTable 行数据」这一条边界收拢在这里，
 * 页面只传 `data`（`unknown`）进来，其余代码一律拿到明确的 `TokenRow`。
 *
 * 可见性依据（docs/permission-design.md §3.4 MCP 令牌权限矩阵）：
 * - 停用/启用、删除「自己的」Token：所有者/用户管理员/普通用户均允许。
 * - 停用/删除「他人的」Token：仅所有者允许 → 非所有者且非本人时**不渲染**入口（§5.7 不渲染，不用 hidden）。
 */
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import { computed } from 'vue';

import type { TokenRow, TokenScope } from '@/services/endpoints';
import { formatDateTime, formatRelative } from '@/services/format';

/** 列字段：与 `TokenRow` 的键一一对应，`actions` 是行操作伪列（列定义见 TokensPage 的 TOKEN_COLUMNS）。 */
type TokenColumnField = keyof TokenRow | 'actions';

const props = defineProps<{
  /** DataTable 提供的行数据；类型由 PrimeVue 标为 any，这里在边界处收敛。 */
  data: unknown;
  field: TokenColumnField;
  /** 当前登录用户 id，用于判定「是不是自己的 Token」。 */
  actorId: string;
  /** 当前登录用户是否为平台所有者。 */
  isOwner: boolean;
}>();

const emit = defineEmits<{
  toggle: [row: TokenRow];
  remove: [row: TokenRow];
}>();

const row = computed(() => props.data as TokenRow);

const SCOPE_LABELS: Record<TokenScope, string> = {
  'read:blueprint': '只读',
  'publish:blueprint': '发布',
};

const SCOPE_SEVERITY: Record<TokenScope, 'secondary' | 'info'> = {
  'read:blueprint': 'secondary',
  'publish:blueprint': 'info',
};

function scopeLabel(scope: TokenScope): string {
  return SCOPE_LABELS[scope];
}

function scopeSeverity(scope: TokenScope): 'secondary' | 'info' {
  return SCOPE_SEVERITY[scope];
}

const isExpired = computed<boolean>(() => {
  const expiresAt = row.value.expiresAt;
  return expiresAt !== null && new Date(expiresAt).getTime() < Date.now();
});

const statusText = computed<string>(() => (row.value.status === 'active' ? '已启用' : '已停用'));

const statusSeverity = computed<'success' | 'secondary'>(() =>
  row.value.status === 'active' ? 'success' : 'secondary',
);

const expiresText = computed<string>(() =>
  row.value.expiresAt === null ? '永不过期' : formatDateTime(row.value.expiresAt),
);

/** 本人 Token 或平台所有者（矩阵：停用/删除自己的 Token 全身份允许；他人的仅所有者）。 */
const canManage = computed<boolean>(
  () =>
    props.isOwner ||
    row.value.boundUserId === props.actorId ||
    row.value.createdByUserId === props.actorId,
);
</script>

<template>
  <span v-if="field === 'name'">{{ row.name }}</span>

  <span v-else-if="field === 'tokenPrefix'" class="mono">{{ row.tokenPrefix }}</span>

  <span v-else-if="field === 'boundUserDisplayName'">{{ row.boundUserDisplayName }}</span>

  <span v-else-if="field === 'scopes'" class="inline">
    <Tag
      v-for="scope in row.scopes"
      :key="scope"
      :value="scopeLabel(scope)"
      :severity="scopeSeverity(scope)"
    />
  </span>

  <span v-else-if="field === 'status'" class="inline">
    <Tag :value="statusText" :severity="statusSeverity" />
    <Tag v-if="isExpired" value="已过期" severity="warn" />
  </span>

  <span v-else-if="field === 'createdByDisplayName'">{{ row.createdByDisplayName }}</span>

  <span v-else-if="field === 'expiresAt'">{{ expiresText }}</span>

  <span v-else-if="field === 'lastUsedAt'">{{ formatRelative(row.lastUsedAt) }}</span>

  <span v-else-if="field === 'createdAt'">{{ formatDateTime(row.createdAt) }}</span>

  <span v-else-if="field === 'actions'" class="row-actions">
    <template v-if="canManage">
      <Button
        :label="row.status === 'active' ? '停用' : '启用'"
        size="small"
        text
        @click="emit('toggle', row)"
      />
      <Button label="删除" size="small" text severity="danger" @click="emit('remove', row)" />
    </template>
  </span>
</template>
