<script setup lang="ts">
/**
 * 区段四「业务能力」＝ 例外授权（`docs/frontend-design.md` §6 / `docs/permission-design.md` §2.2）。
 *
 * 与「管辖范围」的分工：
 *   - 管辖是地盘，分组管辖自动带发布 + 维护；
 *   - 这里只放**例外**：只想让人维护不发版时只勾「蓝图管理」；给普通用户开通写权也走这里。
 * 表格来自 `GET /api/users/:id/access`，只展示例外授权的原始行，不混入管辖派生项。
 * `PUT /api/users/:id/capabilities` 仍是整体替换语义，页面按「已知全集 + 本次变更」提交。
 */
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';
import Tag from 'primevue/tag';

interface CapabilityRecord {
  id: string;
  userName: string;
  capabilityLabel: string;
  scopeLabel: string;
}

defineProps<{
  records: CapabilityRecord[];
  submitting: boolean;
}>();

const emit = defineEmits<{ add: []; revoke: [id: string] }>();

const columns: { field: 'userName' | 'capabilityLabel' | 'scopeLabel' | 'actions'; header: string }[] = [
  { field: 'userName', header: '用户' },
  { field: 'capabilityLabel', header: '能力' },
  { field: 'scopeLabel', header: '资源范围' },
  { field: 'actions', header: '操作' },
];
</script>

<template>
  <div class="section">
    <div class="section-head">
      <div>
        <h2 class="section-title">业务能力（例外授权）</h2>
        <p class="caption">
          管辖是地盘：管辖某个分组即自动获得该组的发布与维护。这里只放**例外**——
          只想让人维护、不想让人发版时只勾「蓝图管理」；给普通用户开通写权也从这里授。
        </p>
      </div>
      <span class="toolbar-spacer" />
      <Button label="添加授权" icon="pi pi-plus" :disabled="submitting" @click="emit('add')" />
    </div>

    <p class="caption">
      下表是各用户**例外授权**的原始记录（不含由管辖自动派生的能力）。保存时按「已有记录 +
      本次变更」整体提交；要撤销某条，直接点对应行的撤销。
    </p>

    <DataTable :value="records" data-key="id" table-style="min-width: 56rem">
      <Column v-for="column in columns" :key="column.field" :header="column.header">
        <template #body="slotProps">
          <span v-if="column.field === 'userName'">{{ (slotProps.data as CapabilityRecord).userName }}</span>
          <span v-else-if="column.field === 'capabilityLabel'">
            <Tag :value="(slotProps.data as CapabilityRecord).capabilityLabel" severity="secondary" />
          </span>
          <span v-else-if="column.field === 'scopeLabel'">
            {{ (slotProps.data as CapabilityRecord).scopeLabel }}
          </span>
          <Button
            v-else
            label="撤销"
            text
            size="small"
            severity="danger"
            :disabled="submitting"
            @click="emit('revoke', (slotProps.data as CapabilityRecord).id)"
          />
        </template>
      </Column>

      <template #empty>
        <p class="caption">还没有任何例外授权；用户管理员的写权现在多半来自「管辖范围」。</p>
      </template>
    </DataTable>
  </div>
</template>
