<script setup lang="ts">
/**
 * 分组区段（frontend-design §P2「两级结构」）。
 *
 * 同一分组的卡片必须收拢在本区段内，不允许打散平铺；空分组保留区头并显示
 * 「暂无蓝图」占位——空分组是移动蓝图时的合法目标，因此不能因为它空就消失。
 * 卡片本身由页面通过默认插槽传入，这样卡片的操作事件不必层层转发。
 */
import Button from 'primevue/button';
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    group: { id: string; name: string; isDefault: boolean; blueprintCount: number };
    /** 本区段内实际渲染出来的卡片数。 */
    renderedCount?: number;
    /** 无搜索、无分组筛选时才允许分组排序（设计 §P2）。 */
    reorderable?: boolean;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    /** 可归档这个分组（默认分组不可归档）。 */
    canArchive?: boolean;
    archived?: boolean;
    canRestore?: boolean;
  }>(),
  {
    renderedCount: 0,
    reorderable: false,
    canMoveUp: false,
    canMoveDown: false,
    canArchive: false,
    archived: false,
    canRestore: false,
  },
);

const emit = defineEmits<{
  moveUp: [];
  moveDown: [];
  archive: [];
  restore: [];
}>();

/** 数量取服务端返回的可见蓝图数（与卡片同一次查询），不用本地渲染数，避免页头/区头口径不一致。 */
const countText = computed(() => `${props.group.blueprintCount} 项`);
</script>

<template>
  <section class="section">
    <div class="section-head group-head">
      <div class="inline group-head-main">
        <h2 class="section-title">{{ group.name }}</h2>
        <span v-if="group.isDefault" class="chip">默认</span>
        <span v-if="archived" class="chip is-muted">已归档</span>
        <span class="caption">{{ countText }}</span>
      </div>

      <div class="inline group-head-actions">
        <template v-if="!archived">
          <Button
            v-if="reorderable"
            icon="pi pi-arrow-up"
            size="small"
            text
            severity="secondary"
            :disabled="!canMoveUp"
            aria-label="上移分组"
            @click="emit('moveUp')"
          />
          <Button
            v-if="reorderable"
            icon="pi pi-arrow-down"
            size="small"
            text
            severity="secondary"
            :disabled="!canMoveDown"
            aria-label="下移分组"
            @click="emit('moveDown')"
          />
          <Button
            v-if="canArchive"
            label="归档分组"
            size="small"
            text
            severity="danger"
            @click="emit('archive')"
          />
        </template>
        <Button
          v-else-if="canRestore"
          label="恢复分组"
          size="small"
          text
          icon="pi pi-refresh"
          @click="emit('restore')"
        />
      </div>
    </div>

    <slot v-if="renderedCount > 0" />
    <p v-else class="empty-state group-empty">暂无蓝图</p>
  </section>
</template>

<style scoped>
.group-head {
  align-items: center;
}

.group-head-main {
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.group-head-actions {
  align-items: center;
}

.group-empty {
  margin: 0;
}
</style>
