/** 测试用最小合法环境变量：任何用例只在它之上做增减 */
export function minimalEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    APP_ENV: 'test',
    API_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    CSRF_ORIGIN_ALLOWLIST: 'http://127.0.0.1:5173',
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_PORT: '5432',
    POSTGRES_DB: 'youzhao_test',
    POSTGRES_USER: 'youzhao',
    POSTGRES_PASSWORD: 'local-dev-password',
    PREVIEW_STORAGE_PATH: '/tmp/youzhao-previews',
    PREVIEW_TICKET_SECRET: 'local-dev-ticket-secret-0123456789',
    PREVIEW_DOMAIN: 'http://127.0.0.1:3001',
    PREVIEW_EMBED_SECRET: 'local-dev-embed-secret-0123456789',
    ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD: 'local-dev-owner-password',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

/** `minimalEnv()` 里的允许来源，状态变更用例要带上它 */
export const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';

/**
 * 一个「一旦被使用就报错」的数据库替身。
 * 用于证明某些路由（如健康检查）真的不碰数据库——比传一个真库更严格。
 */
export function unusedDb(): unknown {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`此路由不应访问数据库（试图读取 ${String(property)}）`);
      },
    },
  );
}

