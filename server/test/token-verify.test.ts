/**
 * MCP Token 自检端点测试（`POST /api/mcp-tokens/verify`，docs/mcp-onboarding-design.md §3.2）。
 *
 * 自检内部会**环回本进程的 `/mcp`** 发一次真实 HTTP（legacy `initialize` + `tools/list`），
 * 所以：
 * - 快乐路径必须先把 `app.listen({ port: 0 })` 打开，否则探针拿不到监听地址 → 503；
 * - 这里不 mock 探针，走的就是客户端将来会走的那条链（Bearer → token_hash → scope → 协议层）。
 *
 * 只读原则：自检不调 `tools/call`，因此不会写任何业务审计（`mcp.*` 动作）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_TOOL_NAMES } from '../mcp/tools.js';
import { ALLOWED_ORIGIN } from './helpers.js';
import {
  createTestContext,
  expectErrorCode,
  login,
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  seedWorld,
  type TestContext,
} from './http-helpers.js';

const VERIFY_URL = '/api/mcp-tokens/verify';
const TOKEN_CREATE_URL = '/api/mcp-tokens';

interface TokenSeed {
  readonly id: string;
  readonly token: string;
  readonly tokenPrefix: string;
}

function headers(cookie?: string): Record<string, string> {
  return cookie === undefined ? { origin: ALLOWED_ORIGIN } : { origin: ALLOWED_ORIGIN, cookie };
}

async function createToken(
  ctx: TestContext,
  cookie: string,
  body: Record<string, unknown>,
): Promise<TokenSeed> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: TOKEN_CREATE_URL,
    headers: headers(cookie),
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data as Record<string, unknown>;
  return {
    id: String(data.id),
    token: String(data.token),
    tokenPrefix: String(data.tokenPrefix),
  };
}

async function verify(ctx: TestContext, cookie: string, token: string) {
  return ctx.app.inject({
    method: 'POST',
    url: VERIFY_URL,
    headers: headers(cookie),
    payload: { token },
  });
}

/** 计数器：审计里有多少条业务动作（`mcp.*`）。 */
async function toolAuditCount(ctx: TestContext): Promise<number> {
  const rows = await ctx.db
    .selectFrom('audit_logs')
    .select('action')
    .where('action', 'like', 'mcp.%')
    .execute();
  return rows.length;
}

test('自检：未登录 → 401', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());

  const response = await ctx.app.inject({
    method: 'POST',
    url: VERIFY_URL,
    headers: headers(),
    payload: { token: 'yz_mcp_tok_x_0123456789abcdef0123456789abcdef' },
  });
  await expectErrorCode(response, 401, 'UNAUTHENTICATED');
});

test('自检：格式不合法 → 401 TOKEN_INVALID（不泄露差异）', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);

  const response = await verify(ctx, cookie, 'not-a-youzhao-token');
  await expectErrorCode(response, 401, 'TOKEN_INVALID');
});

test('自检：格式合法但库里没有 → 401 TOKEN_INVALID', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);

  const ghost = `yz_mcp_tok_99999999-9999-4999-8999-999999999999_${'a'.repeat(32)}`;
  const response = await verify(ctx, cookie, ghost);
  await expectErrorCode(response, 401, 'TOKEN_INVALID');
});

test('自检：明文被改动（哈希对不上）→ 401 TOKEN_INVALID', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
  const seed = await createToken(ctx, cookie, { name: 'tampered', scopes: ['read:blueprint'] });

  const last = seed.token.at(-1);
  const tampered = `${seed.token.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`;
  const response = await verify(ctx, cookie, tampered);
  await expectErrorCode(response, 401, 'TOKEN_INVALID');
});

test('自检：已停用 → 401 TOKEN_INVALID', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
  const seed = await createToken(ctx, cookie, { name: 'disabled', scopes: ['read:blueprint'] });

  await ctx.db
    .updateTable('mcp_tokens')
    .set({ status: 'disabled' })
    .where('id', '=', seed.id)
    .execute();

  const response = await verify(ctx, cookie, seed.token);
  await expectErrorCode(response, 401, 'TOKEN_INVALID');
});

test('自检：已过期 → 401 TOKEN_INVALID', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
  const seed = await createToken(ctx, cookie, { name: 'expired', scopes: ['read:blueprint'] });

  await ctx.db
    .updateTable('mcp_tokens')
    .set({ expires_at: new Date(Date.now() - 60_000) })
    .where('id', '=', seed.id)
    .execute();

  const response = await verify(ctx, cookie, seed.token);
  await expectErrorCode(response, 401, 'TOKEN_INVALID');
});

test('自检：别人的 Token → 403（成员越权自检被挡住）', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
  const seed = await createToken(ctx, ownerCookie, { name: 'owner-only', scopes: ['read:blueprint'] });

  const memberCookie = await login(ctx.app, 'chen', MEMBER_PASSWORD);
  const response = await verify(ctx, memberCookie, seed.token);
  await expectErrorCode(response, 403, 'FORBIDDEN');
});

test('自检：本进程未监听 HTTP → 503（inject 场景）', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
  const seed = await createToken(ctx, cookie, { name: 'no-listen', scopes: ['read:blueprint'] });

  const response = await verify(ctx, cookie, seed.token);
  await expectErrorCode(response, 503, 'SERVICE_UNAVAILABLE');
});

test('自检：MCP_ENABLED=false → 503 MCP_DISABLED', async (t) => {
  const ctx = await createTestContext({ MCP_ENABLED: 'false' });
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
  const seed = await createToken(ctx, cookie, { name: 'mcp-off', scopes: ['read:blueprint'] });

  const response = await verify(ctx, cookie, seed.token);
  await expectErrorCode(response, 503, 'MCP_DISABLED');
});

test('自检快乐路径：真实环回拿到 serverInfo、协议版本与全部工具，且不写业务审计', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
  const seed = await createToken(ctx, cookie, {
    name: 'self-check',
    scopes: ['read:blueprint', 'publish:blueprint'],
  });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });

  const before = await toolAuditCount(ctx);
  const response = await verify(ctx, cookie, seed.token);
  assert.equal(response.statusCode, 200, response.body);

  const data = response.json().data as Record<string, unknown>;
  assert.equal(data.ok, true);
  assert.equal(data.tokenId, seed.id);
  assert.equal(data.tokenPrefix, seed.tokenPrefix);
  assert.deepEqual([...(data.scopes as string[])].sort(), ['publish:blueprint', 'read:blueprint']);

  const serverInfo = data.serverInfo as { name: string; version: string };
  assert.equal(serverInfo.name, 'youzhao');
  assert.match(serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.equal(data.protocolVersion, '2025-06-18');
  assert.equal(data.toolCount, MCP_TOOL_NAMES.length);
  assert.equal((data.tools as unknown[]).length, MCP_TOOL_NAMES.length);
  assert.ok(typeof data.latencyMs === 'number' && (data.latencyMs as number) >= 0);

  const tools = data.tools as { name: string; scope: string }[];
  assert.deepEqual(
    tools.map((tool) => tool.scope).every((scope) => scope === 'read:blueprint' || scope === 'publish:blueprint'),
    true,
  );
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...MCP_TOOL_NAMES].sort(),
  );

  assert.equal(await toolAuditCount(ctx), before, '自检不得写 mcp.* 业务审计');
  const verifyAudits = await ctx.db
    .selectFrom('audit_logs')
    .select('action')
    .where('action', '=', 'token.verify')
    .execute();
  assert.ok(verifyAudits.length >= 1, '自检本身应留下 token.verify 审计');
});

test('自检：只读 Token 在环回里只看到 4 个读工具（scope 闸门生效）', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => await ctx.close());
  await seedWorld(ctx.db);
  const cookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
  const seed = await createToken(ctx, cookie, { name: 'read-only', scopes: ['read:blueprint'] });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });

  const response = await verify(ctx, cookie, seed.token);
  assert.equal(response.statusCode, 200, response.body);

  const data = response.json().data as Record<string, unknown>;
  assert.equal(data.toolCount, 4);
  const tools = data.tools as { scope: string }[];
  assert.equal(tools.length, 4);
  assert.equal(
    tools.every((tool) => tool.scope === 'read:blueprint'),
    true,
  );
});
