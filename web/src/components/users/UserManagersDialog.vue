<script setup lang="ts">
/**
 * 改派管理归属对话框（设计 P4 / docs/permission-design.md §8.3）。
 *
 * 归属是**整体替换**的可多位集合。改派会立即生效：被移出的管理员立刻失去管理权，
 * 但该用户已有的查看授权不会自动清除。二次确认由页面负责。
 * 仅平台所有者可见此入口（用户管理员不能改派）。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import MultiSelect from 'primevue/multiselect';
import { ref, watch } from 'vue';

import type { UserRow } from '@/services/endpoints';
import type { ManagerOption } from '@/components/users/UserCreateDialog.vue';

const visible = defineModel<boolean>('visible', { required: true });

const props = defineProps<{
  user: UserRow | null;
  managerOptions: ManagerOption[];
  submitting: boolean;
  errorText: string;
}>();

const emit = defineEmits<{ submit: [managerIds: string[]] }>();

const managerIds = ref<string[]>([]);

watch(visible, (open) => {
  if (!open) return;
  managerIds.value = [...(props.user?.managedByUserIds ?? [])];
});

function submit(): void {
  emit('submit', [...managerIds.value]);
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :draggable="false"
    :style="{ width: '32rem' }"
    header="改派管理员"
  >
    <Message v-if="errorText !== ''" severity="error" :closable="false">{{ errorText }}</Message>

    <div class="stack">
      <p class="caption">
        为「{{ props.user?.displayName }}」重新指定管理归属。归属是整体替换：没有被选中的管理员会立即失去
        对这个账号的管理权，该用户已有的查看授权不受影响。
      </p>

      <div class="field">
        <label for="manage-by-managers">归属用户管理员</label>
        <MultiSelect
          id="manage-by-managers"
          v-model="managerIds"
          :options="props.managerOptions"
          option-label="label"
          option-value="value"
          :show-toggle-all="false"
          filter
          display="chip"
          placeholder="留空表示暂不指派"
        />
        <small class="caption">可以指定多位管理员；留空表示暂不指派，此时只有平台所有者能管理该账号。</small>
      </div>
    </div>

    <template #footer>
      <Button label="取消" severity="secondary" outlined :disabled="props.submitting" @click="visible = false" />
      <Button label="保存归属" :loading="props.submitting" @click="submit" />
    </template>
  </Dialog>
</template>
