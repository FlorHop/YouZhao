import type { McpConnectionInfo } from '@/services/endpoints';

/**
 * MCP 客户端接入片段生成（docs/mcp-onboarding-design.md §3.4）。
 *
 * 约定：
 * - 地址一律用后端下发的 `GET /api/mcp/connection-info` 的 `httpUrl`，前端**不得自己拼**（架构 §4.7.1）。
 * - Token 明文只在创建响应里出现过一次；没拿到明文时用占位符，提示用户替换。
 * - 客户端字段名（Claude Code / Cursor / VS Code）以本机实测为准，改动前先验证。
 */
export const TOKEN_PLACEHOLDER = 'yz_mcp_…';

export type ClientSnippetId =
  | 'codex'
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'vscode'
  | 'curl'
  | 'stdio';

export interface ClientSnippet {
  readonly id: ClientSnippetId;
  readonly label: string;
  readonly language: 'bash' | 'json' | 'toml';
  /** 是否属于「高级 / 兜底」路径，UI 里默认折叠 */
  readonly advanced: boolean;
  readonly code: string;
  readonly note: string;
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

export function buildClientSnippets(
  info: McpConnectionInfo,
  token: string = TOKEN_PLACEHOLDER,
): ClientSnippet[] {
  const url = info.httpUrl;
  const auth = `${info.authHeader}: ${bearer(token)}`;
  const readHint = '（只读 Token 只能看到 4 个读工具；勾了发布能力才有 4 个写工具）';

  return [
    {
      id: 'codex',
      label: 'Codex CLI',
      language: 'bash',
      advanced: false,
      note: '已实测。用官方命令注册，Token 走环境变量，不必手改 TOML。',
      code: [
        `export YOUZHAO_MCP_TOKEN=${token}`,
        `codex mcp add youzhao --url ${url} --bearer-token-env-var YOUZHAO_MCP_TOKEN`,
      ].join('\n'),
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      language: 'bash',
      advanced: false,
      note: '字段名以本机 `claude mcp` 帮助为准；下面这条在 Claude Code 里注册远端 HTTP 服务。',
      code: `claude mcp add --transport http youzhao ${url} --header "${auth}"`,
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      language: 'json',
      advanced: false,
      note: 'Claude Desktop 目前只吃 stdio，用生态标准桥 mcp-remote 转发到远端地址。',
      code: JSON.stringify(
        {
          mcpServers: {
            youzhao: {
              command: 'npx',
              args: ['-y', 'mcp-remote', url, '--header', auth],
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      language: 'json',
      advanced: false,
      note: '写入 `.cursor/mcp.json`（项目级）或 Cursor 设置的 MCP 面板。',
      code: JSON.stringify(
        { mcpServers: { youzhao: { url, headers: { [info.authHeader]: bearer(token) } } } },
        null,
        2,
      ),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      language: 'json',
      advanced: false,
      note: '写入 `.vscode/mcp.json` 或用命令面板 `MCP: Add Server` 选 HTTP。',
      code: JSON.stringify(
        { mcpServers: { youzhao: { url, headers: { [info.authHeader]: bearer(token) } } } },
        null,
        2,
      ),
    },
    {
      id: 'curl',
      label: '通用 HTTP（排障）',
      language: 'bash',
      advanced: false,
      note: '用来确认地址/Token 是否可用；返回 JSON 即为通。',
      code: [
        `curl -sS -X POST ${url} \\`,
        `  -H '${auth}' \\`,
        `  -H 'Content-Type: application/json' \\`,
        "  -H 'Accept: application/json, text/event-stream' \\",
        `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'`,
      ].join('\n'),
    },
    {
      id: 'stdio',
      label: '自建 stdio 桥（离线/内网兜底）',
      language: 'bash',
      advanced: true,
      note: `只在客户端不支持远端 HTTP 时使用；YOUZHAO_API_BASE 必须是部署地址而不是本机地址。${readHint}`,
      code: `YOUZHAO_API_BASE=${info.httpUrl.replace(/\/[^/]*$/, '')} YOUZHAO_MCP_TOKEN=${token} node server/mcp-server.mjs`,
    },
  ];
}

/** 片段里是否还是占位符（用于提示「先造 Token 再复制」）。 */
export function usesPlaceholder(snippet: ClientSnippet): boolean {
  return snippet.code.includes(TOKEN_PLACEHOLDER);
}
