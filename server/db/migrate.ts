/**
 * 迁移执行器（docs/architecture-design.md §3.2、§3.8 启动自检）。
 *
 * 设计要点：
 * - 纯 SQL 文件（`db/migrations/NNNN_name.sql`），按版本号顺序执行；
 * - `schema_migrations` 记录已执行版本与文件校验和，改过的历史文件会被发现（禁止偷偷改历史）；
 * - **可重复执行**：第二次运行不再执行任何语句；
 * - 每个迁移在一个事务里执行，失败即回滚，不留半应用状态；
 * - 启动时 `assertMigrationsApplied` 校验"没有未执行的迁移"，否则拒绝启动。
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

export interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
}

/** 迁移执行器只需要 `query`，pg.Pool / pg.Client / PGlite 都满足 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
}

/** 需要事务时用这个接口，避免把 BEGIN/COMMIT 发到不同的连接上 */
export interface MigrationRunner extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface Migration {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const migrations: Migration[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (match === null) {
      throw new Error(`迁移文件名不合法：${entry.name}（应为 NNNN_name.sql）`);
    }
    const sql = await readFile(path.join(dir, entry.name), 'utf8');
    migrations.push({
      version: Number.parseInt(match[1] ?? '0', 10),
      name: match[2] ?? '',
      file: entry.name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  migrations.sort((a, b) => a.version - b.version);

  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous !== undefined && current !== undefined && previous.version >= current.version) {
      throw new Error(`迁移版本号重复：${previous.file} 与 ${current.file}`);
    }
  }

  return migrations;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

async function ensureMigrationsTable(db: Queryable): Promise<void> {
  await db.query(`
    create table if not exists schema_migrations (
      version    integer primary key,
      name       text not null,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function readApplied(db: Queryable): Promise<Map<number, AppliedRow>> {
  const result = await db.query('select version, name, checksum from schema_migrations order by version');
  const applied = new Map<number, AppliedRow>();
  for (const row of result.rows) {
    const version = Number(row['version']);
    applied.set(version, {
      version,
      name: String(row['name']),
      checksum: String(row['checksum']),
    });
  }
  return applied;
}

export interface MigrationPlan {
  applied: Migration[];
  pending: Migration[];
}

/** 只计算"已执行 / 待执行"，不写库；校验和历史文件校验和检查也在这里 */
export async function planMigrations(
  db: Queryable,
  options: { dir?: string } = {},
): Promise<MigrationPlan> {
  await ensureMigrationsTable(db);
  const migrations = await loadMigrations(options.dir);
  const appliedRows = await readApplied(db);

  const applied: Migration[] = [];
  const pending: Migration[] = [];

  for (const migration of migrations) {
    const row = appliedRows.get(migration.version);
    if (row === undefined) {
      pending.push(migration);
      continue;
    }
    if (row.checksum !== migration.checksum) {
      throw new Error(
        `迁移 ${migration.file} 已执行过但内容被修改（校验和失配）。` +
          '历史迁移不可修改：请新增一个迁移文件来表达变更。',
      );
    }
    applied.push(migration);
  }

  const knownVersions = new Set(migrations.map((migration) => migration.version));
  for (const version of appliedRows.keys()) {
    if (!knownVersions.has(version)) {
      throw new Error(`数据库中存在未知的迁移版本 ${version}：本地迁移文件比数据库旧，请先同步代码`);
    }
  }

  return { applied, pending };
}

export interface MigrationReport {
  applied: string[];
  alreadyApplied: number;
  pending: string[];
}

export async function runMigrations(
  runner: MigrationRunner,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<MigrationReport> {
  const log = options.log ?? (() => {});
  const plan = await planMigrations(runner, { dir: options.dir });
  const applied: string[] = [];

  for (const migration of plan.pending) {
    log(`→ 执行迁移 ${migration.file}`);
    await runner.transaction(async (tx) => {
      await tx.query(migration.sql);
      await tx.query('insert into schema_migrations (version, name, checksum) values ($1, $2, $3)', [
        migration.version,
        migration.name,
        migration.checksum,
      ]);
    });
    applied.push(migration.file);
  }

  return {
    applied,
    alreadyApplied: plan.applied.length,
    pending: plan.pending.map((migration) => migration.file),
  };
}

/** 启动自检：有未执行的迁移就明确报错（不自动迁移，避免多实例并发迁移） */
export async function assertMigrationsApplied(
  db: Queryable,
  options: { dir?: string } = {},
): Promise<void> {
  const plan = await planMigrations(db, options);
  if (plan.pending.length > 0) {
    const files = plan.pending.map((migration) => migration.file).join(', ');
    throw new Error(`数据库有未执行的迁移：${files}。请先运行 \`pnpm -C server migrate\`。`);
  }
}

async function main(): Promise<void> {
  const { ConfigError, loadConfig } = await import('../config.js');
  const { createPgPool, createPgPoolFromUrl, createPgRunner } = await import('./pool.js');

  // 配置只有一处：默认走 loadConfig()（POSTGRES_*），CI/容器编排可用 DATABASE_URL 显式覆盖
  const explicitUrl = process.env['DATABASE_URL'];
  let pool;
  try {
    pool = explicitUrl ? createPgPoolFromUrl(explicitUrl) : createPgPool(loadConfig());
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`✗ ${error.message}`);
    } else {
      console.error(`✗ 无法建立数据库连接：${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }

  try {
    const report = await runMigrations(createPgRunner(pool), { log: (message) => console.log(message) });
    console.log(
      `✓ 迁移完成：本次执行 ${report.applied.length} 个，已执行 ${report.alreadyApplied} 个，待执行 ${report.pending.length} 个`,
    );
  } catch (error) {
    console.error(`✗ 迁移失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
