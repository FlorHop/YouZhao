/**
 * 本人自助路由（`/api/me/*`，设计文档 §6.2）。
 *
 * 这组用例守的是「命名空间隔离」的反面：**只有** `/api/me/*` 对所有人（含普通成员）开放，
 * 且它只能改自己——契约里根本不存在 `userId` 参数。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED_ORIGIN } from './helpers.js';
import {
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  createTestContext,
  expectErrorCode,
  login,
  seedWorld,
} from './http-helpers.js';

test('普通成员可以改自己的资料（唯一对所有身份开放的写通道）', async () => {
  const context = await createTestContext();
  try {
    const { memberId } = await seedWorld(context.db);
    const cookie = await login(context.app, 'chen', MEMBER_PASSWORD);

    const response = await context.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie, origin: ALLOWED_ORIGIN },
      payload: { displayName: '陈以宁（改）', email: 'chen@example.com' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.user.displayName, '陈以宁（改）');
    assert.equal(response.json().data.user.email, 'chen@example.com');
    assert.equal(response.json().data.user.id, memberId);
  } finally {
    await context.close();
  }
});

test('本人资料不接受身份与状态字段（契约层就挡住自我提权）', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const cookie = await login(context.app, 'chen', MEMBER_PASSWORD);

    for (const payload of [{ identity: 'owner' }, { status: 'disabled' }, { viewGrants: [] }]) {
      const response = await context.app.inject({
        method: 'PATCH',
        url: '/api/me',
        headers: { cookie, origin: ALLOWED_ORIGIN },
        payload,
      });
      await expectErrorCode(response, 400, 'INVALID_ARGUMENT');
    }
  } finally {
    await context.close();
  }
});

test('空字符串把邮箱/手机号清空（而不是写成空串）', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const cookie = await login(context.app, 'chen', MEMBER_PASSWORD);
    await context.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie, origin: ALLOWED_ORIGIN },
      payload: { email: 'chen@example.com' },
    });
    const cleared = await context.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie, origin: ALLOWED_ORIGIN },
      payload: { email: '' },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().data.user.email, null);
  } finally {
    await context.close();
  }
});

test('改密码：原密码错误 → 400 且字段级错误指向 oldPassword', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const cookie = await login(context.app, 'chen', MEMBER_PASSWORD);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie, origin: ALLOWED_ORIGIN },
      payload: { oldPassword: 'not-the-password', newPassword: 'brand-new-pass-1' },
    });
    await expectErrorCode(response, 400, 'INVALID_ARGUMENT');
    const fields = response.json().error.details.fields;
    assert.equal(fields[0].path, '/oldPassword');
  } finally {
    await context.close();
  }
});

test('改密码：新密码与原密码相同被拒', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const cookie = await login(context.app, 'chen', MEMBER_PASSWORD);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie, origin: ALLOWED_ORIGIN },
      payload: { oldPassword: MEMBER_PASSWORD, newPassword: MEMBER_PASSWORD },
    });
    await expectErrorCode(response, 400, 'INVALID_ARGUMENT');
  } finally {
    await context.close();
  }
});

test('改密码：弱口令被拒（默认口令与过短口令）', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const cookie = await login(context.app, 'owner', OWNER_PASSWORD);
    for (const newPassword of ['123456', 'short']) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/me/password',
        headers: { cookie, origin: ALLOWED_ORIGIN },
        payload: { oldPassword: OWNER_PASSWORD, newPassword },
      });
      await expectErrorCode(response, 400, 'INVALID_ARGUMENT');
    }
  } finally {
    await context.close();
  }
});

test('改密码成功：清除强制改密标记、吊销其他会话、当前会话继续可用', async () => {
  const context = await createTestContext();
  try {
    const { memberId } = await seedWorld(context.db);
    await context.db
      .updateTable('users')
      .set({ must_change_password: true })
      .where('id', '=', memberId)
      .execute();

    // 同一用户两个会话：A 改密，B 应被踢下线
    const cookieA = await login(context.app, 'chen', MEMBER_PASSWORD);
    const cookieB = await login(context.app, 'chen', MEMBER_PASSWORD);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie: cookieA, origin: ALLOWED_ORIGIN },
      payload: { oldPassword: MEMBER_PASSWORD, newPassword: 'fresh-member-pass-9' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.user.mustChangePassword, false);

    const stillIn = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieA } });
    assert.equal(stillIn.statusCode, 200);

    const kickedOut = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieB } });
    await expectErrorCode(kickedOut, 401, 'SESSION_EXPIRED');

    // 新密码可登录，旧密码不可
    const newLogin = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'chen', password: 'fresh-member-pass-9' },
    });
    assert.equal(newLogin.statusCode, 200);
    const oldLogin = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'chen', password: MEMBER_PASSWORD },
    });
    assert.equal(oldLogin.statusCode, 401);
  } finally {
    await context.close();
  }
});

test('未登录时 /api/me 的读写一律 401', async () => {
  const context = await createTestContext();
  try {
    const patch = await context.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { displayName: '匿名' },
    });
    await expectErrorCode(patch, 401, 'UNAUTHENTICATED');

    const password = await context.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { oldPassword: 'x', newPassword: 'y'.repeat(20) },
    });
    await expectErrorCode(password, 401, 'UNAUTHENTICATED');
  } finally {
    await context.close();
  }
});

test('无权限概念：成员改自己的资料不需要任何业务能力（身份不参与判定）', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const cookie = await login(context.app, 'chen', MEMBER_PASSWORD);
    const response = await context.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie, origin: ALLOWED_ORIGIN },
      payload: { phone: '13800000000' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.user.phone, '13800000000');
  } finally {
    await context.close();
  }
});
