import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import { createApp } from 'vue';

import 'primeicons/primeicons.css';
import '@/styles/tokens.css';
import '@/styles/base.css';

import App from '@/App.vue';
import { zhCnLocale } from '@/app/locale';
import { YouzhaoPreset } from '@/app/primevue';
import router from '@/app/router';

const app = createApp(App);

app.use(createPinia());
app.use(PrimeVue, {
  ripple: false,
  locale: zhCnLocale,
  theme: {
    preset: YouzhaoPreset,
    options: {
      // 本期仅浅色：该设计体系没有深色 token（设计 §11）
      darkModeSelector: false,
      cssLayer: { name: 'primevue', order: 'theme, base, primevue' },
    },
  },
});
app.use(ToastService);
app.use(ConfirmationService);
app.use(router);

app.mount('#app');
