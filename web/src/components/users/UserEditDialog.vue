<script lang="ts">
export interface UserEditPayload {
  displayName: string;
  email: string;
  phone: string;
}
</script>

<script setup lang="ts">
/**
 * 编辑资料对话框（设计 P4）。只改资料三字段：
 * `PATCH /api/users/:id` 的契约只接受 displayName / email / phone / status
 * （docs/permission-design.md §6.2），状态是独立动作，用户名不可改。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import { computed, ref, watch } from 'vue';

import type { UserRow } from '@/services/endpoints';

const visible = defineModel<boolean>('visible', { required: true });

const props = defineProps<{
  user: UserRow | null;
  submitting: boolean;
  errorText: string;
  fieldErrors: Record<string, string>;
}>();

const emit = defineEmits<{ submit: [payload: UserEditPayload] }>();

const displayName = ref('');
const email = ref('');
const phone = ref('');
const submitted = ref(false);

watch(visible, (open) => {
  if (!open) return;
  submitted.value = false;
  displayName.value = props.user?.displayName ?? '';
  email.value = props.user?.email ?? '';
  phone.value = props.user?.phone ?? '';
});

const localErrors = computed<Record<string, string>>(() => {
  if (!submitted.value) return {};
  const out: Record<string, string> = {};
  if (displayName.value.trim() === '') out.displayName = '请填写姓名';
  return out;
});

const errors = computed<Record<string, string>>(() => ({
  ...props.fieldErrors,
  ...localErrors.value,
}));

function submit(): void {
  submitted.value = true;
  if (Object.keys(localErrors.value).length > 0) return;
  emit('submit', {
    displayName: displayName.value.trim(),
    email: email.value.trim(),
    phone: phone.value.trim(),
  });
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :draggable="false"
    :style="{ width: '30rem' }"
    header="编辑资料"
  >
    <Message v-if="errorText !== ''" severity="error" :closable="false">{{ errorText }}</Message>

    <div class="stack">
      <p class="caption">
        正在编辑「{{ props.user?.displayName }}」（用户名 {{ props.user?.username }}）。用户名不可修改，
        账号状态请用行内的停用 / 启用。
      </p>

      <div class="field">
        <label for="edit-user-displayName">姓名<span class="text-danger"> *</span></label>
        <InputText
          id="edit-user-displayName"
          v-model="displayName"
          autocomplete="off"
          :invalid="Boolean(errors.displayName)"
        />
        <small v-if="errors.displayName" class="field-error">{{ errors.displayName }}</small>
      </div>

      <div class="field">
        <label for="edit-user-email">邮箱</label>
        <InputText id="edit-user-email" v-model="email" autocomplete="off" />
      </div>

      <div class="field">
        <label for="edit-user-phone">手机号</label>
        <InputText id="edit-user-phone" v-model="phone" autocomplete="off" />
      </div>
    </div>

    <template #footer>
      <Button label="取消" severity="secondary" outlined :disabled="props.submitting" @click="visible = false" />
      <Button label="保存" :loading="props.submitting" @click="submit" />
    </template>
  </Dialog>
</template>
