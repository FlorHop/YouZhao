<script setup lang="ts">
import Button from 'primevue/button';
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="state-block" style="min-height: 100vh">
    <i class="pi pi-compass" aria-hidden="true" />
    <p class="state-title">页面不存在</p>
    <p class="state-text">地址可能已失效，或者该蓝图已经被归档。</p>
    <Button label="返回蓝图" size="small" @click="router.push({ name: 'blueprints' })" />
  </div>
</template>
