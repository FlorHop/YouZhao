<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
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
  username: '',
  password: ''
});
const setupForm = reactive({
  username: '',
  displayName: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: ''
});
const isSetupMode = computed(() => app.setupRequired.value);

async function submitLogin() {
  loading.value = true;
  errorMessage.value = '';

  try {
    await app.login(form.username, form.password);
    router.push(app.hasFunctionPermission('demo-preview', 'view') ? '/blueprints' : '/settings');
  } catch (error) {
    errorMessage.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

async function submitSetup() {
  loading.value = true;
  errorMessage.value = '';

  try {
    if (setupForm.password !== setupForm.confirmPassword) throw new Error('两次输入的密码不一致');
    await app.setupAdmin(
      {
        username: setupForm.username,
        displayName: setupForm.displayName,
        email: setupForm.email,
        phone: setupForm.phone
      },
      setupForm.password
    );
    form.username = setupForm.username;
    form.password = setupForm.password;
    await submitLogin();
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
        <img class="login-logo" :src="logoUrl" alt="有招" />
      </div>

      <form class="login-panel" @submit.prevent="isSetupMode ? submitSetup() : submitLogin()">
        <div class="login-panel-header">
          <h2>{{ isSetupMode ? '初始化管理员' : '登录' }}</h2>
          <span>{{ isSetupMode ? '首次部署需要创建平台管理员帐号' : '请输入帐号密码进入平台' }}</span>
        </div>

        <Message v-if="errorMessage" severity="error" :closable="false">{{ errorMessage }}</Message>

        <div v-if="isSetupMode" class="dialog-form">
          <div class="form-field">
            <label for="setup-username">管理员用户名</label>
            <InputText id="setup-username" v-model="setupForm.username" autocomplete="username" autofocus />
          </div>
          <div class="form-field">
            <label for="setup-display-name">姓名</label>
            <InputText id="setup-display-name" v-model="setupForm.displayName" autocomplete="name" />
          </div>
          <div class="form-field">
            <label for="setup-email">邮箱</label>
            <InputText id="setup-email" v-model="setupForm.email" autocomplete="email" />
          </div>
          <div class="form-field">
            <label for="setup-phone">手机号</label>
            <InputText id="setup-phone" v-model="setupForm.phone" autocomplete="tel" />
          </div>
          <div class="form-field">
            <label for="setup-password">密码</label>
            <Password id="setup-password" v-model="setupForm.password" :feedback="false" toggleMask autocomplete="new-password" />
          </div>
          <div class="form-field">
            <label for="setup-confirm-password">确认密码</label>
            <Password
              id="setup-confirm-password"
              v-model="setupForm.confirmPassword"
              :feedback="false"
              toggleMask
              autocomplete="new-password"
            />
          </div>
        </div>

        <div v-else class="dialog-form">
          <div class="form-field">
            <label for="username">用户名</label>
            <InputText id="username" v-model="form.username" autocomplete="username" autofocus />
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

        <Button
          class="login-submit"
          type="submit"
          :label="isSetupMode ? '完成初始化' : '登录平台'"
          :icon="isSetupMode ? 'pi pi-check' : 'pi pi-sign-in'"
          :loading="loading"
        />
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
  width: min(980px, 100%);
  grid-template-columns: minmax(0, 1fr) 400px;
  gap: 28px;
  align-items: stretch;
}

.login-copy {
  display: grid;
  min-height: 500px;
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
  padding: 28px;
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

</style>
