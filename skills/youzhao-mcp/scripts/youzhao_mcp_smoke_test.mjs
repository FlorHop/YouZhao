#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';

const serverPath = process.argv[2];

if (!serverPath) {
  console.error('Usage: youzhao_mcp_smoke_test.mjs <path-to-server/mcp-server.mjs>');
  process.exit(1);
}

const child = spawn(process.execPath, [path.resolve(serverPath)], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit']
});

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  const message = { jsonrpc: '2.0', id, method, params };
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function readMessage() {
  const separator = buffer.indexOf('\r\n\r\n');
  if (separator < 0) return null;
  const header = buffer.subarray(0, separator).toString('utf8');
  const match = header.match(/content-length:\s*(\d+)/i);
  if (!match) throw new Error('Missing Content-Length');
  const length = Number(match[1]);
  const start = separator + 4;
  const end = start + length;
  if (buffer.length < end) return null;
  const body = buffer.subarray(start, end).toString('utf8');
  buffer = buffer.subarray(end);
  return JSON.parse(body);
}

child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let message;
  while ((message = readMessage())) {
    const handler = pending.get(message.id);
    if (!handler) continue;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  }
});

child.on('exit', (code) => {
  if (code !== 0 && pending.size > 0) {
    for (const { reject } of pending.values()) reject(new Error(`MCP server exited with code ${code}`));
  }
});

try {
  const initialized = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'youzhao-smoke-test', version: '0.1.0' }
  });
  console.log(`initialized: ${initialized.serverInfo?.name}`);

  const list = await send('tools/list', {});
  console.log(`tools: ${list.tools.map((tool) => tool.name).join(', ')}`);

  const result = await send('tools/call', {
    name: 'youzhao.list_blueprints',
    arguments: { limit: 5 }
  });
  console.log(result.content?.[0]?.text ?? JSON.stringify(result));
  child.kill();
} catch (error) {
  child.kill();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
