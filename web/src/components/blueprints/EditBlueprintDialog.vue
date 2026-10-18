<script lang="ts">
/** 维护蓝图信息的提交载荷（只带实际改动的字段，页面据此调用 PATCH）。 */
export interface EditBlueprintPayload {
  name: string;
  summary: string;
  tags: string[];
  groupId: string;
}
</script>

<script setup lang="ts">
/**
 * 维护蓝图信息（frontend-design §P2 卡片操作「维护」：编辑名称／概述／标签、移动分组）。
 *
 * 归档蓝图是独立动作（卡片上的「归档蓝图」），不放在这个表单里，避免把
 * 一个可逆的信息编辑和一次影响可见性的动作混在同一次提交里。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Textarea from 'primevue/textarea';
import { computed, ref, watch } from 'vue';

import type { BlueprintCard as BlueprintCardRow, BlueprintGroup } from '@/services/endpoints';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    blueprint: BlueprintCardRow | null;
    /** 可作为移动目标的分组（页面按 blueprint.manage 覆盖范围过滤，超范围项不列出）。 */
    groups: readonly BlueprintGroup[];
    submitting?: boolean;
    errorText?: string;
  }>(),
  { submitting: false, errorText: '' },
);

const emit = defineEmits<{
  'update:visible': [visible: boolean];
  submit: [payload: EditBlueprintPayload];
}>();

const name = ref('');
const summary = ref('');
const tagsText = ref('');
const groupId = ref('');
const localErrors = ref<Record<string, string>>({});

const groupOptions = computed(() =>
  props.groups.map((group) => ({ label: group.name, value: group.id })),
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    const current = props.blueprint;
    name.value = current?.name ?? '';
    summary.value = current?.summary ?? '';
    tagsText.value = current?.tags.join('、') ?? '';
    groupId.value = current?.groupId ?? props.groups[0]?.id ?? '';
    localErrors.value = {};
  },
);

function parseTags(raw: string): string[] {
  const parts = raw
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return [...new Set(parts)];
}

function submit(): void {
  const tags = parseTags(tagsText.value);
  const errors: Record<string, string> = {};
  if (name.value.trim() === '') errors.name = '请填写蓝图名称。';
  else if (name.value.trim().length > 120) errors.name = '蓝图名称不超过 120 个字符。';
  if (summary.value.length > 2000) errors.summary = '概述不超过 2000 个字符。';
  if (tags.length > 20) errors.tags = '标签最多 20 个。';
  else if (tags.some((tag) => tag.length > 32)) errors.tags = '单个标签不超过 32 个字符。';
  if (groupId.value === '') errors.groupId = '请选择所属分组。';
  localErrors.value = errors;
  if (Object.keys(errors).length > 0) return;
  emit('submit', {
    name: name.value.trim(),
    summary: summary.value.trim(),
    tags,
    groupId: groupId.value,
  });
}
</script>

<template>
  <Dialog
    :visible="visible"
    header="维护蓝图"
    :modal="true"
    :draggable="false"
    class="dialog-wide"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="stack">
      <p class="caption">保存后立即生效；调整分组会改变哪些账号能看到这个蓝图。</p>

      <div class="field">
        <label for="bp-edit-name">蓝图名称</label>
        <InputText id="bp-edit-name" v-model="name" maxlength="120" :disabled="submitting" />
        <p v-if="localErrors.name !== undefined" class="field-error">{{ localErrors.name }}</p>
      </div>

      <div class="field">
        <label for="bp-edit-summary">概述</label>
        <Textarea id="bp-edit-summary" v-model="summary" :rows="3" maxlength="2000" :disabled="submitting" />
        <p v-if="localErrors.summary !== undefined" class="field-error">{{ localErrors.summary }}</p>
      </div>

      <div class="field">
        <label for="bp-edit-tags">标签</label>
        <InputText id="bp-edit-tags" v-model="tagsText" placeholder="多个标签用逗号分隔" :disabled="submitting" />
        <p v-if="localErrors.tags !== undefined" class="field-error">{{ localErrors.tags }}</p>
      </div>

      <div class="field">
        <label for="bp-edit-group">所属分组</label>
        <Select
          id="bp-edit-group"
          v-model="groupId"
          :options="groupOptions"
          option-label="label"
          option-value="value"
          placeholder="选择分组"
          :disabled="submitting"
        />
        <p v-if="localErrors.groupId !== undefined" class="field-error">{{ localErrors.groupId }}</p>
      </div>

      <p v-if="errorText !== ''" class="field-error">{{ errorText }}</p>
    </div>

    <template #footer>
      <Button
        label="取消"
        severity="secondary"
        outlined
        :disabled="submitting"
        @click="emit('update:visible', false)"
      />
      <Button label="保存" :loading="submitting" @click="submit" />
    </template>
  </Dialog>
</template>

<style scoped>
.dialog-wide {
  width: min(92vw, 46rem);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field label {
  color: var(--fg-2);
  font-size: var(--text-sm);
}
</style>
