<script setup lang="ts">
/**
 * 产物压缩包选择器（architecture-design §6.5：`FileUpload`（`mode="basic"`、`accept=".zip"`、`customUpload`））。
 *
 * 这里只做「选文件 + 就地提示」：包内结构（入口 `index.html`、绝对路径与 `..` 穿越、体积上限）
 * 由服务端「先校验后落盘」判定（frontend-design §P2「上传与覆盖的约束」）。
 * 前端不复制第二套判定——两份判定必然漂移，只会给出互相矛盾的结论。
 */
import FileUpload from 'primevue/fileupload';
import type { FileUploadSelectEvent } from 'primevue/fileupload';
import { computed, ref } from 'vue';

import { formatBytes } from '@/services/format';

const props = withDefaults(
  defineProps<{
    /** 已选文件；由父级持有，对话框关闭时置空。 */
    file: File | null;
    /** 对话框重新打开时递增，用于重置原生文件输入（否则会残留上一次的选择）。 */
    resetKey?: number;
    disabled?: boolean;
    chooseLabel?: string;
  }>(),
  { resetKey: 0, disabled: false, chooseLabel: '选择压缩包' },
);

const emit = defineEmits<{ 'update:file': [file: File | null] }>();

const localError = ref('');

const fileSummary = computed(() =>
  props.file === null ? '' : `${props.file.name}（${formatBytes(props.file.size)}）`,
);

function onSelect(event: FileUploadSelectEvent): void {
  const picked = event.files[0];
  if (picked === undefined) return;
  if (!/\.zip$/i.test(picked.name)) {
    localError.value = '产物必须是 .zip 压缩包（包内根目录需包含入口 index.html）。';
    emit('update:file', null);
    return;
  }
  localError.value = '';
  emit('update:file', picked);
}

function clear(): void {
  localError.value = '';
  emit('update:file', null);
}
</script>

<template>
  <div class="stack">
    <div class="inline picker-row">
      <FileUpload
        :key="resetKey"
        mode="basic"
        accept=".zip,application/zip"
        :auto="false"
        :custom-upload="true"
        :multiple="false"
        :show-upload-button="false"
        :show-cancel-button="false"
        :choose-label="chooseLabel"
        :disabled="disabled"
        @select="onSelect"
      />
      <span v-if="file !== null" class="caption picker-file">{{ fileSummary }}</span>
      <button v-if="file !== null && !disabled" type="button" class="text-action" @click="clear">
        移除
      </button>
    </div>
    <p class="caption">
      压缩包根目录必须包含入口 index.html，可包含它依赖的静态资源；含绝对路径或 .. 的条目会被服务端拒绝，且不会写入半成品。
    </p>
    <p v-if="localError !== ''" class="field-error">{{ localError }}</p>
  </div>
</template>

<style scoped>
.picker-row {
  flex-wrap: wrap;
}

.picker-file {
  color: var(--fg);
}
</style>
