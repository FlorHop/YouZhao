import { createRouter, createWebHistory } from 'vue-router';
import DemoPage from './pages/DemoPage.vue';
import SettingsPage from './pages/SettingsPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/demo' },
    { path: '/demo', component: DemoPage },
    { path: '/settings', component: SettingsPage }
  ]
});
