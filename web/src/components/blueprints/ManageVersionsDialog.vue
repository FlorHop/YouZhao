<script setup lang="ts">
/**
 * 管理版本（frontend-design §P2 卡片操作「归档版本」与「恢复」）。
 *
 * 版本列表按需加载：列表接口一次给足卡片字段，但**不含**版本明细，
 * 而设计明确禁止「逐条再请求详情」（N+1）；所以版本明细只在用户真正打开这个
 * 对话框时按蓝图拉一次，并复用服务端返回的 `capabilities` 判定每行操作。
 */
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Dialog from 'primevue/dialog';
import { computed } from 'vue';

import type { BlueprintVersion } from '@/services/endpoints';
import { formatBytes, formatDateTime } from '@/services/format';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    blueprintName?: string;
    /** 版本明细；null = 还没加载。 */
    versions?: readonly BlueprintVersion[] | null;
    loading?: boolean;
    errorText?: string;
    canManage?: boolean;
    /** 正在提交的版本号，用于禁用该行并显示 loading。 */
    busyVersion?: string;
  }>(),
  {
    blueprintName: '',
    versions: null,
    loading: false,
    errorText: '',
    canManage: false,
    busyVersion: '',
  },
);

const emit = defineEmits<{
  'update:visible': [visible: boolean];
  archive: [version: string];
  restore: [version: string];
  reload: [];
}>();

const SOURCE_LABEL: Record<string, string> = {
  mcp: 'MCP 发布',
  web: '页内发布',
  'web-cover': '页内覆盖',
};

const rows = computed<BlueprintVersion[]>(() => [...(props.versions ?? [])]);
const availableCount = computed(
  () => (props.versions ?? []).filter((item) => item.archivedAt === null).length,
);

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

function statusLabel(status: string): string {
  return status === 'available' ? '可预览' : '产物缺失';
}

/** 设计：不得归档最后一个可用版本——服务端也会拒绝（LAST_VERSION_PROTECTED）。 */
function canArchive(item: BlueprintVersion): boolean {
  if (!props.canManage) return false;
  if (item.archivedAt !== null) return false;
  return availableCount.value > 1;
}

function archiveTitle(item: BlueprintVersion): string {
  if (!props.canManage) return '';
  if (availableCount.value <= 1) return '不能归档蓝图的最后一个可用版本';
  return `归档版本 v${item.version}`;
}
</script>

<template>
  <Dialog
    :visible="visible"
    header="管理版本"
    :modal="true"
    :draggable="false"
    class="dialog-wide"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="stack">
      <p class="caption">
        {{ blueprintName === '' ? '' : `蓝图「${blueprintName}」：` }}归档的版本不能再被预览，但产物保留，随时可以恢复；最后一个可用版本不能归档。
      </p>

      <p v-if="errorText !== ''" class="field-error">{{ errorText }}</p>

      <div class="versions-table">
        <DataTable
          :value="rows"
          data-key="version"
          :loading="loading"
          size="small"
          scrollable
          class="data-table"
        >
          <Column field="version" header="版本" />
          <Column field="status" header="产物">
            <template #body="{ data }">
              <span class="chip" :class="{ 'is-muted': data.status !== 'available' }">
                {{ statusLabel(data.status) }}
              </span>
            </template>
          </Column>
          <Column field="publishSource" header="来源">
            <template #body="{ data }">{{ sourceLabel(data.publishSource) }}</template>
          </Column>
          <Column field="artifactBytes" header="大小">
            <template #body="{ data }">{{ formatBytes(data.artifactBytes) }}</template>
          </Column>
          <Column field="deployedAt" header="发布时间">
            <template #body="{ data }">{{ formatDateTime(data.deployedAt) }}</template>
          </Column>
          <Column field="publishNote" header="发布说明">
            <template #body="{ data }">
              <span v-if="data.publishNote !== ''" class="caption">{{ data.publishNote }}</span>
              <span v-else class="caption text-muted">—</span>
            </template>
          </Column>
          <Column header="操作">
            <template #body="{ data }">
              <div class="row-actions">
                <Button
                  v-if="data.archivedAt === null"
                  label="归档"
                  size="small"
                  text
                  severity="danger"
                  :disabled="!canArchive(data) || busyVersion === data.version"
                  :loading="busyVersion === data.version"
                  :title="archiveTitle(data)"
                  @click="emit('archive', data.version)"
                />
                <Button
                  v-else
                  label="恢复"
                  size="small"
                  text
                  :disabled="!canManage || busyVersion === data.version"
                  :loading="busyVersion === data.version"
                  @click="emit('restore', data.version)"
                />
                <span v-if="data.isLatest" class="chip">最新</span>
              </div>
            </template>
          </Column>
          <template #empty>
            <p class="empty-state">
              {{ loading ? '正在加载版本…' : '这个蓝图当前没有版本记录。' }}
            </p>
          </template>
        </DataTable>
      </div>
    </div>

    <template #footer>
      <Button label="重新加载" severity="secondary" outlined :disabled="loading" @click="emit('reload')" />
      <Button label="关闭" @click="emit('update:visible', false)" />
    </template>
  </Dialog>
</template>

<style scoped>
.versions-table {
  overflow-x: auto;
}
</style>
