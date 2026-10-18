<script setup lang="ts">
/**
 * 区段二「管理员与可委派范围」（仅平台所有者可见，设计 `docs/frontend-design.md` §6 区段二）。
 *
 * 可委派范围**不单独设置**：它等于该管理员自己在区段一被授予的查看范围，
 * 因此行内操作是「查看其范围」而不是「调整范围」。
 */
import Button from 'primevue/button';
import Column from 'primevue/column';
import DataTable from 'primevue/datatable';

interface AdminRow {
  id: string;
  displayName: string;
  managedCount: number;
  scopeSummary: string;
}

const props = defineProps<{
  rows: AdminRow[];
  submitting: boolean;
}>();

const emit = defineEmits<{ viewScope: [id: string]; add: [] }>();

const columns: { field: 'displayName' | 'managedCount' | 'scopeSummary' | 'actions'; header: string }[] = [
  { field: 'displayName', header: '用户管理员' },
  { field: 'managedCount', header: '当前管理用户数' },
  { field: 'scopeSummary', header: '可委派范围摘要' },
  { field: 'actions', header: '操作' },
];
</script>

<template>
  <div class="section">
    <div class="section-head">
      <div>
        <h2 class="section-title">管理员与可委派范围</h2>
        <p class="caption">
          用户管理员只能把「可委派范围」内的分组与蓝图授予他管理的用户，不能超出。
        </p>
      </div>
      <span class="toolbar-spacer" />
      <Button
        label="添加用户管理员"
        icon="pi pi-plus"
        :disabled="submitting"
        @click="emit('add')"
      />
    </div>

    <DataTable :value="props.rows" data-key="id" table-style="min-width: 56rem">
      <Column v-for="column in columns" :key="column.field" :header="column.header">
        <template #body="slotProps">
          <span v-if="column.field === 'displayName'">
            {{ (slotProps.data as AdminRow).displayName }}
          </span>
          <span v-else-if="column.field === 'managedCount'">
            {{ (slotProps.data as AdminRow).managedCount }}
          </span>
          <span v-else-if="column.field === 'scopeSummary'" class="caption">
            {{ (slotProps.data as AdminRow).scopeSummary }}
          </span>
          <Button
            v-else
            label="查看其范围"
            text
            size="small"
            icon="pi pi-arrow-right"
            @click="emit('viewScope', (slotProps.data as AdminRow).id)"
          />
        </template>
      </Column>

      <template #empty>
        <p class="caption">还没有用户管理员。可以用右上角的「添加用户管理员」任命一位。</p>
      </template>
    </DataTable>

    <p class="caption">
      该范围决定此管理员能为其管理的用户开放哪些蓝图，不包含蓝图管理与发布权；
      它不单独维护，而等于该管理员自己被授予的查看范围。
    </p>
  </div>
</template>
