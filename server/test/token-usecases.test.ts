/**
 * MCP Token 管理用例层测试（`server/app/tokens.ts`）。
 *
 * 直接调用例函数、直接查库断言，不经过 HTTP，锁的是用例层的判权、可见范围裁剪、
 * 明文只落摘要与审计；HTTP 冒烟用例则走 `createTestContext()` 产出的完整应用
 * （`server/http/app.ts` 已接线 `registerTokenRoutes`）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CreateMcpTokenRequest } from '@youzhao/contracts/types';
import { buildUserContext } from '../app/context.js';
import {
  createMcpToken,
  deleteMcpToken,
  listMcpTokens,
  updateMcpToken,
} from '../app/tokens.js';
import type { TokenAudit } from '../app/tokens.js';
import type { Db } from '../db/types.js';
import type { RequestContext } from '../domain/entities.js';
import { AppError } from '../domain/errors.js';
import { hashMcpToken, MCP_TOKEN_PREFIX, parseMcpToken } from '../domain/mcp-token.js';
import { ALLOWED_ORIGIN } from './helpers.js';
import {
  createTestContext,
  expectErrorCode,
  login,
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  seedUser,
  seedWorld,
  type TestContext,
} from './http-helpers.js';

/** 用例层的审计上下文（HTTP 层由 requestId / ip 填充）。 */
const AUDIT: TokenAudit = { requestId: 'test-request', ip: '127.0.0.1' };

const READ_ONLY: CreateMcpTokenRequest['scopes'] = ['read:blueprint'];
const PUBLISH: CreateMcpTokenRequest['scopes'] = ['publish:blueprint'];

/** `mcp_tokens` 一行的读侧形状（只取断言用到的列）。 */
interface TokenRow {
  readonly id: string;
  readonly name: string;
  readonly token_hash: string;
  readonly token_prefix: string;
  readonly bound_user_id: string;
  readonly created_by_user_id: string;
  readonly scopes: string[];
  readonly status: string;
  readonly expires_at: Date | null;
  readonly last_used_at: Date | null;
  readonly created_at: Date;
}

async function findTokenRow(db: Db, tokenId: string): Promise<TokenRow | null> {
  const row = await db
    .selectFrom('mcp_tokens')
    .selectAll()
    .where('id', '=', tokenId)
    .executeTakeFirst();
  return row === undefined ? null : row;
}

async function requireTokenRow(db: Db, tokenId: string): Promise<TokenRow> {
  const row = await findTokenRow(db, tokenId);
  if (row === null) throw new Error(`mcp_tokens 里找不到 ${tokenId}`);
  return row;
}

/** 断言用例抛出的 `AppError` 错误码。 */
async function expectAppError(code: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError && error.code === code) return;
    const actual = error instanceof AppError ? error.code : String(error);
    throw new Error(`期望 ${code}，实际 ${actual}`);
  }
  throw new Error(`期望抛出 ${code}，但调用成功了`);
}

function contextOf(ctx: TestContext, userId: string): Promise<RequestContext> {
  return buildUserContext(ctx.db, userId);
}

test('所有者创建只读 Token：明文只出现一次，库里只有摘要（sha256 + 前缀）', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId } = await seedWorld(ctx.db);
    const owner = await contextOf(ctx, ownerId);

    const created = await createMcpToken(
      ctx.db,
      owner,
      { name: '只读令牌', scopes: READ_ONLY },
      AUDIT,
    );

    // 响应：明文形如 yz_mcp_tok_<uuid>_<secret>，可直接被 parseMcpToken 解回主键
    assert.ok(created.token.startsWith(`${MCP_TOKEN_PREFIX}tok_`));
    assert.equal(parseMcpToken(created.token)?.tokenId, created.id);
    assert.ok(created.token.startsWith(created.tokenPrefix));
    assert.equal(created.name, '只读令牌');
    assert.deepEqual(created.scopes, ['read:blueprint']);
    assert.equal(created.status, 'active');
    assert.equal(created.boundUserId, ownerId);
    assert.equal(created.boundUserDisplayName, '所有者');
    assert.equal(created.createdByUserId, ownerId);
    assert.equal(created.createdByDisplayName, '所有者');
    assert.equal(created.expiresAt, null);
    assert.equal(created.lastUsedAt, null);
    assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);

    // 库里只有摘要：明文不可从中还原
    const row = await requireTokenRow(ctx.db, created.id);
    assert.notEqual(row.token_hash, created.token);
    assert.equal(row.token_hash, hashMcpToken(created.token));
    assert.equal(row.token_prefix, created.tokenPrefix);
    assert.deepEqual(row.scopes, ['read:blueprint']);
    assert.equal(row.status, 'active');
    assert.equal(row.bound_user_id, ownerId);
    assert.equal(row.created_by_user_id, ownerId);
    assert.equal(row.expires_at, null);
    assert.equal(row.last_used_at, null);

    // 过期时间按 ISO 字符串原样往返
    const withExpiry = await createMcpToken(
      ctx.db,
      owner,
      { name: '有期限', scopes: READ_ONLY, expiresAt: '2030-01-02T03:04:05.000Z' },
      AUDIT,
    );
    assert.equal(withExpiry.expiresAt, '2030-01-02T03:04:05.000Z');
  } finally {
    await ctx.close();
  }
});

test('member 为自己创建成功；列表只含自己创建或被绑定给自己的 Token', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, adminId, memberId } = await seedWorld(ctx.db);
    const owner = await contextOf(ctx, ownerId);
    const member = await contextOf(ctx, memberId);

    const own = await createMcpToken(ctx.db, member, { name: '我的只读', scopes: READ_ONLY }, AUDIT);
    assert.equal(own.boundUserId, memberId);
    assert.equal(own.createdByUserId, memberId);

    // 别人创建、也没绑定给 member 的两个 Token
    const ownerToken = await createMcpToken(ctx.db, owner, { name: '所有者自用', scopes: READ_ONLY }, AUDIT);
    const forAdmin = await createMcpToken(
      ctx.db,
      owner,
      { name: '管理员用', scopes: READ_ONLY, bindUserId: adminId },
      AUDIT,
    );

    const memberList = await listMcpTokens(ctx.db, member, AUDIT);
    assert.deepEqual(memberList.items.map((item) => item.id), [own.id]);
    assert.equal(memberList.items[0]?.boundUserDisplayName, '陈以宁');
    assert.equal(memberList.items[0]?.createdByDisplayName, '陈以宁');

    // 所有者创建的、但绑定给 member 的 Token 对 member 可见
    const boundToMember = await createMcpToken(
      ctx.db,
      owner,
      { name: '派发给陈以宁', scopes: READ_ONLY, bindUserId: memberId },
      AUDIT,
    );
    const visibleIds = (await listMcpTokens(ctx.db, member, AUDIT)).items.map((item) => item.id);
    assert.deepEqual(new Set(visibleIds), new Set([own.id, boundToMember.id]));

    // 所有者看全平台
    const ownerIds = (await listMcpTokens(ctx.db, owner, AUDIT)).items.map((item) => item.id);
    assert.deepEqual(new Set(ownerIds), new Set([own.id, ownerToken.id, forAdmin.id, boundToMember.id]));

    // 被派发者本人看得到「绑定给自己、但不是自己创建」的那条，且展示名区分两侧
    const forwarded = (await listMcpTokens(ctx.db, member, AUDIT)).items.find(
      (item) => item.id === boundToMember.id,
    );
    assert.equal(forwarded?.boundUserDisplayName, '陈以宁');
    assert.equal(forwarded?.createdByDisplayName, '所有者');
  } finally {
    await ctx.close();
  }
});

test('member 传 bindUserId 替他人创建 → FORBIDDEN，并留下 deny 审计', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    const member = await contextOf(ctx, memberId);

    await expectAppError('FORBIDDEN', () =>
      createMcpToken(
        ctx.db,
        member,
        { name: '越权派发', scopes: READ_ONLY, bindUserId: ownerId },
        AUDIT,
      ),
    );

    // 被拒的创建不落库
    assert.equal((await listMcpTokens(ctx.db, member, AUDIT)).items.length, 0);

    const audits = await ctx.db
      .selectFrom('audit_logs')
      .select(['action', 'result', 'error_code', 'target_id'])
      .where('action', '=', 'token.create')
      .execute();
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'deny');
    assert.equal(audits[0]?.error_code, 'FORBIDDEN');
    assert.equal(audits[0]?.target_id, null);
  } finally {
    await ctx.close();
  }
});

test('所有者可以为他人创建 Token（bindUserId 指向 member）', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    const owner = await contextOf(ctx, ownerId);
    const member = await contextOf(ctx, memberId);

    const created = await createMcpToken(
      ctx.db,
      owner,
      { name: '替陈以宁创建', scopes: READ_ONLY, bindUserId: memberId },
      AUDIT,
    );
    assert.equal(created.boundUserId, memberId);
    assert.equal(created.boundUserDisplayName, '陈以宁');
    assert.equal(created.createdByUserId, ownerId);
    assert.equal(created.createdByDisplayName, '所有者');

    // member 自己没有创建权给他人的 Token 时，仅凭「绑定给我」即可操作它
    const updated = await updateMcpToken(ctx.db, member, created.id, { status: 'disabled' }, AUDIT);
    assert.equal(updated.status, 'disabled');
  } finally {
    await ctx.close();
  }
});

test('member 申请 publish:blueprint 而自身没有 blueprint.publish → SCOPE_DENIED', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    const owner = await contextOf(ctx, ownerId);
    const member = await contextOf(ctx, memberId);

    await expectAppError('SCOPE_DENIED', () =>
      createMcpToken(ctx.db, member, { name: '想发布', scopes: PUBLISH }, AUDIT),
    );
    // 只读 scope 人人可建（S2）
    const readOnly = await createMcpToken(ctx.db, member, { name: '只读', scopes: READ_ONLY }, AUDIT);
    assert.deepEqual(readOnly.scopes, ['read:blueprint']);

    // 所有者的 scope 上限是全集
    const ownerPublish = await createMcpToken(ctx.db, owner, { name: '发布', scopes: PUBLISH }, AUDIT);
    assert.deepEqual(ownerPublish.scopes, ['publish:blueprint']);

    // 空 scope 连契约都过不去，策略层也拒绝
    await expectAppError('INVALID_ARGUMENT', () =>
      createMcpToken(ctx.db, owner, { name: '空', scopes: [] }, AUDIT),
    );
  } finally {
    await ctx.close();
  }
});

test('启停与改名：本人可停用再启用；第三方对他人的 Token PATCH → FORBIDDEN 且不改库', async () => {
  const ctx = await createTestContext();
  try {
    const { memberId } = await seedWorld(ctx.db);
    const member = await contextOf(ctx, memberId);
    const created = await createMcpToken(ctx.db, member, { name: '我的', scopes: READ_ONLY }, AUDIT);

    const disabled = await updateMcpToken(ctx.db, member, created.id, { status: 'disabled' }, AUDIT);
    assert.equal(disabled.status, 'disabled');
    assert.equal((await requireTokenRow(ctx.db, created.id)).status, 'disabled');

    const enabled = await updateMcpToken(ctx.db, member, created.id, { status: 'active' }, AUDIT);
    assert.equal(enabled.status, 'active');

    const renamed = await updateMcpToken(ctx.db, member, created.id, { name: '改名后' }, AUDIT);
    assert.equal(renamed.name, '改名后');

    // 空请求体：契约允许，不应发出空 UPDATE，也不应报错
    const noop = await updateMcpToken(ctx.db, member, created.id, {}, AUDIT);
    assert.equal(noop.name, '改名后');
    assert.equal(noop.status, 'active');

    // 另一个普通成员既不是所有者、也不是创建者/绑定者
    const otherId = await seedUser(ctx.db, {
      username: 'liu',
      password: 'liu-pass-1234',
      displayName: '刘工',
    });
    const other = await contextOf(ctx, otherId);
    await expectAppError('FORBIDDEN', () =>
      updateMcpToken(ctx.db, other, created.id, { status: 'disabled' }, AUDIT),
    );
    assert.equal((await requireTokenRow(ctx.db, created.id)).status, 'active');

    // 不存在的 id（资源级码 TOKEN_NOT_FOUND）
    await expectAppError('TOKEN_NOT_FOUND', () =>
      updateMcpToken(ctx.db, member, 'tok_does_not_exist', { status: 'disabled' }, AUDIT),
    );
  } finally {
    await ctx.close();
  }
});

test('DELETE 后列表里消失、行被物理删除；再删同一 id → NOT_FOUND', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    const owner = await contextOf(ctx, ownerId);
    const member = await contextOf(ctx, memberId);
    const created = await createMcpToken(ctx.db, member, { name: '待删', scopes: READ_ONLY }, AUDIT);

    const deleted = await deleteMcpToken(ctx.db, owner, created.id, AUDIT);
    assert.equal(deleted.id, created.id);
    assert.equal(deleted.name, '待删');
    assert.equal(deleted.tokenPrefix, created.tokenPrefix);

    assert.equal(await findTokenRow(ctx.db, created.id), null);
    assert.deepEqual((await listMcpTokens(ctx.db, member, AUDIT)).items, []);
    assert.deepEqual((await listMcpTokens(ctx.db, owner, AUDIT)).items, []);

    await expectAppError('TOKEN_NOT_FOUND', () => deleteMcpToken(ctx.db, owner, created.id, AUDIT));
  } finally {
    await ctx.close();
  }
});

test('列表排序：created_at desc，同刻用 id asc 兜底', async () => {
  const ctx = await createTestContext();
  try {
    const { memberId } = await seedWorld(ctx.db);
    const member = await contextOf(ctx, memberId);

    const first = await createMcpToken(ctx.db, member, { name: '早', scopes: READ_ONLY }, AUDIT);
    const second = await createMcpToken(ctx.db, member, { name: '晚', scopes: READ_ONLY }, AUDIT);

    await ctx.db
      .updateTable('mcp_tokens')
      .set({ created_at: new Date('2026-01-01T00:00:00.000Z') })
      .where('id', '=', first.id)
      .execute();
    await ctx.db
      .updateTable('mcp_tokens')
      .set({ created_at: new Date('2026-02-01T00:00:00.000Z') })
      .where('id', '=', second.id)
      .execute();

    const ordered = await listMcpTokens(ctx.db, member, AUDIT);
    assert.deepEqual(
      ordered.items.map((item) => item.name),
      ['晚', '早'],
    );
    assert.equal(ordered.items[0]?.createdAt, '2026-02-01T00:00:00.000Z');

    // 同一时刻：按 id 升序兜底
    await ctx.db
      .updateTable('mcp_tokens')
      .set({ created_at: new Date('2026-03-01T00:00:00.000Z') })
      .where('id', 'in', [first.id, second.id])
      .execute();
    const tied = await listMcpTokens(ctx.db, member, AUDIT);
    assert.deepEqual(
      tied.items.map((item) => item.id),
      [first.id, second.id].sort(),
    );
  } finally {
    await ctx.close();
  }
});

/**
 * 路由层冒烟。
 *
 * 直接用 `createTestContext()` 产出的、已接线完毕的完整应用，真正跑到 Fastify 的请求
 * 校验、响应序列化与错误信封——只 typecheck 是锁不住这些的。
 */
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallOptions {
  readonly cookie?: string;
  readonly payload?: Record<string, unknown>;
}

function call(ctx: TestContext, method: Method, url: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { origin: ALLOWED_ORIGIN };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return ctx.app.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

test('HTTP：四个端点的状态码、data/meta 信封与契约校验', async () => {
  const ctx = await createTestContext();
  try {
    const { ownerId, memberId } = await seedWorld(ctx.db);
    const ownerCookie = await login(ctx.app, 'owner', OWNER_PASSWORD);
    const memberCookie = await login(ctx.app, 'chen', MEMBER_PASSWORD);

    // 未登录：/api/* 的会话中间件先拦下
    assert.equal((await call(ctx, 'GET', '/api/mcp-tokens')).statusCode, 401);

    // POST → 201，data.token 是明文，meta.requestId 存在
    const created = await call(ctx, 'POST', '/api/mcp-tokens', {
      cookie: ownerCookie,
      payload: { name: '冒烟令牌', scopes: ['read:blueprint'] },
    });
    assert.equal(created.statusCode, 201);
    const createdBody = created.json() as {
      data: { id: string; token: string; tokenPrefix: string; status: string };
      meta: { requestId: string };
    };
    assert.ok(createdBody.data.token.startsWith(MCP_TOKEN_PREFIX));
    assert.equal(typeof createdBody.meta.requestId, 'string');
    assert.ok(createdBody.meta.requestId.length > 0);
    assert.equal(createdBody.data.status, 'active');

    // GET：空列表 + 完整 meta（契约要求 page/pageSize/total/requestId 四项）
    const empty = await call(ctx, 'GET', '/api/mcp-tokens', { cookie: memberCookie });
    assert.equal(empty.statusCode, 200);
    const emptyBody = empty.json() as {
      data: { items: unknown[] };
      meta: { page: number; pageSize: number; total: number; requestId: string };
    };
    assert.deepEqual(emptyBody.data.items, []);
    assert.equal(emptyBody.meta.page, 1);
    assert.equal(emptyBody.meta.total, 0);
    assert.deepEqual(Object.keys(emptyBody.meta).sort(), ['page', 'pageSize', 'requestId', 'total']);

    // GET：所有者看得到刚才那条，字段被响应 schema 完整序列化
    const ownerList = await call(ctx, 'GET', '/api/mcp-tokens', { cookie: ownerCookie });
    const ownerBody = ownerList.json() as {
      data: { items: { id: string; tokenPrefix: string; expiresAt: unknown; lastUsedAt: unknown }[] };
      meta: { total: number };
    };
    assert.equal(ownerBody.meta.total, 1);
    assert.equal(ownerBody.data.items[0]?.id, createdBody.data.id);
    assert.equal(ownerBody.data.items[0]?.tokenPrefix, createdBody.data.tokenPrefix);
    assert.equal(ownerBody.data.items[0]?.expiresAt, null);
    assert.equal(ownerBody.data.items[0]?.lastUsedAt, null);

    // PATCH → 200，meta 只有 requestId
    const patched = await call(ctx, 'PATCH', `/api/mcp-tokens/${createdBody.data.id}`, {
      cookie: ownerCookie,
      payload: { name: '改名', status: 'disabled' },
    });
    assert.equal(patched.statusCode, 200);
    const patchedBody = patched.json() as {
      data: { name: string; status: string };
      meta: { requestId: string };
    };
    assert.equal(patchedBody.data.name, '改名');
    assert.equal(patchedBody.data.status, 'disabled');
    assert.deepEqual(Object.keys(patchedBody.meta), ['requestId']);

    // 请求体契约：未知字段被拒（additionalProperties: false）
    const extraField = await call(ctx, 'POST', '/api/mcp-tokens', {
      cookie: ownerCookie,
      payload: { name: '非法', scopes: ['read:blueprint'], nope: true },
    });
    assert.equal(extraField.statusCode, 400);

    // 未知状态值同样被拒
    const badStatus = await call(ctx, 'PATCH', `/api/mcp-tokens/${createdBody.data.id}`, {
      cookie: ownerCookie,
      payload: { status: 'frozen' },
    });
    assert.equal(badStatus.statusCode, 400);

    // 无权限：member 替他人在 body 里指定 bindUserId → 403 FORBIDDEN
    const forbidden = await call(ctx, 'POST', '/api/mcp-tokens', {
      cookie: memberCookie,
      payload: { name: '越权', scopes: ['read:blueprint'], bindUserId: ownerId },
    });
    await expectErrorCode(forbidden, 403, 'FORBIDDEN');

    // 资源不存在：PATCH 不存在的 id → 404 TOKEN_NOT_FOUND（资源级码，与兄弟资源同惯例）
    const missing = await call(ctx, 'PATCH', '/api/mcp-tokens/tok_missing', {
      cookie: ownerCookie,
      payload: { name: 'x' },
    });
    await expectErrorCode(missing, 404, 'TOKEN_NOT_FOUND');

    // DELETE → 200 + 被删对象的 summary；列表随即为空
    const deleted = await call(ctx, 'DELETE', `/api/mcp-tokens/${createdBody.data.id}`, {
      cookie: ownerCookie,
    });
    assert.equal(deleted.statusCode, 200);
    const deletedBody = deleted.json() as { data: { id: string; name: string } };
    assert.equal(deletedBody.data.id, createdBody.data.id);
    assert.equal(deletedBody.data.name, '改名');
    assert.equal((await findTokenRow(ctx.db, createdBody.data.id)), null);
    assert.deepEqual((await listMcpTokens(ctx.db, await contextOf(ctx, memberId), AUDIT)).items, []);
  } finally {
    await ctx.close();
  }
});
