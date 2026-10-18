<script setup lang="ts">
/**
 * 蓝图卡片（frontend-design §P2「蓝图卡片」）。
 *
 * 一张卡片 = 一项蓝图任务（不是一版）；多版本都在这一张卡片里。
 * 操作区**按能力装配**：两个能力都没有时整块不渲染，卡片保持纯浏览态。
 * 版本选择只影响当前浏览，不回写服务端、不改变「最新版本」的判定。
 */
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed } from 'vue';

import type { BlueprintCapabilities, BlueprintCard as BlueprintCardRow, BlueprintVersion } from '@/services/endpoints';
import { formatDateTime } from '@/services/format';

const props = withDefaults(
  defineProps<{
    card: BlueprintCardRow;
    caps: BlueprintCapabilities;
    /** 版本明细；null = 尚未按需加载（列表接口不含版本明细，禁止 N+1）。 */
    versions?: readonly BlueprintVersion[] | null;
    versionsLoading?: boolean;
    selectedVersion?: string;
    /** 有写操作在途时禁用整个操作区，避免重复提交。 */
    busy?: boolean;
  }>(),
  { versions: null, versionsLoading: false, selectedVersion: '', busy: false },
);

const emit = defineEmits<{
  preview: [version: string];
  'request-versions': [];
  'update:selectedVersion': [version: string];
  edit: [];
  publish: [];
  cover: [version: string];
  manageVersions: [];
  archive: [];
  restore: [];
}>();

const isArchived = computed(() => props.card.status === 'archived');

const currentVersion = computed(() => {
  if (props.selectedVersion !== '') return props.selectedVersion;
  return props.card.latestVersion?.version ?? '';
});

const versionText = computed(() => (currentVersion.value === '' ? '—' : `v${currentVersion.value}`));

/** 只有一个版本时不显示版本选择器（设计 §P2）。 */
const showVersionPicker = computed(() => !isArchived.value && props.card.versionCount > 1);

const versionOptions = computed(() => {
  const loaded = props.versions;
  if (loaded !== null) {
    return loaded
      .filter((item) => item.archivedAt === null)
      .map((item) => ({
        label: `v${item.version}${item.isLatest ? '（最新）' : ''}`,
        value: item.version,
      }));
  }
  return currentVersion.value === ''
    ? []
    : [{ label: `v${currentVersion.value}`, value: currentVersion.value }];
});

const artifactMissing = computed(
  () => props.card.latestVersion !== null && props.card.latestVersion.status === 'missing',
);

const hasAnyAction = computed(
  () => !isArchived.value || props.caps.canManage,
);

function onCardClick(): void {
  // 归档蓝图没有可预览的产物，点了必然是被拒绝的死路，所以不作跳转。
  if (isArchived.value || props.busy) return;
  if (currentVersion.value === '') return;
  emit('preview', currentVersion.value);
}

function onVersionChange(value: string): void {
  emit('update:selectedVersion', value);
}

function onCover(): void {
  if (currentVersion.value === '') return;
  emit('cover', currentVersion.value);
}
</script>

<template>
  <article
    class="resource-card"
    :class="{ 'is-archived': isArchived, 'is-static': isArchived }"
    @click="onCardClick"
  >
    <div class="resource-card-head">
      <h3 class="resource-card-title">{{ card.name }}</h3>
      <span v-if="isArchived" class="chip is-muted">已归档</span>
      <span v-else-if="artifactMissing" class="chip is-muted text-warn">产物缺失</span>
    </div>

    <p class="resource-card-summary">
      {{ card.summary === '' ? '暂无概述' : card.summary }}
    </p>

    <div class="resource-card-meta">
      <span class="caption">{{ card.groupName }}</span>
      <span class="caption">更新于 {{ formatDateTime(card.updatedAt) }}</span>
    </div>

    <div v-if="card.tags.length > 0" class="inline tag-row">
      <span v-for="tag in card.tags" :key="tag" class="chip is-muted">{{ tag }}</span>
    </div>

    <div class="inline version-row">
      <span class="label">当前版本</span>
      <Select
        v-if="showVersionPicker"
        :model-value="currentVersion"
        :options="versionOptions"
        option-label="label"
        option-value="value"
        :loading="versionsLoading"
        :disabled="busy"
        aria-label="选择要预览的版本"
        @show="emit('request-versions')"
        @focus="emit('request-versions')"
        @update:model-value="onVersionChange"
      />
      <span v-else class="mono version-text">{{ versionText }}</span>
      <span v-if="card.versionCount > 1" class="caption">
        共 {{ card.versionCount }} 个可用版本
      </span>
    </div>

    <div v-if="hasAnyAction" class="row-actions card-actions" @click.stop>
      <template v-if="!isArchived">
        <Button
          label="预览"
          icon="pi pi-eye"
          size="small"
          text
          :disabled="busy"
          @click="emit('preview', currentVersion)"
        />
        <Button
          v-if="caps.canManage"
          label="维护"
          icon="pi pi-pencil"
          size="small"
          text
          :disabled="busy"
          @click="emit('edit')"
        />
        <Button
          v-if="caps.canPublish"
          label="发布新版本"
          icon="pi pi-cloud-upload"
          size="small"
          text
          :disabled="busy"
          @click="emit('publish')"
        />
        <Button
          v-if="caps.canManage"
          label="覆盖版本"
          icon="pi pi-upload"
          size="small"
          text
          :disabled="busy || currentVersion === ''"
          @click="onCover"
        />
        <Button
          v-if="caps.canManage"
          label="管理版本"
          icon="pi pi-history"
          size="small"
          text
          :disabled="busy"
          @click="emit('manageVersions')"
        />
        <span class="toolbar-spacer" />
        <Button
          v-if="caps.canManage"
          label="归档蓝图"
          icon="pi pi-trash"
          size="small"
          text
          severity="danger"
          :disabled="busy"
          @click="emit('archive')"
        />
      </template>
      <template v-else>
        <Button
          v-if="caps.canManage"
          label="恢复"
          icon="pi pi-refresh"
          size="small"
          text
          :disabled="busy"
          @click="emit('restore')"
        />
      </template>
    </div>
  </article>
</template>

<style scoped>
.resource-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.resource-card-summary {
  margin: 0;
  color: var(--muted);
  font-size: var(--text-sm);
  line-height: var(--leading-body);
}

.tag-row {
  flex-wrap: wrap;
}

.version-row {
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.version-text {
  color: var(--fg);
}

.card-actions {
  flex-wrap: wrap;
  margin-top: auto;
}

.is-static {
  cursor: default;
}
</style>
