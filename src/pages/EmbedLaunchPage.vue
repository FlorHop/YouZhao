<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ProgressSpinner from 'primevue/progressspinner';
import Button from 'primevue/button';
import { useAppState } from '../state';

const app = useAppState();
const route = useRoute();
const router = useRouter();
const errorMessage = ref('');

function safeRedirect(value: unknown) {
  const redirect = typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/blueprints';
  return redirect.includes('\\') ? '/blueprints' : redirect;
}

onMounted(async () => {
  const ticket = typeof route.query.ticket === 'string' ? route.query.ticket : '';
  if (!ticket) {
    errorMessage.value = '缺少嵌入登录凭证';
    return;
  }

  try {
    const result = await app.exchangeEmbedTicket(ticket);
    await router.replace(safeRedirect(route.query.redirect ?? result.redirect));
  } catch (error) {
    errorMessage.value = (error as Error).message || '嵌入登录失败';
  }
});
</script>

<template>
  <main class="embed-launch">
    <section class="embed-panel">
      <template v-if="!errorMessage">
        <ProgressSpinner aria-label="正在进入有招" />
        <h1>正在进入有招</h1>
      </template>
      <template v-else>
        <i class="pi pi-exclamation-triangle" />
        <h1>无法进入</h1>
        <p>{{ errorMessage }}</p>
        <Button label="返回登录" severity="secondary" outlined @click="router.replace('/login')" />
      </template>
    </section>
  </main>
</template>

<style scoped>
.embed-launch {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
  background: var(--app-bg);
}

.embed-panel {
  display: grid;
  width: min(360px, 100%);
  justify-items: center;
  gap: 14px;
  padding: 24px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  background: var(--app-panel);
  box-shadow: var(--app-shadow);
  text-align: center;
}

.embed-panel h1 {
  margin: 0;
  font-size: 18px;
}

.embed-panel p {
  margin: 0;
  color: var(--app-muted);
}

.embed-panel > i {
  color: var(--p-red-500);
  font-size: 26px;
}
</style>
