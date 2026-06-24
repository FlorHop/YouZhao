<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { useAppState } from '../state';
import logoUrl from '../assets/youzhao-logo.png';

const router = useRouter();
const app = useAppState();
const loading = ref(false);
const errorMessage = ref('');
const form = reactive({
  username: 'admin',
  password: 'admin123'
});

const demoAccounts = [
  { label: '管理员', username: 'admin', password: 'admin123', note: '系统设置 + 蓝图管理' },
  { label: '蓝图管理者', username: 'demo.manager', password: 'demo123', note: '蓝图管理' },
  { label: '蓝图查看者', username: 'viewer', password: 'viewer123', note: '蓝图查看' }
];

function fillAccount(account: (typeof demoAccounts)[number]) {
  form.username = account.username;
  form.password = account.password;
  errorMessage.value = '';
}

function submitLogin() {
  loading.value = true;
  errorMessage.value = '';

  try {
    app.login(form.username, form.password);
    router.push(app.hasFunctionPermission('demo-preview', 'view') ? '/blueprints' : '/settings');
  } catch (error) {
    errorMessage.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-shell">
      <div class="login-copy">
        <img class="login-logo" :src="logoUrl" alt="有招平台" />
      </div>

      <form class="login-panel" @submit.prevent="submitLogin">
        <div class="login-panel-header">
          <h2>登录</h2>
          <span>使用下方演示账号快速进入</span>
        </div>

        <Message v-if="errorMessage" severity="error" :closable="false">{{ errorMessage }}</Message>

        <div class="dialog-form">
          <div class="form-field">
            <label for="username">用户名</label>
            <InputText id="username" v-model="form.username" autocomplete="username" />
          </div>
          <div class="form-field">
            <label for="password">密码</label>
            <Password
              id="password"
              v-model="form.password"
              :feedback="false"
              toggleMask
              autocomplete="current-password"
            />
          </div>
        </div>

        <Button class="login-submit" type="submit" label="登录平台" icon="pi pi-sign-in" :loading="loading" />

        <div class="account-list">
          <button
            v-for="account in demoAccounts"
            :key="account.username"
            type="button"
            class="account-chip"
            @click="fillAccount(account)"
          >
            <strong>{{ account.label }}</strong>
            <span>{{ account.username }} / {{ account.password }}</span>
            <small>{{ account.note }}</small>
          </button>
        </div>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  min-width: 1180px;
  min-height: 100vh;
  place-items: center;
  padding: 32px;
  background:
    linear-gradient(180deg, rgba(101, 127, 144, 0.12), rgba(101, 127, 144, 0) 42%),
    var(--app-bg);
}

.login-shell {
  display: grid;
  width: min(1040px, 100%);
  grid-template-columns: minmax(0, 1fr) 420px;
  gap: 28px;
  align-items: stretch;
}

.login-copy {
  display: grid;
  min-height: 560px;
  place-items: center;
  padding: 42px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel);
  box-shadow: var(--app-shadow);
}

.login-logo {
  width: min(430px, 86%);
  height: auto;
  border-radius: 12px;
  object-fit: contain;
  background: #ffffff;
}

.login-panel {
  align-self: center;
  padding: 22px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel);
  box-shadow: 0 18px 40px rgba(45, 58, 67, 0.1);
}

.login-panel-header {
  margin-bottom: 18px;
}

.login-panel-header h2 {
  margin: 0;
  font-size: 22px;
}

.login-panel-header span {
  display: block;
  margin-top: 6px;
  color: var(--app-muted);
  font-size: 13px;
}

.login-submit {
  width: 100%;
  margin-top: 18px;
}

.account-list {
  display: grid;
  gap: 8px;
  margin-top: 18px;
}

.account-chip {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 11px 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  color: var(--app-text);
  background: var(--app-panel-muted);
  text-align: left;
  cursor: pointer;
}

.account-chip:hover {
  border-color: rgba(37, 99, 235, 0.42);
  background: var(--app-primary-weak);
}

.account-chip span,
.account-chip small {
  color: var(--app-muted);
}
</style>
