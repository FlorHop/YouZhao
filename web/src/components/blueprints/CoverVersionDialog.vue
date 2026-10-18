<script lang="ts">
/** 覆盖已有版本的提交载荷（页面统一调用接口，并在确认框之后执行）。 */
export interface CoverVersionPayload {
  version: string;
  publishNote: string;
  artifact: File;
}
</script>

<script setup lang="ts">
/**
 * 覆盖已有版本（frontend-design §P2「上传与覆盖的约束」）。
 *
 * 只收集「产物 + 发布说明」；**不可逆**确认框由页面统一走 `ConfirmDialog`
 * （确认文案必须写明「版本号与发布记录保持不变，原产物无法恢复」）。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Textarea from 'primevue/textarea';
import { ref, watch } from 'vue';

import BlueprintArtifactPicker from '@/components/blueprints/BlueprintArtifactPicker.vue';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    blueprintName?: string;
    /** 被覆盖的目标版本号（对话框内固定展示，不允许改）。 */
    version?: string;
    submitting?: boolean;
    errorText?: string;
  }>(),
  { blueprintName: '', version: '', submitting: false, errorText: '' },
);

const emit = defineEmits<{
  'update:visible': [visible: boolean];
  submit: [payload: CoverVersionPayload];
}>();

const publishNote = ref('');
const artifact = ref<File | null>(null);
const pickerKey = ref(0);
const localErrors = ref<Record<string, string>>({});

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    publishNote.value = '';
    artifact.value = null;
    localErrors.value = {};
    pickerKey.value += 1;
  },
);

function submit(): void {
  const errors: Record<string, string> = {};
  if (publishNote.value.length > 500) errors.publishNote = '发布说明不超过 500 个字符。';
  if (artifact.value === null) errors.artifact = '请选择用于覆盖的产物压缩包。';
  localErrors.value = errors;
  const picked = artifact.value;
  if (Object.keys(errors).length > 0 || picked === null) return;
  emit('submit', {
    version: props.version,
    publishNote: publishNote.value.trim(),
    artifact: picked,
  });
}
</script>

<template>
  <Dialog
    :visible="visible"
    header="覆盖已有版本"
    :modal="true"
    :draggable="false"
    class="dialog-wide"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="stack">
      <p class="caption">
        {{ blueprintName === '' ? '' : `蓝图「${blueprintName}」` }}将用新产物替换
        <span class="mono">v{{ version }}</span>
        的内容：版本号不变、不新增版本、发布记录保持不变。提交前还会再确认一次，因为原产物无法恢复。
      </p>

      <div class="field">
        <label for="bp-cover-artifact">新产物压缩包</label>
        <BlueprintArtifactPicker
          :file="artifact"
          :reset-key="pickerKey"
          :disabled="submitting"
          choose-label="选择压缩包"
          @update:file="artifact = $event"
        />
        <p v-if="localErrors.artifact !== undefined" class="field-error">{{ localErrors.artifact }}</p>
      </div>

      <div class="field">
        <label for="bp-cover-note">发布说明</label>
        <Textarea id="bp-cover-note" v-model="publishNote" :rows="2" maxlength="500" :disabled="submitting" />
        <p v-if="localErrors.publishNote !== undefined" class="field-error">
          {{ localErrors.publishNote }}
        </p>
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
      <Button label="继续" :disabled="submitting" @click="submit" />
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
