<script lang="ts">
/** 发布新版本的提交载荷（页面统一调用接口并刷新）。 */
export interface PublishVersionPayload {
  version: string;
  publishNote: string;
  artifact: File;
}
</script>

<script setup lang="ts">
/**
 * 发布新版本（frontend-design §P2 卡片操作「发布新版本」：上传新产物，新增一个版本并设为最新）。
 *
 * 所需能力 `blueprint.publish` 覆盖目标分组；入口由页面按能力装配，无权时整块不渲染。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import { ref, watch } from 'vue';

import BlueprintArtifactPicker from '@/components/blueprints/BlueprintArtifactPicker.vue';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    blueprintName?: string;
    submitting?: boolean;
    errorText?: string;
  }>(),
  { blueprintName: '', submitting: false, errorText: '' },
);

const emit = defineEmits<{
  'update:visible': [visible: boolean];
  submit: [payload: PublishVersionPayload];
}>();

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const version = ref('');
const publishNote = ref('');
const artifact = ref<File | null>(null);
const pickerKey = ref(0);
const localErrors = ref<Record<string, string>>({});

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    version.value = '';
    publishNote.value = '';
    artifact.value = null;
    localErrors.value = {};
    pickerKey.value += 1;
  },
);

function submit(): void {
  const errors: Record<string, string> = {};
  if (version.value.trim() === '') errors.version = '请填写新版本号。';
  else if (!VERSION_PATTERN.test(version.value.trim())) {
    errors.version = '版本号需以字母或数字开头，只能包含字母、数字、点、下划线和连字符（最长 64 位）。';
  }
  if (publishNote.value.length > 500) errors.publishNote = '发布说明不超过 500 个字符。';
  if (artifact.value === null) errors.artifact = '请选择新版本的产物压缩包。';
  localErrors.value = errors;
  const picked = artifact.value;
  if (Object.keys(errors).length > 0 || picked === null) return;
  emit('submit', {
    version: version.value.trim(),
    publishNote: publishNote.value.trim(),
    artifact: picked,
  });
}
</script>

<template>
  <Dialog
    :visible="visible"
    header="发布新版本"
    :modal="true"
    :draggable="false"
    class="dialog-wide"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="stack">
      <p class="caption">
        {{ blueprintName === '' ? '' : `为「${blueprintName}」` }}新增一个版本并设为最新；原有版本与其产物不受影响。
      </p>

      <div class="field">
        <label for="bp-publish-version">新版本号</label>
        <InputText
          id="bp-publish-version"
          v-model="version"
          maxlength="64"
          placeholder="例如 1.1.0"
          :disabled="submitting"
        />
        <p v-if="localErrors.version !== undefined" class="field-error">{{ localErrors.version }}</p>
      </div>

      <div class="field">
        <label for="bp-publish-note">发布说明</label>
        <Textarea
          id="bp-publish-note"
          v-model="publishNote"
          :rows="2"
          maxlength="500"
          :disabled="submitting"
        />
        <p v-if="localErrors.publishNote !== undefined" class="field-error">
          {{ localErrors.publishNote }}
        </p>
      </div>

      <div class="field">
        <label for="bp-publish-artifact">产物压缩包</label>
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
      <Button label="发布新版本" :loading="submitting" @click="submit" />
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
