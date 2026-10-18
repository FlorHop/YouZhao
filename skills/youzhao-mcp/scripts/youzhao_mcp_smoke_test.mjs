#!/usr/bin/env node
/**
 * 有招 MCP stdio 冒烟测试（skills/youzhao-mcp/scripts/youzhao_mcp_smoke_test.mjs）。
 *
 * 用法：
 *   YOUZHAO_API_BASE=http://127.0.0.1:4174 \
 *   YOUZHAO_MCP_TOKEN=yz_mcp_xxx_yyy \
 *   node skills/youzhao-mcp/scripts/youzhao_mcp_smoke_test.mjs path/to/server/mcp-server.mjs
 *
 * 做三件事：走旧代 `initialize`（拿到 serverInfo）、`tools/list`（确认工具数量与 scope 裁剪）、
 * `youzhao.list_blueprints`（确认 Token 真的能读到数据）。任何一步失败都会打印原因并以非 0 退出。
 *
 * 注意：桥用**换行分隔 JSON-RPC**（不是 `Content-Length:` 分帧）；stdout 只承载协议。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const serverPath = process.argv[2];
if (!serverPath) {
  console.error('用法: youzhao_mcp_smoke_test.mjs <path-to-server/mcp-server.mjs>');
  process.exit(1);
}
if (!process.env.YOUZHAO_API_BASE || !process.env.YOUZHAO_MCP_TOKEN) {
  console.error('缺少环境变量：YOUZHAO_API_BASE 与 YOUZHAO_MCP_TOKEN 都必须设置');
  process.exit(1);
}

const child = spawn(process.execPath, [path.resolve(serverPath)], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;
let failed = false;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error(`✗ 无法解析的响应行：${line.slice(0, 200)}`);
      failed = true;
      continue;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`等待 ${method} 响应超时`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function resultOf(message) {
  if (message?.error) throw new Error(`服务端返回错误：${JSON.stringify(message.error)}`);
  return message?.result;
}

try {
  const initialized = resultOf(await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'youzhao-smoke', version: '1' } }));
  console.log(`✔ initialize: ${initialized.serverInfo?.name} ${initialized.serverInfo?.version}`);

  const listed = resultOf(await call('tools/list', {}));
  const names = (listed.tools ?? []).map((tool) => tool.name);
  console.log(`✔ tools/list: ${names.length} 个 → ${names.join(', ')}`);

  const blueprints = resultOf(await call('tools/call', { name: 'youzhao.list_blueprints', arguments: { pageSize: 5 } }));
  const rawText = blueprints.content?.[0]?.text ?? '';
  let structured = blueprints.structuredContent;
  if (structured === undefined) {
    try {
      structured = JSON.parse(rawText);
    } catch {
      throw new Error(`list_blueprints 返回了非 JSON 文本（协议层或输出校验失败）：${rawText.slice(0, 500)}`);
    }
  }
  if (blueprints.isError) throw new Error(`list_blueprints 失败：${structured?.error?.message ?? JSON.stringify(structured)}`);
  console.log(`✔ youzhao.list_blueprints: ${structured.items?.length ?? 0} 个蓝图、${structured.groups?.length ?? 0} 个分组可访问`);
  console.log('\n冒烟测试通过。');
} catch (error) {
  failed = true;
  console.error(`\n✗ 冒烟测试失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  child.stdin.end();
  child.kill('SIGKILL');
  process.exit(failed ? 1 : 0);
}
