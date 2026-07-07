import { createRouter, createWebHistory } from 'vue-router';
import BlueprintPreviewPage from './pages/BlueprintPreviewPage.vue';
import DemoPage from './pages/DemoPage.vue';
import EmbedLaunchPage from './pages/EmbedLaunchPage.vue';
import ForbiddenPage from './pages/ForbiddenPage.vue';
import LoginPage from './pages/LoginPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import { useAppState } from './state';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/blueprints' },
    { path: '/login', component: LoginPage, meta: { public: true } },
    { path: '/embed/launch', component: EmbedLaunchPage, meta: { public: true, embed: true } },
    { path: '/demo', redirect: '/blueprints' },
    { path: '/blueprints', component: DemoPage, meta: { module: 'demo-preview', level: 'view' } },
    { path: '/blueprints/:id/preview', component: BlueprintPreviewPage, meta: { module: 'demo-preview', level: 'view' } },
    { path: '/settings', component: SettingsPage, meta: { module: 'system-settings', level: 'manage' } },
    { path: '/403', component: ForbiddenPage },
    { path: '/:pathMatch(.*)*', redirect: '/blueprints' }
  ]
});

router.beforeEach(async (to) => {
  const app = useAppState();

  await app.refreshSetupStatus();
  await app.bootstrapSession();

  if (app.setupRequired.value) {
    if (to.path !== '/login') return { path: '/login', query: { setup: '1' } };
    return true;
  }

  if (to.meta.public) {
    if (to.meta.embed) return true;
    if (app.isAuthenticated.value) {
      return app.hasFunctionPermission('demo-preview', 'view') ? '/blueprints' : '/settings';
    }
    return true;
  }

  if (!app.isAuthenticated.value) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }

  const module = to.meta.module;
  const level = to.meta.level;
  if (typeof module === 'string' && (level === 'view' || level === 'manage')) {
    if (!app.hasFunctionPermission(module as 'demo-preview' | 'system-settings', level)) {
      if (to.path !== '/403') return '/403';
    }
  }

  return true;
});
