#!/usr/bin/env node
/**
 * 有招 MCP stdio 桥（docs/architecture-design.md §4.3、§4.7）。
 *
 * 为什么需要它：桌面 MCP 客户端（Codex、Claude Desktop 等）只会说 **stdio**，而 MCP 协议实现
 * 在服务端进程内（`server/mcp/http.ts`，挂 `/mcp`）。这个桥只做两件事：
 *   1. 把 stdin 上的「换行分隔 JSON-RPC」逐条 POST 到 `<YOUZHAO_API_BASE><YOUZHAO_MCP_PATH>`；
 *   2. 把响应（可能是 `application/json`，也可能是 SSE 的 `data:` 帧）解回「换行分隔 JSON-RPC」写 stdout。
 *
 * 纪律：
 * - **不解释 MCP 语义**：工具、scope、审计、幂等一律在服务端（同一个实现），避免两套行为；
 * - **stdout 只写协议**：诊断信息一律 stderr（stdout 是协议通道，混进日志会让客户端解析失败）；
 * - **不落盘 Token**：令牌只从环境变量读，不写入日志、不回显。
 *
 * 环境变量：
 * - `YOUZHAO_API_BASE`（必填）例如 `https://youzhao.florai.cn`（本机开发用 `http://127.0.0.1:3000`）
 * - `YOUZHAO_MCP_TOKEN`（必填）MCP Token 明文，`yz_mcp_<tokenId>_<secret>`
 * - `YOUZHAO_MCP_PATH`（可选，默认 `/mcp`）
 * - `YOUZHAO_MCP_TIMEOUT_MS`（可选，默认 120000）
 */
import { stdin, stdout, stderr, env, exit } from 'node:process';

const DEFAULT_PATH = '/mcp';
const DEFAULT_TIMEOUT_MS = 120_000;
const MODERN_VERSION = '2026-07-28';

/** 按换行切分 stdin 缓冲，返回 [完整行, 残留]。`\r\n` 与 `\n` 都接受。 */
export function splitFrames(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    const index = rest.indexOf('\n');
    if (index === -1) break;
    const line = rest.slice(0, index).replace(/\r$/, '').trim();
    rest = rest.slice(index + 1);
    if (line !== '') frames.push(line);
  }
  return [frames, rest];
}

/** 从一条 HTTP 响应体里取出 JSON-RPC 报文：JSON 直出，SSE 取所有 `data:` 帧。 */
export function extractMessages(contentType, body) {
  if (/text\/event-stream/i.test(contentType)) {
    const messages = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload !== '') messages.push(payload);
    }
    return messages;
  }
  const trimmed = body.trim();
  return trimmed === '' ? [] : [trimmed];
}

/**
 * 请求头：把 JSON-RPC 报文里的方法与工具名映射成现代协议的 `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`。
 *
 * 现代 era（≥ `2026-07-28`）里服务端会校验「头与体内声明的协议版本一致」，缺头直接 -32020；
 * 而 initialize 也必须带该头。旧代（initialize 时代，如 `2025-11-25`）**不能**带现代头，
 * 否则会被判成版本不一致——所以这里按客户端声明的版本决定发不发。
 */
export function headersFor(message, { token, protocolVersion }) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };
  if (message === null || typeof message !== 'object') return headers;
  const declared =
    message.method === 'initialize' && typeof message.params?.protocolVersion === 'string'
      ? message.params.protocolVersion
      : protocolVersion;
  if (typeof declared !== 'string' || declared < MODERN_VERSION) return headers;

  headers['mcp-protocol-version'] = declared;
  if (typeof message.method === 'string') {
    headers['mcp-method'] = message.method;
    if (typeof message.params?.name === 'string') headers['mcp-name'] = message.params.name;
  }
  return headers;
}

async function main() {
  const apiBase = (env.YOUZHAO_API_BASE ?? '').replace(/\/+$/, '');
  const token = env.YOUZHAO_MCP_TOKEN ?? '';
  const path = env.YOUZHAO_MCP_PATH ?? DEFAULT_PATH;
  const timeoutMs = Number.parseInt(env.YOUZHAO_MCP_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;

  if (apiBase === '' || token === '') {
    stderr.write('✗ 缺少环境变量：YOUZHAO_API_BASE 与 YOUZHAO_MCP_TOKEN 都必须设置\n');
    exit(1);
  }
  const endpoint = `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  stderr.write(`有招 MCP stdio 桥已启动 → ${endpoint}\n`);

  let buffer = '';
  let protocolVersion = null;
  let inflight = Promise.resolve();

  async function forward(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    // 客户端协商的协议版本决定后续请求要不要带 mcp-protocol-version（现代 era 必带）
    if (message?.method === 'initialize' && typeof message.params?.protocolVersion === 'string') {
      protocolVersion = message.params.protocolVersion;
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: headersFor(message, { token, protocolVersion }),
        body: line,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) {
        stderr.write(`✗ 服务端返回 ${response.status}：${body.slice(0, 400)}\n`);
      }
      for (const item of extractMessages(response.headers.get('content-type') ?? '', body)) {
        stdout.write(`${item}\n`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      stderr.write(`✗ 转发失败：${reason}\n`);
      stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message?.id ?? null,
          error: { code: -32603, message: `有招 MCP 桥转发失败：${reason}` },
        })}\n`,
      );
    }
  }

  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buffer += chunk;
    const [frames, rest] = splitFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      // 保持先后顺序：串行转发，避免响应乱序（stdio 客户端按 id 匹配，但顺序更易诊断）
      inflight = inflight.then(() => forward(frame));
    }
  });
  stdin.on('end', () => {
    void inflight.then(() => exit(0));
  });
}

// 作为模块被 import 时（测试用纯函数）不启动；作为脚本运行时才连 stdin
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
