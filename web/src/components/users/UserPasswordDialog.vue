<script setup lang="ts">
/**
 * 重置密码对话框（设计 P4）。危险动作，确认环节由页面的 ConfirmDialog 承担：
 * 本对话框只收集新密码，提交后仍会弹二次确认（docs/frontend-design.md §7 危险动作规范）。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { computed, ref, watch } from 'vue';

import type { UserRow } from '@/services/endpoints';

const visible = defineModel<boolean>('visible', { required: true });

const props = defineProps<{
  user: UserRow | null;
  submitting: boolean;
  errorText: string;
  fieldErrors: Record<string, string>;
}>();

const emit = defineEmits<{ submit: [password: string] }>();

const password = ref('');
const submitted = ref(false);

watch(visible, (open) => {
  if (!open) return;
  submitted.value = false;
  password.value = '';
});

const localErrors = computed<Record<string, string>>(() => {
  if (!submitted.value) return {};
  const out: Record<string, string> = {};
  if (password.value === '') out.password = '请填写新的初始密码';
  return out;
});

const errors = computed<Record<string, string>>(() => ({
  ...props.fieldErrors,
  ...localErrors.value,
}));

function submit(): void {
  submitted.value = true;
  if (Object.keys(localErrors.value).length > 0) return;
  emit('submit', password.value);
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :draggable="false"
    :style="{ width: '30rem' }"
    header="重置密码"
  >
    <Message v-if="errorText !== ''" severity="error" :closable="false">{{ errorText }}</Message>

    <div class="stack">
      <p class="caption">
        为「{{ props.user?.displayName }}」设置新的初始密码。重置后该用户当前的所有登录会话会立即失效，
        需要用新密码重新登录，并且首次登录时会被要求再次修改密码。
      </p>

      <div class="field">
        <label for="reset-user-password">新的初始密码<span class="text-danger"> *</span></label>
        <Password
          v-model="password"
          input-id="reset-user-password"
          :feedback="false"
          toggle-mask
          :input-props="{ autocomplete: 'new-password' }"
          :invalid="Boolean(errors.password)"
        />
        <small v-if="errors.password" class="field-error">{{ errors.password }}</small>
      </div>

      <p class="caption">新密码请通过安全渠道告知本人，本平台不会再次显示它。</p>
    </div>

    <template #footer>
      <Button label="取消" severity="secondary" outlined :disabled="props.submitting" @click="visible = false" />
      <Button label="重置密码" :loading="props.submitting" @click="submit" />
    </template>
  </Dialog>
</template>
