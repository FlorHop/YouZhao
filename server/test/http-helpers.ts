/**
 * HTTP 层测试装配：真实迁移过的 PGlite + Kysely + Fastify `inject`。
 *
 * 只做「能让路由测试跑起来」的最小装配；权限矩阵本身在 `test/policy.test.ts`，
 * 这里验证的是「策略接进 HTTP 之后行为不变」——包括路由守卫、Cookie、错误信封与 CSRF。
 */
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import type { Db } from '../db/types.js';
import { newId } from '../domain/ids.js';
import { hashPassword } from '../domain/password.js';
import { buildServer } from '../http/app.js';
import { ALLOWED_ORIGIN, minimalEnv } from './helpers.js';
import { createTestDb, runnerFor } from './pglite-kysely.js';

export const OWNER_PASSWORD = 'owner-pass-1234';
export const ADMIN_PASSWORD = 'admin-pass-1234';
export const MEMBER_PASSWORD = 'member-pass-1234';

export interface TestContext {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly config: AppConfig;
  readonly pglite: PGlite;
  close(): Promise<void>;
}

export async function createTestContext(overrides: Record<string, string | undefined> = {}): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(runnerFor(pglite));
  const db = createTestDb(pglite);
  const config = loadConfig(minimalEnv(overrides));
  const app = buildServer({ config, db, probeDatabase: async () => 'up' });
  return {
    app,
    db,
    config,
    pglite,
    close: async () => {
      await app.close();
      await pglite.close();
    },
  };
}

export interface SeedUserInput {
  readonly username: string;
  readonly password: string;
  readonly displayName?: string;
  readonly identity?: 'owner' | 'user_admin' | 'member';
  readonly status?: 'active' | 'disabled';
  readonly managedBy?: readonly string[];
  readonly grantedBy?: string | null;
  readonly createdBy?: string | null;
}

export async function seedUser(db: Db, input: SeedUserInput): Promise<string> {
  const id = newId('usr');
  await db
    .insertInto('users')
    .values({
      id,
      username: input.username,
      display_name: input.displayName ?? input.username,
      status: input.status ?? 'active',
      password_hash: await hashPassword(input.password),
      must_change_password: false,
      created_by_user_id: input.createdBy ?? null,
    })
    .execute();
  await db
    .insertInto('user_identity')
    .values({
      user_id: id,
      identity: input.identity ?? 'member',
      granted_by: input.grantedBy ?? null,
    })
    .execute();
  for (const managerId of input.managedBy ?? []) {
    await db
      .insertInto('user_managers')
      .values({ user_id: id, manager_user_id: managerId })
      .execute();
  }
  return id;
}

export interface SeededWorld {
  readonly ownerId: string;
  readonly adminId: string;
  readonly memberId: string;
}

/** 标准世界：一位所有者、一位用户管理员（由所有者指派）、一位普通成员（归该管理员管） */
export async function seedWorld(db: Db): Promise<SeededWorld> {
  const ownerId = await seedUser(db, {
    username: 'owner',
    password: OWNER_PASSWORD,
    displayName: '所有者',
    identity: 'owner',
  });
  const adminId = await seedUser(db, {
    username: 'zhou',
    password: ADMIN_PASSWORD,
    displayName: '周予安',
    identity: 'user_admin',
    grantedBy: ownerId,
    createdBy: ownerId,
  });
  const memberId = await seedUser(db, {
    username: 'chen',
    password: MEMBER_PASSWORD,
    displayName: '陈以宁',
    managedBy: [adminId],
    createdBy: adminId,
  });
  return { ownerId, adminId, memberId };
}

/** 登录并返回可复用的 Cookie 头；顺带断言登录成功，避免用例里到处判 200 */
export async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ALLOWED_ORIGIN },
    payload: { username, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`登录失败（${response.statusCode}）：${response.body}`);
  }
  const cookie = response.cookies[0];
  if (cookie === undefined) throw new Error('登录响应没有下发 Cookie');
  return `${cookie.name}=${cookie.value}`;
}

export async function expectErrorCode(
  response: { statusCode: number; json(): unknown },
  status: number,
  code: string,
): Promise<void> {
  const body = response.json() as { error?: { code?: string } };
  if (response.statusCode !== status || body.error?.code !== code) {
    throw new Error(
      `期望 ${status} ${code}，实际 ${response.statusCode} ${String(body.error?.code)}（${JSON.stringify(body)}）`,
    );
  }
}
