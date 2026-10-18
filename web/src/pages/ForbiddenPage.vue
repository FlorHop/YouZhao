<script setup lang="ts">
/**
 * 403（设计 §11）：无权进入管理页时的页面。
 * 不说「你没有权限」就结束——要说明这是身份边界，并给出返回路径。
 */
import Button from 'primevue/button';
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="state-block" style="min-height: 100vh">
    <i class="pi pi-lock" aria-hidden="true" />
    <p class="state-title">无权访问</p>
    <p class="state-text">
      用户与权限管理只对平台所有者和管理员开放。你的账号可以查看被授权的蓝图，并使用自己的 MCP Token。
    </p>
    <Button label="返回蓝图" size="small" @click="router.push({ name: 'blueprints' })" />
  </div>
</template>
