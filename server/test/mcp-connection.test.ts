/**
 * MCP 接入信息（`GET /api/mcp/connection-info`）：docs/mcp-onboarding-design.md §3.1。
 *
 * 断言的是「服务端事实」：客户端片段里的地址、传输方式、工具数量都由这里推导，
 * 前端不再硬编码 `127.0.0.1:4174`（旧站端口）这类只在一台机器上成立的地址。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMcpPath } from '../mcp/connection.js';
import {
  createTestContext,
  expectErrorCode,
  login,
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  seedWorld,
} from './http-helpers.js';

test('接入信息：未登录 → 401 UNAUTHENTICATED（不能匿名探服务地址）', async () => {
  const harness = await createTestContext();
  try {
    const response = await harness.app.inject({ method: 'GET', url: '/api/mcp/connection-info' });
    await expectErrorCode(response, 401, 'UNAUTHENTICATED');
  } finally {
    await harness.close();
  }
});

test('接入信息：登录后返回由服务端推导的接入事实', async () => {
  const harness = await createTestContext();
  try {
    await seedWorld(harness.db);
    const cookie = await login(harness.app, 'owner', OWNER_PASSWORD);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/mcp/connection-info',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.equal(body.data.enabled, true);
    assert.equal(body.data.httpUrl, 'http://127.0.0.1:3000/mcp');
    assert.equal(body.data.path, '/mcp');
    assert.equal(body.data.transport, 'streamable-http');
    assert.equal(body.data.authHeader, 'Authorization');
    assert.equal(body.data.authScheme, 'Bearer');
    // 版本由客户端 initialize 协商，接入方不手填
    assert.deepEqual(body.data.protocol, {
      negotiatedBy: 'client-initialize',
      modernEra: true,
      legacyEra: true,
    });
    // 只支持 Bearer：OAuth 客户端要靠 mcp-remote 兜底，前端据此给出提示
    assert.equal(body.data.oauth.enabled, false);
    assert.ok(body.data.oauth.note.length > 0);
    // 工具口径由工具表推导，避免「组件说 4+4、文档说 5+3」的三处不一致
    assert.deepEqual(body.data.tools, { total: 8, read: 4, write: 4 });
    assert.deepEqual(body.data.scopes, ['publish:blueprint', 'read:blueprint']);
    assert.equal(body.data.tokenPagePath, '/settings/tokens');
    assert.equal(typeof body.meta.requestId, 'string');
  } finally {
    await harness.close();
  }
});

test('接入信息：普通成员也能读（与 Token 页同一权限面，不要求业务能力）', async () => {
  const harness = await createTestContext();
  try {
    await seedWorld(harness.db);
    const cookie = await login(harness.app, 'chen', MEMBER_PASSWORD);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/mcp/connection-info',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.httpUrl, 'http://127.0.0.1:3000/mcp');
  } finally {
    await harness.close();
  }
});

test('接入信息：httpUrl 取 API_PUBLIC_BASE_URL 的 origin，MCP_PATH 允许不带前导斜杠', async () => {
  const harness = await createTestContext({
    // 故意带尾斜杠、路径故意不带前导斜杠，验证规范化
    API_PUBLIC_BASE_URL: 'https://youzhao.example.com/',
    MCP_PATH: 'mcp',
  });
  try {
    await seedWorld(harness.db);
    const cookie = await login(harness.app, 'owner', OWNER_PASSWORD);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/mcp/connection-info',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.httpUrl, 'https://youzhao.example.com/mcp');
    assert.equal(body.data.path, '/mcp');
  } finally {
    await harness.close();
  }
});

test('接入信息：MCP_ENABLED=false → 503 MCP_DISABLED（不给连不上的地址）', async () => {
  const harness = await createTestContext({ MCP_ENABLED: 'false' });
  try {
    await seedWorld(harness.db);
    const cookie = await login(harness.app, 'owner', OWNER_PASSWORD);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/mcp/connection-info',
      headers: { cookie },
    });
    await expectErrorCode(response, 503, 'MCP_DISABLED');
  } finally {
    await harness.close();
  }
});

test('normalizeMcpPath：补齐前导斜杠，已规范的路径原样返回', () => {
  assert.equal(normalizeMcpPath('/mcp'), '/mcp');
  assert.equal(normalizeMcpPath('mcp'), '/mcp');
  assert.equal(normalizeMcpPath('/custom/mcp'), '/custom/mcp');
  assert.equal(normalizeMcpPath('custom/mcp'), '/custom/mcp');
});
