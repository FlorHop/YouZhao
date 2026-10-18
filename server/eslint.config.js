import tseslint from 'typescript-eslint';

/**
 * 后端 lint（M0）：只用 typescript-eslint 推荐规则。
 * 不引入需要类型信息的规则（type-aware），让 lint 与 tsc 各自独立、跑得快。
 */
export default tseslint.config(
  {
    // mcp-server.mjs 是 M3 重写的 stdio 薄桥（纯 .mjs，没有类型信息可 lint）
    ignores: ['node_modules/**', 'mcp-server.mjs'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // 进程入口（main.ts）、CLI（db/migrate.ts、db/migrate-legacy.ts）与
    // 共享存储接线（db/open.ts：pglite 的启动告警必须让人看见）
    files: ['main.ts', 'db/migrate.ts', 'db/migrate-legacy.ts', 'db/open.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // audit/audit.ts 的写入失败兜底：审计不得抛异常打断业务，只允许这一行 stderr
    files: ['audit/audit.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // 测试要断言 console.error 被调用、要静音噪音
    files: ['test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
