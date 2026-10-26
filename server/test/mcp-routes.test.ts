/**
 * MCP 端点端到端测试（`server/mcp/*` + `/mcp` 挂载）。
 *
 * 走**真实 HTTP**（`app.listen` + `fetch`），而不是 `inject`：Streamable HTTP 的
 * 形态由官方 SDK 决定，只有真连一次才能验证「头 + 信封 + SSE/JSON 双形态」这条链路。
 *
 * 两代线协议都要锁（docs/architecture-design.md §4.2、§4.7）：
 * - 2026-07-28 现代代：`Mcp-Protocol-Version` + `Mcp-Method`（tools/call 还要 `Mcp-Name`）
 *   + 请求体 `params._meta` 里的 `io.modelcontextprotocol/protocolVersion` 与 `clientCapabilities`，
 *   响应是 `application/json`。网关**不得**改写 `Mcp-*` 头，否则这里就会 400。
 * - 旧代（initialize 时代）：只要 JSON-RPC，响应是 `text/event-stream`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_TOOL_NAMES } from '../mcp/tools.js';
import { ALLOWED_ORIGIN } from './helpers.js';
import { createTestContext, login, OWNER_PASSWORD, seedWorld, type TestContext } from './http-helpers.js';

// ── 线协议辅助 ──────────────────────────────────────────────────────────────

const MODERN_VERSION = '2026-07-28';

interface McpReply {
  readonly status: number;
  readonly contentType: string;
  readonly headers: Headers;
  /** 已经解开 SSE 包装的 JSON-RPC 报文 */
  readonly message: Record<string, unknown>;
  readonly raw: string;
}

/** 从可能是 SSE 的响应体里取出 JSON-RPC 报文 */
function parseMessage(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Record<string, unknown>;
  const dataLines = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  assert.ok(dataLines.length > 0, `响应既不是 JSON 也不是 SSE：${raw.slice(0, 200)}`);
  return JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
}

interface RpcOptions {
  readonly token?: string;
  readonly modern?: boolean;
  readonly method?: string;
  readonly name?: string;
}

async function rpc(address: string, body: Record<string, unknown>, options: RpcOptions = {}): Promise<McpReply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.modern === true) {
    headers['mcp-protocol-version'] = MODERN_VERSION;
    if (options.method !== undefined) headers['mcp-method'] = options.method;
    if (options.name !== undefined) headers['mcp-name'] = options.name;
    const params = (body.params ?? {}) as Record<string, unknown>;
    body = {
      ...body,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
  }
  const response = await fetch(`${address}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    headers: response.headers,
    message: parseResponseBody(raw, response),
    raw,
  };
}

function parseResponseBody(raw: string, response: Response): Record<string, unknown> {
  if (response.status >= 400 && (response.headers.get('content-type') ?? '').includes('application/json')) {
    // 非 2xx 时可能是本应用的错误信封（401/403）或 MCP 的 JSON-RPC error
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed;
  }
  return parseMessage(raw);
}

function errorEnvelope(reply: McpReply): { code: string; message: string } {
  const error = (reply.message.error ?? {}) as { code?: string; message?: string };
  return { code: error.code ?? '', message: error.message ?? '' };
}

function resultOf(reply: McpReply): Record<string, unknown> {
  assert.equal(reply.status, 200, `期望 200，实际 ${reply.status}：${reply.raw.slice(0, 300)}`);
  const result = reply.message.result;
  assert.ok(result !== undefined, `响应没有 result：${reply.raw.slice(0, 300)}`);
  return result as Record<string, unknown>;
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

interface McpWorld {
  readonly ctx: TestContext;
  readonly address: string;
  readonly ownerId: string;
  readonly memberId: string;
  readonly fullToken: string;
  readonly readToken: string;
  readonly memberToken: string;
  close(): Promise<void>;
}

async function makeWorld(overrides: Record<string, string | undefined> = {}): Promise<McpWorld> {
  const ctx = await createTestContext(overrides);
  const { ownerId, memberId } = await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);

  async function createToken(name: string, scopes: readonly string[], bindUserId?: string): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/mcp-tokens',
      headers: { origin: ALLOWED_ORIGIN, cookie },
      payload: { name, scopes, ...(bindUserId === undefined ? {} : { bindUserId }) },
    });
    assert.equal(response.statusCode, 201, response.body);
    return (response.json() as { data: { token: string } }).data.token;
  }

  const fullToken = await createToken('全权', ['read:blueprint', 'publish:blueprint']);
  const readToken = await createToken('只读', ['read:blueprint']);
  const memberToken = await createToken('成员全权', ['read:blueprint', 'publish:blueprint'], memberId);
  const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  return {
    ctx,
    address,
    ownerId,
    memberId,
    fullToken,
    readToken,
    memberToken,
    close: () => ctx.close(),
  };
}

function toolNames(reply: McpReply): string[] {
  const tools = resultOf(reply).tools;
  assert.ok(Array.isArray(tools));
  return (tools as Array<{ name: string }>).map((tool) => tool.name);
}

// ── 用例 ────────────────────────────────────────────────────────────────────

test('MCP：无令牌 / 坏令牌 / 停用 / 过期 一律 401 + WWW-Authenticate', async () => {
  const world = await makeWorld();
  try {
    const anonymous = await rpc(world.address, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Bearer realm="youzhao"/);

    const malformed = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: 'yz_mcp_tok_dead_deadbeef' },
    );
    assert.equal(malformed.status, 401);
    assert.match(malformed.headers.get('www-authenticate') ?? '', /error="invalid_token"/);

    // 停用：改库后立刻失效（不依赖会话缓存）
    const disabled = await ctx_token(world, world.readToken);
    await world.ctx.db.updateTable('mcp_tokens').set({ status: 'disabled' }).where('id', '=', disabled.id).execute();
    const afterDisable = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { token: world.readToken },
    );
    assert.equal(afterDisable.status, 401);

    // 过期：直接把 expires_at 设到过去
    const expired = await ctx_token(world, world.fullToken);
    await world.ctx.db
      .updateTable('mcp_tokens')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('id', '=', expired.id)
      .execute();
    const afterExpire = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { token: world.fullToken },
    );
    assert.equal(afterExpire.status, 401);
  } finally {
    await world.close();
  }
});

test('MCP：绑定用户被停用 → 403 FORBIDDEN（不是 401）', async () => {
  const world = await makeWorld();
  try {
    await world.ctx.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', world.memberId).execute();
    const reply = await rpc(world.address, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: world.memberToken });
    assert.equal(reply.status, 403);
    assert.equal(errorEnvelope(reply).code, 'FORBIDDEN');
  } finally {
    await world.close();
  }
});

test('MCP：tools/list 按 Token scope 过滤，且顺序确定', async () => {
  const world = await makeWorld();
  try {
    const all = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: world.fullToken, modern: true, method: 'tools/list' },
    );
    const allNames = toolNames(all);
    assert.equal(allNames.length, 8);
    // 「顺序确定」= 注册顺序稳定，而非字典序；以工具模块声明的清单为准
    assert.deepEqual([...allNames], [...MCP_TOOL_NAMES]);

    const readOnly = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: world.readToken, modern: true, method: 'tools/list' },
    );
    const readNames = toolNames(readOnly);
    assert.equal(readNames.length, 4);
    assert.equal(readNames.includes('youzhao.publish_blueprint'), false);
    assert.equal(readNames.includes('youzhao.create_blueprint_group'), false);

    // 每个工具都带 outputSchema 与 annotations（§4.5）
    const tools = resultOf(all).tools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      assert.equal(typeof tool.outputSchema, 'object', `${String(tool.name)} 缺 outputSchema`);
      assert.equal(typeof tool.annotations, 'object', `${String(tool.name)} 缺 annotations`);
    }
  } finally {
    await world.close();
  }
});

test('MCP：tools/call 走用例层，返回 structuredContent；只读令牌调写工具 → SCOPE_DENIED', async () => {
  const world = await makeWorld();
  try {
    const groups = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'youzhao.list_blueprint_groups', arguments: {} } },
      { token: world.readToken, modern: true, method: 'tools/call', name: 'youzhao.list_blueprint_groups' },
    );
    const result = resultOf(groups);
    const structured = result.structuredContent as { groups: Array<{ id: string }> };
    assert.deepEqual(
      structured.groups.map((group) => group.id),
      ['group_default'],
    );

    const denied = await rpc(
      world.address,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'youzhao.publish_blueprint', arguments: { name: 'x', groupId: 'group_default', version: '1.0.0', html: '<html></html>' } },
      },
      { token: world.readToken, modern: true, method: 'tools/call', name: 'youzhao.publish_blueprint' },
    );
    assert.equal(denied.status, 403);
    assert.equal(errorEnvelope(denied).code, 'SCOPE_DENIED');
    assert.match(denied.headers.get('www-authenticate') ?? '', /error="insufficient_scope"/);
  } finally {
    await world.close();
  }
});

test('MCP：成员令牌建分组被策略拒绝（FORBIDDEN——建组仅所有者）', async () => {
  const world = await makeWorld();
  try {
    const reply = await rpc(
      world.address,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'youzhao.create_blueprint_group', arguments: { name: '成员建的组' } },
      },
      { token: world.memberToken, modern: true, method: 'tools/call', name: 'youzhao.create_blueprint_group' },
    );
    // 凭证与 scope 问题才是 HTTP 401/403；**策略拒绝**是工具级失败：
    // HTTP 200 + result.isError（MCP 惯例，让模型看得见失败原因）。
    // 建组自 2026-10-26 起仅所有者可做（permission-design §2.3），因此是 FORBIDDEN 而非缺能力。
    assert.equal(reply.status, 200);
    const result = resultOf(reply);
    assert.equal(result.isError, true);
    const structured = result.structuredContent as { error: { code: string } };
    assert.equal(structured.error.code, 'FORBIDDEN');
  } finally {
    await world.close();
  }
});

test('MCP：publish_blueprint 幂等 —— 同一 idempotencyKey 只落一个蓝图', async () => {
  const world = await makeWorld();
  try {
    const args = {
      name: 'MCP 幂等蓝图',
      groupId: 'group_default',
      version: '1.0.0',
      html: '<!doctype html><html><body>ok</body></html>',
      idempotencyKey: 'idem-key-1',
    };
    const first = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'youzhao.publish_blueprint', arguments: args } },
      { token: world.fullToken, modern: true, method: 'tools/call', name: 'youzhao.publish_blueprint' },
    );
    const firstStructured = resultOf(first).structuredContent as { blueprint: { id: string } };

    const second = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'youzhao.publish_blueprint', arguments: args } },
      { token: world.fullToken, modern: true, method: 'tools/call', name: 'youzhao.publish_blueprint' },
    );
    const secondStructured = resultOf(second).structuredContent as { blueprint: { id: string } };
    assert.equal(secondStructured.blueprint.id, firstStructured.blueprint.id);

    const rows = await world.ctx.db.selectFrom('blueprints').select(['id']).where('name', '=', 'MCP 幂等蓝图').execute();
    assert.equal(rows.length, 1);
  } finally {
    await world.close();
  }
});

test('MCP：旧代客户端（无版本头）可用，响应是 SSE；现代协议缺头/缺 _meta 会被拒', async () => {
  const world = await makeWorld();
  try {
    const legacy = await rpc(
      world.address,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: world.fullToken },
    );
    assert.equal(legacy.status, 200);
    assert.match(legacy.contentType, /text\/event-stream/);
    assert.equal(toolNames(legacy).length, 8);

    const initialize = await rpc(
      world.address,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-probe', version: '0' } },
      },
      { token: world.fullToken },
    );
    const info = resultOf(initialize).serverInfo;
    assert.deepEqual(info, { name: 'youzhao', version: '2.0.0' });

    // 现代协议：漏 Mcp-Method → 400（网关改写 Mcp-* 头会立刻触发这个错误）
    const missingMethod = await rpc(world.address, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, {
      token: world.fullToken,
      modern: true,
    });
    assert.equal(missingMethod.status, 400);

    // 现代协议：漏 _meta → 400
    const missingMeta = await fetch(`${world.address}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${world.fullToken}`,
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });
    assert.equal(missingMeta.status, 400);
  } finally {
    await world.close();
  }
});

test('MCP：每次工具调用都落审计（token_id + 工具名 + 绑定用户）', async () => {
  const world = await makeWorld();
  try {
    await rpc(
      world.address,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'youzhao.list_blueprint_groups', arguments: {} } },
      { token: world.fullToken, modern: true, method: 'tools/call', name: 'youzhao.list_blueprint_groups' },
    );
    const rows = await world.ctx.db
      .selectFrom('audit_logs')
      .select(['action', 'target_type', 'result', 'token_id'])
      .execute();
    const toolRows = rows.filter((row) => row.action.startsWith('mcp.'));
    assert.ok(toolRows.length >= 1, `没有 MCP 审计：${JSON.stringify(rows)}`);
    assert.equal(toolRows[0]?.result, 'allow');
    assert.equal(toolRows[0]?.token_id !== null, true);
  } finally {
    await world.close();
  }
});

/** 取令牌行（用于停用/过期用例） */
async function ctx_token(world: McpWorld, token: string): Promise<{ id: string }> {
  // 明文形如 yz_mcp_<tokenId>_<secret>；tokenId 自身带 `tok_` 前缀，故去掉首两段与末段
  const parts = token.split('_');
  const tokenId = parts.slice(2, -1).join('_');
  const row = await world.ctx.db.selectFrom('mcp_tokens').select(['id']).where('id', '=', tokenId).executeTakeFirst();
  assert.ok(row !== undefined, `找不到令牌行：${tokenId}`);
  return { id: row.id };
}

// ── stdio 桥（server/mcp-server.mjs）端到端 ────────────────────────────────
// 桌面客户端只会说 stdio；桥把「换行分隔 JSON-RPC」转发到 `/mcp`，再把响应（JSON 或 SSE）
// 解回 stdio。这里真起一个子进程，确保桥与真实路由在同一套协议上对话。
test('MCP stdio 桥：旧代 initialize + tools/list 走通（含 SSE 解帧），stdout 只有协议报文', async () => {
  const world = await makeWorld();
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['mcp-server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      YOUZHAO_API_BASE: world.address,
      YOUZHAO_MCP_TOKEN: world.fullToken,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    // 旧代（initialize 时代）客户端：不声明 2026-07-28，桥就不会带现代 Mcp-* 头
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' } },
      })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);

    const messages: Array<Record<string, unknown>> = [];
    let buffer = '';
    const collect = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    };
    child.stdout.on('data', collect);
    const waitFor = async (count: number): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (messages.length < count && Date.now() < deadline) {
        // stdout 已在 collect 里累积；这里只等一小会儿再看，避免依赖 events 命名空间导入
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitFor(2);

    assert.equal(messages.length >= 2, true, `只收到 ${messages.length} 条：${JSON.stringify(messages)}`);
    const initialized = messages.find((item) => item.id === 1) as {
      result?: { serverInfo?: { name?: string } };
      error?: unknown;
    };
    assert.equal(initialized?.error, undefined, JSON.stringify(initialized));
    assert.equal(initialized?.result?.serverInfo?.name, 'youzhao');
    const listed = messages.find((item) => item.id === 2) as { result?: { tools?: unknown[] } };
    assert.equal((listed?.result?.tools ?? []).length, 8);
  } finally {
    child.kill('SIGKILL');
    await world.close();
  }
});

// ── 冒烟脚本（skills/youzhao-mcp/scripts/youzhao_mcp_smoke_test.mjs）────────────
// 用户排障时真正会跑的就是这个脚本；把它接进 CI，避免它随协议演进而悄悄失效。
test('MCP 冒烟脚本：initialize + tools/list + list_blueprints 全通过', async () => {
  const world = await makeWorld();
  const { spawn } = await import('node:child_process');
  try {
    const child = spawn(
      process.execPath,
      ['../skills/youzhao-mcp/scripts/youzhao_mcp_smoke_test.mjs', 'mcp-server.mjs'],
      {
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, YOUZHAO_API_BASE: world.address, YOUZHAO_MCP_TOKEN: world.fullToken },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

    assert.equal(code, 0, `退出码 ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /冒烟测试通过/);
    assert.match(stdout, /tools\/list: 8 个/);
    assert.match(stdout, /youzhao\.list_blueprints: \d+ 个蓝图/);
  } finally {
    await world.close();
  }
});

// ── 输出契约全覆盖 ─────────────────────────────────────────────────────────
// outputSchema 会校验 structuredContent；只测一两个工具会漏掉「字段多一个/少一个」这类漂移，
// 所以这里把 8 个工具全部真调一遍（这也是发现 list_blueprints 少声明 page/pageSize/total 的那次回归）。
test('MCP：8 个工具全部可调用，且出参通过 outputSchema 校验', async () => {
  const world = await makeWorld();
  let next = 1;
  const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const reply = await rpc(
      world.address,
      { jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } },
      { token: world.fullToken, modern: true, method: 'tools/call', name },
    );
    const result = resultOf(reply);
    assert.equal(result.isError, undefined, `${name} 失败：${JSON.stringify(result.content)}`);
    assert.notEqual(result.structuredContent, undefined, `${name} 缺少 structuredContent`);
    return result.structuredContent as Record<string, unknown>;
  };

  try {
    const groups = await callTool('youzhao.list_blueprint_groups', {});
    assert.equal(Array.isArray(groups.groups), true);
    const groupId = (groups.groups as Array<{ id: string }>)[0]?.id ?? '';

    const listed = await callTool('youzhao.list_blueprints', { pageSize: 5 });
    assert.equal(typeof listed.total, 'number');
    assert.equal(Array.isArray(listed.items), true);

    const published = await callTool('youzhao.publish_blueprint', {
      name: '输出校验蓝图',
      groupId,
      version: 'v1.0.0',
      html: '<!doctype html><html><body>ok</body></html>',
      markdown: '# ok',
      idempotencyKey: 'out-check-1',
    });
    const blueprintId = (published.blueprint as { id: string }).id;

    const detail = await callTool('youzhao.get_blueprint', { blueprintId });
    assert.equal((detail.versions as unknown[]).length, 1);
    assert.equal(typeof (detail.capabilities as { canPublish: boolean }).canPublish, 'boolean');

    // 两种形态都要覆盖：带 markdown = 两文件 → 票据化清单；不带 = 单文件文本 → 内联 text
    const multi = await callTool('youzhao.get_blueprint_artifact', { blueprintId, version: 'v1.0.0' });
    assert.equal(multi.entry, 'index.html');
    assert.equal(multi.text, undefined);
    assert.match(String(multi.url), /^https?:\/\//);
    assert.equal(typeof multi.expiresAt, 'string');
    assert.equal((multi.files as unknown[]).length, 2);

    await callTool('youzhao.publish_blueprint', {
      blueprintId,
      name: '输出校验蓝图',
      groupId,
      version: 'v1.0.1',
      html: '<!doctype html><html><body>single</body></html>',
      idempotencyKey: 'out-check-1b',
    });
    const inline = await callTool('youzhao.get_blueprint_artifact', { blueprintId, version: 'v1.0.1' });
    assert.match(String(inline.text), /<!doctype html>/);
    assert.equal(inline.url, undefined);

    const covered = await callTool('youzhao.cover_blueprint_version', {
      blueprintId,
      version: 'v1.0.0',
      html: '<!doctype html><html><body>covered</body></html>',
      idempotencyKey: 'out-check-2',
    });
    assert.equal((covered.version as { version: string }).version, 'v1.0.0');

    const removed = await callTool('youzhao.delete_blueprint_version', {
      blueprintId,
      version: 'v1.0.1',
      idempotencyKey: 'out-check-3',
    });
    assert.equal((removed.version as { version: string }).version, 'v1.0.1');

    const created = await callTool('youzhao.create_blueprint_group', { name: '输出校验分组', idempotencyKey: 'out-check-4' });
    assert.equal((created.group as { name: string }).name, '输出校验分组');
    assert.equal(Array.isArray(created.movedBlueprintIds), true);
  } finally {
    await world.close();
  }
});

// ── 限流（§4.5「调用限流」）──────────────────────────────────────────────
test('MCP：按 Token 限流，超过 RATE_LIMIT_MCP_PER_MINUTE → 429 RATE_LIMITED', async () => {
  const world = await makeWorld({ RATE_LIMIT_MCP_PER_MINUTE: '3' });
  try {
    const call = (): Promise<McpReply> =>
      rpc(
        world.address,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'youzhao.list_blueprint_groups', arguments: {} } },
        { token: world.fullToken, modern: true, method: 'tools/call', name: 'youzhao.list_blueprint_groups' },
      );

    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    const blocked = await call();
    assert.equal(blocked.status, 429, blocked.raw);
    const envelope = blocked.message as { error?: { code?: string } };
    assert.equal(envelope.error?.code, 'RATE_LIMITED', blocked.raw);
  } finally {
    await world.close();
  }
});
