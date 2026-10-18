/**
 * 进程入口（docs/architecture-design.md §3.2、§3.8、§3.9）。
 *
 * 纪律：**缺配置、数据库不可达、迁移未完成 → 明确报错并非零码退出**，绝不带病启动。
 */
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { assertMigrationsApplied } from './db/migrate.js';
import { openStorage } from './db/open.js';
import { ensureInitialOwner } from './app/bootstrap.js';
import { buildServer } from './http/app.js';

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }

  const storage = await openStorage(config);
  const { db } = storage;

  try {
    await assertMigrationsApplied(storage.runner);
  } catch (error) {
    await storage.close().catch(() => undefined);
    fail(`启动自检失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 初始所有者由环境变量注入并保证幂等（§3.4 规则 4）；不再提供 setup 接口
  try {
    const owner = await ensureInitialOwner(db, {
      username: config.bootstrap.ownerUsername,
      password: config.bootstrap.ownerPassword,
      displayName: config.bootstrap.ownerDisplayName,
    });
    if (owner.created) {
      console.info(`✓ 已创建初始所有者「${config.bootstrap.ownerUsername}」，首次登录后需修改密码`);
    }
  } catch (error) {
    await storage.close().catch(() => undefined);
    fail(`初始化所有者失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const app = buildServer({
    config,
    db,
    probeDatabase: () => storage.probe(),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await storage.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ host: config.http.host, port: config.http.port });
  app.log.info(
    { env: config.appEnv, previewDomain: config.preview.domain, mcpEnabled: config.mcp.enabled },
    'youzhao api ready',
  );
}

await main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
