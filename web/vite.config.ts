import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * 开发期拓扑（与生产同构，见 docs/architecture-design.md §3.6）：
 *   - 应用域：本 dev server（默认 5173）。`/api` 反代到 API（默认 3000）。
 *   - 预览域：**必须与应用域不同源**（服务端 config 强制校验），
 *     由 `pnpm dev:preview-origin` 在 3001 起一个只转发 `/preview` 的小代理。
 *     产物 iframe 因此与页面跨源，`sandbox` 与预览 Cookie 的行为在本地就与生产一致。
 */
const API_TARGET = process.env.YOUZHAO_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      // MCP 只给 Agent 用，浏览器界面不需要；保留一条便于联调。
      '/mcp': { target: API_TARGET, changeOrigin: false },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
  build: {
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          primevue: ['primevue', '@primeuix/themes'],
        },
      },
    },
  },
});
