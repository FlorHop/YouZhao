<script lang="ts">
export interface UserCreatePayload {
  username: string;
  displayName: string;
  email: string;
  phone: string;
  password: string;
  managedByUserIds: string[];
}

export interface ManagerOption {
  label: string;
  value: string;
}
</script>

<script setup lang="ts">
/**
 * 新建用户对话框（设计 P4，docs/frontend-design.md §6）。
 *
 * 只含「账号信息」与「管理归属」两段：**不含**身份选择、查看范围、业务能力、Token 选项。
 * 原因见 docs/permission-design.md §6.2 —— POST /api/users 请求体没有 identity 字段，
 * 服务端恒建 member（提升只能走身份变更）；范围与能力分别在权限页配置。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import MultiSelect from 'primevue/multiselect';
import Password from 'primevue/password';
import { computed, ref, watch } from 'vue';

const visible = defineModel<boolean>('visible', { required: true });

const props = defineProps<{
  /** 平台所有者可多选管理归属；用户管理员创建的成员自动归自己，此处只读。 */
  isOwner: boolean;
  managerOptions: ManagerOption[];
  submitting: boolean;
  errorText: string;
  fieldErrors: Record<string, string>;
}>();

const emit = defineEmits<{ submit: [payload: UserCreatePayload] }>();

const username = ref('');
const displayName = ref('');
const email = ref('');
const phone = ref('');
const password = ref('');
const managerIds = ref<string[]>([]);
const submitted = ref(false);

function clear(): void {
  username.value = '';
  displayName.value = '';
  email.value = '';
  phone.value = '';
  password.value = '';
  managerIds.value = [];
  submitted.value = false;
}

watch(visible, (open) => {
  if (open) clear();
});

const localErrors = computed<Record<string, string>>(() => {
  if (!submitted.value) return {};
  const out: Record<string, string> = {};
  if (username.value.trim() === '') out.username = '请填写用户名';
  if (displayName.value.trim() === '') out.displayName = '请填写姓名';
  if (password.value === '') out.password = '请填写初始密码';
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
    username: username.value.trim(),
    displayName: displayName.value.trim(),
    email: email.value.trim(),
    phone: phone.value.trim(),
    password: password.value,
    managedByUserIds: props.isOwner ? [...managerIds.value] : [],
  });
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :draggable="false"
    :style="{ width: '34rem' }"
    header="新建用户"
  >
    <Message v-if="errorText !== ''" severity="error" :closable="false">{{ errorText }}</Message>

    <div class="stack">
      <div>
        <p class="section-title">账号信息</p>
        <p class="caption">
          初始密码为一次性密码，该用户首次登录后需要修改。新建的账号是普通用户，
          查看范围与业务能力请创建后到权限页配置。
        </p>
      </div>

      <div class="field">
        <label for="create-user-username">用户名<span class="text-danger"> *</span></label>
        <InputText
          id="create-user-username"
          v-model="username"
          autocomplete="off"
          :invalid="Boolean(errors.username)"
        />
        <small v-if="errors.username" class="field-error">{{ errors.username }}</small>
      </div>

      <div class="field">
        <label for="create-user-displayName">姓名<span class="text-danger"> *</span></label>
        <InputText
          id="create-user-displayName"
          v-model="displayName"
          autocomplete="off"
          :invalid="Boolean(errors.displayName)"
        />
        <small v-if="errors.displayName" class="field-error">{{ errors.displayName }}</small>
      </div>

      <div class="field">
        <label for="create-user-email">邮箱</label>
        <InputText id="create-user-email" v-model="email" autocomplete="off" />
      </div>

      <div class="field">
        <label for="create-user-phone">手机号</label>
        <InputText id="create-user-phone" v-model="phone" autocomplete="off" />
      </div>

      <div class="field">
        <label for="create-user-password">初始密码<span class="text-danger"> *</span></label>
        <Password
          v-model="password"
          input-id="create-user-password"
          :feedback="false"
          toggle-mask
          :input-props="{ autocomplete: 'new-password' }"
          :invalid="Boolean(errors.password)"
        />
        <small v-if="errors.password" class="field-error">{{ errors.password }}</small>
      </div>

      <div class="divider" />

      <div>
        <p class="section-title">管理归属</p>
        <p class="caption">
          决定谁可以管理这个账号。普通用户可以同时归属多位用户管理员，归属管理员可以编辑资料、
          停用账号与重置密码。
        </p>
      </div>

      <div v-if="props.isOwner" class="field">
        <label for="create-user-managers">归属用户管理员</label>
        <MultiSelect
          id="create-user-managers"
          v-model="managerIds"
          :options="props.managerOptions"
          option-label="label"
          option-value="value"
          :show-toggle-all="false"
          filter
          display="chip"
          placeholder="留空表示暂不指派"
        />
        <small class="caption">留空表示暂不指派；之后可以在用户列表里改派。</small>
      </div>

      <div v-else class="field">
        <label>管理归属</label>
        <p>归属：你</p>
        <small class="caption">你创建的普通用户自动归你管理，之后由平台所有者改派。</small>
      </div>
    </div>

    <template #footer>
      <Button label="取消" severity="secondary" outlined :disabled="props.submitting" @click="visible = false" />
      <Button label="创建用户" :loading="props.submitting" @click="submit" />
    </template>
  </Dialog>
</template>
