<script setup lang="ts">
/**
 * 区段三「业务能力」的「添加授权」对话框（设计 `docs/frontend-design.md` §6 区段三）：
 * 选择用户 → 选择能力 → **显式**选择范围，不存在「全部分组」默认值。
 */
import type { CapabilityName, ScopeRef } from '@/services/endpoints';

import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';

import { capabilityLabel } from '@/stores/session';

interface Option {
  label: string;
  value: string;
}

const visible = defineModel<boolean>('visible', { required: true });

const props = defineProps<{
  userOptions: Option[];
  groupOptions: Option[];
  blueprintOptions: Option[];
  submitting: boolean;
  errorText: string;
}>();

const emit = defineEmits<{
  submit: [userId: string, capability: CapabilityName, target: ScopeRef];
}>();

const capabilityOptions: Option[] = [
  { label: capabilityLabel('blueprint.manage'), value: 'blueprint.manage' },
  { label: capabilityLabel('blueprint.publish'), value: 'blueprint.publish' },
];

const scopeTypeOptions: Option[] = [
  { label: '分组', value: 'group' },
  { label: '单个蓝图', value: 'blueprint' },
];

const userId = ref<string | null>(null);
const capability = ref<CapabilityName | null>(null);
const targetType = ref<string | null>(null);
const targetId = ref<string | null>(null);

watch(visible, (open) => {
  if (!open) return;
  userId.value = null;
  capability.value = null;
  targetType.value = null;
  targetId.value = null;
});

watch(targetType, () => {
  targetId.value = null;
});

const targetOptions = computed<Option[]>(() => {
  if (targetType.value === 'group') return props.groupOptions;
  if (targetType.value === 'blueprint') return props.blueprintOptions;
  return [];
});

const canSubmit = computed(
  () =>
    userId.value !== null &&
    capability.value !== null &&
    targetType.value !== null &&
    targetId.value !== null,
);

function onConfirm(): void {
  const selectedUser = userId.value;
  const selectedCapability = capability.value;
  const selectedType = targetType.value;
  const selectedTarget = targetId.value;
  if (selectedUser === null || selectedCapability === null || selectedTarget === null) return;
  if (selectedType !== 'group' && selectedType !== 'blueprint') return;
  emit('submit', selectedUser, selectedCapability, {
    targetType: selectedType,
    targetId: selectedTarget,
  });
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    header="添加授权"
    :modal="true"
    :draggable="false"
    :style="{ width: '34rem' }"
  >
    <div class="field">
      <label for="capability-user">用户</label>
      <Select
        v-model="userId"
        input-id="capability-user"
        :options="userOptions"
        option-label="label"
        option-value="value"
        placeholder="选择用户"
        filter
      />
    </div>

    <div class="field">
      <label for="capability-name">能力</label>
      <Select
        v-model="capability"
        input-id="capability-name"
        :options="capabilityOptions"
        option-label="label"
        option-value="value"
        placeholder="选择能力"
      />
    </div>

    <div class="field">
      <label for="capability-scope-type">范围类型</label>
      <Select
        v-model="targetType"
        input-id="capability-scope-type"
        :options="scopeTypeOptions"
        option-label="label"
        option-value="value"
        placeholder="选择范围类型"
      />
    </div>

    <div class="field">
      <label for="capability-scope">具体范围</label>
      <Select
        v-model="targetId"
        input-id="capability-scope"
        :options="targetOptions"
        option-label="label"
        option-value="value"
        :placeholder="targetType === null ? '请先选择范围类型' : '请选择具体范围'"
        :disabled="targetType === null"
        filter
      />
      <p class="caption">必须显式选择一个分组或一个蓝图，没有「全部分组」这类默认范围。</p>
    </div>

    <Message v-if="errorText !== ''" severity="error" :closable="false">{{ errorText }}</Message>

    <template #footer>
      <div class="inline">
        <Button
          label="取消"
          text
          severity="secondary"
          :disabled="submitting"
          @click="visible = false"
        />
        <Button
          label="授予能力"
          icon="pi pi-check"
          :loading="submitting"
          :disabled="!canSubmit"
          @click="onConfirm"
        />
      </div>
    </template>
  </Dialog>
</template>
