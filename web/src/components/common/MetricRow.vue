<script setup lang="ts">
/**
 * 指标条（设计 §3）：页头下方的关键数字，`label` 在上、数值在下。
 */
export interface Metric {
  label: string;
  value: string | number;
}

defineProps<{ metrics: readonly Metric[] }>();
</script>

<template>
  <div class="metric-row">
    <div v-for="metric in metrics" :key="metric.label" class="metric-cell">
      <div class="metric-label">{{ metric.label }}</div>
      <div class="metric-value">{{ metric.value }}</div>
    </div>
  </div>
</template>
