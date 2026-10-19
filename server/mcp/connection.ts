/**
 * MCP 接入信息（`GET /api/mcp/connection-info`，docs/mcp-onboarding-design.md §3.1）。
 *
 * 为什么要有这个模块：客户端接入片段里「该填哪个地址」只有服务端知道
 * （`API_PUBLIC_BASE_URL` 的 origin + `MCP_PATH`）。此前前端把 `127.0.0.1:4174`
 * 写死在片段里，云端用户照抄必然连不上——所以让片段从服务端事实生成，而不是硬编码。
 */
import type { McpConnectionInfoResponse } from '@youzhao/contracts/types';
import type { AppConfig } from '../config.js';
import { MCP_TOOL_NAMES, MCP_TOOL_SCOPES } from './tools.js';

/** 契约里 `data` 的形状（单一事实来源：packages/contracts/schemas/mcp/connection-info.json）。 */
export type McpConnectionData = McpConnectionInfoResponse['data'];

/** 把 MCP_PATH 规范成带前导斜杠的路径。 */
export function normalizeMcpPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * 由配置推导接入事实。不含任何密钥——Token 明文只在创建响应里出现一次。
 *
 * `tools` 的读写口径直接数工具表，避免再出现「前端组件说 4+4、技能文档说 5+3、
 * 实际 8 个」这类三处不一致（§3.5 P6）。
 */
export function buildMcpConnectionInfo(config: AppConfig): McpConnectionData {
  const path = normalizeMcpPath(config.mcp.path);
  const scopes = [...new Set(MCP_TOOL_NAMES.map((name) => MCP_TOOL_SCOPES[name]))].sort();
  const write = MCP_TOOL_NAMES.filter(
    (name) => MCP_TOOL_SCOPES[name] === 'publish:blueprint',
  ).length;

  return {
    enabled: config.mcp.enabled,
    httpUrl: new URL(path, config.publicBaseUrl).toString(),
    path,
    transport: 'streamable-http',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    protocol: {
      // 协议版本由客户端 initialize 协商，接入方不需要手填；两个时代都支持（见 server/mcp/http.ts）
      negotiatedBy: 'client-initialize',
      modernEra: true,
      legacyEra: true,
    },
    oauth: {
      enabled: false,
      note: '本服务只校验 Bearer Token，不提供 OAuth 发现端点；只支持 OAuth 的客户端可用 npx mcp-remote 兜底。',
    },
    tools: { total: MCP_TOOL_NAMES.length, read: MCP_TOOL_NAMES.length - write, write },
    scopes,
    tokenPagePath: '/settings/tokens',
  };
}
