<script setup lang="ts">
/**
 * 增量授权的底部吸附变更条（设计 `docs/frontend-design.md` §3「变更条」/ §6 区段一）。
 * 显示待应用变更数量与 + 新增 / − 撤销 明细；没有变更时主按钮禁用。
 */
import Button from 'primevue/button';

defineProps<{
  additions: string[];
  removals: string[];
  applying: boolean;
  blocked: boolean;
}>();

const emit = defineEmits<{ apply: []; discard: [] }>();
</script>

<template>
  <div class="change-bar">
    <div class="change-summary">
      <strong>待应用变更 {{ additions.length + removals.length }} 项</strong>
      <span v-if="additions.length > 0" class="meta">+ 新增：{{ additions.join('、') }}</span>
      <span v-if="removals.length > 0" class="meta">− 撤销：{{ removals.join('、') }}</span>
      <span v-if="additions.length + removals.length === 0" class="meta">
        勾选或取消「我可以调整的」中的条目后，在这里一次性提交。
      </span>
    </div>
    <div class="inline">
      <Button
        label="放弃修改"
        text
        severity="secondary"
        :disabled="additions.length + removals.length === 0"
        @click="emit('discard')"
      />
      <Button
        label="应用变更"
        icon="pi pi-save"
        :loading="applying"
        :disabled="additions.length + removals.length === 0 || blocked"
        @click="emit('apply')"
      />
    </div>
  </div>
</template>

<style scoped>
.change-summary {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
</style>
