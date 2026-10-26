/**
 * 会话 store 的准入判定（设计 §4 / §11）。
 *
 * 这些用例刻意只覆盖「前端渲染用什么身份/范围判断」——它是入口可见性，
 * 不是安全边界；真正的越权拒绝由服务端用例负责（`server/test/*`）。
 */
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionData } from '@/services/endpoints';

import { identityLabel, useSessionStore } from './session';

function sessionFixture(identity: SessionData['user']['identity']): SessionData {
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
    capabilities: [{ capability: 'blueprint.publish', targetType: 'group', targetId: 'grp_a' }],
    viewGrants: [
      {
        targetType: 'group',
        targetId: 'grp_a',
        grantedByUserId: 'usr_owner',
        grantedByDisplayName: 'Flor',
        grantedAt: '2026-10-19T02:00:00.000Z',
      },
    ],
    delegableScopes: [{ targetType: 'group', targetId: 'grp_a' }],
    jurisdiction: { groupIds: ['grp_a'], blueprintIds: [] },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope(data: unknown): unknown {
  return { data, meta: { requestId: 'req_test' } };
}

describe('会话 store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
  });

  it('load() 遇到 401 视为未登录，不留下错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: '请先登录' } }),
      ),
    );

    const session = useSessionStore();
    await session.load();

    expect(session.status).toBe('anonymous');
    expect(session.user).toBeNull();
    expect(session.loadError).toBeNull();
  });

  it('load() 成功后暴露身份、范围与能力', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, envelope(sessionFixture('user_admin')))),
    );

    const session = useSessionStore();
    await session.load();

    expect(session.status).toBe('authenticated');
    expect(session.identity).toBe('user_admin');
    expect(session.canEnterManagement).toBe(true);
    expect(session.viewGrants).toHaveLength(1);
    expect(session.delegableScopes).toHaveLength(1);
    expect(session.capabilities[0]?.capability).toBe('blueprint.publish');
  });

  it('普通成员不得进入用户/权限管理（仅入口隐藏，服务端仍会校验）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, envelope(sessionFixture('member')))));

    const session = useSessionStore();
    await session.load();

    expect(session.identity).toBe('member');
    expect(session.canEnterManagement).toBe(false);
  });

  it('signIn() 写入会话，signOut() 清空', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse(200, envelope(sessionFixture('owner')));
      return jsonResponse(204, null);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = useSessionStore();
    await session.signIn('flor', 'yz-owner-pass');
    expect(session.identity).toBe('owner');
    expect(session.isOwner).toBe(true);

    await session.signOut();
    expect(session.status).toBe('anonymous');
    expect(session.user).toBeNull();
  });

  it('身份与能力都有中文标签（界面不留英文枚举）', () => {
    expect(identityLabel('owner')).toBe('平台所有者');
    expect(identityLabel('user_admin')).toBe('用户管理员');
    expect(identityLabel('member')).toBe('普通用户');
  });
});
