<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from 'primevue/avatar';
import ConfirmDialog from 'primevue/confirmdialog';
import Select from 'primevue/select';
import Toast from 'primevue/toast';
import { useAppState } from './state';

const route = useRoute();
const router = useRouter();
const app = useAppState();

const currentUserModel = computed({
  get: () => app.currentUserId.value,
  set: (value: string) => {
    app.currentUserId.value = value;
    if (route.path === '/settings' && !app.hasFunctionPermission('system-settings', 'manage')) {
      router.push('/demo');
    }
  }
});

const navItems = computed(() => [
  {
    label: 'Demo',
    icon: 'pi pi-th-large',
    path: '/demo',
    visible: app.hasFunctionPermission('demo-preview', 'view')
  },
  {
    label: '系统设置',
    icon: 'pi pi-cog',
    path: '/settings',
    visible: app.hasFunctionPermission('system-settings', 'manage')
  }
]);
</script>

<template>
  <Toast />
  <ConfirmDialog />
  <div class="app-shell">
    <aside class="side-nav">
      <div class="brand">
        <div class="brand-mark">有</div>
        <div>
          <strong>有招平台</strong>
          <span>Demo Delivery</span>
        </div>
      </div>

      <nav class="nav-list">
        <button
          v-for="item in navItems.filter((nav) => nav.visible)"
          :key="item.path"
          class="nav-item"
          :class="{ active: route.path === item.path }"
          type="button"
          @click="router.push(item.path)"
        >
          <i :class="item.icon" />
          <span>{{ item.label }}</span>
        </button>
      </nav>
    </aside>

    <main class="main-area">
      <header class="top-bar">
        <div>
          <strong>{{ route.path === '/settings' ? '系统设置' : 'Demo 展示' }}</strong>
          <span>纯前端 MVP，用于验证交互与权限边界</span>
        </div>
        <div class="user-switcher">
          <Avatar icon="pi pi-user" shape="circle" />
          <Select
            v-model="currentUserModel"
            :options="app.state.users"
            optionLabel="displayName"
            optionValue="id"
            class="user-select"
            aria-label="切换模拟用户"
          />
        </div>
      </header>

      <section class="content-area">
        <RouterView />
      </section>
    </main>
  </div>
</template>
