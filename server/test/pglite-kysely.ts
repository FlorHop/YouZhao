/**
 * 兼容层：PGlite↔Kysely 适配器已提升到 `server/db/pglite.ts`（开发与测试共用），
 * 这里只保留旧导入路径，测试代码无需改动。
 */
export { queryable, runnerFor, createPgliteDb, createTestDb, openPgliteDatabase } from '../db/pglite.js';
export type { PgliteClient, PgliteDatabase } from '../db/pglite.js';
