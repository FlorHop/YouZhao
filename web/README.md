# web —— 有招工作台前端（M4）

Vue 3 + TypeScript + Vite + vue-router + Pinia + PrimeVue 4（Aura 预设 + 自定 token 覆盖）。
视觉取自 Open Design 内置的 `openai` 设计体系（`src/styles/tokens.css` 是唯一绑定层）。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm -C web dev` | 开发服务器（5173，`/api`、`/mcp` 代理到 api） |
| `pnpm -C web dev:preview-origin` | 本地预览域代理（3001，仅转发 `/preview`） |
| `pnpm -C web typecheck` | `vue-tsc --noEmit` |
| `pnpm -C web lint` | `eslint .`（含禁止裸色值的规则） |
| `pnpm -C web test` | `vitest run` |
| `pnpm -C web build` | 类型检查 + 生产构建 |

## 本地联调（必须跑两个进程）

```bash
# 1) 后端（需要 Postgres；迁移见 server/README.md）
pnpm server:dev                       # http://127.0.0.1:3000

# 2) 前端
pnpm -C web dev                       # http://127.0.0.1:5173
pnpm -C web dev:preview-origin        # http://127.0.0.1:3001（预览域）
```

后端的 `PREVIEW_DOMAIN` 要指向预览域（`http://127.0.0.1:3001`），否则产物 iframe
拿到的地址会落在应用域上，`sandbox` 与预览 Cookie 的行为就和生产不一致。

## 目录

```
src/
  app/         # 应用装配（primevue preset、locale、router）
  components/  # 跨页公共组件（PageHeader、MetricRow、StateBlock…）
  pages/       # 路由页面：登录 / 蓝图 / 预览 / 用户 / 权限 / Token / 我的账号 / 403 / 404
  services/    # api（唯一 fetch 通道）、endpoints（契约类型别名仓库）、format（纯格式化）
  stores/      # Pinia（session）
  styles/      # tokens.css（设计体系绑定）+ base.css（结构层）
```

## 约定（改代码前先读）

- **样式只在两个地方定义**：`src/styles/tokens.css`（设计体系取值）与 `src/styles/base.css`
  （结构层，只允许使用 token）。其余地方禁止裸色值，eslint 会拦。
- **服务端契约是唯一事实来源**：类型与校验器都来自 `@youzhao/contracts`；前端不重写字段形状。
- **前端不是安全边界**：路由守卫只决定渲染什么（普通用户整体进不去用户/权限页），
  真正的拒绝由服务端逐接口判定。任何「前端藏起来就等于安全」的写法都不要加。
- **失败态必须有出口**：用 `StateBlock`，别用行内红字替代可操作的重试。

## 冒烟

```bash
pnpm smoke:ui            # 浏览器级 15 步（功能 + 视觉审计 + 键盘与无障碍；需先起 api 与 web dev，并有一个开 CDP 的 Chrome）
pnpm smoke:e2e           # HTTP 契约 16 步（只针对 api）
```

`smoke:ui` 会额外断言设计体系约束：无渐变背景、无横向溢出、字体与强调色绑定 token、
每页主按钮唯一。截图落在 `artifacts/smoke-ui/`（已 gitignore）。
