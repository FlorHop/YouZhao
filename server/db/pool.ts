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

/** 把连接池接到 Kysely：用例层与领域层只认 `Db`，不认 `pg`。 */
export function createPgDb(pool: DatabasePool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function createPgPool(config: AppConfig): DatabasePool {
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
