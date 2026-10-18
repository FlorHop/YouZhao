/**
 * 把 PGlite 接到 Kysely 上（**仅供开发/测试**，见 docs/architecture-design.md §3.1.1）。
 *
 * 生产一律走 `pg` 连接池（`db/pool.ts`）；这里的驱动只为两种场合存在：
 * 单元/路由测试（每个文件一个内存实例）与本地没有 Postgres 时的接口联调
 * （`DB_DRIVER=pglite`，生产环境会被 `config.ts` 直接拒绝）。
 *
 * 仓库里没有 pglite 的 Kysely 方言包，也不允许为测试加依赖，所以这里用
 * Kysely 的 PostgreSQL 编译器/适配器 + 一个只覆盖测试需要的极简 Driver
 * （单连接、无连接池；`transaction` 由 Kysely 发 begin/commit/rollback）。
 *
 * 注意：PGlite 是**单连接**引擎，这里再并发开两个 Kysely 事务会互相穿插，
 * 因此本 helper 不适合验证"多实例并发启动"这类场景（真实 PostgreSQL 才行）。
 */
import type { PGlite } from '@electric-sql/pglite';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, CompiledQuery } from 'kysely';
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from 'kysely';
import { runMigrations } from './migrate.js';
import type { Queryable, MigrationRunner } from './migrate.js';
import type { Database, Db } from '../db/types.js';

/** PGlite 的最小公开面（只用到 query / exec），避免在测试里引入 any */
export interface PgliteClient {
  query<T>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<Array<{ rows: Record<string, unknown>[]; affectedRows?: number }>>;
}

/** Kysely 的 Queryable（迁移执行器要的接口）：无参时走简单协议，可一次执行多条语句 */
export function queryable(client: PgliteClient): Queryable {
  return {
    query: async (sql, params) => {
      if (params && params.length > 0) {
        const result = await client.query<Record<string, unknown>>(sql, params);
        return { rows: result.rows };
      }
      const results = await client.exec(sql);
      return { rows: results.at(-1)?.rows ?? [] };
    },
  };
}

/** 迁移执行器：PGlite 的单连接事务（生产侧由 pg 连接池提供） */
export function runnerFor(client: PGlite): MigrationRunner {
  return {
    ...queryable(client),
    transaction: (fn) => client.transaction((tx) => fn(queryable(tx))),
  };
}

function toBigInt(value: number | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value);
}

class PgliteConnection implements DatabaseConnection {
  constructor(private readonly client: PgliteClient) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql: text, parameters } = compiledQuery;
    if (parameters.length > 0) {
      const result = await this.client.query(text, [...parameters]);
      // 驱动边界：结果行的形状由 SQL 决定，类型系统无法证明，只能断言
      return {
        rows: result.rows as R[],
        numAffectedRows: toBigInt(result.affectedRows),
      };
    }
    const results = await this.client.exec(text);
    const last = results.at(-1);
    return {
      rows: (last?.rows ?? []) as R[],
      numAffectedRows: toBigInt(last?.affectedRows),
    };
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiledQuery);
  }
}

class PgliteDriver implements Driver {
  constructor(private readonly client: PgliteClient) {}

  async init(): Promise<void> {
    // 无连接池，无需预热
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new PgliteConnection(this.client);
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    // 单连接：归还即空操作
  }

  async destroy(): Promise<void> {
    // PGlite 生命周期由测试自己管理
  }
}

class PgliteDialect implements Dialect {
  constructor(private readonly client: PgliteClient) {}

  createDriver(): Driver {
    return new PgliteDriver(this.client);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}

export function createPgliteDb(client: PgliteClient): Db {
  return new Kysely<Database>({ dialect: new PgliteDialect(client) });
}

/** 兼容测试里的旧名字（语义相同）。 */
export const createTestDb = createPgliteDb;

export interface PgliteDatabase {
  readonly db: Db;
  readonly runner: MigrationRunner;
  probe(): Promise<'up' | 'down'>;
  close(): Promise<void>;
}

/**
 * 一个「迁移完成、可以直接建服务」的内存数据库。
 * 空路径表示纯内存实例，不落盘——本地联调重跑即回到干净状态。
 */
export async function openPgliteDatabase(path?: string): Promise<PgliteDatabase> {
  const { PGlite } = await import('@electric-sql/pglite');
  const client = new PGlite(path);
  await runMigrations(runnerFor(client));
  return {
    db: createPgliteDb(client),
    runner: runnerFor(client),
    probe: async () => {
      await client.query('select 1');
      return 'up' as const;
    },
    close: () => client.close(),
  };
}
