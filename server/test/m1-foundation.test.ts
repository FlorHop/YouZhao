/**
 * M1 基础层测试：不透明 id、scrypt 口令、审计脱敏与写入、初始化所有者。
 * 数据库用 PGlite（真实 PostgreSQL 语义）跑真实迁移后的 schema。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { ensureInitialOwner } from '../app/bootstrap.js';
import { createAuditWriter, redact, writeAudit } from '../audit/audit.js';
import { runMigrations } from '../db/migrate.js';
import type { Db } from '../db/types.js';
import { AppError } from '../domain/errors.js';
import { DEFAULT_GROUP_ID, newId } from '../domain/ids.js';
import {
  MIN_PASSWORD_LENGTH,
  assertAcceptablePassword,
  hashPassword,
  verifyPassword,
} from '../domain/password.js';
import { createTestDb, runnerFor } from './pglite-kysely.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 建一个已跑完全部迁移的 PGlite + Kysely */
async function freshDb(): Promise<{ db: Db; pglite: PGlite }> {
  const pglite = new PGlite();
  await runMigrations(runnerFor(pglite));
  return { db: createTestDb(pglite), pglite };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `期望 AppError，实际是 ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`期望抛出 ${code}，但没有抛错`);
}

async function countRows(db: Db, table: 'users' | 'user_identity' | 'audit_logs'): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

test('newId：前缀 + UUID，不透明且不重复', () => {
  assert.match(
    newId('usr'),
    /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.notEqual(newId('grp'), newId('grp'));
  assert.equal(newId('ses').startsWith('ses_'), true);
  assert.equal(DEFAULT_GROUP_ID, 'group_default');
});

test('hashPassword：产出 scrypt 串，参数写在串里且每次盐不同', async () => {
  const plain = 'S3cret-passphrase';
  const stored = await hashPassword(plain);
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(await verifyPassword(plain, stored), true);
  assert.equal(await verifyPassword('S3cret-passphras', stored), false);
  assert.equal(await verifyPassword(plain.toUpperCase(), stored), false);
  assert.notEqual(await hashPassword(plain), stored);
  // 只按串里的参数计算：把参数改小后校验必失败（将来提参数不会作废旧口令）
  assert.equal(await verifyPassword(plain, stored.replace('$16384$', '$8192$')), false);
});

test('verifyPassword：格式非法一律 false，不抛异常', async () => {
  const bad = [
    '',
    'plain',
    'scrypt$16384$8$1$onlyfourparts',
    'bcrypt$16384$8$1$YWJj$YWJj',
    'scrypt$0$8$1$YWJj$YWJj',
    'scrypt$x$8$1$YWJj$YWJj',
    'scrypt$16384$8$1$$YWJj',
    'scrypt$16384$8$1$YWJj$',
  ];
  for (const stored of bad) {
    assert.equal(await verifyPassword('whatever', stored), false, `应拒绝：${stored}`);
  }
});

test('assertAcceptablePassword：拒绝过短与禁用口令', async () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.doesNotThrow(() => assertAcceptablePassword('a-good-passphrase'));

  for (const weak of ['short', '12345678', '123456', 'password', 'admin', 'youzhao', '  ADMIN  ']) {
    assert.throws(
      () => assertAcceptablePassword(weak),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.equal(error.details?.reason, 'WEAK_PASSWORD');
        return true;
      },
      `应拒绝：${weak}`,
    );
  }
});

test('redact：递归脱敏敏感键，保持其他值，循环引用返回 [circular]', () => {
  const date = new Date(0);
  const shared = { keep: 1 };
  const input = {
    password: 'p',
    Password: 'p2',
    Authorization: 'Bearer x',
    nested: { token: 't', keep: 2 },
    list: [{ secret: 's' }, 'ok'],
    sharedA: shared,
    sharedB: shared,
    date,
  };
  const output = redact(input);
  assert.ok(isRecord(output));
  assert.equal(output['password'], '[redacted]');
  assert.equal(output['Password'], '[redacted]');
  assert.equal(output['Authorization'], '[redacted]');

  const nested = output['nested'];
  assert.ok(isRecord(nested));
  assert.equal(nested['token'], '[redacted]');
  assert.equal(nested['keep'], 2);

  const list = output['list'];
  assert.ok(Array.isArray(list));
  const items: unknown[] = list;
  const first = items[0];
  assert.ok(isRecord(first));
  assert.equal(first['secret'], '[redacted]');
  assert.equal(items[1], 'ok');

  // 同一对象被两个兄弟字段引用不是环，都应保留
  const sharedA = output['sharedA'];
  const sharedB = output['sharedB'];
  assert.ok(isRecord(sharedA) && isRecord(sharedB));
  assert.equal(sharedA['keep'], 1);
  assert.equal(sharedB['keep'], 1);
  assert.equal(output['date'], date);

  const cyclic: Record<string, unknown> = { name: 'root' };
  cyclic['self'] = cyclic;
  const cyclicOut = redact(cyclic);
  assert.ok(isRecord(cyclicOut));
  assert.equal(cyclicOut['name'], 'root');
  assert.equal(cyclicOut['self'], '[circular]');
});

test('createAuditWriter：写入审计行，detail 落库前已脱敏', async () => {
  const { db, pglite } = await freshDb();
  try {
    const writer = createAuditWriter(db);
    await writer({
      actorType: 'user',
      actorId: 'usr_1',
      requestId: 'req_1',
      action: 'view_grant.create',
      targetType: 'group',
      targetId: DEFAULT_GROUP_ID,
      result: 'allow',
      detail: { password: 'p', nested: { token: 'abc', keep: 2 } },
      ip: '127.0.0.1',
      durationMs: 4,
    });

    const row = await db.selectFrom('audit_logs').selectAll().executeTakeFirstOrThrow();
    assert.match(row.id, /^aud_/);
    assert.equal(row.action, 'view_grant.create');
    assert.equal(row.result, 'allow');
    assert.equal(row.actor_type, 'user');
    assert.equal(row.actor_id, 'usr_1');
    assert.equal(row.request_id, 'req_1');
    assert.equal(row.target_id, DEFAULT_GROUP_ID);
    assert.equal(row.duration_ms, 4);
    assert.ok(row.at instanceof Date);

    const detail = row.detail;
    assert.ok(isRecord(detail));
    assert.equal(detail['password'], '[redacted]');
    const nested = detail['nested'];
    assert.ok(isRecord(nested));
    assert.equal(nested['token'], '[redacted]');
    assert.equal(nested['keep'], 2);
    assert.equal(await countRows(db, 'audit_logs'), 1);
  } finally {
    await db.destroy();
    await pglite.close();
  }
});

test('审计写入失败不抛出：只 console.error（审计不阻断业务）', async () => {
  // 故意不跑迁移：audit_logs 不存在
  const pglite = new PGlite();
  const db = createTestDb(pglite);
  const originalError = console.error;
  let logged = 0;
  console.error = (..._args: unknown[]) => {
    logged += 1;
  };
  try {
    await writeAudit(db, { actorType: 'system', action: 'noop', result: 'allow' });
    await createAuditWriter(db)({ actorType: 'system', action: 'noop', result: 'allow' });
    assert.equal(logged, 2);
  } finally {
    console.error = originalError;
    await db.destroy();
    await pglite.close();
  }
});

test('ensureInitialOwner：首次创建所有者并强制改密，二次调用幂等', async () => {
  const { db, pglite } = await freshDb();
  try {
    const first = await ensureInitialOwner(db, {
      username: 'admin',
      password: 'owner-pass-1',
      displayName: '系统管理员',
    });
    assert.equal(first.created, true);
    assert.match(first.ownerId, /^usr_/);

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', first.ownerId)
      .executeTakeFirstOrThrow();
    assert.equal(user.username, 'admin');
    assert.equal(user.display_name, '系统管理员');
    assert.equal(user.status, 'active');
    assert.equal(user.must_change_password, true);
    assert.equal(user.created_by_user_id, null);
    assert.notEqual(user.password_hash, 'owner-pass-1');
    assert.equal(await verifyPassword('owner-pass-1', user.password_hash), true);

    const identity = await db
      .selectFrom('user_identity')
      .selectAll()
      .where('user_id', '=', first.ownerId)
      .executeTakeFirstOrThrow();
    assert.equal(identity.identity, 'owner');
    assert.equal(identity.granted_by, null);

    // 幂等：换用户名/口令再调一次，仍返回既有 owner，不新建、不改动
    const second = await ensureInitialOwner(db, {
      username: 'someone-else',
      password: 'owner-pass-2',
      displayName: '别人',
    });
    assert.deepEqual(second, { created: false, ownerId: first.ownerId });
    assert.equal(await countRows(db, 'users'), 1);
    assert.equal(await countRows(db, 'user_identity'), 1);

    // 只审计了真正落库的那一次
    const audits = await db
      .selectFrom('audit_logs')
      .select(['action', 'actor_type', 'target_id', 'result'])
      .execute();
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, 'user.bootstrapOwner');
    assert.equal(audits[0]?.actor_type, 'system');
    assert.equal(audits[0]?.target_id, first.ownerId);
  } finally {
    await db.destroy();
    await pglite.close();
  }
});

test('ensureInitialOwner：不覆盖非 owner 用户，异常数据不静默提权', async () => {
  const { db, pglite } = await freshDb();
  try {
    // 预置历史/异常数据：有用户、但没有 owner 身份
    const existingId = newId('usr');
    await db
      .insertInto('users')
      .values({
        id: existingId,
        username: 'someone',
        display_name: '某人',
        email: null,
        phone: null,
        status: 'active',
        password_hash: await hashPassword('someone-pass'),
        must_change_password: false,
        created_by_user_id: null,
      })
      .execute();

    // 用户名已被占用 → 冲突，且不覆盖
    await expectAppError(
      ensureInitialOwner(db, {
        username: 'someone',
        password: 'owner-pass-1',
        displayName: '冒充者',
      }),
      'USERNAME_CONFLICT',
    );

    // 用户名没被占用但存在非 owner 用户 → 数据异常，交人工处理
    await expectAppError(
      ensureInitialOwner(db, {
        username: 'admin',
        password: 'owner-pass-1',
        displayName: '系统管理员',
      }),
      'INTERNAL_ERROR',
    );

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', existingId)
      .executeTakeFirstOrThrow();
    assert.equal(user.username, 'someone');
    assert.equal(user.must_change_password, false);
    assert.equal(await verifyPassword('someone-pass', user.password_hash), true);
    assert.equal(await countRows(db, 'users'), 1);
    assert.equal(await countRows(db, 'user_identity'), 0);
  } finally {
    await db.destroy();
    await pglite.close();
  }
});
