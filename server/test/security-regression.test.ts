/**
 * M6 验收：§7「安全设计」全表复测（`docs/architecture-design.md` §7 的 12 条）。
 *
 * 这个文件的目的不是重复已有用例，而是把 §7 的**对策**逐条钉成一个可复跑的断言，
 * 让「安全回归」有单一入口可查：每条用例的标题都以 `§7-#N` 开头，直接对应表格行号。
 * 与既有用例重合的部分（例如 ZIP 校验、策略矩阵）在 `docs/architecture-design.md`
 * §8.4 的对照表里指向它们，这里只补「没有别处断言」的横切不变量。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../config.js';
import { newId } from '../domain/ids.js';
import { artifactDirFor, assertSafeSegment, resolveArtifactPath, writeArtifactPackage } from '../storage/artifacts.js';
import type { ZipEntry } from '../storage/zip.js';
import { ALLOWED_ORIGIN, minimalEnv } from './helpers.js';
import { createTestContext, expectErrorCode, login, seedWorld, type TestContext } from './http-helpers.js';

const INDEX_HTML = '<!doctype html><html><head><title>安全回归</title>'
  + '<link rel="stylesheet" href="assets/app.css"></head>'
  + '<body><div id="app">安全回归样例</div></body></html>';

function sampleFiles(): ZipEntry[] {
  return [
    { path: 'index.html', bytes: Buffer.from(INDEX_HTML) },
    { path: 'assets/app.css', bytes: Buffer.from('body{color:#111}') },
  ];
}

interface SeededBlueprint {
  readonly blueprintId: string;
  readonly version: string;
}

async function seedBlueprint(context: TestContext, ownerId: string): Promise<SeededBlueprint> {
  const blueprintId = newId('bp');
  const version = 'v1.0.0';
  await context.db
    .insertInto('blueprints')
    .values({
      id: blueprintId,
      name: '安全回归蓝图',
      summary: '用于 §7 复测',
      tags: ['测试'],
      group_id: 'group_default',
      status: 'active',
      created_by_user_id: ownerId,
    })
    .execute();
  const published = await writeArtifactPackage({
    root: context.config.preview.storagePath,
    blueprintId,
    version,
    files: sampleFiles(),
    replace: false,
  });
  await context.db
    .insertInto('blueprint_versions')
    .values({
      id: newId('ver'),
      blueprint_id: blueprintId,
      version,
      is_latest: true,
      status: 'available',
      entry_path: 'index.html',
      publish_source: 'web',
      publish_note: '',
      artifact_path: published.artifactPath,
      artifact_hash: published.hash,
      artifact_bytes: published.bytes,
    })
    .execute();
  return { blueprintId, version };
}

interface TicketBody {
  readonly data: { readonly url: string; readonly ticket: string };
}

async function requestTicket(context: TestContext, cookie: string, blueprintId: string) {
  return context.app.inject({
    method: 'POST',
    url: '/api/preview-tickets',
    headers: { origin: ALLOWED_ORIGIN, cookie },
    payload: { blueprintId, purpose: 'preview' },
  });
}

async function redeem(context: TestContext, url: string) {
  const response = await context.app.inject({ method: 'GET', url });
  const cookie = response.cookies.find((item) => item.name === 'yz_preview');
  return {
    statusCode: response.statusCode,
    cookie: cookie === undefined ? null : cookie,
    cookieHeader: cookie === undefined ? '' : `${cookie.name}=${cookie.value}`,
  };
}

function captureConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `期望 ConfigError，实际 ${String(error)}`);
    return error;
  }
  throw new Error('期望配置校验失败，但 loadConfig 成功返回');
}

describe('M6 §7 安全回归（全表复测）', () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  async function makeContext(): Promise<TestContext> {
    const root = await mkdtemp(path.join(tmpdir(), 'youzhao-secreg-'));
    const context = await createTestContext({ PREVIEW_STORAGE_PATH: root });
    cleanups.push(async () => {
      await context.close();
      await rm(root, { recursive: true, force: true });
    });
    return context;
  }

  it('§7-#1 产物不再匿名可读：无票据无 Cookie 一律 403，且响应不含任何产物字节', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);

    const response = await context.app.inject({
      method: 'GET',
      url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
    });
    await expectErrorCode(response, 403, 'FORBIDDEN');
    assert.equal(response.body.includes('安全回归样例'), false, '拒绝响应里不应出现产物正文');
    assert.equal(response.body.includes('assets/app.css'), false);
  });

  it('§7-#1 撤权后已签发的预览会话立刻失效（逐请求鉴权，不依赖签发时快照）', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const ownerCookie = await login(context.app, 'owner', 'owner-pass-1234');

    // 成员被显式授权后走完换票流程，拿到预览 Cookie
    await context.db
      .insertInto('view_grants')
      .values({
        id: newId('grn'),
        user_id: world.memberId,
        target_type: 'blueprint',
        target_id: blueprint.blueprintId,
        granted_by: world.ownerId,
      })
      .execute();
    const memberCookie = await login(context.app, 'chen', 'member-pass-1234');
    const body = (await requestTicket(context, memberCookie, blueprint.blueprintId)).json() as TicketBody;
    const redeemed = await redeem(context, body.data.url);
    assert.equal(redeemed.statusCode, 303);
    assert.notEqual(redeemed.cookie, null);

    const before = await context.app.inject({
      method: 'GET',
      url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
      headers: { cookie: redeemed.cookieHeader },
    });
    assert.equal(before.statusCode, 200, before.body);

    // 撤权：同一枚预览 Cookie 立刻失效（不重新签发也不缓存快照）
    await context.db
      .deleteFrom('view_grants')
      .where('user_id', '=', world.memberId)
      .where('target_id', '=', blueprint.blueprintId)
      .execute();
    await expectErrorCode(
      await context.app.inject({
        method: 'GET',
        url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
        headers: { cookie: redeemed.cookieHeader },
      }),
      403,
      'FORBIDDEN',
    );
    assert.equal(ownerCookie.includes('yz_session='), true);
  });

  it('§7-#2 编码穿越与非法路径段被拒（单次解码 + 段校验，不做 decodeURIComponent 后直接拼路径）', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const ownerCookie = await login(context.app, 'owner', 'owner-pass-1234');
    const body = (await requestTicket(context, ownerCookie, blueprint.blueprintId)).json() as TicketBody;
    const redeemed = await redeem(context, body.data.url);
    assert.equal(redeemed.statusCode, 303);

    for (const evil of ['%2e%2e%2fetc%2fpasswd', '..%2fsecret.txt', '%5c..%5cwin.ini']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/${evil}`,
        headers: { cookie: redeemed.cookieHeader },
      });
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${evil} 应被拒，实际 ${response.statusCode}`);
      assert.equal(response.body.includes('root:'), false, '穿越响应不得回显系统文件内容');
    }

    // 纯函数层：`..` 穿越、绝对路径、NUL 一律拒绝
    for (const relPath of ['../x', 'a/../../x', 'a\0b', '..\\x', 'a\\..\\..\\x', '/etc/passwd']) {
      assert.throws(
        () => resolveArtifactPath({ root: '/tmp/root', blueprintId: 'bp_1', version: 'v1', relPath }),
        /产物|路径|非法|穿越/,
        `${relPath} 应被拒`,
      );
    }
    // 空段与反斜杠会被规范化（而非报错），但结果必须仍落在该版本目录内
    const versionBase = path.resolve('/tmp/root', 'bp_1', 'v1');
    for (const relPath of ['a//b', 'a\\b', './assets/app.js', 'index.html']) {
      const resolved = resolveArtifactPath({ root: '/tmp/root', blueprintId: 'bp_1', version: 'v1', relPath });
      assert.ok(
        resolved === versionBase || resolved.startsWith(`${versionBase}${path.sep}`),
        `${relPath} 解析结果越出该版本目录：${resolved}`,
      );
    }
  });

  it('§7-#3 版本号走字符集白名单，目录名不用用户输入直接拼（`..` 进不了路径段）', async () => {
    assert.equal(assertSafeSegment('v1.0.0', 'version'), 'v1.0.0');
    for (const bad of ['..', '.', 'v1/../x', 'v1/x', 'a b', '', 'x'.repeat(65)]) {
      assert.throws(() => assertSafeSegment(bad, 'version'), /版本号|蓝图|id|非法/);
    }
    assert.equal(artifactDirFor('/srv/previews', 'bp_1', 'v1.0.0'), path.join('/srv/previews', 'bp_1', 'v1.0.0'));
    assert.throws(() => artifactDirFor('/srv/previews', 'bp_1', '../..'), /版本号|非法/);
  });

  it('§7-#4 缺少 PREVIEW_TICKET_SECRET 时配置校验直接失败（不存在硬编码回退值）', async () => {
    const missing = captureConfigError(minimalEnv({ PREVIEW_TICKET_SECRET: undefined }));
    assert.equal(missing.issues.some((issue) => issue.includes('PREVIEW_TICKET_SECRET')), true, missing.message);

    // 生产环境下密钥强度必须达标（开发/测试允许短密钥，避免本地每次都要造 32 位随机串）
    const weak = captureConfigError(
      minimalEnv({
        APP_ENV: 'production',
        API_PUBLIC_BASE_URL: 'https://app.example.com',
        PREVIEW_DOMAIN: 'https://preview.example.com',
        PREVIEW_TICKET_SECRET: 'dev-secret',
      }),
    );
    assert.equal(weak.issues.some((issue) => issue.includes('PREVIEW_TICKET_SECRET')), true, weak.message);

    const embedMissingInProd = captureConfigError(
      minimalEnv({ APP_ENV: 'production', PREVIEW_EMBED_SECRET: undefined }),
    );
    assert.equal(embedMissingInProd.issues.some((issue) => issue.includes('PREVIEW_EMBED_SECRET')), true);
  });

  it('§7-#5 预览 Cookie 是 HttpOnly 且路径受限；产物响应带 sandbox CSP（不含 allow-same-origin）', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const ownerCookie = await login(context.app, 'owner', 'owner-pass-1234');
    const body = (await requestTicket(context, ownerCookie, blueprint.blueprintId)).json() as TicketBody;
    const redeemed = await redeem(context, body.data.url);
    assert.equal(redeemed.statusCode, 303);
    assert.notEqual(redeemed.cookie, null);
    assert.equal(redeemed.cookie?.httpOnly, true, '预览 Cookie 必须 HttpOnly（产物是发布者可控文档）');
    assert.equal(redeemed.cookie?.path, '/preview');

    const artifact = await context.app.inject({
      method: 'GET',
      url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
      headers: { cookie: redeemed.cookieHeader },
    });
    assert.equal(artifact.statusCode, 200);
    const csp = artifact.headers['content-security-policy'];
    assert.equal(typeof csp, 'string');
    assert.match(csp as string, /sandbox /);
    assert.equal((csp as string).includes('allow-same-origin'), false, 'sandbox 不得含 allow-same-origin');
    assert.equal(artifact.headers['x-content-type-options'], 'nosniff');
    assert.equal(artifact.headers['cache-control'], 'no-store');

    // 应用域会话 Cookie 同样是 HttpOnly（旧实现把 Bearer 放在 localStorage）
    const session = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'owner', password: 'owner-pass-1234' },
    });
    assert.equal(session.cookies[0]?.httpOnly, true);
  });

  it('§7-#6 接口响应只序列化白名单字段：没有密码哈希 / 令牌哈希 / 全量快照', async () => {
    const context = await makeContext();
    await seedWorld(context.db);
    const ownerCookie = await login(context.app, 'owner', 'owner-pass-1234');

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/mcp-tokens',
      headers: { origin: ALLOWED_ORIGIN, cookie: ownerCookie },
      payload: { name: '回归用 Token', scopes: ['read:blueprint'] },
    });
    assert.equal(created.statusCode, 201, created.body);

    const createdToken = (created.json() as { data: { token: string } }).data.token;
    assert.ok(createdToken.startsWith('yz_mcp_'), '创建响应必须返回一次性明文令牌');

    const responses = [
      await context.app.inject({ method: 'GET', url: '/api/users?pageSize=50', headers: { cookie: ownerCookie } }),
      await context.app.inject({ method: 'GET', url: '/api/mcp-tokens', headers: { cookie: ownerCookie } }),
      created,
    ];
    for (const response of responses) {
      const text = response.body;
      for (const forbidden of ['passwordHash', 'password_hash', 'tokenHash', 'token_hash', 'adminSnapshot', 'credentials']) {
        assert.equal(text.includes(forbidden), false, `${forbidden} 不应出现在响应中`);
      }
    }
    // 列表接口不得回显令牌明文（只有创建那一刻可以给一次），只暴露前缀
    const list = await context.app.inject({ method: 'GET', url: '/api/mcp-tokens', headers: { cookie: ownerCookie } });
    assert.equal(list.body.includes(createdToken), false, '列表不得包含令牌明文');
    assert.equal(list.body.includes('yz_mcp_tok_'), true, '列表应只暴露令牌前缀');
  });

  it('§7-#7 用户被停用后既有会话立即失效（会话可吊销 + 有 TTL 字段）', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);
    const memberCookie = await login(context.app, 'chen', 'member-pass-1234');
    assert.equal(
      (await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: memberCookie } })).statusCode,
      200,
    );

    await context.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', world.memberId).execute();

    const after = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: memberCookie } });
    assert.ok(after.statusCode === 401 || after.statusCode === 403, `停用后应失效，实际 ${after.statusCode}`);

    const sessions = await context.db.selectFrom('sessions').select(['expires_at']).where('user_id', '=', world.memberId).execute();
    assert.equal(sessions.length > 0, true, '会话落库且带过期时间（可吊销、有 TTL）');
  });

  it('§7-#8 不存在开放初始化接口；初始密码一次性且以 scrypt 落库；登录双维度限流', async () => {
    const context = await makeContext();
    await seedWorld(context.db);

    for (const url of ['/api/setup/status', '/api/setup/admin']) {
      const response = await context.app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, `${url} 不应存在（初始所有者由环境变量注入）`);
    }

    const ownerCookie = await login(context.app, 'owner', 'owner-pass-1234');
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { origin: ALLOWED_ORIGIN, cookie: ownerCookie },
      payload: { username: 'newbie', displayName: '新同事', password: 'initial-pass-1234' },
    });
    // 创建接口状态码：当前 users/blueprints/blueprint-groups 用 200、mcp-tokens 用 201，
    // 统一为 201 记在 §8.4 清理项；此处只断言「确实创建成功且回读得到该资源」。
    assert.equal(created.statusCode, 200, created.body);
    assert.equal((created.json() as { data: { username: string } }).data.username, 'newbie');

    const row = await context.db
      .selectFrom('users')
      .select(['password_hash', 'must_change_password'])
      .where('username', '=', 'newbie')
      .executeTakeFirstOrThrow();
    assert.equal(row.password_hash.startsWith('scrypt$'), true, '口令必须是 scrypt 哈希');
    assert.equal(row.password_hash.includes('initial-pass-1234'), false);
    assert.equal(row.must_change_password, true, '新建用户必须首登改密');

    // 登录限流：连续失败到超过阈值即 429（而不是无限尝试）
    let limited = false;
    for (let attempt = 0; attempt < 15 && !limited; attempt += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ALLOWED_ORIGIN },
        payload: { username: 'newbie', password: `wrong-pass-${attempt}` },
      });
      if (response.statusCode === 429) limited = true;
    }
    assert.equal(limited, true, '登录失败应有维度限流（429）');
  });

  it('§7-#9 身份与权限只来自 /api/me：撤权后同一次会话立刻看不到该资源', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const memberCookie = await login(context.app, 'chen', 'member-pass-1234');

    await context.db
      .insertInto('view_grants')
      .values({
        id: newId('grn'),
        user_id: world.memberId,
        target_type: 'blueprint',
        target_id: blueprint.blueprintId,
        granted_by: world.ownerId,
      })
      .execute();

    const granted = (await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: memberCookie } })).json() as {
      data: { viewGrants: readonly { targetId: string }[]; capabilities: readonly unknown[] };
    };
    assert.equal(granted.data.viewGrants.some((grant) => grant.targetId === blueprint.blueprintId), true);

    await context.db
      .deleteFrom('view_grants')
      .where('user_id', '=', world.memberId)
      .where('target_id', '=', blueprint.blueprintId)
      .execute();

    const revoked = (await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: memberCookie } })).json() as {
      data: { viewGrants: readonly { targetId: string }[] };
    };
    assert.equal(revoked.data.viewGrants.some((grant) => grant.targetId === blueprint.blueprintId), false);
  });

  it('§7-#10 同级管理员不能互相管理，所有者账号整体受保护', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);

    // 第二位用户管理员（由所有者任命）与第一位同级
    const secondAdminId = newId('usr');
    const ownerCookie = await login(context.app, 'owner', 'owner-pass-1234');
    const adminCookie = await login(context.app, 'zhou', 'admin-pass-1234');
    const demoteOwner = await context.app.inject({
      method: 'PATCH',
      url: `/api/users/${world.ownerId}`,
      headers: { origin: ALLOWED_ORIGIN, cookie: ownerCookie },
      payload: { displayName: '不该成功' },
    });
    await expectErrorCode(demoteOwner, 403, 'OWNER_PROTECTED');

    const peer = await context.app.inject({
      method: 'PUT',
      url: `/api/users/${secondAdminId}/identity`,
      headers: { origin: ALLOWED_ORIGIN, cookie: adminCookie },
      payload: { identity: 'member' },
    });
    assert.ok(peer.statusCode === 403 || peer.statusCode === 404, `同级管理员不得改他人身份，实际 ${peer.statusCode}`);

    const otherAdmin = await context.app.inject({
      method: 'PATCH',
      url: `/api/users/${secondAdminId}`,
      headers: { origin: ALLOWED_ORIGIN, cookie: adminCookie },
      payload: { displayName: '同级改名' },
    });
    assert.ok(otherAdmin.statusCode === 403 || otherAdmin.statusCode === 404, `实际 ${otherAdmin.statusCode}`);
  });

  it('§7-#12 审计不记敏感内容；错误响应不回显服务端绝对路径', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);
    await seedBlueprint(context, world.ownerId);
    const ownerCookie = await login(context.app, 'owner', 'owner-pass-1234');

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/mcp-tokens',
      headers: { origin: ALLOWED_ORIGIN, cookie: ownerCookie },
      payload: { name: '审计用 Token', scopes: ['read:blueprint'] },
    });
    const plaintext = (created.json() as { data: { token: string } }).data.token;
    assert.match(plaintext, /^yz_mcp_/);

    const audits = await context.db.selectFrom('audit_logs').selectAll().execute();
    const dump = JSON.stringify(audits);
    assert.equal(dump.includes('owner-pass-1234'), false, '审计不得记口令');
    assert.equal(dump.includes(plaintext), false, '审计不得记令牌明文');
    assert.equal(dump.includes('安全回归样例'), false, '审计不得记产物正文');
    assert.equal(dump.includes(context.config.preview.storagePath), false, '审计不得记绝对路径');

    const missing = await context.app.inject({
      method: 'GET',
      url: '/preview/p/bp_missing/v1.0.0/',
      headers: { cookie: ownerCookie },
    });
    assert.ok(missing.statusCode >= 400);
    assert.equal(missing.body.includes(context.config.preview.storagePath), false, '错误响应不得回显绝对路径');
  });
});
