<script setup lang="ts">
/**
 * 页面状态块（设计 §3）：一个组件承担空 / 加载 / 失败三态，
 * 失败态必须给出「重新加载」或明确的主操作，不用行内红字代替。
 *
 * 回调支持两种写法：`@retry="load"`（事件）或 `:on-retry="load"`（属性），
 * 两者表达的是同一件事——给用户一个出口。
 */
import Button from 'primevue/button';

withDefaults(
  defineProps<{
    state: 'loading' | 'empty' | 'error' | 'ready';
    /** 空态标题，例如「还没有蓝图」。 */
    title?: string;
    /** 失败或空态下的说明与处置建议。 */
    description?: string;
    /** 失败态的重试回调；传入即渲染「重新加载」。 */
    onRetry?: (() => void) | undefined;
    /** 空态主操作文案与回调；`actionLabel` 非空即渲染按钮。 */
    actionLabel?: string;
    onAction?: (() => void) | undefined;
  }>(),
  {
    title: '',
    description: '',
    actionLabel: '',
    onRetry: undefined,
    onAction: undefined,
  },
);

const emit = defineEmits<{ retry: []; action: [] }>();

/**
 * 注意：`onRetry` / `onAction` 这两个属性名就是 Vue 的 `retry` / `action`
 * 事件监听器（`:on-retry="load"` 与 `@retry="load"` 是同一件事），
 * 因此这里只 `emit`，不要再手工调用 props 里的回调——否则会调用两次。
 */
function retry(): void {
  emit('retry');
}

function action(): void {
  emit('action');
}
</script>

<template>
  <div v-if="state === 'loading'" class="state-block">
    <i class="pi pi-spin pi-spinner" aria-hidden="true" />
    <p class="state-text">正在加载…</p>
  </div>

  <div v-else-if="state === 'error'" class="state-block" role="alert">
    <i class="pi pi-exclamation-triangle" aria-hidden="true" />
    <p class="state-title">加载失败</p>
    <p v-if="description !== ''" class="state-text">{{ description }}</p>
    <Button v-if="onRetry !== undefined" label="重新加载" size="small" @click="retry" />
  </div>

  <div v-else-if="state === 'empty'" class="state-block">
    <i class="pi pi-inbox" aria-hidden="true" />
    <p v-if="title !== ''" class="state-title">{{ title }}</p>
    <p v-if="description !== ''" class="state-text">{{ description }}</p>
    <Button v-if="actionLabel !== ''" :label="actionLabel" size="small" @click="action" />
  </div>

  <slot v-else />
</template>
