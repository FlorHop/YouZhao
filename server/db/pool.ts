/**
 * PostgreSQL 连接与迁移执行器适配（docs/architecture-design.md §3.1、§3.2）。
 * 只在这里出现 `pg`，其余模块依赖 `Queryable` / Kysely 的抽象。
 */
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { AppConfig } from '../config.js';
import type { MigrationRunner, Queryable } from './migrate.js';
import type { Database, Db } from './types.js';

const { Pool } = pg;

export type DatabasePool = pg.Pool;

/**
 * node-postgres 默认把 `int8/bigint`（OID 20）当**字符串**返回，而本机开发/测试用的
 * PGlite 驱动返回**数字**。同一份领域层代码要在两种驱动下产出同样形状的数据
 * （契约里 `artifactBytes`、`meta.total` 都是 integer），所以建池前统一按数字解析。
 *
 * 取值域受限（产物 ≤ 32MiB、计数 ≪ 2^53），不会丢精度；生产上 `pg` 与 PGlite 的这处
 * 差异曾导致 `GET /api/blueprints` 在真库上 500（fast-json-stringify 报
 * `latestVersion` 与 schema 不匹配）——见 docs/architecture-design.md §3.1.1。
 */
export function installPgTypeParsers(): void {
  pg.types.setTypeParser(20, (value: string) => Number(value));
}

/** 把连接池接到 Kysely：用例层与领域层只认 `Db`，不认 `pg`。 */
export function createPgDb(pool: DatabasePool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function createPgPool(config: AppConfig): DatabasePool {
  installPgTypeParsers();
  return new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: `${config.appName}-api`,
  });
}

export function createPgPoolFromUrl(url: string): DatabasePool {
  installPgTypeParsers();
  return new Pool({ connectionString: url, application_name: 'youzhao-migrate' });
}

/** 把连接池适配成迁移执行器：事务固定在同一连接上 */
export function createPgRunner(pool: DatabasePool): MigrationRunner {
  return {
    query: (sql, params) => pool.query(sql, params ?? []) as Promise<{ rows: Array<Record<string, unknown>> }>,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({
          query: (sql, params) =>
            client.query(sql, params ?? []) as Promise<{ rows: Array<Record<string, unknown>> }>,
        });
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** 健康检查用的探针：只做最小往返，不抛异常 */
export async function probeDatabase(db: Queryable): Promise<'up' | 'down'> {
  try {
    await db.query('select 1');
    return 'up';
  } catch {
    return 'down';
  }
}
