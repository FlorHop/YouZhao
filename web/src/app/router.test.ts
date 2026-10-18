/**
 * 路由守卫的准入判定（设计 §4 / §11）：
 *   - 未登录访问业务页 → /login（并带 next 回跳）
 *   - 已登录访问 /login → 回蓝图页
 *   - 普通成员直达 /users、/permissions → /403（整体不进入，而非进入后报错）
 *   - 用户管理员/所有者可以进入
 */
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import { createAppRouter } from '@/app/router';
import type { SessionData } from '@/services/endpoints';
import { useSessionStore } from '@/stores/session';

function fixture(identity: SessionData['user']['identity']): SessionData {
  return {
    user: {
      id: 'usr_1',
      username: 'flor',
      displayName: 'Flor',
      email: null,
      phone: null,
      identity,
      status: 'active',
      mustChangePassword: false,
      managedByUserIds: [],
    },
    capabilities: [],
    viewGrants: [],
    delegableScopes: [],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 让 `session.load()` 在守卫里拿到指定的身份。 */
function stubSession(identity: SessionData['user']['identity'] | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      identity === null
        ? jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: '请先登录' } })
        : jsonResponse(200, { data: fixture(identity), meta: { requestId: 'req_test' } }),
    ),
  );
}

async function visit(path: string): Promise<{
  name: string | undefined;
  query: Record<string, unknown>;
}> {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const route = router.currentRoute.value;
  return { name: route.name as string | undefined, query: route.query };
}

describe('路由守卫', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
  });

  it('未登录直达 /permissions → 登录页并记录回跳地址', async () => {
    stubSession(null);
    const { name, query } = await visit('/permissions');
    expect(name).toBe('login');
    expect(query.next).toBe('/permissions');
  });

  it('未登录访问 /blueprints → 登录页（默认落地页，不记回跳）', async () => {
    stubSession(null);
    const { name, query } = await visit('/blueprints');
    expect(name).toBe('login');
    expect(query.next).toBeUndefined();
  });

  it('普通成员直达 /users → /403', async () => {
    stubSession('member');
    const { name } = await visit('/users');
    expect(name).toBe('forbidden');
  });

  it('用户管理员可进入 /users 与 /permissions', async () => {
    stubSession('user_admin');
    expect((await visit('/users')).name).toBe('users');
    expect((await visit('/permissions')).name).toBe('permissions');
  });

  it('已登录访问 /login → 回蓝图页', async () => {
    stubSession('owner');
    const { name } = await visit('/login');
    expect(name).toBe('blueprints');
  });

  it('未知地址落到 404 页而不是白屏', async () => {
    stubSession('member');
    const { name } = await visit('/nope');
    expect(name).toBe('not-found');
  });

  it('会话加载失败时按未登录处理（不把用户卡在白屏）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const session = useSessionStore();
    await session.load();
    expect(session.status).toBe('anonymous');
    expect((await visit('/blueprints')).name).toBe('login');
  });
});
