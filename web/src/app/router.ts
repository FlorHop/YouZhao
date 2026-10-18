/**
 * 路由与守卫。
 *
 * 守卫只决定「渲染什么」：`/users`、`/permissions` 是**身份级**准入
 * （普通用户整体不可进入，直达 URL 显示 /403），不是数据级裁剪。
 * 服务端仍会逐接口校验，前端守卫不是安全边界（设计 §11）。
 *
 * 路由表与守卫分开导出，便于在测试里用内存路由复现准入判定。
 */

import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw, Router, RouterHistory } from 'vue-router';

import { useSessionStore } from '@/stores/session';

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/blueprints' },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/pages/LoginPage.vue'),
    meta: { anonymousOnly: true, bare: true },
  },
  {
    path: '/blueprints',
    name: 'blueprints',
    component: () => import('@/pages/BlueprintsPage.vue'),
    meta: { title: '蓝图' },
  },
  {
    path: '/blueprints/:id/preview',
    name: 'blueprint-preview',
    component: () => import('@/pages/BlueprintPreviewPage.vue'),
    meta: { bare: true, fullscreen: true },
    props: true,
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('@/pages/UsersPage.vue'),
    meta: { title: '用户', management: true },
  },
  {
    path: '/permissions',
    name: 'permissions',
    component: () => import('@/pages/PermissionsPage.vue'),
    meta: { title: '权限', management: true },
  },
  {
    path: '/tokens',
    name: 'tokens',
    component: () => import('@/pages/TokensPage.vue'),
    meta: { title: 'MCP Token' },
  },
  {
    path: '/account',
    name: 'account',
    component: () => import('@/pages/AccountPage.vue'),
    meta: { title: '我的账号' },
  },
  {
    path: '/403',
    name: 'forbidden',
    component: () => import('@/pages/ForbiddenPage.vue'),
    meta: { bare: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/pages/NotFoundPage.vue'),
    meta: { bare: true },
  },
];

export function installGuards(router: Router): void {
  router.beforeEach(async (to) => {
    const session = useSessionStore();
    if (session.status === 'unknown') await session.load();

    const authenticated = session.status === 'authenticated';

    if (to.meta.anonymousOnly === true) {
      return authenticated ? { name: 'blueprints' } : true;
    }

    if (!authenticated) {
      return {
        name: 'login',
        query: to.fullPath === '/blueprints' ? undefined : { next: to.fullPath },
      };
    }

    if (to.meta.management === true && !session.canEnterManagement) {
      return { name: 'forbidden' };
    }

    return true;
  });
}

export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  const router = createRouter({ history, routes });
  installGuards(router);
  return router;
}

export default createAppRouter();
