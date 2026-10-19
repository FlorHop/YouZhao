<script setup lang="ts">
/**
 * 页面状态块（设计 §3）：一个组件承担空 / 加载 / 失败三态，
 * 失败态必须给出「重新加载」或明确的主操作，不用行内红字代替。
 *
 * 回调必须写成 `@retry="load"` / `@action="fn"`。
 * 别写 `:on-retry="load"`：Vue 会把它编译成字面量键 `on-retry` 的 vnode prop，
 * 属性解析能取到 `onRetry`，但 `emit()` 查的是 `vnode.props.onRetry`（驼峰）——
 * 查不到，事件静默丢失，按钮变成死键（见本文件下方注释）。
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
 * 这里只 `emit`，不再手工调用 props 里的回调，避免重复调用。
 * 但注意 `:on-retry="load"` **不是** `@retry="load"` 的等价写法：
 *   - `@retry="load"` 编译成 `vnode.props.onRetry`，`emit('retry')` 能找到；
 *   - `:on-retry="load"` 编译成 `vnode.props['on-retry']`，`emit()` 找不到，
 *     回调永远不触发（属性解析那一步会被驼峰化，所以看起来「有值」）。
 * 需要手写 camelCase 绑定时要用 `:onRetry="load"` 或直接 `@retry`。
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
