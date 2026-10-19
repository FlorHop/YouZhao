/**
 * 客户端配置片段的生成规则（docs/mcp-onboarding-design.md §3.4）。
 *
 * 这里固化三件容易回归的事：
 * 1. 片段里的地址只能来自服务端给的 `httpUrl`（前端不得自己拼，architecture §4.7.1）；
 * 2. 没有明文时必须显式留占位符并允许 `usesPlaceholder` 检出，不能悄悄生成一个「看起来能跑」的假 Token；
 * 3. 高级的 stdio 桥要按部署地址推导 `YOUZHAO_API_BASE`，不能再把本地 4174 写死回去。
 */
import { describe, expect, it } from 'vitest';

import type { McpConnectionInfo } from '@/services/endpoints';

import { buildClientSnippets, TOKEN_PLACEHOLDER, usesPlaceholder } from './client-snippets';

const INFO: McpConnectionInfo = {
  enabled: true,
  httpUrl: 'https://youzhao.florai.cn/mcp',
  path: '/mcp',
  transport: 'streamable-http',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  protocol: { negotiatedBy: 'client-initialize', modernEra: true, legacyEra: true },
  oauth: { enabled: false, note: '本服务只认识 Bearer Token，需要 OAuth 的客户端请用 mcp-remote 兜底。' },
  tools: { total: 8, read: 4, write: 4 },
  scopes: ['publish:blueprint', 'read:blueprint'],
  tokenPagePath: '/settings/tokens',
};

describe('buildClientSnippets', () => {
  it('按固定顺序给出七个客户端，只有 stdio 桥是高级项', () => {
    const snippets = buildClientSnippets(INFO);
    expect(snippets.map((snippet) => snippet.id)).toEqual([
      'codex',
      'claude-code',
      'claude-desktop',
      'cursor',
      'vscode',
      'curl',
      'stdio',
    ]);
    expect(snippets.filter((snippet) => snippet.advanced).map((snippet) => snippet.id)).toEqual(['stdio']);
  });

  it('没有明文时全部片段都用占位符，并能被 usesPlaceholder 检出', () => {
    const snippets = buildClientSnippets(INFO);
    for (const snippet of snippets) {
      expect(snippet.code).toContain(TOKEN_PLACEHOLDER);
      expect(usesPlaceholder(snippet)).toBe(true);
    }
  });

  it('拿到明文后嵌进片段，且不再标记为占位符', () => {
    const token = 'yz_mcp_tok_demo_0123456789abcdef0123456789abcdef';
    const snippets = buildClientSnippets(INFO, token);
    for (const snippet of snippets) {
      expect(snippet.code).toContain(token);
      expect(usesPlaceholder(snippet)).toBe(false);
    }
  });

  it('Codex 用官方命令 + 环境变量，地址取自服务端', () => {
    const codex = buildClientSnippets(INFO, 'yz_mcp_x_y').find((snippet) => snippet.id === 'codex');
    expect(codex?.code).toContain('codex mcp add youzhao --url https://youzhao.florai.cn/mcp');
    expect(codex?.code).toContain('--bearer-token-env-var YOUZHAO_MCP_TOKEN');
  });

  it('stdio 桥的 YOUZHAO_API_BASE 从接入地址推导，而不是写死本地端口', () => {
    const stdio = buildClientSnippets(INFO, 'yz_mcp_x_y').find((snippet) => snippet.id === 'stdio');
    expect(stdio?.code).toContain('YOUZHAO_API_BASE=https://youzhao.florai.cn');
    expect(stdio?.code).not.toContain('127.0.0.1');
  });
});
