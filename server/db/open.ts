/**
 * 存储接入点（§3.2、§3.9）。
 *
 * `postgres` 走 `pg` 连接池（生产唯一选择）；`pglite` 只用于本地开发/测试
 * （生产由 `config.ts` 硬拒），让没有 Postgres 的机器也能把接口跑起来。
 *
 * 从 `main.ts` 抽出来是为了让 `db/migrate-legacy.ts` 这类一次性脚本
 * 与 api 用**完全相同**的接线（包括 pglite 的启动告警）。
 */
import type { AppConfig } from '../config.js';
import type { MigrationRunner } from './migrate.js';
import { createPgDb, createPgPool, createPgRunner, probeDatabase } from './pool.js';
import type { Db } from './types.js';

export interface Storage {
  readonly db: Db;
  readonly runner: MigrationRunner;
  probe(): Promise<'up' | 'down'>;
  close(): Promise<void>;
}

export async function openStorage(config: AppConfig): Promise<Storage> {
  if (config.database.driver === 'pglite') {
    const { openPgliteDatabase } = await import('./pglite.js');
    console.info('⚠ DB_DRIVER=pglite：数据只存在内存里，重启即清空（仅限本地开发）');
    return openPgliteDatabase();
  }
  const pool = createPgPool(config);
  return {
    db: createPgDb(pool),
    runner: createPgRunner(pool),
    probe: () => probeDatabase(pool),
    close: () => pool.end(),
  };
}
