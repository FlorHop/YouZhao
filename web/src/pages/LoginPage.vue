<script setup lang="ts">
/**
 * 登录（设计 P1）。只有用户名 + 密码两个字段：
 * 平台不提供注册，账号由管理员创建，因此页面上不放「注册」入口。
 */
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/services/api';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const errorText = ref('');
const submitting = ref(false);

const canSubmit = computed(
  () => username.value.trim() !== '' && password.value !== '' && !submitting.value,
);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorText.value = '';
  try {
    await session.signIn(username.value.trim(), password.value);
    const next = route.query.next;
    await router.push(typeof next === 'string' && next !== '' ? next : { name: 'blueprints' });
  } catch (error) {
    errorText.value =
      error instanceof ApiError
        ? error.message
        : '无法连接服务，请确认后端服务已启动后重试。';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-screen">
    <form class="card login-card" @submit.prevent="submit">
      <h1 class="login-title">有招</h1>
      <p class="lede">登录后查看你被授权的蓝图。</p>

      <Message v-if="errorText !== ''" severity="error" :closable="false">
        {{ errorText }}
      </Message>

      <div class="field">
        <label for="login-username">用户名</label>
        <InputText
          id="login-username"
          v-model="username"
          autocomplete="username"
          autofocus
          :disabled="submitting"
        />
      </div>

      <div class="field">
        <label for="login-password">密码</label>
        <InputText
          id="login-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          :disabled="submitting"
        />
      </div>

      <Button
        type="submit"
        label="登录"
        :loading="submitting"
        :disabled="!canSubmit"
        class="login-submit"
      />
    </form>
  </div>
</template>
