<script setup lang="ts">
import Button from 'primevue/button';
import { useRouter } from 'vue-router';
import { useAppState } from '../state';

const router = useRouter();
const app = useAppState();

function goHome() {
  if (app.hasFunctionPermission('demo-preview', 'view')) {
    router.push('/blueprints');
    return;
  }
  if (app.hasFunctionPermission('system-settings', 'manage')) {
    router.push('/settings');
    return;
  }
  app.logout();
  router.push('/login');
}
</script>

<template>
  <div class="denied-state forbidden-page">
    <div>
      <i class="pi pi-lock" />
      <h1>无可访问权限</h1>
      <p>当前账号没有可进入的功能模块，请联系系统管理员调整授权。</p>
      <Button label="返回可访问页面" icon="pi pi-arrow-left" @click="goHome" />
    </div>
  </div>
</template>

<style scoped>
.forbidden-page {
  min-height: calc(100vh - 108px);
  text-align: center;
}

.forbidden-page i {
  color: var(--app-primary);
  font-size: 30px;
}

.forbidden-page h1 {
  margin: 14px 0 8px;
  color: var(--app-text);
  font-size: 22px;
}

.forbidden-page p {
  margin: 0 0 18px;
}
</style>
