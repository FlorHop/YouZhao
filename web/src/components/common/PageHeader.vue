<script setup lang="ts">
/**
 * 页头（设计 §3 受控扩展）：标题 + 一行说明 + 右侧主操作。
 * 说明文案承担「能做什么 / 不能做什么」的边界说明（§9 文案规范）。
 */
defineProps<{
  title: string;
  lede?: string;
}>();
</script>

<template>
  <header class="page-header">
    <div class="page-header-row">
      <div>
        <h1 class="page-title">{{ title }}</h1>
        <p v-if="lede !== undefined && lede !== ''" class="lede">{{ lede }}</p>
      </div>
      <div class="toolbar" style="margin-bottom: 0">
        <slot name="actions" />
      </div>
    </div>
  </header>
</template>
