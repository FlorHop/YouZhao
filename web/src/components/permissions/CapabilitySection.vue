<script setup lang="ts">
/**
 * 区段三「业务能力」（设计 `docs/frontend-design.md` §6 区段三 / §8 流程⑤）。
 *
 * 契约现状（见回报中的设计文档缺口）：本期**没有**读取他人业务能力的接口，
 * 且 `PUT /api/users/:id/capabilities` 是整体替换语义，因此这里只能列出
 * 本次会话内由本页授予的能力，并在页面上如实说明；撤销时以同一集合整体提交。
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
  grantedAt: string;
}

defineProps<{
  records: CapabilityRecord[];
  submitting: boolean;
}>();

const emit = defineEmits<{ add: []; revoke: [id: string] }>();

const columns: { field: 'userName' | 'capabilityLabel' | 'scopeLabel' | 'grantedAt' | 'actions'; header: string }[] = [
  { field: 'userName', header: '用户' },
  { field: 'capabilityLabel', header: '能力' },
  { field: 'scopeLabel', header: '资源范围' },
  { field: 'grantedAt', header: '授予时间' },
  { field: 'actions', header: '操作' },
];
</script>

<template>
  <div class="section">
    <div class="section-head">
      <div>
        <h2 class="section-title">业务能力</h2>
        <p class="caption">
          授予此处能力后，该用户才能在指定范围内维护或发布蓝图；这与能否管理账号无关。
        </p>
      </div>
      <span class="toolbar-spacer" />
      <Button label="添加授权" icon="pi pi-plus" :disabled="submitting" @click="emit('add')" />
    </div>

    <p class="caption">
      注意：本期服务端不提供读取他人业务能力的接口，因此下表只包含在本次会话中由你授予的记录；
      保存时会以「下表剩余的记录」整体替换该用户的能力。如果该用户此前在别处被授予过能力，
      请先在下方确认后再撤销。
    </p>

    <DataTable :value="records" data-key="id" table-style="min-width: 64rem">
      <Column v-for="column in columns" :key="column.field" :header="column.header">
        <template #body="slotProps">
          <span v-if="column.field === 'userName'">{{ (slotProps.data as CapabilityRecord).userName }}</span>
          <span v-else-if="column.field === 'capabilityLabel'">
            <Tag :value="(slotProps.data as CapabilityRecord).capabilityLabel" severity="secondary" />
          </span>
          <span v-else-if="column.field === 'scopeLabel'">
            {{ (slotProps.data as CapabilityRecord).scopeLabel }}
          </span>
          <span v-else-if="column.field === 'grantedAt'" class="meta">
            {{ (slotProps.data as CapabilityRecord).grantedAt }}
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
        <p class="caption">本次会话还没有授予任何业务能力。</p>
      </template>
    </DataTable>
  </div>
</template>
