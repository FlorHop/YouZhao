/**
 * 环境变量读取与校验（docs/architecture-design.md §3.9）。
 *
 * 纪律：
 * - 缺必填项、类型不合法、生产环境的危险取值 → 收集**全部**问题后抛 `ConfigError`；
 *   调用方（main.ts）打印问题并以非零码退出，绝不"带病启动"。
 * - 不在代码里留任何生产密钥回退值（对照旧实现硬编码的 `youzhao_embed_dev_secret`）。
 */
export type AppEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  appName: string;
  appEnv: AppEnv;
  publicBaseUrl: string;
  timezone: string;
  http: {
    host: string;
    port: number;
    jsonBodyLimitBytes: number;
  };
  session: {
    cookieName: string;
    ttlSeconds: number;
    originAllowlist: string[];
  };
  rateLimit: {
    loginPerMinute: number;
    mcpPerMinute: number;
  };
  /**
   * 存储驱动（§3.1.1 开发注记）：生产只允许 `postgres`；
   * `pglite` 是本地开发/测试在没有 Postgres 时也能把接口跑起来的手段。
   */
  database: {
    driver: 'postgres' | 'pglite';
  };
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  preview: {
    publicBasePath: string;
    storagePath: string;
    ticketSecret: string;
    /** 嵌入共享密钥（docs/architecture-design.md §3.7）：生产必填，开发/测试留空表示未启用嵌入 */
    embedSecret: string;
    ticketTtlSeconds: number;
    domain: string;
  };
  mcp: {
    enabled: boolean;
    path: string;
    maxBodyBytes: number;
  };
  bootstrap: {
    ownerUsername: string;
    ownerPassword: string;
    ownerDisplayName: string;
  };
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`配置校验失败（${issues.length} 项）：\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type Env = Record<string, string | undefined>;

/** 生产环境禁止出现的取值（历史硬编码/文档示例占位符） */
const FORBIDDEN_SECRETS = new Set([
  'youzhao_embed_dev_secret',
  'change_me',
  'changeme',
  'secret',
  '123456',
]);

const OWNER_USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;

class EnvReader {
  readonly issues: string[] = [];

  constructor(private readonly env: Env) {}

  private raw(key: string): string | undefined {
    const value = this.env[key];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  str(
    key: string,
    options: { required?: boolean; fallback?: string; minLength?: number } = {},
  ): string {
    const value = this.raw(key);
    if (value === undefined) {
      if (options.fallback !== undefined) return options.fallback;
      if (options.required) this.issues.push(`缺少必填环境变量 ${key}`);
      return '';
    }
    if (options.minLength !== undefined && value.length < options.minLength) {
      this.issues.push(`${key} 长度至少 ${options.minLength}（当前 ${value.length}）`);
    }
    return value;
  }

  int(
    key: string,
    options: { fallback?: number; required?: boolean; min?: number; max?: number } = {},
  ): number {
    const value = this.raw(key);
    if (value === undefined) {
      if (options.fallback !== undefined) return options.fallback;
      if (options.required) {
        this.issues.push(`缺少必填环境变量 ${key}`);
        return 0;
      }
      return 0;
    }
    if (!/^-?\d+$/.test(value)) {
      this.issues.push(`${key} 必须是整数（当前 ${JSON.stringify(value)}）`);
      return options.fallback ?? 0;
    }
    const parsed = Number.parseInt(value, 10);
    if (options.min !== undefined && parsed < options.min) {
      this.issues.push(`${key} 不能小于 ${options.min}（当前 ${parsed}）`);
    }
    if (options.max !== undefined && parsed > options.max) {
      this.issues.push(`${key} 不能大于 ${options.max}（当前 ${parsed}）`);
    }
    return parsed;
  }

  bool(key: string, fallback: boolean): boolean {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) return false;
    this.issues.push(`${key} 必须是布尔值 true/false（当前 ${JSON.stringify(value)}）`);
    return fallback;
  }

  list(key: string, fallback: string[] = []): string[] {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  /** 生产环境不得使用危险/占位取值 */
  guardSecret(key: string, value: string, appEnv: AppEnv): void {
    if (value === '') return;
    if (FORBIDDEN_SECRETS.has(value.toLowerCase())) {
      this.issues.push(`${key} 使用了被禁止的取值（历史硬编码或文档占位符），请改为随机值`);
    } else if (appEnv === 'production' && value.length < 32) {
      this.issues.push(`${key} 在生产环境长度至少 32（当前 ${value.length}）`);
    }
  }

  /** 生产环境要求 HTTPS */
  guardHttps(key: string, value: string, appEnv: AppEnv): void {
    if (value === '' || appEnv !== 'production') return;
    if (!value.startsWith('https://')) {
      this.issues.push(`${key} 在生产环境必须是 https://（当前 ${value}）`);
    }
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function loadConfig(env: Env = process.env): AppConfig {
  const reader = new EnvReader(env);

  const appName = reader.str('APP_NAME', { fallback: 'youzhao' });
  const appEnvRaw = reader.str('APP_ENV', { fallback: 'development' });
  const appEnv: AppEnv = ['development', 'test', 'production'].includes(appEnvRaw)
    ? (appEnvRaw as AppEnv)
    : 'development';
  if (appEnv !== appEnvRaw) {
    reader.issues.push(`APP_ENV 必须是 development/test/production（当前 ${appEnvRaw}）`);
  }

  const publicBaseUrl = reader.str('API_PUBLIC_BASE_URL', { required: true });
  reader.guardHttps('API_PUBLIC_BASE_URL', publicBaseUrl, appEnv);

  const http = {
    host: reader.str('API_HOST', { fallback: '0.0.0.0' }),
    port: reader.int('API_PORT', { fallback: 3000, min: 1, max: 65535 }),
    jsonBodyLimitBytes: reader.int('API_JSON_BODY_LIMIT_BYTES', {
      fallback: 5 * 1024 * 1024,
      min: 1024,
    }),
  };

  const session = {
    cookieName: reader.str('SESSION_COOKIE_NAME', { fallback: 'yz_session' }),
    ttlSeconds: reader.int('SESSION_TTL_SECONDS', { fallback: 43_200, min: 300, max: 2_592_000 }),
    originAllowlist: reader.list('CSRF_ORIGIN_ALLOWLIST'),
  };
  if (session.originAllowlist.length === 0) {
    reader.issues.push(
      '缺少必填环境变量 CSRF_ORIGIN_ALLOWLIST（逗号分隔的允许来源，例如 http://127.0.0.1:5173）',
    );
  }

  const rateLimit = {
    loginPerMinute: reader.int('RATE_LIMIT_LOGIN_PER_MINUTE', { fallback: 10, min: 1, max: 600 }),
    // MCP 是机器通道：默认额度比登录宽松，但必须有上限（§4.5「调用限流」）
    mcpPerMinute: reader.int('RATE_LIMIT_MCP_PER_MINUTE', { fallback: 120, min: 1, max: 100_000 }),
  };

  const driverRaw = reader.str('DB_DRIVER', { fallback: 'postgres' });
  if (driverRaw !== 'postgres' && driverRaw !== 'pglite') {
    reader.issues.push(`DB_DRIVER 必须是 postgres 或 pglite（当前 ${driverRaw}）`);
  }
  if (driverRaw === 'pglite' && appEnv === 'production') {
    reader.issues.push('DB_DRIVER=pglite 只用于本地开发/测试：生产必须连接真实 Postgres');
  }
  const usePostgres = driverRaw !== 'pglite';

  const postgres = usePostgres
    ? {
        host: reader.str('POSTGRES_HOST', { required: true }),
        port: reader.int('POSTGRES_PORT', { fallback: 5432, min: 1, max: 65535 }),
        database: reader.str('POSTGRES_DB', { required: true }),
        user: reader.str('POSTGRES_USER', { required: true }),
        password: reader.str('POSTGRES_PASSWORD', { required: true, minLength: 4 }),
      }
    : {
        host: reader.str('POSTGRES_HOST', { fallback: '' }),
        port: reader.int('POSTGRES_PORT', { fallback: 5432, min: 1, max: 65535 }),
        database: reader.str('POSTGRES_DB', { fallback: '' }),
        user: reader.str('POSTGRES_USER', { fallback: '' }),
        password: reader.str('POSTGRES_PASSWORD', { fallback: '' }),
      };
  if (usePostgres) reader.guardSecret('POSTGRES_PASSWORD', postgres.password, appEnv);

  const preview = {
    publicBasePath: reader.str('PREVIEW_PUBLIC_BASE_PATH', { fallback: '/preview' }),
    storagePath: reader.str('PREVIEW_STORAGE_PATH', { required: true }),
    ticketSecret: reader.str('PREVIEW_TICKET_SECRET', { required: true }),
    // 旧实现有硬编码回退值（youzhao_embed_dev_secret），这里删除回退：生产必须显式注入
    embedSecret: reader.str(
      'PREVIEW_EMBED_SECRET',
      appEnv === 'production' ? { required: true, minLength: 32 } : {},
    ),
    ticketTtlSeconds: reader.int('PREVIEW_TICKET_TTL_SECONDS', { fallback: 60, min: 10, max: 900 }),
    domain: reader.str('PREVIEW_DOMAIN', { required: true }),
  };
  reader.guardSecret('PREVIEW_TICKET_SECRET', preview.ticketSecret, appEnv);
  reader.guardSecret('PREVIEW_EMBED_SECRET', preview.embedSecret, appEnv);
  reader.guardHttps('PREVIEW_DOMAIN', preview.domain, appEnv);

  // 预览域必须与应用域不同源：同源会让发布者可控的产物能读取会话 Cookie（旧实现的存储型 XSS 面）
  const apiOrigin = originOf(publicBaseUrl);
  const previewOrigin = originOf(preview.domain);
  if (apiOrigin !== null && previewOrigin !== null && apiOrigin === previewOrigin) {
    reader.issues.push(
      `PREVIEW_DOMAIN 必须与应用域不同源（两者都是 ${apiOrigin}）；产物同源交付会让产物脚本获得会话能力`,
    );
  }

  const mcp = {
    enabled: reader.bool('MCP_ENABLED', true),
    path: reader.str('MCP_PATH', { fallback: '/mcp' }),
    maxBodyBytes: reader.int('MCP_MAX_BODY_BYTES', { fallback: 5 * 1024 * 1024, min: 1024 }),
  };

  const bootstrap = {
    ownerUsername: reader.str('ADMIN_USERNAME', { required: true }),
    ownerPassword: reader.str('ADMIN_PASSWORD', { required: true, minLength: 8 }),
    ownerDisplayName: reader.str('ADMIN_DISPLAY_NAME', { fallback: '系统管理员' }),
  };
  if (bootstrap.ownerUsername !== '' && !OWNER_USERNAME_PATTERN.test(bootstrap.ownerUsername)) {
    reader.issues.push(
      `ADMIN_USERNAME 只允许 3-64 位字母、数字、点、下划线、连字符（当前 ${bootstrap.ownerUsername}）`,
    );
  }
  reader.guardSecret('ADMIN_PASSWORD', bootstrap.ownerPassword, appEnv);

  if (reader.issues.length > 0) throw new ConfigError(reader.issues);

  return {
    appName,
    appEnv,
    publicBaseUrl,
    timezone: reader.str('APP_TIMEZONE', { fallback: 'Asia/Shanghai' }),
    http,
    session,
    rateLimit,
    database: { driver: driverRaw === 'pglite' ? 'pglite' : 'postgres' },
    postgres,
    preview,
    mcp,
    bootstrap,
  };
}
