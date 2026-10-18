<script lang="ts">
/**
 * 提交载荷由页面消费（页面统一负责调用接口、映射错误、刷新列表），
 * 因此这里用普通 `<script>` 块导出类型，避免在页面重复一份形状。
 */
export interface CreateBlueprintPayload {
  name: string;
  summary: string;
  tags: string[];
  groupId: string;
  version: string;
  publishNote: string;
  artifact: File;
}
</script>

<script setup lang="ts">
/**
 * 页内新建蓝图（frontend-design §P2「页内新建蓝图」）。
 *
 * 表单字段与发布参数对齐：蓝图名称（必填）、概述、标签、所属分组（默认选中默认分组）、
 * 版本号（必填）、发布说明，外加产物压缩包；一次提交同时建立蓝图与首个版本。
 * 名称冲突、版本号冲突由服务端返回，页面把原文注入 `errorText` 并保留已填内容。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Textarea from 'primevue/textarea';
import { computed, ref, watch } from 'vue';

import BlueprintArtifactPicker from '@/components/blueprints/BlueprintArtifactPicker.vue';
import type { BlueprintGroup } from '@/services/endpoints';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 允许在此发布的分组（页面已按 blueprint.publish 覆盖范围过滤，超范围项不列出）。 */
    groups: readonly BlueprintGroup[];
    defaultGroupId: string;
    submitting?: boolean;
    errorText?: string;
  }>(),
  { submitting: false, errorText: '' },
);

const emit = defineEmits<{
  'update:visible': [visible: boolean];
  submit: [payload: CreateBlueprintPayload];
}>();

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const name = ref('');
const summary = ref('');
const tagsText = ref('');
const groupId = ref('');
const version = ref('');
const publishNote = ref('');
const artifact = ref<File | null>(null);
const pickerKey = ref(0);
const localErrors = ref<Record<string, string>>({});

const groupOptions = computed(() =>
  props.groups.map((group) => ({ label: group.name, value: group.id })),
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    name.value = '';
    summary.value = '';
    tagsText.value = '';
    version.value = '';
    publishNote.value = '';
    artifact.value = null;
    localErrors.value = {};
    pickerKey.value += 1;
    const preferred = props.groups.some((group) => group.id === props.defaultGroupId)
      ? props.defaultGroupId
      : (props.groups[0]?.id ?? '');
    groupId.value = preferred;
  },
);

/** 标签：逗号（中英文）或顿号分隔；上限与契约一致（≤20 个，每个 ≤32 字符）。 */
function parseTags(raw: string): string[] {
  const parts = raw
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return [...new Set(parts)];
}

function validate(tags: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (name.value.trim() === '') errors.name = '请填写蓝图名称。';
  else if (name.value.trim().length > 120) errors.name = '蓝图名称不超过 120 个字符。';
  if (version.value.trim() === '') errors.version = '请填写版本号。';
  else if (!VERSION_PATTERN.test(version.value.trim())) {
    errors.version = '版本号需以字母或数字开头，只能包含字母、数字、点、下划线和连字符（最长 64 位）。';
  }
  if (summary.value.length > 2000) errors.summary = '概述不超过 2000 个字符。';
  if (publishNote.value.length > 500) errors.publishNote = '发布说明不超过 500 个字符。';
  if (tags.length > 20) errors.tags = '标签最多 20 个。';
  else if (tags.some((tag) => tag.length > 32)) errors.tags = '单个标签不超过 32 个字符。';
  if (groupId.value === '') errors.groupId = '请选择所属分组。';
  if (artifact.value === null) errors.artifact = '请选择产物压缩包（根目录需包含 index.html）。';
  return errors;
}

function submit(): void {
  const tags = parseTags(tagsText.value);
  const errors = validate(tags);
  localErrors.value = errors;
  const picked = artifact.value;
  if (Object.keys(errors).length > 0 || picked === null) return;
  emit('submit', {
    name: name.value.trim(),
    summary: summary.value.trim(),
    tags,
    groupId: groupId.value,
    version: version.value.trim(),
    publishNote: publishNote.value.trim(),
    artifact: picked,
  });
}
</script>

<template>
  <Dialog
    :visible="visible"
    header="新建蓝图"
    :modal="true"
    :draggable="false"
    class="dialog-wide"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="stack">
      <p class="caption">创建蓝图的同时发布首个版本。</p>

      <div class="field">
        <label for="bp-create-name">蓝图名称</label>
        <InputText id="bp-create-name" v-model="name" maxlength="120" :disabled="submitting" />
        <p v-if="localErrors.name !== undefined" class="field-error">{{ localErrors.name }}</p>
      </div>

      <div class="field">
        <label for="bp-create-summary">概述</label>
        <Textarea id="bp-create-summary" v-model="summary" :rows="3" maxlength="2000" :disabled="submitting" />
        <p v-if="localErrors.summary !== undefined" class="field-error">{{ localErrors.summary }}</p>
      </div>

      <div class="field">
        <label for="bp-create-tags">标签</label>
        <InputText
          id="bp-create-tags"
          v-model="tagsText"
          placeholder="多个标签用逗号分隔，最多 20 个"
          :disabled="submitting"
        />
        <p v-if="localErrors.tags !== undefined" class="field-error">{{ localErrors.tags }}</p>
      </div>

      <div class="field">
        <label for="bp-create-group">所属分组</label>
        <Select
          id="bp-create-group"
          v-model="groupId"
          :options="groupOptions"
          option-label="label"
          option-value="value"
          placeholder="选择分组"
          :disabled="submitting"
        />
        <p v-if="localErrors.groupId !== undefined" class="field-error">{{ localErrors.groupId }}</p>
      </div>

      <div class="field">
        <label for="bp-create-version">版本号</label>
        <InputText
          id="bp-create-version"
          v-model="version"
          maxlength="64"
          placeholder="例如 1.0.0"
          :disabled="submitting"
        />
        <p v-if="localErrors.version !== undefined" class="field-error">{{ localErrors.version }}</p>
      </div>

      <div class="field">
        <label for="bp-create-note">发布说明</label>
        <Textarea id="bp-create-note" v-model="publishNote" :rows="2" maxlength="500" :disabled="submitting" />
        <p v-if="localErrors.publishNote !== undefined" class="field-error">{{ localErrors.publishNote }}</p>
      </div>

      <div class="field">
        <label for="bp-create-artifact">产物压缩包</label>
        <BlueprintArtifactPicker
          :file="artifact"
          :reset-key="pickerKey"
          :disabled="submitting"
          @update:file="artifact = $event"
        />
        <p v-if="localErrors.artifact !== undefined" class="field-error">{{ localErrors.artifact }}</p>
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
      <Button label="创建并发布" :loading="submitting" @click="submit" />
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
