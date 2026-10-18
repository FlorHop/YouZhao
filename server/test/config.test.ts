import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig, type Env } from '../config.js';
import { minimalEnv } from './helpers.js';

/** loadConfig 抛错时取回 ConfigError（assert.throws 在 @types/node 24 返回 void，无法读取 issues） */
function expectConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `期望 ConfigError，实际是 ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: '期望抛出 ConfigError，但配置加载成功了' });
}

const expectConfigErrorFor = (env: Env) => expectConfigError(() => loadConfig(env));

test('完整环境变量：解析出类型正确的配置并使用默认值', () => {
  const config = loadConfig(minimalEnv());

  assert.equal(config.appEnv, 'test');
  assert.equal(config.appName, 'youzhao');
  assert.equal(config.http.host, '0.0.0.0');
  assert.equal(config.http.port, 3000);
  assert.equal(config.session.cookieName, 'yz_session');
  assert.equal(config.session.ttlSeconds, 43_200);
  assert.deepEqual(config.session.originAllowlist, ['http://127.0.0.1:5173']);
  assert.equal(config.rateLimit.loginPerMinute, 10);
  assert.equal(config.postgres.port, 5432);
  assert.equal(config.preview.ticketTtlSeconds, 60);
  assert.equal(config.mcp.enabled, true);
  assert.equal(config.mcp.maxBodyBytes, 5 * 1024 * 1024);
  assert.equal(config.bootstrap.ownerDisplayName, '系统管理员');
});

test('缺必填项：一次 collect 全部问题，而不是只报第一个', () => {
  const error = expectConfigErrorFor(
    minimalEnv({
      API_PUBLIC_BASE_URL: undefined,
      CSRF_ORIGIN_ALLOWLIST: undefined,
      POSTGRES_HOST: undefined,
      POSTGRES_DB: undefined,
      POSTGRES_USER: undefined,
      POSTGRES_PASSWORD: undefined,
      PREVIEW_STORAGE_PATH: undefined,
      PREVIEW_TICKET_SECRET: undefined,
      PREVIEW_DOMAIN: undefined,
      ADMIN_USERNAME: undefined,
      ADMIN_PASSWORD: undefined,
    }),
  );

  assert.equal(error.issues.length, 11);
  for (const key of [
    'API_PUBLIC_BASE_URL',
    'CSRF_ORIGIN_ALLOWLIST',
    'POSTGRES_HOST',
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'PREVIEW_STORAGE_PATH',
    'PREVIEW_TICKET_SECRET',
    'PREVIEW_DOMAIN',
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
  ]) {
    assert.ok(
      error.issues.some((issue) => issue.includes(key)),
      `issues 应包含 ${key}：${error.issues.join(' | ')}`,
    );
  }
});

test('数值型配置非法时给出可读问题', () => {
  const error = expectConfigErrorFor(minimalEnv({ API_PORT: 'abc', SESSION_TTL_SECONDS: '10' }));
  assert.ok(error.issues.some((issue) => issue.includes('API_PORT 必须是整数')));
  assert.ok(error.issues.some((issue) => issue.includes('SESSION_TTL_SECONDS 不能小于 300')));
});

test('布尔/列表解析：非法布尔值报错，列表按逗号切分并去空', () => {
  const config = loadConfig(
    minimalEnv({
      MCP_ENABLED: 'off',
      CSRF_ORIGIN_ALLOWLIST: 'https://a.example.com, ,https://b.example.com',
    }),
  );
  assert.equal(config.mcp.enabled, false);
  assert.deepEqual(config.session.originAllowlist, [
    'https://a.example.com',
    'https://b.example.com',
  ]);

  const error = expectConfigErrorFor(minimalEnv({ MCP_ENABLED: 'maybe' }));
  assert.ok(error.issues.some((issue) => issue.includes('MCP_ENABLED 必须是布尔值')));
});

test('禁止历史硬编码密钥：youzhao_embed_dev_secret 一律拒绝', () => {
  const error = expectConfigErrorFor(
    minimalEnv({ PREVIEW_TICKET_SECRET: 'youzhao_embed_dev_secret' }),
  );
  assert.ok(
    error.issues.some((issue) => issue.includes('PREVIEW_TICKET_SECRET 使用了被禁止的取值')),
  );
});

test('禁止默认弱口令：123456 不能出现在初始化路径', () => {
  const error = expectConfigErrorFor(minimalEnv({ ADMIN_PASSWORD: '123456' }));
  assert.ok(error.issues.some((issue) => issue.includes('ADMIN_PASSWORD')));
});

test('生产环境：必须 HTTPS、密钥足够长、预览域必须与应用域不同源', () => {
  const error = expectConfigErrorFor(
    minimalEnv({
      APP_ENV: 'production',
      API_PUBLIC_BASE_URL: 'http://youzhao.example.com',
      PREVIEW_DOMAIN: 'http://youzhao.example.com',
      PREVIEW_TICKET_SECRET: 'short-secret',
    }),
  );

  assert.ok(
    error.issues.some((issue) => issue.includes('API_PUBLIC_BASE_URL 在生产环境必须是 https://')),
  );
  assert.ok(
    error.issues.some((issue) => issue.includes('PREVIEW_DOMAIN 必须与应用域不同源')),
    error.issues.join(' | '),
  );
  assert.ok(
    error.issues.some((issue) => issue.includes('PREVIEW_TICKET_SECRET 在生产环境长度至少 32')),
  );
});

test('生产环境合法配置可以通过', () => {
  const config = loadConfig(
    minimalEnv({
      APP_ENV: 'production',
      API_PUBLIC_BASE_URL: 'https://youzhao.example.com',
      PREVIEW_DOMAIN: 'https://preview.youzhao.example.com',
      PREVIEW_TICKET_SECRET: 'T9k2mQ7pR4sV8xZ1aB3cD5eF6gH0jK2l',
      POSTGRES_PASSWORD: 'P9k2mQ7pR4sV8xZ1aB3cD5eF6gH0jK2l',
      ADMIN_PASSWORD: 'A9k2mQ7pR4sV8xZ1aB3cD5eF6gH0jK2l',
    }),
  );
  assert.equal(config.appEnv, 'production');
  assert.equal(config.preview.domain, 'https://preview.youzhao.example.com');
});

test('ADMIN_USERNAME 有字符集约束', () => {
  const error = expectConfigErrorFor(minimalEnv({ ADMIN_USERNAME: '管 理员' }));
  assert.ok(error.issues.some((issue) => issue.includes('ADMIN_USERNAME 只允许')));
});
