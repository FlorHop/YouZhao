/**
 * MCP Token 自检探针（docs/mcp-onboarding-design.md §3.2）。
 *
 * 作用：拿一个**明文** Token，对本进程的 `/mcp` 走一次真实环回请求，回答三件事——
 * 这个 Token 现在能不能用、协议协商出什么版本、客户端实际会看到哪些工具。
 *
 * 为什么走环回而不是内部直调：
 * - 鉴权链路（Bearer 解析 → token_hash 比对 → scope 闸门 → 上下文构建 → 协议层）只有走真实
 *   HTTP 才被完整覆盖；内部直调会绕开协议层，验证不到「客户端实际会遇到的失败」。
 * - `/mcp` 由 `toNodeHandler` + `reply.hijack()` 处理，`fastify.inject()` 不兼容。
 *
 * 为什么两个调用都走 legacy（握手）时代：
 * - 现代时代（2026-07-28）根本没有 `initialize`（实测返回 -32601 Method not found）。
 * - `tools/list` 在两个时代都可用，且 legacy 的响应是 SSE —— 一个解析器就够，也正好覆盖
 *   Claude Desktop / mcp-remote / Codex 这类客户端真实走的路径。
 * - 不调用 `tools/call`：自检不应该写业务审计，也不应该产生任何业务副作用。
 */

import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config.js';
import type { TokenScope } from '../domain/entities.js';
import { AppError } from '../domain/errors.js';
import { MCP_TOOL_SCOPES } from './tools.js';

/** 自检的超时时间：客户端连不上时不要挂住管理页面。 */
const PROBE_TIMEOUT_MS = 3_000;

/** 自检用的协议版本：握手（legacy）时代的稳定版本。 */
const PROBE_PROTOCOL_VERSION = '2025-06-18';

export interface McpProbeTool {
  readonly name: string;
  readonly title: string | null;
  readonly scope: TokenScope;
}

export interface McpProbeOutcome {
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly protocolVersion: string;
  readonly tools: readonly McpProbeTool[];
  readonly latencyMs: number;
}

/** 用例层只依赖这个函数签名，不依赖 HTTP/Fastify：便于单测注入替身。 */
export type McpTokenProbe = (token: string) => Promise<McpProbeOutcome>;

interface JsonRpcAnswer {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取本进程实际监听地址；没在监听（单测直接 inject）时返回 null。 */
export function mcpLoopbackBase(server: FastifyInstance): string | null {
  const address = server.server.address();
  if (address === null || typeof address === 'string') return null;
  const info = address satisfies AddressInfo;
  const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
  return `http://${host}:${info.port}`;
}

/**
 * 从响应里取出 JSON-RPC 结果：兼容 `text/event-stream`（逐块扫描 `data:` 行）与
 * `application/json`。SSE 里可能夹通知，因此扫完所有块、取第一个带 result/error 的。
 */
function parseAnswer(text: string, contentType: string): JsonRpcAnswer {
  if (contentType.includes('application/json')) {
    return JSON.parse(text) as JsonRpcAnswer;
  }
  for (const block of text.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find((candidate) => candidate.startsWith('data:'));
    if (line === undefined) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload.length === 0 || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcAnswer;
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
    } catch {
      // 单块解析失败不致命：继续看下一块
    }
  }
  throw new AppError('SERVICE_UNAVAILABLE', 'MCP 自检失败：无法解析服务端响应');
}

async function rpc(
  options: { readonly url: string; readonly token: string },
  body: unknown,
): Promise<JsonRpcAnswer> {
  let response: Response;
  try {
    response = await fetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      `MCP 自检失败：无法连接本机 MCP 端点（${messageOf(error)}）`,
    );
  }
  const text = await response.text();
  if (response.status === 401) throw new AppError('TOKEN_INVALID');
  if (response.status === 403) throw new AppError('SCOPE_DENIED');
  if (!response.ok) {
    throw new AppError('SERVICE_UNAVAILABLE', `MCP 自检失败：服务端返回 ${response.status}`);
  }
  return parseAnswer(text, response.headers.get('content-type') ?? '');
}

function scopeOfTool(name: string): TokenScope {
  const scope = MCP_TOOL_SCOPES[name as keyof typeof MCP_TOOL_SCOPES];
  if (scope === undefined) {
    // 工具注册表与 scope 表必须同步：不同步说明 scope 闸门判断不了这个工具，自检要吵出来。
    throw new AppError('SERVICE_UNAVAILABLE', `MCP 自检失败：工具 ${name} 未登记 scope`);
  }
  return scope;
}

/** 造一个绑定到「本进程 /mcp」的探针；地址不可用时调用即 503。 */
export function createMcpTokenProbe(options: {
  readonly server: FastifyInstance;
  readonly config: AppConfig;
}): McpTokenProbe {
  return async (token: string): Promise<McpProbeOutcome> => {
    if (!options.config.mcp.enabled) throw new AppError('MCP_DISABLED');
    const base = mcpLoopbackBase(options.server);
    if (base === null) {
      throw new AppError('SERVICE_UNAVAILABLE', 'MCP 自检失败：本进程未监听 HTTP 端口');
    }
    const url = `${base}${options.config.mcp.path}`;
    const startedAt = Date.now();

    const initialized = await rpc({ url, token }, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROBE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'youzhao-self-check', version: '1.0.0' },
      },
    });
    if (initialized.error !== undefined) {
      throw new AppError('SERVICE_UNAVAILABLE', `MCP 自检失败：${initialized.error.message}`);
    }
    const handshake = initialized.result as
      | { readonly protocolVersion?: unknown; readonly serverInfo?: { readonly name?: unknown; readonly version?: unknown } }
      | undefined;
    const serverName = handshake?.serverInfo?.name;
    const serverVersion = handshake?.serverInfo?.version;
    if (typeof handshake?.protocolVersion !== 'string' || typeof serverName !== 'string' || typeof serverVersion !== 'string') {
      throw new AppError('SERVICE_UNAVAILABLE', 'MCP 自检失败：initialize 响应缺少 serverInfo');
    }

    const listed = await rpc({ url, token }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    if (listed.error !== undefined) {
      throw new AppError('SERVICE_UNAVAILABLE', `MCP 自检失败：${listed.error.message}`);
    }
    const rawTools = (listed.result as { readonly tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(rawTools)) {
      throw new AppError('SERVICE_UNAVAILABLE', 'MCP 自检失败：tools/list 响应缺少 tools');
    }
    const tools: McpProbeTool[] = rawTools.map((entry) => {
      const tool = entry as { readonly name?: unknown; readonly title?: unknown };
      if (typeof tool.name !== 'string') {
        throw new AppError('SERVICE_UNAVAILABLE', 'MCP 自检失败：工具缺少 name');
      }
      return {
        name: tool.name,
        title: typeof tool.title === 'string' ? tool.title : null,
        scope: scopeOfTool(tool.name),
      };
    });

    return {
      serverInfo: { name: serverName, version: serverVersion },
      protocolVersion: handshake.protocolVersion,
      tools,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  };
}
