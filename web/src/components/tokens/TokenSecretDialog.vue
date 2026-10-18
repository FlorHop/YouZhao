<script setup lang="ts">
/**
 * P6 一次性明文展示面板（docs/frontend-design.md §6 P6；docs/permission-design.md §5.4 数据模型）。
 *
 * 契约与裁决依据：
 * - `POST /api/mcp-tokens` 只在创建成功那一次返回 `token` 明文，之后任何接口都不返回（§6.3），
 *   服务端只存哈希（§5.4 `tokenHash`，另有 `tokenPreview` 供列表展示）。
 * - §5.7「一次性信息（Token 明文、初始密码）只展示一次并给复制，关闭后不可再取回」。
 * - 明文只存在于组件内存里：不写 URL、不写 localStorage、不回填到任何输入框；父级在关闭事件里
 *   立即把载荷置空（§5.6「明细只展示一次，离开页面即丢弃」）。
 * - 关闭路径不止「我已保存」：Esc / 右上角关闭同样算作放弃明文（§10 要求对话框可用 Esc 关闭），
 *   这里用醒目警示把后果讲清楚，而不是把关闭键藏起来。
 */
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { useToast } from 'primevue/usetoast';
import { computed } from 'vue';

import type { TokenRow, TokenScope } from '@/services/endpoints';
import { formatDateTime } from '@/services/format';

const props = defineProps<{
  visible: boolean;
  /** 一次性明文载荷；父级在关闭时立即置 null。 */
  token: (TokenRow & { token: string }) | null;
}>();

const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const toast = useToast();

const SCOPE_LABELS: Record<TokenScope, string> = {
  'read:blueprint': '只读',
  'publish:blueprint': '发布',
};

const scopesText = computed<string>(() => {
  const token = props.token;
  if (token === null) return '—';
  return token.scopes.map((scope) => SCOPE_LABELS[scope]).join(' · ');
});

const expiresText = computed<string>(() => {
  const token = props.token;
  if (token === null) return '—';
  return token.expiresAt === null ? '永不过期' : formatDateTime(token.expiresAt);
});

async function copyToken(): Promise<void> {
  const token = props.token;
  if (token === null) return;
  try {
    await navigator.clipboard.writeText(token.token);
    toast.add({
      severity: 'success',
      summary: '已复制',
      detail: '明文已复制到剪贴板，请立刻粘贴进 MCP 客户端配置。',
      life: 3000,
    });
  } catch {
    toast.add({
      severity: 'error',
      summary: '复制失败',
      detail: '浏览器拒绝了剪贴板访问，请手动选中上面的明文后复制。',
      life: 5000,
    });
  }
}

function close(): void {
  emit('update:visible', false);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :draggable="false"
    header="Token 已创建"
    :style="{ width: '38rem' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div v-if="token !== null" class="secret-body">
      <p class="secret-warn" role="alert">
        明文只在这一次展示。关闭本窗口后，任何接口都不会再返回它，你也无法再次查看——请先复制并保存。
      </p>

      <code class="mono secret-value">{{ token.token }}</code>

      <div class="secret-meta">
        <span class="label">名称</span><span>{{ token.name }}</span>
        <span class="label">标识</span><span class="mono">{{ token.tokenPrefix }}</span>
        <span class="label">绑定用户</span><span>{{ token.boundUserDisplayName }}</span>
        <span class="label">能力</span><span>{{ scopesText }}</span>
        <span class="label">有效期</span><span>{{ expiresText }}</span>
      </div>

      <div class="secret-actions">
        <Button label="复制 Token" icon="pi pi-copy" size="small" @click="copyToken" />
      </div>

      <p class="hint">
        口令泄露的处理：回到 Token 列表把这把 Token <strong>停用</strong>或<strong>删除</strong>，再用新建的
        Token 更新客户端配置。停用立即生效（不必等它过期）且可以再启用；删除不可恢复。
      </p>
      <p class="hint">
        客户端接入：把这段明文填进 MCP 客户端配置的 <span class="mono">YOUZHAO_MCP_TOKEN</span>；
        完整配置片段见 Token 列表页的「MCP 客户端接入」。
      </p>
    </div>

    <template #footer>
      <Button label="我已保存" @click="close" />
    </template>
  </Dialog>
</template>

<style scoped>
.secret-body {
  display: grid;
  gap: var(--space-4);
}

.secret-warn {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  color: var(--fg-2);
  background: var(--surface-warm);
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
}

.secret-value {
  display: block;
  padding: var(--space-3) var(--space-4);
  overflow-wrap: anywhere;
  font-size: var(--text-sm);
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.secret-meta {
  display: grid;
  grid-template-columns: 5rem 1fr;
  gap: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
}

.secret-actions {
  display: flex;
  gap: var(--space-3);
}

.hint {
  margin: 0;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--muted);
}
</style>
