<script setup lang="ts">
/**
 * 查看范围授权面板（设计 P5 区段一右栏，`docs/frontend-design.md` §6 / §7）。
 *
 * 只做展示与上报勾选，**不持有任何状态**：待提交的增删由页面保存，
 * 这样并发冲突时用户未提交的选择不会被组件卸载或重载冲掉。
 * 「其他人授予的」是纯文本行、带授予者与时间、**没有勾选框**（§7）。
 */
import type { UserRow } from '@/services/endpoints';

import Checkbox from 'primevue/checkbox';

import StateBlock from '@/components/common/StateBlock.vue';
import { formatDateTime } from '@/services/format';

interface EditableTarget {
  key: string;
  label: string;
  checked: boolean;
}

interface ReadonlyGrant {
  key: string;
  label: string;
  grantedByDisplayName: string;
  grantedAt: string;
}

defineProps<{
  user: UserRow | null;
  groupTargets: readonly EditableTarget[];
  blueprintTargets: readonly EditableTarget[];
  readonlyGrants: readonly ReadonlyGrant[];
  loading: boolean;
  errorText: string;
  disabled: boolean;
  editableHint: string;
  readonlyHint: string;
}>();

const emit = defineEmits<{ toggle: [key: string]; retry: [] }>();

function domId(key: string): string {
  return `grant-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}
</script>

<template>
  <div class="two-col-panel">
    <StateBlock
      v-if="user === null"
      state="empty"
      title="先选择一位用户"
      description="左侧列出的是你可以授予查看范围的用户。"
    />
    <StateBlock v-else-if="loading" state="loading" />
    <StateBlock
      v-else-if="errorText !== ''"
      state="error"
      :description="errorText"
      @retry="emit('retry')"
    />
    <template v-else>
      <div class="section">
        <div class="section-head">
          <h2 class="section-title">我可以调整的</h2>
          <p class="caption">{{ editableHint }}</p>
        </div>

        <h3 class="label">分组</h3>
        <p v-if="groupTargets.length === 0" class="caption">
          你没有可委派的分组；需要由平台所有者为你扩大查看范围。
        </p>
        <div v-else class="grant-list">
          <div v-for="target in groupTargets" :key="target.key" class="grant-row">
            <Checkbox
              :input-id="domId(target.key)"
              :model-value="target.checked"
              binary
              :disabled="disabled"
              @change="emit('toggle', target.key)"
            />
            <label :for="domId(target.key)">{{ target.label }}</label>
          </div>
        </div>

        <h3 class="label">单个蓝图</h3>
        <p v-if="blueprintTargets.length === 0" class="caption">
          你没有可委派的单个蓝图；需要由平台所有者为你扩大查看范围。
        </p>
        <div v-else class="grant-list">
          <div v-for="target in blueprintTargets" :key="target.key" class="grant-row">
            <Checkbox
              :input-id="domId(target.key)"
              :model-value="target.checked"
              binary
              :disabled="disabled"
              @change="emit('toggle', target.key)"
            />
            <label :for="domId(target.key)">{{ target.label }}</label>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2 class="section-title">其他人授予的</h2>
          <p class="caption">{{ readonlyHint }}</p>
        </div>
        <p v-if="readonlyGrants.length === 0" class="caption">
          这位用户目前没有来自其他人的授权。
        </p>
        <div v-else class="grant-list">
          <div v-for="grant in readonlyGrants" :key="grant.key" class="grant-row is-readonly">
            <span>{{ grant.label }}</span>
            <span class="meta">
              由 {{ grant.grantedByDisplayName }} 于 {{ formatDateTime(grant.grantedAt) }} 授予
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.grant-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.grant-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
}

.grant-row.is-readonly {
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  justify-content: center;
  padding: var(--space-1) 0;
}

.grant-row label {
  cursor: pointer;
}

.label {
  margin-top: var(--space-4);
}
</style>
