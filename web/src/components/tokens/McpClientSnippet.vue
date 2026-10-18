<script setup lang="ts">
/**
 * P6 的 MCP 客户端接入片段（docs/frontend-design.md §6 P6「给一个可复制的客户端接入片段」）。
 *
 * 文案与 `skills/youzhao-mcp/SKILL.md` 保持一致：`command: node` + `args` 指向仓库里的
 * `server/mcp-server.mjs`（stdio 桥，换行分隔 JSON-RPC ↔ `POST /mcp`，见 architecture-design.md §4.3.1），
 * 环境变量 `YOUZHAO_API_BASE` / `YOUZHAO_MCP_TOKEN`（可选 `YOUZHAO_MCP_PATH` 默认 `/mcp`、
 * `YOUZHAO_MCP_TIMEOUT_MS` 默认 `120000`，一般不用写）。
 *
 * 这里刻意不写任何工具数量：architecture-design.md §4.5 的工具表是 4 读 + 4 写，
 * 而 SKILL.md 正文写「5 个读工具 / 3 个写工具」——规格自相矛盾，页面不复制任何一方的数字。
 */
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';

const toast = useToast();

/** 与 SKILL.md 的接入 JSON 逐字一致（仅把 token 占位符写得更醒目）。 */
const SNIPPET = `{
  "mcpServers": {
    "youzhao": {
      "command": "node",
      "args": ["/absolute/path/to/youzhao/server/mcp-server.mjs"],
      "env": {
        "YOUZHAO_API_BASE": "http://127.0.0.1:4174",
        "YOUZHAO_MCP_TOKEN": "<创建 Token 时复制的明文>"
      }
    }
  }
}`;

/** Windows 上同一个 args 的 JSON 写法：每个反斜杠都要转义成两个。 */
const WINDOWS_ARGS = String.raw`"args": ["C:\\path\\to\\youzhao\\server\\mcp-server.mjs"]`;

async function copySnippet(): Promise<void> {
  try {
    await navigator.clipboard.writeText(SNIPPET);
    toast.add({
      severity: 'success',
      summary: '已复制',
      detail: '接入片段已复制；粘贴后记得替换绝对路径、服务端地址与 Token 明文。',
      life: 3000,
    });
  } catch {
    toast.add({
      severity: 'error',
      summary: '复制失败',
      detail: '浏览器拒绝了剪贴板访问，请手动选中片段后复制。',
      life: 5000,
    });
  }
}
</script>

<template>
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">MCP 客户端接入</h2>
    </div>

    <p class="caption snippet-lede">
      把下面这段配置写进客户端的 MCP 配置里，重启客户端后用 <span class="mono">tools/list</span> 或
      <span class="mono">scripts/youzhao_mcp_smoke_test.mjs</span> 验证。只读 scope 的 Token
      在客户端里看不到写工具，因为服务端按 scope 裁剪了工具列表。
    </p>

    <div class="snippet-block">
      <pre class="mono snippet-code">{{ SNIPPET }}</pre>
      <div class="snippet-actions">
        <Button label="复制配置" icon="pi pi-copy" size="small" outlined @click="copySnippet" />
      </div>
    </div>

    <ul class="snippet-list">
      <li>
        <span class="mono">args</span> 要填<strong>绝对路径</strong>：在仓库根目录执行
        <span class="mono">realpath server/mcp-server.mjs</span>（Windows PowerShell 可用
        <span class="mono">(Resolve-Path .\server\mcp-server.mjs).Path</span>）取路径。
      </li>
      <li>
        macOS / Linux：路径以 <span class="mono">/</span> 开头，JSON 里照原样写，例如
        <span class="mono">"/Users/you/youzhao/server/mcp-server.mjs"</span>。
      </li>
      <li>
        Windows：磁盘路径形如 <span class="mono">C:\path\to\youzhao\server\mcp-server.mjs</span>，
        在 JSON 里每个反斜杠必须写成两个，即
        <span class="mono">{{ WINDOWS_ARGS }}</span>。
      </li>
      <li>
        <span class="mono">YOUZHAO_API_BASE</span> 换成你的服务端地址（本地默认
        <span class="mono">http://127.0.0.1:4174</span>）；<span class="mono">YOUZHAO_MCP_TOKEN</span>
        填创建 Token 时复制的明文——它只在创建成功那一刻出现过一次，Token 被停用或删除后，
        客户端会收到 401，需要重新创建并更新配置。
      </li>
      <li>
        可选：<span class="mono">YOUZHAO_MCP_PATH</span>（默认 <span class="mono">/mcp</span>）、
        <span class="mono">YOUZHAO_MCP_TIMEOUT_MS</span>（默认 <span class="mono">120000</span>）。
      </li>
    </ul>
  </section>
</template>

<style scoped>
.snippet-lede {
  max-width: 62rem;
}

.snippet-block {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
}

.snippet-code {
  width: 100%;
  margin: 0;
  padding: var(--space-4);
  overflow-x: auto;
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.snippet-list {
  display: grid;
  gap: var(--space-3);
  max-width: 62rem;
  padding-left: var(--space-5);
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--muted);
}
</style>
