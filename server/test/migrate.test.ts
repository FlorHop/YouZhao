import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  MIGRATIONS_DIR,
  assertMigrationsApplied,
  loadMigrations,
  planMigrations,
  runMigrations,
  type MigrationRunner,
  type Queryable,
} from '../db/migrate.js';

/** PGlite 客户端最小面（query 走扩展协议；exec 走简单协议，可一次执行多条语句） */
interface PgliteClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  exec(sql: string): Promise<unknown>;
}

/**
 * 迁移文件是多语句的 SQL：PGlite 的 query() 走扩展协议，一次只能一条语句，
 * 因此无参时改用 exec()（简单协议）。生产侧 pg 的 query() 在无参时同样是简单协议，语义一致。
 */
function queryable(client: PgliteClient): Queryable {
  return {
    query: async (sql, params) => {
      if (params && params.length > 0) {
        const result = (await client.query(sql, params)) as { rows: Array<Record<string, unknown>> };
        return { rows: result.rows };
      }
      const results = (await client.exec(sql)) as Array<{ rows: Array<Record<string, unknown>> }>;
      return { rows: results.at(-1)?.rows ?? [] };
    },
  };
}

function runnerFor(db: PGlite): MigrationRunner {
  return {
    ...queryable(db),
    transaction: (fn) => db.transaction((tx) => fn(queryable(tx))),
  };
}

async function tempMigrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'youzhao-migrations-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

test('迁移可重复执行：第二次运行不再执行任何语句', async () => {
  const db = new PGlite();
  try {
    // 期望值从仓库迁移目录推导，避免每加一个迁移就要改测试
    const expected = (await loadMigrations(MIGRATIONS_DIR)).map((migration) => migration.file);
    assert.ok(expected.length > 0);

    const first = await runMigrations(runnerFor(db));
    assert.deepEqual(first.applied, expected);
    assert.equal(first.alreadyApplied, 0);

    const second = await runMigrations(runnerFor(db));
    assert.deepEqual(second.applied, []);
    assert.equal(second.alreadyApplied, expected.length);

    const table = await db.query<{ name: string | null }>(
      "select to_regclass('public.app_settings') as name",
    );
    assert.equal(table.rows[0]?.name, 'app_settings');

    const recorded = await db.query<{ count: string }>(
      'select count(*)::text as count from schema_migrations',
    );
    assert.equal(recorded.rows[0]?.count, String(expected.length));

    await assertMigrationsApplied(runnerFor(db));
  } finally {
    await db.close();
  }
});

test('启动自检：有未执行的迁移 → 明确报错并指出文件名', async () => {
  const db = new PGlite();
  try {
    await assert.rejects(
      () => assertMigrationsApplied(runnerFor(db)),
      (error: Error) => {
        assert.match(error.message, /未执行的迁移/);
        assert.match(error.message, /0001_init\.sql/);
        assert.match(error.message, /pnpm -C server migrate/);
        return true;
      },
    );
  } finally {
    await db.close();
  }
});

test('历史迁移被修改 → 校验和失配，拒绝继续', async () => {
  const dir = await tempMigrationsDir({ '0001_init.sql': 'create table if not exists t1 (id int);' });
  const db = new PGlite();
  try {
    await runMigrations(runnerFor(db), { dir });
    await writeFile(
      path.join(dir, '0001_init.sql'),
      'create table if not exists t1 (id int);\n-- 事后偷偷改历史文件\n',
      'utf8',
    );
    await assert.rejects(
      () => planMigrations(runnerFor(db), { dir }),
      /校验和失配/,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('迁移在事务内执行：SQL 失败不留半应用状态', async () => {
  const dir = await tempMigrationsDir({
    '0001_init.sql': 'create table if not exists t2 (id int);',
    '0002_broken.sql': 'create table if not exists t3 (id int);\nselect * from does_not_exist;',
  });
  const db = new PGlite();
  try {
    await assert.rejects(() => runMigrations(runnerFor(db), { dir }));
    const t3 = await db.query<{ name: string | null }>("select to_regclass('public.t3') as name");
    assert.equal(t3.rows[0]?.name, null, '失败迁移里已执行的语句应被回滚');
    const applied = await db.query<{ count: string }>(
      'select count(*)::text as count from schema_migrations',
    );
    assert.equal(applied.rows[0]?.count, '1', '只有 0001 被记录');
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('迁移文件名必须符合 NNNN_name.sql', async () => {
  const dir = await tempMigrationsDir({ 'init.sql': 'select 1;' });
  try {
    await assert.rejects(() => loadMigrations(dir), /迁移文件名不合法/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('数据库版本比本地新 → 拒绝启动（避免用旧代码写新库）', async () => {
  const dir = await tempMigrationsDir({
    '0001_init.sql': 'create table if not exists t4 (id int);',
    '0002_more.sql': 'create table if not exists t5 (id int);',
  });
  const oldDir = await tempMigrationsDir({
    '0001_init.sql': 'create table if not exists t4 (id int);',
  });
  const db = new PGlite();
  try {
    await runMigrations(runnerFor(db), { dir });
    await assert.rejects(() => planMigrations(runnerFor(db), { dir: oldDir }), /未知的迁移版本 2/);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
    await rm(oldDir, { recursive: true, force: true });
  }
});

test('仓库内置迁移目录可被加载且版本号唯一', async () => {
  const migrations = await loadMigrations(MIGRATIONS_DIR);
  assert.ok(migrations.length >= 1);
  assert.equal(migrations[0]?.file, '0001_init.sql');
  const versions = migrations.map((migration) => migration.version);
  assert.deepEqual(versions, [...new Set(versions)]);
});
