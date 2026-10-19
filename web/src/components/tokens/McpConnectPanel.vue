<script setup lang="ts">
/**
 * 「连接 Agent」面板（第 3 步，替换原 McpClientSnippet.vue）。
 *
 * 结构见 docs/mcp-onboarding-design.md §3.3；视觉语言沿用 web/src/styles/tokens.css
 * （OpenAI 设计体系绑定层：白底、单绿 #10a37f、12/16/24 的圆角与间距节奏）。
 *
 * 三条硬规则：
 * 1. 接入地址一律来自 `GET /api/mcp/connection-info`（架构 §4.7.1：前端不得自己拼接入地址）；
 * 2. Token 明文只在创建那一刻存在——页面把刚创建的明文通过 `tokenPlaintext` 递进来，
 *    面板把它嵌进片段并预填自检输入框；没有明文时用占位符提醒用户替换；
 * 3. 自检排在客户端片段之前：先确认这把 Token 可用，再去配客户端。
 */
import { computed, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Tab from 'primevue/tab';
import TabList from 'primevue/tablist';
import TabPanel from 'primevue/tabpanel';
import TabPanels from 'primevue/tabpanels';
import Tabs from 'primevue/tabs';
import { useToast } from 'primevue/usetoast';
import StateBlock from '@/components/common/StateBlock.vue';
import { ApiError } from '@/services/api';
import {
  fetchMcpConnectionInfo,
  verifyToken,
  type McpConnectionInfo,
  type TokenSelfCheck,
} from '@/services/endpoints';
import { buildClientSnippets, TOKEN_PLACEHOLDER, usesPlaceholder, type ClientSnippetId } from './client-snippets';

const props = withDefaults(
  defineProps<{
    /** 页面刚创建成功的 Token 明文（只在那一刻存在）。 */
    tokenPlaintext?: string | null;
    /** 能否创建 Token；false 时只展示接入信息与自检。 */
    canCreateToken?: boolean;
  }>(),
  { tokenPlaintext: null, canCreateToken: false },
);

const emit = defineEmits<{ createToken: [] }>();

const toast = useToast();

const info = ref<McpConnectionInfo | null>(null);
const infoState = ref<'loading' | 'ready' | 'error'>('loading');
const infoError = ref('');

const token = ref(props.tokenPlaintext ?? '');
const activeClient = ref<ClientSnippetId>('codex');

const checkState = ref<'idle' | 'running' | 'ok' | 'fail'>('idle');
const checkResult = ref<TokenSelfCheck | null>(null);
const checkMessage = ref('');

watch(
  () => props.tokenPlaintext,
  (value) => {
    if (value !== null && value !== '') token.value = value;
  },
);

const snippets = computed(() =>
  info.value === null
    ? []
    : buildClientSnippets(info.value, token.value === '' ? TOKEN_PLACEHOLDER : token.value),
);

const toolSummary = computed(() => {
  const tools = info.value?.tools;
  if (tools === undefined) return '';
  const { total, read, write } = tools;
  return `共 ${total} 个工具：${read} 个读工具、${write} 个写工具；只读 Token 只能看到读工具。`;
});

const bearerPreview = computed(() => (token.value === '' ? '<你的 Token>' : token.value));

/** 把后端错误码翻成用户能照着做的说明（不要直接抛裸错误消息）。 */
function describeCode(code: string, fallback: string): string {
  switch (code) {
    case 'MCP_DISABLED':
      return '服务端没有开启 MCP 接入（MCP_ENABLED=false）；请部署方打开后再试。';
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
      return '登录状态已失效，请重新登录后再打开本页。';
    default:
      return fallback;
  }
}

async function loadInfo(): Promise<void> {
  infoState.value = 'loading';
  infoError.value = '';
  try {
    info.value = await fetchMcpConnectionInfo();
    infoState.value = 'ready';
  } catch (caught) {
    infoError.value =
      caught instanceof ApiError
        ? describeCode(caught.code, caught.message)
        : '无法读取接入信息，请稍后重试。';
    infoState.value = 'error';
  }
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.add({ severity: 'success', summary: '已复制', detail: `${label}已复制到剪贴板。`, life: 3000 });
  } catch {
    toast.add({
      severity: 'error',
      summary: '复制失败',
      detail: '浏览器拒绝了剪贴板访问，请手动选中后复制。',
      life: 5000,
    });
  }
}

async function runCheck(): Promise<void> {
  const value = token.value.trim();
  if (value === '') {
    toast.add({
      severity: 'warn',
      summary: '先填入 Token',
      detail: '粘贴创建 Token 时复制的明文，或先创建一把 Token。',
      life: 4000,
    });
    return;
  }

  checkState.value = 'running';
  checkResult.value = null;
  checkMessage.value = '';
  try {
    checkResult.value = await verifyToken(value);
    checkState.value = 'ok';
  } catch (caught) {
    checkState.value = 'fail';
    checkMessage.value =
      caught instanceof ApiError
        ? caught.code === 'TOKEN_INVALID'
          ? 'Token 无效、已停用或已过期，请重新创建后再试。'
          : caught.code === 'FORBIDDEN'
            ? '这把 Token 不属于当前账号，无法代为检测；请用它所属的账号登录后自检。'
            : caught.code === 'MCP_DISABLED'
              ? '服务端没有开启 MCP 接入（MCP_ENABLED=false）。'
              : caught.code === 'SERVICE_UNAVAILABLE'
                ? '服务端自检暂时不可用（环回调用失败或超时），请稍后重试。'
                : caught.message
        : '自检请求失败，请稍后重试。';
  }
}

onMounted(loadInfo);
</script>

<template>
  <section class="section connect-panel">
    <!-- 页面级主色按钮全页只留一个（页头的「连接 Agent」）；
         这里不再放第二个「创建 Token」，避免与页头动作重复、也避免同页两个主色按钮。 -->
    <div class="section-head connect-head">
      <h2 class="section-title">连接 Agent</h2>
    </div>

    <p class="caption connect-lede">
      把下面的地址与 Token 填进客户端的 MCP 配置即可调用有招的工具。
      {{ toolSummary }}
    </p>

    <StateBlock v-if="infoState === 'loading'" state="loading" />
    <StateBlock
      v-else-if="infoState === 'error'"
      state="error"
      title="读不到接入信息"
      :description="infoError"
      @retry="loadInfo"
    />

    <template v-else-if="info !== null">
      <div class="connect-block">
        <div class="connect-row">
          <span class="label">接入地址</span>
          <code class="mono connect-value">{{ info.httpUrl }}</code>
          <Button label="复制" icon="pi pi-copy" size="small" text @click="copyText(info.httpUrl, '接入地址')" />
        </div>
        <div class="connect-row">
          <span class="label">认证</span>
          <code class="mono connect-value">{{ info.authHeader }}: {{ info.authScheme }} {{ bearerPreview }}</code>
          <Button
            label="复制"
            icon="pi pi-copy"
            size="small"
            text
            @click="copyText(`${info.authHeader}: ${info.authScheme} ${token}`, '认证头')"
          />
        </div>
        <div class="connect-row">
          <span class="hint">
            传输方式 {{ info.transport }}；OAuth {{ info.oauth.enabled ? '已启用' : '未启用' }}——{{ info.oauth.note }}
          </span>
          <Button label="重新同步" icon="pi pi-refresh" size="small" text @click="loadInfo" />
        </div>
      </div>

      <div class="connect-block">
        <h3 class="sub-title">连接自检</h3>
        <div class="connect-row">
          <InputText v-model="token" class="connect-input" placeholder="粘贴创建 Token 时复制的明文" />
          <Button
            label="检测连接"
            icon="pi pi-bolt"
            size="small"
            outlined
            :loading="checkState === 'running'"
            @click="runCheck"
          />
          <Button
            v-if="props.canCreateToken"
            label="创建新 Token"
            size="small"
            text
            @click="emit('createToken')"
          />
        </div>
        <p v-if="checkState === 'ok' && checkResult !== null" class="hint connect-ok">
          ✓ 连接正常 · 协议 {{ checkResult.protocolVersion }} · 可见 {{ checkResult.toolCount }} 个工具（{{
            checkResult.scopes.includes('publish:blueprint') ? '含发布' : '只读'
          }}） · {{ checkResult.latencyMs }} ms
        </p>
        <p v-else-if="checkState === 'fail'" class="hint text-danger">✗ {{ checkMessage }}</p>
        <p v-else class="hint">
          自检会用你手上的明文走一次 initialize + tools/list，不写业务审计，也不改动任何数据。
        </p>
      </div>

      <div class="connect-block">
        <h3 class="sub-title">客户端配置</h3>
        <Tabs v-model:value="activeClient">
          <TabList>
            <Tab v-for="snippet in snippets" :key="snippet.id" :value="snippet.id">{{ snippet.label }}</Tab>
          </TabList>
          <TabPanels>
            <TabPanel v-for="snippet in snippets" :key="snippet.id" :value="snippet.id">
              <p class="hint">{{ snippet.note }}</p>
              <div class="snippet-block">
                <pre class="mono snippet-code">{{ snippet.code }}</pre>
                <div class="snippet-actions">
                  <Button
                    label="复制配置"
                    icon="pi pi-copy"
                    size="small"
                    outlined
                    @click="copyText(snippet.code, '配置片段')"
                  />
                  <span v-if="usesPlaceholder(snippet)" class="hint">
                    片段里还是占位符，先创建一把 Token 再复制。
                  </span>
                </div>
              </div>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>
    </template>
  </section>
</template>

<style scoped>
.connect-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.connect-lede {
  max-width: 62rem;
}

.connect-block {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-6);
}

.connect-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.connect-value {
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}

.connect-input {
  min-width: 22rem;
}

.connect-ok {
  color: var(--fg);
}

.snippet-block {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  margin-top: var(--space-3);
}

.snippet-code {
  width: 100%;
  max-height: 22rem;
  margin: 0;
  padding: var(--space-4);
  overflow: auto;
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.snippet-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
</style>
