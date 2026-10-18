/**
 * M6 验收：列表分页性能（`docs/architecture-design.md` §8 M6 行「性能（列表 1000 条分页）」）。
 *
 * 跑在 PGlite（WASM、单线程）上，绝对耗时比真实 PostgreSQL 慢一个量级，
 * 所以断言取「宽松上限 + 深页与首页同量级」，重点是证明两件事：
 * 1) 1000 条数据下分页元数据与页大小正确（不是把全表读进内存再切片）；
 * 2) 深页（page=50）耗时与首页同量级 —— 若实现退化成「全量加载后切片」，深页会成倍变慢。
 * 实测值打印在用例标题里，便于留档。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { hashPassword } from '../domain/password.js';
import { createTestContext, login, seedWorld, type TestContext } from './http-helpers.js';

const TOTAL = 1000;
const BATCH = 250;

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += size) result.push(rows.slice(start, start + size));
  return result;
}

interface PageBody {
  readonly data: { readonly items: readonly unknown[]; readonly groups?: readonly unknown[]; readonly total: number };
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

describe('M6 验收：列表 1000 条分页', () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  async function makeContext(): Promise<TestContext> {
    const context = await createTestContext();
    cleanups.push(() => context.close());
    return context;
  }

  it(`1000 条蓝图：首页与深页分页正确，深页耗时与首页同量级`, async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);

    const blueprintRows = [];
    const versionRows = [];
    for (let index = 1; index <= TOTAL; index += 1) {
      const suffix = String(index).padStart(4, '0');
      const id = `bp_perf_${suffix}`;
      blueprintRows.push({
        id,
        name: `性能蓝图 ${index}`,
        summary: '分页性能用例',
        tags: ['性能'],
        group_id: 'group_default',
        status: 'active' as const,
        created_by_user_id: world.ownerId,
      });
      versionRows.push({
        id: `ver_perf_${suffix}`,
        blueprint_id: id,
        version: 'v1.0.0',
        is_latest: true,
        status: 'available' as const,
        entry_path: 'index.html',
        artifact_path: `/tmp/youzhao-perf/${id}/v1.0.0`,
        artifact_hash: '0'.repeat(64),
        artifact_bytes: 1024,
        publish_source: 'web' as const,
        publish_note: '',
      });
    }
    for (const chunk of chunks(blueprintRows, BATCH)) {
      await context.db.insertInto('blueprints').values(chunk).execute();
    }
    for (const chunk of chunks(versionRows, BATCH)) {
      await context.db.insertInto('blueprint_versions').values(chunk).execute();
    }

    const cookie = await login(context.app, 'owner', 'owner-pass-1234');
    async function fetchPage(page: number): Promise<{ statusCode: number; ms: number; body: PageBody }> {
      const started = Date.now();
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/blueprints?page=${page}&pageSize=20`,
        headers: { cookie },
      });
      return { statusCode: response.statusCode, ms: Date.now() - started, body: response.json() as PageBody };
    }

    const first = await fetchPage(1);
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.meta.total, TOTAL);
    assert.equal(first.body.meta.pageSize, 20);
    assert.equal(first.body.data.items.length, 20);
    assert.equal((first.body.data.groups ?? []).length > 0, true, '分组卡片随列表返回');

    const middle = await fetchPage(25);
    assert.equal(middle.body.meta.page, 25);
    assert.equal(middle.body.data.items.length, 20);

    const deep = await fetchPage(50);
    assert.equal(deep.body.meta.total, TOTAL);
    assert.equal(deep.body.data.items.length, 20);

    // 深页不得退化成「全量加载后切片」：耗时与首页同量级（宽松 4 倍 + 400ms 底噪）
    assert.ok(
      deep.ms <= Math.max(400, first.ms * 4),
      `深页 ${deep.ms}ms 明显慢于首页 ${first.ms}ms（疑似全量加载后切片）`,
    );
    assert.ok(first.ms < 3000, `首页耗时 ${first.ms}ms 超出 PGlite 宽松上限`);

    console.log(`[性能] 蓝图列表 1000 条：首页 ${first.ms}ms / 第 25 页 ${middle.ms}ms / 第 50 页 ${deep.ms}ms`);
  });

  it('1000 名成员：用户列表分页元数据正确，且深页不劣化', async () => {
    const context = await makeContext();
    const world = await seedWorld(context.db);

    // scrypt 很贵（每条约 100ms），这里只算一次哈希后复用——性能关注的是读路径。
    const sharedHash = await hashPassword('perf-pass-1234');
    const userRows = [];
    const identityRows = [];
    for (let index = 1; index <= TOTAL; index += 1) {
      const suffix = String(index).padStart(4, '0');
      const id = `usr_perf_${suffix}`;
      userRows.push({
        id,
        username: `perf_user_${suffix}`,
        display_name: `性能成员 ${index}`,
        status: 'active' as const,
        password_hash: sharedHash,
        must_change_password: false,
        created_by_user_id: world.adminId,
      });
      identityRows.push({ user_id: id, identity: 'member' as const, granted_by: world.ownerId });
    }
    for (const chunk of chunks(userRows, BATCH)) await context.db.insertInto('users').values(chunk).execute();
    for (const chunk of chunks(identityRows, BATCH)) await context.db.insertInto('user_identity').values(chunk).execute();

    const cookie = await login(context.app, 'owner', 'owner-pass-1234');
    async function fetchPage(page: number): Promise<{ statusCode: number; ms: number; body: PageBody }> {
      const started = Date.now();
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/users?page=${page}&pageSize=20`,
        headers: { cookie },
      });
      return { statusCode: response.statusCode, ms: Date.now() - started, body: response.json() as PageBody };
    }

    const first = await fetchPage(1);
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.meta.total, TOTAL + 3, '1000 名性能成员 + 标准世界的 3 个账号');
    assert.equal(first.body.data.items.length, 20);

    const deep = await fetchPage(50);
    assert.equal(deep.body.meta.total, TOTAL + 3);
    assert.equal(deep.body.data.items.length, 20);
    assert.ok(
      deep.ms <= Math.max(400, first.ms * 4),
      `深页 ${deep.ms}ms 明显慢于首页 ${first.ms}ms（疑似全量加载后切片）`,
    );

    console.log(`[性能] 用户列表 1003 条：首页 ${first.ms}ms / 第 50 页 ${deep.ms}ms`);
  });
});
