/**
 * 登录 / 会话 / 登出路由（`docs/architecture-design.md` §3.4、§6.1、§6.2）。
 *
 * 重点验证三件事：
 * 1. 失败一律同一句话（不泄露账号是否存在）；
 * 2. 被停用用户即使拿着有效 Cookie 也立刻进不来（不变量：停用即时生效）；
 * 3. Cookie 属性、CSRF 来源校验、限流与错误信封都对。
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
  seedUser,
  seedWorld,
} from './http-helpers.js';
import { hashSessionToken, newSessionToken } from '../domain/session.js';
import { ensureInitialOwner } from '../app/bootstrap.js';

const WRONG_CREDENTIALS = '用户名或密码不正确';

test('未登录访问 /api/me → 401 UNAUTHENTICATED', async () => {
  const context = await createTestContext();
  try {
    const response = await context.app.inject({ method: 'GET', url: '/api/me' });
    await expectErrorCode(response, 401, 'UNAUTHENTICATED');
  } finally {
    await context.close();
  }
});

test('登录成功：下发 HTTP-only Cookie，响应体即当前身份、能力与范围', async () => {
  const context = await createTestContext();
  try {
    // 初始所有者由启动引导创建：首登响应必须带 mustChangePassword=true（前端据此强制改密）
    const { ownerId } = await ensureInitialOwner(context.db, {
      username: 'owner',
      password: OWNER_PASSWORD,
      displayName: '所有者',
    });
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'owner', password: OWNER_PASSWORD },
    });
    assert.equal(response.statusCode, 200);

    const cookie = response.cookies[0];
    assert.ok(cookie !== undefined, '应下发 Cookie');
    assert.equal(cookie.name, context.config.session.cookieName);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Lax');
    assert.equal(cookie.path, '/');

    const body = response.json();
    assert.equal(body.data.user.id, ownerId);
    assert.equal(body.data.user.identity, 'owner');
    assert.deepEqual(body.data.capabilities, []);
    assert.deepEqual(body.data.viewGrants, []);
    assert.deepEqual(body.data.delegableScopes, []);
    assert.equal(body.data.user.mustChangePassword, true);
    assert.equal(body.meta.requestId, response.headers['x-request-id']);

    // 拿 Cookie 再取一次 /api/me，必须与登录响应一致（前端刷新页面靠这个）
    const me = await context.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json().data.user, body.data.user);
  } finally {
    await context.close();
  }
});

test('登录失败：密码错误与用户名不存在返回同一句话，不泄露账号存在性', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const badPassword = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'owner', password: 'definitely-wrong' },
    });
    const noSuchUser = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'nobody-here', password: 'definitely-wrong' },
    });

    assert.equal(badPassword.statusCode, 401);
    assert.equal(noSuchUser.statusCode, 401);
    assert.equal(
      badPassword.json().error.message,
      noSuchUser.json().error.message,
    );
    assert.equal(badPassword.json().error.message, WRONG_CREDENTIALS);
    assert.equal(badPassword.json().error.code, 'UNAUTHENTICATED');
  } finally {
    await context.close();
  }
});

test('被停用用户：登录被拒，且已有会话立刻失效（不需要逐个吊销）', async () => {
  const context = await createTestContext();
  try {
    const { memberId } = await seedWorld(context.db);
    const cookie = await login(context.app, 'chen', MEMBER_PASSWORD);

    await context.db
      .updateTable('users')
      .set({ status: 'disabled' })
      .where('id', '=', memberId)
      .execute();

    const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    // 停用用户即使会话未撤销也进不来：UNAUTHENTICATED（会话本身仍有效，故不是 SESSION_EXPIRED）
    await expectErrorCode(me, 401, 'UNAUTHENTICATED');

    const relogin = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'chen', password: MEMBER_PASSWORD },
    });
    await expectErrorCode(relogin, 401, 'UNAUTHENTICATED');
    assert.equal(relogin.json().error.message, WRONG_CREDENTIALS);
  } finally {
    await context.close();
  }
});

test('过期会话：返回 SESSION_EXPIRED（与未登录区分，前端据此提示重新登录）', async () => {
  const context = await createTestContext();
  try {
    const { memberId } = await seedWorld(context.db);
    const raw = newSessionToken();
    const past = new Date(Date.now() - 60_000);
    await context.db
      .insertInto('sessions')
      .values({
        id: 'ses_expired',
        token_hash: hashSessionToken(raw),
        user_id: memberId,
        expires_at: past,
      })
      .execute();

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `${context.config.session.cookieName}=${raw}` },
    });
    await expectErrorCode(response, 401, 'SESSION_EXPIRED');
  } finally {
    await context.close();
  }
});

test('登出：204、清除 Cookie，之后会话不可再用', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const cookie = await login(context.app, 'owner', OWNER_PASSWORD);

    const logout = await context.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: ALLOWED_ORIGIN },
    });
    assert.equal(logout.statusCode, 204);

    const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    // 会话被撤销（尚未过期）→ SESSION_EXPIRED；完全没带 Cookie 才是 UNAUTHENTICATED
    await expectErrorCode(me, 401, 'SESSION_EXPIRED');
  } finally {
    await context.close();
  }
});

test('CSRF：状态变更请求的来源不在允许名单内（或缺失）→ 403 FORBIDDEN', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const foreign = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { username: 'owner', password: OWNER_PASSWORD },
    });
    await expectErrorCode(foreign, 403, 'FORBIDDEN');

    const missing = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: OWNER_PASSWORD },
    });
    await expectErrorCode(missing, 403, 'FORBIDDEN');
  } finally {
    await context.close();
  }
});

test('来源允许名单是必填配置：缺失或为空时启动即失败（CSRF 防线不允许被关掉）', async () => {
  await assert.rejects(
    () => createTestContext({ CSRF_ORIGIN_ALLOWLIST: undefined }),
    (error: unknown) => String(error).includes('CSRF_ORIGIN_ALLOWLIST'),
  );
});

test('登录限流：超过每分钟上限返回 429 RATE_LIMITED', async () => {
  const context = await createTestContext({ RATE_LIMIT_LOGIN_PER_MINUTE: '2' });
  try {
    await seedWorld(context.db);
    const attempt = async () =>
      context.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ALLOWED_ORIGIN },
        payload: { username: 'owner', password: 'wrong-password' },
      });

    assert.equal((await attempt()).statusCode, 401);
    assert.equal((await attempt()).statusCode, 401);
    await expectErrorCode(await attempt(), 429, 'RATE_LIMITED');
  } finally {
    await context.close();
  }
});

test('会话 Cookie 无效时按未登录处理（不报 500）', async () => {
  const context = await createTestContext();
  try {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `${context.config.session.cookieName}=not-a-real-token` },
    });
    await expectErrorCode(response, 401, 'UNAUTHENTICATED');
  } finally {
    await context.close();
  }
});

test('安全响应头与审计：登录写入 auth.login，失败写入 auth.loginFailed', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'owner', password: OWNER_PASSWORD },
    });
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(typeof response.headers['x-contract-version'], 'string');

    await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { username: 'owner', password: 'wrong' },
    });

    const actions = await context.db
      .selectFrom('audit_logs')
      .select(['action', 'result', 'at'])
      .orderBy('at', 'asc')
      .execute();
    assert.deepEqual(
      actions.map((row) => `${row.action}:${row.result}`),
      ['auth.login:allow', 'auth.loginFailed:deny'],
    );
  } finally {
    await context.close();
  }
});

test('用户管理员与普通成员都能登录并拿到自己的身份', async () => {
  const context = await createTestContext();
  try {
    await seedWorld(context.db);
    const admin = await login(context.app, 'zhou', 'admin-pass-1234');
    const member = await login(context.app, 'chen', MEMBER_PASSWORD);

    const adminMe = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin } });
    const memberMe = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: member } });
    assert.equal(adminMe.json().data.user.identity, 'user_admin');
    assert.equal(memberMe.json().data.user.identity, 'member');
    // 成员归属该管理员（S7 多归属的展示面）
    assert.equal(memberMe.json().data.user.managedByUserIds.length, 1);
  } finally {
    await context.close();
  }
});

test('用户管理员的可委派范围 = 本人查看范围（S1）', async () => {
  const context = await createTestContext();
  try {
    const { adminId } = await seedWorld(context.db);
    await context.db.insertInto('blueprint_groups').values({ id: 'grp_a', name: '产品蓝图组', is_default: false, sort_order: 10 }).execute();
    await context.db
      .insertInto('view_grants')
      .values({
        id: 'grn_1',
        user_id: adminId,
        target_type: 'group',
        target_id: 'grp_a',
        granted_by: adminId,
      })
      .execute();

    const cookie = await login(context.app, 'zhou', 'admin-pass-1234');
    const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    assert.deepEqual(
      me.json().data.viewGrants.map((grant: { targetType: string; targetId: string }) => `${grant.targetType}:${grant.targetId}`),
      ['group:grp_a'],
    );
    assert.deepEqual(me.json().data.delegableScopes, [{ targetType: 'group', targetId: 'grp_a' }]);
  } finally {
    await context.close();
  }
});

test('普通成员没有可委派范围（身份决定的派生字段）', async () => {
  const context = await createTestContext();
  try {
    const memberId = await seedUser(context.db, {
      username: 'solo',
      password: MEMBER_PASSWORD,
      identity: 'member',
    });
    await context.db.insertInto('blueprint_groups').values({ id: 'grp_b', name: '运营蓝图组', is_default: false, sort_order: 20 }).execute();
    await context.db
      .insertInto('view_grants')
      .values({
        id: 'grn_2',
        user_id: memberId,
        target_type: 'group',
        target_id: 'grp_b',
        granted_by: memberId,
      })
      .execute();

    const cookie = await login(context.app, 'solo', MEMBER_PASSWORD);
    const me = await context.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    assert.deepEqual(
      me.json().data.viewGrants.map((grant: { targetType: string; targetId: string }) => `${grant.targetType}:${grant.targetId}`),
      ['group:grp_b'],
    );
    assert.deepEqual(me.json().data.delegableScopes, []);
  } finally {
    await context.close();
  }
});
