<script setup lang="ts">
/**
 * 应用外壳（`docs/frontend-design.md` §4）：
 *   - 侧边导航按身份过滤，**不渲染**无权访问的入口
 *   - `我的账号` 不进主导航，只从顶栏头像菜单进入
 *   - 无外壳路由（登录、预览、403）由各页面自己占满视口
 */
import ConfirmDialog from 'primevue/confirmdialog';
import Menu from 'primevue/menu';
import Toast from 'primevue/toast';
import { computed, ref } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';

import { identityLabel, useSessionStore } from '@/stores/session';

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const accountMenu = ref<InstanceType<typeof Menu> | null>(null);

const bare = computed(() => route.meta.bare === true);

interface NavItem {
  name: string;
  label: string;
  icon: string;
}

const navItems = computed<NavItem[]>(() => {
  const items: NavItem[] = [{ name: 'blueprints', label: '蓝图', icon: 'pi pi-th-large' }];
  if (session.canEnterManagement) {
    items.push(
      { name: 'users', label: '用户', icon: 'pi pi-users' },
      { name: 'permissions', label: '权限', icon: 'pi pi-shield' },
    );
  }
  items.push({ name: 'tokens', label: 'MCP Token', icon: 'pi pi-key' });
  return items;
});

/** 身份标签只在「用户」「权限」两页出现（§4）。 */
const showIdentityTag = computed(() => {
  const name = String(route.name ?? '');
  return name === 'users' || name === 'permissions';
});

const identityText = computed(() =>
  session.identity === null ? '' : identityLabel(session.identity),
);

const accountMenuItems = computed(() => [
  { label: '我的账号', icon: 'pi pi-user', command: () => void router.push({ name: 'account' }) },
  { separator: true },
  { label: '退出登录', icon: 'pi pi-sign-out', command: () => void signOut() },
]);

function toggleAccountMenu(event: Event): void {
  accountMenu.value?.toggle(event);
}

async function signOut(): Promise<void> {
  await session.signOut();
  await router.push({ name: 'login' });
}
</script>

<template>
  <Toast position="bottom-right" />
  <ConfirmDialog :draggable="false" />

  <RouterView v-if="bare" />

  <div v-else class="shell">
    <header class="shell-topbar">
      <RouterLink class="shell-brand" :to="{ name: 'blueprints' }">有招</RouterLink>

      <div class="shell-user">
        <span v-if="showIdentityTag" class="identity-tag">{{ identityText }}</span>
        <span class="text-muted">{{ session.displayName }}</span>
        <button
          type="button"
          class="text-action inline"
          aria-haspopup="true"
          aria-controls="account-menu"
          aria-label="账号菜单"
          @click="toggleAccountMenu"
        >
          <i class="pi pi-user" aria-hidden="true" />
        </button>
        <Menu id="account-menu" ref="accountMenu" :model="accountMenuItems" :popup="true" />
      </div>
    </header>

    <div class="shell-body">
      <nav class="shell-sidenav" aria-label="主导航">
        <ul class="nav-list">
          <li v-for="item in navItems" :key="item.name">
            <RouterLink
              class="nav-item"
              :class="{ 'is-active': route.name === item.name }"
              :to="{ name: item.name }"
            >
              <i :class="item.icon" aria-hidden="true" />
              <span>{{ item.label }}</span>
            </RouterLink>
          </li>
        </ul>
      </nav>

      <main class="shell-main">
        <div class="shell-main-inner">
          <RouterView />
        </div>
      </main>
    </div>
  </div>
</template>
