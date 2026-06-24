<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from 'primevue/avatar';
import Button from 'primevue/button';
import ConfirmDialog from 'primevue/confirmdialog';
import Toast from 'primevue/toast';
import { useAppState } from './state';

const route = useRoute();
const router = useRouter();
const app = useAppState();
const sidebarWidth = ref(68);
const isResizing = ref(false);

const isPublicPage = computed(() => route.path === '/login');
const isFullScreenPage = computed(() => route.path.includes('/preview'));

const navItems = computed(() => [
  {
    label: '蓝图',
    icon: 'pi pi-th-large',
    path: '/blueprints',
    visible: app.hasFunctionPermission('demo-preview', 'view')
  },
  {
    label: '系统设置',
    icon: 'pi pi-cog',
    path: '/settings',
    visible: app.hasFunctionPermission('system-settings', 'manage')
  }
]);

function logout() {
  app.logout();
  router.push('/login');
}

function toggleSidebar() {
  sidebarWidth.value = sidebarWidth.value > 100 ? 68 : 244;
}

function startSidebarResize(event: MouseEvent) {
  isResizing.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', resizeSidebar);
  window.addEventListener('mouseup', stopSidebarResize);
  event.preventDefault();
}

function resizeSidebar(event: MouseEvent) {
  if (!isResizing.value) return;
  sidebarWidth.value = Math.min(280, Math.max(68, event.clientX));
}

function stopSidebarResize() {
  isResizing.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', resizeSidebar);
  window.removeEventListener('mouseup', stopSidebarResize);
}

onBeforeUnmount(stopSidebarResize);
</script>

<template>
  <Toast />
  <ConfirmDialog />
  <RouterView v-if="isPublicPage || isFullScreenPage" />
  <div v-else class="app-shell">
    <aside
      class="side-nav"
      :class="{ collapsed: sidebarWidth <= 100 }"
      :style="{ width: `${sidebarWidth}px`, flexBasis: `${sidebarWidth}px` }"
    >
      <div class="brand">
        <div class="brand-mark">有</div>
        <div class="brand-copy">
          <strong>有招平台</strong>
          <span>蓝图设计与展示</span>
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
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>
      <Button
        class="sidebar-toggle"
        :icon="sidebarWidth > 100 ? 'pi pi-angle-left' : 'pi pi-angle-right'"
        text
        rounded
        severity="secondary"
        :aria-label="sidebarWidth > 100 ? '收起菜单' : '展开菜单'"
        @click="toggleSidebar"
      />
      <div class="sidebar-resizer" @mousedown="startSidebarResize" />
    </aside>

    <main class="main-area">
      <header class="top-bar">
        <div>
          <strong>{{ route.path === '/settings' ? '系统设置' : '蓝图展示' }}</strong>
        </div>
        <div v-if="app.currentUser.value" class="user-switcher">
          <Avatar icon="pi pi-user" shape="circle" />
          <div class="user-meta">
            <strong>{{ app.currentUser.value.displayName }}</strong>
            <span>{{ app.currentUser.value.username }}</span>
          </div>
          <Button icon="pi pi-sign-out" text rounded severity="secondary" aria-label="退出登录" @click="logout" />
        </div>
      </header>

      <section class="content-area">
        <RouterView />
      </section>
    </main>
  </div>
</template>
