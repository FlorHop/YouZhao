/**
 * 预览域交付与嵌入票据（§3.6、§3.7）的端到端测试。
 *
 * 这一层要证明的行为与旧实现直接相对：
 * - 产物**不再匿名可读**：没有票据、没有预览 Cookie 就取不到任何字节；
 * - 票据**一次性**、与蓝图+版本绑定、过期即失效；
 * - 归档 / 撤权 / 停用**立刻**生效（不依赖签发快照）；
 * - 嵌入凭共享密钥换票，未配置即视为未启用，不存在硬编码回退值。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { hashTicket } from '../app/preview.js';
import { newId } from '../domain/ids.js';
import { writeArtifactPackage } from '../storage/artifacts.js';
import type { ZipEntry } from '../storage/zip.js';
import { ALLOWED_ORIGIN } from './helpers.js';
import {
  createTestContext,
  expectErrorCode,
  login,
  seedWorld,
  type TestContext,
} from './http-helpers.js';

const EMBED_SECRET = 'local-dev-embed-secret-0123456789';

const INDEX_HTML = [
  '<!doctype html><html><head><title>示例蓝图</title>',
  '<link rel="stylesheet" href="assets/app.css"></head>',
  '<body><div id="app">示例蓝图</div><script src="assets/app.js"></script></body></html>',
].join('');

function sampleFiles(): ZipEntry[] {
  return [
    { path: 'index.html', bytes: Buffer.from(INDEX_HTML) },
    { path: 'assets/app.css', bytes: Buffer.from('body{color:#111}') },
    { path: 'assets/app.js', bytes: Buffer.from('document.title="示例蓝图"') },
  ];
}

interface SeededBlueprint {
  readonly blueprintId: string;
  readonly version: string;
  readonly groupId: string;
}

/** 直接按 0003 的列写一行蓝图 + 一个版本，并把真实产物落盘（不走 HTTP，避免依赖 M2 路由）。 */
async function seedBlueprint(
  context: TestContext,
  ownerId: string,
  options: { version?: string; blueprintStatus?: 'active' | 'archived'; versionStatus?: 'available' | 'missing' } = {},
): Promise<SeededBlueprint> {
  const blueprintId = newId('bp');
  const version = options.version ?? 'v1.0.0';
  const groupId = 'group_default';

  await context.db
    .insertInto('blueprints')
    .values({
      id: blueprintId,
      name: '示例蓝图',
      summary: '用于预览测试',
      tags: ['测试'],
      group_id: groupId,
      status: options.blueprintStatus ?? 'active',
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
      status: options.versionStatus ?? 'available',
      entry_path: 'index.html',
      artifact_path: published.artifactPath,
      artifact_hash: published.hash,
      artifact_bytes: published.bytes,
      publish_source: 'web',
      publish_note: '测试',
    })
    .execute();

  return { blueprintId, version, groupId };
}

async function grantView(context: TestContext, userId: string, blueprintId: string, grantedBy: string): Promise<void> {
  await context.db
    .insertInto('view_grants')
    .values({
      id: newId('grn'),
      user_id: userId,
      target_type: 'blueprint',
      target_id: blueprintId,
      granted_by: grantedBy,
    })
    .execute();
}

async function requestTicket(
  context: TestContext,
  cookie: string | null,
  blueprintId: string,
  purpose: 'preview' | 'embed' = 'preview',
): Promise<{ statusCode: number; body: string; json(): unknown; cookies: readonly { name: string; value: string }[] }> {
  return context.app.inject({
    method: 'POST',
    url: '/api/preview-tickets',
    headers: cookie === null ? { origin: ALLOWED_ORIGIN } : { origin: ALLOWED_ORIGIN, cookie },
    payload: { blueprintId, purpose },
  }) as never;
}

async function redeem(context: TestContext, url: string): Promise<{ statusCode: number; previewCookie: string | null }> {
  const response = await context.app.inject({ method: 'GET', url });
  const cookie = response.cookies.find((item) => item.name === 'yz_preview');
  return { statusCode: response.statusCode, previewCookie: cookie === undefined ? null : `${cookie.name}=${cookie.value}` };
}

describe('预览域交付与嵌入票据', () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  async function makeContext(overrides: Record<string, string | undefined> = {}): Promise<{ context: TestContext; root: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'youzhao-preview-'));
    const context = await createTestContext({ PREVIEW_STORAGE_PATH: root, ...overrides });
    cleanups.push(async () => {
      await context.close();
      await rm(root, { recursive: true, force: true });
    });
    return { context, root };
  }

  it('所有者无需 view_grants 即可申请票据（隐式能力覆盖全部资源）', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const cookie = await login(context.app, 'owner', 'owner-pass-1234');

    const response = await requestTicket(context, cookie, blueprint.blueprintId);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { data: { url: string; purpose: string; version: string } };
    assert.equal(body.data.purpose, 'preview');
    assert.equal(body.data.version, blueprint.version);
    assert.match(body.data.url, /^http:\/\/127\.0\.0\.1:3001\/preview\/p\/bp_/);
  });

  it('没有查看权的成员申请票据被拒（403 FORBIDDEN）', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const cookie = await login(context.app, 'chen', 'member-pass-1234');

    const response = await requestTicket(context, cookie, blueprint.blueprintId);
    await expectErrorCode(response, 403, 'FORBIDDEN');
  });

  it('授权后可申请；撤权后立刻被拒（不依赖签发快照）', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const cookie = await login(context.app, 'chen', 'member-pass-1234');

    await grantView(context, world.memberId, blueprint.blueprintId, world.ownerId);
    assert.equal((await requestTicket(context, cookie, blueprint.blueprintId)).statusCode, 200);

    await context.db
      .deleteFrom('view_grants')
      .where('user_id', '=', world.memberId)
      .where('target_id', '=', blueprint.blueprintId)
      .execute();
    await expectErrorCode(await requestTicket(context, cookie, blueprint.blueprintId), 403, 'FORBIDDEN');
  });

  it('换票一次有效：首次 303 + 预览 Cookie，票据用第二次被拒', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const cookie = await login(context.app, 'owner', 'owner-pass-1234');
    const ticket = ((await requestTicket(context, cookie, blueprint.blueprintId)).json() as { data: { url: string } }).data.url;

    const first = await redeem(context, ticket);
    assert.equal(first.statusCode, 303);
    assert.notEqual(first.previewCookie, null);

    // 预览域会话已建立：同址再取（无票据）应能拿到产物
    const again = await context.app.inject({
      method: 'GET',
      url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
      headers: { cookie: first.previewCookie ?? '' },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.headers['content-type'], 'text/html; charset=utf-8');

    await expectErrorCode(await context.app.inject({ method: 'GET', url: ticket }), 403, 'FORBIDDEN');
  });

  it('票据与请求的蓝图版本不匹配时被拒', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const one = await seedBlueprint(context, world.ownerId);
    const two = await seedBlueprint(context, world.ownerId, { version: 'v2.0.0' });
    const cookie = await login(context.app, 'owner', 'owner-pass-1234');
    const ticket = ((await requestTicket(context, cookie, one.blueprintId)).json() as { data: { url: string } }).data.url;

    const wrong = ticket.replace(one.blueprintId, two.blueprintId);
    await expectErrorCode(await context.app.inject({ method: 'GET', url: wrong }), 403, 'FORBIDDEN');
  });

  it('过期票据被拒（403）', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const raw = 'yz_pt_expired-ticket-for-test';
    await context.db
      .insertInto('preview_tickets')
      .values({
        id: newId('tkt'),
        ticket_hash: hashTicket(raw),
        blueprint_id: blueprint.blueprintId,
        version: blueprint.version,
        issued_to_user_id: world.ownerId,
        purpose: 'preview',
        expires_at: new Date(Date.now() - 60_000),
      })
      .execute();

    await expectErrorCode(
      await context.app.inject({ method: 'GET', url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/?t=${raw}` }),
      403,
      'FORBIDDEN',
    );
  });

  it('没有票据也没有预览 Cookie 时取产物被拒（匿名可读的旧行为已消失）', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);

    await expectErrorCode(
      await context.app.inject({ method: 'GET', url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/` }),
      403,
      'FORBIDDEN',
    );
  });

  it('换票后子资源可读，并带 nosniff 与 CSP 头', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const cookie = await login(context.app, 'owner', 'owner-pass-1234');
    const ticket = ((await requestTicket(context, cookie, blueprint.blueprintId)).json() as { data: { url: string } }).data.url;
    const { previewCookie } = await redeem(context, ticket);

    const asset = await context.app.inject({
      method: 'GET',
      url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/assets/app.js`,
      headers: { cookie: previewCookie ?? '' },
    });
    assert.equal(asset.statusCode, 200, asset.body);
    assert.equal(asset.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');
    assert.equal(asset.headers['cache-control'], 'no-store');
    assert.match(String(asset.headers['content-security-policy']), /default-src 'none'/);

    const html = await context.app.inject({
      method: 'GET',
      url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
      headers: { cookie: previewCookie ?? '' },
    });
    const csp = String(html.headers['content-security-policy']);
    assert.match(csp, /sandbox allow-scripts allow-popups/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, new RegExp(`frame-ancestors ${ALLOWED_ORIGIN.replace(/\./g, '\\.')}`));
    assert.match(html.body, /示例蓝图/);
  });

  it('产物路径穿越被拒（编码后的 .. 也不能越出产物目录）', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const cookie = await login(context.app, 'owner', 'owner-pass-1234');
    const ticket = ((await requestTicket(context, cookie, blueprint.blueprintId)).json() as { data: { url: string } }).data.url;
    const { previewCookie } = await redeem(context, ticket);

    const traversal = await context.app.inject({
      method: 'GET',
      url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      headers: { cookie: previewCookie ?? '' },
    });
    assert.ok(
      traversal.statusCode === 400 || traversal.statusCode === 403,
      `期望 400/403，实际 ${traversal.statusCode}：${traversal.body}`,
    );
  });

  it('归档蓝图后：新票据申请 404、已换票的预览 403', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    const cookie = await login(context.app, 'owner', 'owner-pass-1234');
    const ticket = ((await requestTicket(context, cookie, blueprint.blueprintId)).json() as { data: { url: string } }).data.url;
    const { previewCookie } = await redeem(context, ticket);
    assert.equal(
      (
        await context.app.inject({
          method: 'GET',
          url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
          headers: { cookie: previewCookie ?? '' },
        })
      ).statusCode,
      200,
    );

    await context.db
      .updateTable('blueprints')
      .set({ status: 'archived', archived_at: new Date() })
      .where('id', '=', blueprint.blueprintId)
      .execute();

    await expectErrorCode(await requestTicket(context, cookie, blueprint.blueprintId), 404, 'BLUEPRINT_NOT_FOUND');
    await expectErrorCode(
      await context.app.inject({
        method: 'GET',
        url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
        headers: { cookie: previewCookie ?? '' },
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('停用用户后，其已换票的预览立即失效', async () => {
    const { context } = await makeContext();
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);
    await grantView(context, world.memberId, blueprint.blueprintId, world.ownerId);
    const cookie = await login(context.app, 'chen', 'member-pass-1234');
    const ticket = ((await requestTicket(context, cookie, blueprint.blueprintId)).json() as { data: { url: string } }).data.url;
    const { previewCookie } = await redeem(context, ticket);

    await context.db.updateTable('users').set({ status: 'disabled' }).where('id', '=', world.memberId).execute();

    await expectErrorCode(
      await context.app.inject({
        method: 'GET',
        url: `/preview/p/${blueprint.blueprintId}/${blueprint.version}/`,
        headers: { cookie: previewCookie ?? '' },
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('嵌入换票：密钥缺失或不正确回 401，正确密钥无会话也能换票', async () => {
    const { context } = await makeContext({ PREVIEW_EMBED_SECRET: EMBED_SECRET });
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);

    const missing = await context.app.inject({
      method: 'POST',
      url: '/api/embed/tickets',
      payload: { blueprintId: blueprint.blueprintId },
    });
    await expectErrorCode(missing, 401, 'UNAUTHENTICATED');

    const wrong = await context.app.inject({
      method: 'POST',
      url: '/api/embed/tickets',
      headers: { 'x-embed-secret': 'not-the-secret' },
      payload: { blueprintId: blueprint.blueprintId },
    });
    await expectErrorCode(wrong, 401, 'UNAUTHENTICATED');

    const ok = await context.app.inject({
      method: 'POST',
      url: '/api/embed/tickets',
      headers: { 'x-embed-secret': EMBED_SECRET },
      payload: { blueprintId: blueprint.blueprintId },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((ok.json() as { data: { purpose: string } }).data.purpose, 'embed');
  });

  it('未配置嵌入密钥时嵌入接口回 503，而不是回退到任何默认密钥', async () => {
    const { context } = await makeContext({ PREVIEW_EMBED_SECRET: '' });
    const world = await seedWorld(context.db);
    const blueprint = await seedBlueprint(context, world.ownerId);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/embed/tickets',
      headers: { 'x-embed-secret': 'youzhao_embed_dev_secret' },
      payload: { blueprintId: blueprint.blueprintId },
    });
    await expectErrorCode(response, 503, 'SERVICE_UNAVAILABLE');
  });

  it('嵌入票据申请对不存在的蓝图回 404（不泄露存在性以外的信息）', async () => {
    const { context } = await makeContext({ PREVIEW_EMBED_SECRET: EMBED_SECRET });
    await seedWorld(context.db);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/embed/tickets',
      headers: { 'x-embed-secret': EMBED_SECRET },
      payload: { blueprintId: 'bp_not_exists' },
    });
    await expectErrorCode(response, 404, 'BLUEPRINT_NOT_FOUND');
  });
});
