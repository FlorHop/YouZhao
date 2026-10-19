# 有招（YouZhao）

内部演示蓝图平台：把 HTML / Markdown 演示产物按「分组 → 蓝图 → 版本」组织起来，通过浏览器预览，并让 AI Agent 经 MCP 读取与发布。

本仓库是 **v2 重建**（契约优先 + PostgreSQL 关系模型 + MCP 服务）。旧版单文件 `app_state` JSON 应用已在 M6 切流中移除；旧数据可经迁移工具导入（见下）。设计与实施文档在 [`docs/`](docs/)。

---

## 一眼看懂的结构

| 目录 | 内容 |
| --- | --- |
| `packages/contracts/` | **契约唯一事实来源**：`schemas/**/*.json`（JSON Schema）+ 生成器（`gen` / `check`）→ `generated/*.ts`（类型与服务端校验共用） |
| `server/` | Fastify + PostgreSQL 16 + Kysely 的 API；含身份权限域、蓝图与产物存储、预览票据、MCP 服务、旧数据迁移 CLI |
| `web/` | Vue 3 + PrimeVue 前端（工作台 + 预览运行时的宿主页），OpenAI 设计体系 token 绑定 |
| `deploy/` | 容器化编排：compose（postgres / api / web / gateway）、网关 nginx、安装/升级/备份/恢复脚本 |
| `scripts/` | 无三方依赖的验收脚本：`smoke:e2e`（HTTP 契约 16 步）、`smoke:ui`（浏览器 15 步，含视觉与键盘无障碍审计） |
| `skills/youzhao-mcp/` | MCP 接入说明（SKILL.md、逐工具参考、stdio 桥与冒烟脚本） |
| `docs/` | 产品 PRD、架构设计（含 M0–M6 落地注记）、权限设计、前端设计、交互审核 |

> **契约单一事实来源**：任何接口字段改动都先改 `packages/contracts/schemas/`，再 `pnpm contracts:gen`；`pnpm verify` 的第一步会拒绝未同步的生成物。

---

## 本地启动（本机没有 PostgreSQL 时）

前置：Node ≥ 20（本机 24.x）、`pnpm`。

```bash
# 1) 安装依赖（契约包 / 服务端 / 前端各自独立）
pnpm -C packages/contracts install && pnpm -C server install && pnpm -C web install

# 2) 环境变量：样例即本地可跑的值
cp server/.env.example server/.env
#   本机没有 PostgreSQL → 把 server/.env 里的 DB_DRIVER 改成 pglite（内存库，重启即清空，生产被硬拒）

# 3) 起 API（默认 http://127.0.0.1:3000）
pnpm server:dev

# 4) 起前端（另开一个终端；Vite 监听 [::1]:5173，请用 http://localhost:5173 访问）
pnpm web:dev

# 5) 起「预览域」代理（再开一个终端）——预览域必须与应用域不同源，本地用 3001 模拟
pnpm web:preview-origin
```

首次启动会用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 自动创建**所有者**（identity = `owner`，隐式拥有全部业务能力与可见范围），并提示修改口令。

有 PostgreSQL 16 时把 `DB_DRIVER=postgres`（默认）与 `POSTGRES_*` 填好即可，其余步骤相同。

---

## 验收与门禁

```bash
pnpm verify    # 契约 check+test → server lint/typecheck/test → web lint/typecheck/test

# 端到端冒烟（需要先把 API 跑起来）
pnpm smoke:e2e -- --base http://127.0.0.1:3000

# 浏览器级冒烟（需要 API + web dev + Chrome 以 CDP 启动；见 web/README.md）
pnpm smoke:ui
```

`smoke:e2e` 覆盖：健康检查、登录、分组、Token（断言响应不含 `token_hash`）、MCP `tools/list` 与发布、蓝图列表与详情、预览票据 → 303 换 Cookie → 产物（校验 CSP / nosniff）、匿名与二次换票必须 403、Token 删除后立即失效。

---

## 权限模型（一句话版）

三种互斥身份：**所有者**（全平台唯一，隐式拥有全部能力）、**用户管理员**（只能管理被指派的用户，且只能授予**自己获准委派**的查看范围）、**成员**（只能看到被授权的蓝图）。

业务能力 `blueprint.manage` / `blueprint.publish` 必须带资源范围；所有者之外谁都不能管理同级或所有者。完整矩阵、错误码与端点契约见 [`docs/permission-design.md`](docs/permission-design.md)。

---

## 旧数据迁移（v1 → v2）

```bash
# 先干跑，看「迁移前后可见范围对照」与需要人工确认的事项
pnpm server:migrate:legacy -- --data-dir /data/youzhao --owner admin --dry-run --report /tmp/legacy-report.json
# 确认后落库
pnpm server:migrate:legacy -- --data-dir /data/youzhao --owner admin --report /tmp/legacy-report.json
```

要点：旧明文口令一次性转为 scrypt 并强制改密；旧 Token 只迁元数据且一律停用（需重建）；旧模型没有「管理归属」概念，需在所有者的权限页批量指派；原分组已被删除的蓝图会落入**无授权占位分组**（不改变任何人的可见范围）；可见范围变宽的人会在报告里逐条点名。详见 [`docs/architecture-design.md`](docs/architecture-design.md) §8.1。

---

## 部署

```bash
cd deploy
cp .env.example .env      # 首次请把 please-change-this-* 换成随机值
./scripts/install.sh      # 构建并起 postgres / api / web / gateway，等待健康检查
./scripts/upgrade.sh      # 升级（默认先备份）
./scripts/backup.sh       # 备份（数据库 dump + 产物目录 + .env 快照）
./scripts/restore.sh      # 恢复（需二次确认）
```

应用域 `/` → web、`/api` 与 `/mcp` → api；预览**独立域** `/preview/...` → api，应用域下的 `/preview*` 一律 404。详见 [`deploy/README.md`](deploy/README.md) 与 [`docs/architecture-design.md`](docs/architecture-design.md) §8.2。

---

## MCP 接入

**远端 HTTP（推荐）**——不用克隆仓库，也不用在本机装 Node：

```bash
# Codex CLI 0.162+
export YOUZHAO_MCP_TOKEN="yz_mcp_..."
codex mcp add youzhao --url https://youzhao.florai.cn/mcp --bearer-token-env-var YOUZHAO_MCP_TOKEN
```

**只支持 stdio 的客户端**（Claude Desktop、Cursor 等）用生态桥 `mcp-remote`：

```json
{
  "mcpServers": {
    "youzhao": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://youzhao.florai.cn/mcp",
               "--header", "Authorization: Bearer <粘贴 Token 明文>"]
    }
  }
}
```

- 接入地址由服务端给出：`GET /api/mcp/connection-info` 返回 `httpUrl`、认证方式与协议信息，前端不再硬编码主机名。
- 连不上先自检：`POST /api/mcp-tokens/verify` 收明文 Token，环回本服务的 `/mcp` 跑一次 `initialize` + `tools/list`（不调用业务工具、不写业务审计），返回 `{ ok, protocolVersion, toolCount, tools, latencyMs }`。

Token 在「MCP Token」页创建（明文只显示一次）。实际能力 = **绑定用户的平台权限 ∩ Token scope**；`read:blueprint` 只能读，`publish:blueprint` 才能发布。应用内「连接 Agent」面板会按客户端生成上面的配置（样式原型：[`docs/design/mcp-connect-panel.html`](docs/design/mcp-connect-panel.html)）。工具清单与逐工具入参见 [`skills/youzhao-mcp/`](skills/youzhao-mcp/)——共 **8 个工具 = 4 读 + 4 写**。

---

## 文档索引

| 文档 | 用途 |
| --- | --- |
| [`docs/demo-platform-prd.md`](docs/demo-platform-prd.md) | 产品需求（用户/权限/蓝图/MCP 的原始口径） |
| [`docs/architecture-design.md`](docs/architecture-design.md) | 前后端与 MCP 架构、数据模型、M0–M6 落地注记、部署与迁移要点 |
| [`docs/permission-design.md`](docs/permission-design.md) | 权限模型、矩阵、不变量、端点与错误码契约 |
| [`docs/mcp-onboarding-design.md`](docs/mcp-onboarding-design.md) | MCP 客户端接入优化：问题定位、接入契约（`connection-info` / `verify`）、分步落地与验收 |
| [`docs/frontend-design.md`](docs/frontend-design.md) | 页面清单与逐页交互规格（P1–P8） |
| [`docs/deployment-rules.md`](docs/deployment-rules.md) · [`docs/frontend-rules.md`](docs/frontend-rules.md) | 部署约束与前端规范（设计令牌、组件优先级、页面骨架） |
| [`docs/prototype-interaction-review.md`](docs/prototype-interaction-review.md) | 早期高保真原型的交互审核记录 |
| [`docs/design/mcp-connect-panel.html`](docs/design/mcp-connect-panel.html) | 「连接 Agent」面板样式原型（四状态可交互，截图在 `docs/design/shots/`） |
