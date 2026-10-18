<script setup lang="ts">
/**
 * 新建分组（frontend-design §P2「分组区」：`新建分组` 只需分组名称，平台内唯一）。
 *
 * 入口本身按能力门控（`blueprint.manage` 覆盖目标范围），页面在无权时**不渲染**按钮；
 * 这里是纯表单：校验只在本地做「必填 + 长度」，唯一性由服务端判定（GROUP_CONFLICT 就地展示）。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    submitting?: boolean;
    /** 服务端失败原因，由页面注入并就地展示。 */
    errorText?: string;
  }>(),
  { submitting: false, errorText: '' },
);

const emit = defineEmits<{
  'update:visible': [visible: boolean];
  submit: [name: string];
}>();

const name = ref('');
const localError = ref('');

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      name.value = '';
      localError.value = '';
    }
  },
);

function close(): void {
  emit('update:visible', false);
}

function submit(): void {
  const trimmed = name.value.trim();
  if (trimmed === '') {
    localError.value = '请填写分组名称。';
    return;
  }
  if (trimmed.length > 60) {
    localError.value = '分组名称不超过 60 个字符。';
    return;
  }
  localError.value = '';
  emit('submit', trimmed);
}
</script>

<template>
  <Dialog
    :visible="visible"
    header="新建分组"
    :modal="true"
    :draggable="false"
    class="dialog-narrow"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="stack">
      <p class="caption">
        分组用来收拢同一类蓝图；分组名称在平台内唯一。分组本身不授予权限——查看权与业务能力在「权限」页按分组分配。
      </p>
      <div class="field">
        <label for="new-group-name">分组名称</label>
        <InputText
          id="new-group-name"
          v-model="name"
          maxlength="60"
          autocomplete="off"
          :disabled="submitting"
        />
        <p v-if="localError !== ''" class="field-error">{{ localError }}</p>
        <p v-else-if="errorText !== ''" class="field-error">{{ errorText }}</p>
      </div>
    </div>

    <template #footer>
      <Button label="取消" severity="secondary" outlined :disabled="submitting" @click="close" />
      <Button label="新建分组" :loading="submitting" @click="submit" />
    </template>
  </Dialog>
</template>

<style scoped>
.dialog-narrow {
  width: min(92vw, 30rem);
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
