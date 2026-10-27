# 有招（YouZhao）

内部演示蓝图平台：把 HTML / Markdown 演示产物按「分组 → 蓝图 → 版本」组织起来，通过浏览器预览，并让 AI Agent 经 MCP 读取与发布。

本仓库是 **v2 重建**（契约优先 + PostgreSQL 关系模型 + MCP 服务）。旧版单文件 `app_state` JSON 应用已在 M6 切流中移除；旧数据可经迁移工具导入（见下）。设计与实施文档在 [`docs/`](docs/)。

## 最近变更（2026-10）

- **管辖上线**（迁移 `0006_jurisdiction`）：新增 `group_managers` / `blueprint_managers` 两张表，配 `GET /api/users/:id/access`、`PUT /api/users/:id/jurisdiction`；`/api/me` 的 `capabilities` 改为**有效能力**（管辖派生 ∪ 例外授权），并新增 `jurisdiction` 字段。
- **建组收回给所有者**：`group.create` 只对 `owner` 放行；建组不再自动写任何授权行。管理员需要新分组时，由所有者先建组、再用「管辖」把组交给他。
- 权限口径以 [`docs/permission-design.md`](docs/permission-design.md) §2.2（例外授权）/ §2.3（管辖）/ §4（十三条不变量）为准；生产升级记录见 [`docs/architecture-design.md`](docs/architecture-design.md) §8.5。

---

## 一眼看懂的结构

| 目录 | 内容 |
| --- | --- |
| `packages/contracts/` | **契约唯一事实来源**：`schemas/**/*.json`（JSON Schema）+ 生成器（`gen` / `check`）→ `generated/*.ts`（类型与服务端校验共用） |
| `server/` | Fastify + PostgreSQL 16 + Kysely 的 API；含身份权限域、蓝图与产物存储、预览票据、MCP 服务、旧数据迁移 CLI |
| `web/` | Vue 3 + PrimeVue 前端（工作台 + 预览运行时的宿主页），OpenAI 设计体系 token 绑定 |
| `deploy/` | 容器化编排：compose（postgres / api / web / gateway）、网关 nginx、安装/升级/备份/恢复脚本；**原生安装**的逐条跑单见本文「部署」一节 |
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

服务端测试跑内存库（pglite），不需要本地 PostgreSQL；全量约 4 分钟，线上排查建议后台执行。冒烟脚本要显式传账号：`node scripts/smoke-e2e.mjs --base <url> --preview <url> --origin <url> --username <admin> --password <pwd>`。

---

## 权限模型（2026-10 现状）

四层正交判定，服务端强制，前端隐藏按钮只是体验优化：

| 层 | 表 | 作用 |
| --- | --- | --- |
| 身份 | `user_identity` | `owner`（全平台唯一，隐式全权）/ `user_admin`（管被指派的用户 + 自己管辖的分组）/ `member` |
| 查看权 | `view_grants` | 读：分组或单蓝图；管理员可委派的查看范围 = 自己的查看范围 |
| **管辖** | `group_managers` / `blueprint_managers` | 把分组或单张蓝图交给某位用户管理员负责（**只有所有者能设**） |
| 业务能力 | `capabilities` | **例外授权**：`blueprint.manage`（维护）/ `blueprint.publish`（建蓝图、发版本），必须带资源范围 |

- **有效能力 = 管辖派生 ∪ 例外授权**（并集，只加不减）：分组管辖 ⇒ 该组「维护 + 发布」，并覆盖组内全部蓝图；单蓝图管辖 ⇒ 只「维护」，**不**推出在该组新建。所有者由策略短路放行，不写能力行。
- **MCP Token** 最终权限 = 绑定用户的有效能力 ∩ Token scope（`read:blueprint` / `publish:blueprint`）。
- **建组只有所有者能做**（`group.create`）：建组等于划新地盘，不由管辖派生，否则「管一个组」会被延伸成「无限建组、每组都自动带发版权」。管理员需要新组 → 向所有者申请，所有者建组后用管辖把组交给他。
- 「只维护不发版」的管理员：只给 `blueprint.manage`（或只划单蓝图管辖），他的发布入口与发布 Token 都不可用。

完整矩阵、十三条不变量与端点契约见 [`docs/permission-design.md`](docs/permission-design.md)（§2.2 例外授权、§2.3 管辖、§4 不变量）。

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

两种形态，**选一种，不要混用同一套数据库**：

| 形态 | 适用 | 入口 |
| --- | --- | --- |
| **原生安装**（当前生产形态） | 单机 ECS / 内网服务器，无容器运行时 | 下一节，逐条照抄即可 |
| 容器编排 | 已有 Docker Compose 的环境 | [`deploy/README.md`](deploy/README.md)：`install.sh` / `upgrade.sh` / `backup.sh` / `restore.sh` |

两种形态的接口面一致：应用域 `/` → web、`/api` 与 `/mcp` → api；预览走**独立域** `/preview/...` → api，应用域下的 `/preview*` 恒 404（预览域必须与应用域不同源，服务端启动时校验）。

### 原生安装（Agent 可直接照做的跑单）

前置：Ubuntu 24.04+、PostgreSQL 16、Node 24、pnpm 12、nginx、两个域名（应用域 + 预览域）与证书；建议 ≥2 GiB 内存（1.6 GiB 可跑，但要把 `NODE_OPTIONS` 压到 384 MB）。

```bash
# 0) 前置自检
node -v && pnpm -v && psql --version && nginx -v

# 1) 专用用户与目录：应用一律以 youzhao 身份运行，不要用 root 跑 pnpm/node
useradd -r -m -d /srv/youzhao -s /bin/bash youzhao
mkdir -p /srv/youzhao/{app,data/previews,logs} /etc/youzhao
chown -R youzhao:youzhao /srv/youzhao

# 2) 代码与依赖（契约包 / 服务端 / 前端各自独立安装）
sudo -u youzhao git clone --branch rebuild-v2 --depth 1 https://github.com/FlorHop/YouZhao.git /srv/youzhao/app
sudo -u youzhao bash -c 'cd /srv/youzhao/app && pnpm -C packages/contracts install && pnpm -C server install && pnpm -C web install'

# 3) 数据库（密码换成 openssl rand -hex 32 的结果）
sudo -u postgres psql -c "CREATE ROLE youzhao LOGIN PASSWORD '<随机>'"
sudo -u postgres psql -c "CREATE DATABASE youzhao OWNER youzhao"

# 4) 配置：把下方清单写进 /etc/youzhao/api.env，然后 chown root:youzhao && chmod 640
# 5) 迁移（必须先于启动：api 启动时发现未执行迁移会直接退出）
#    注意：迁移 CLI 读的是进程环境变量，不会自动读 systemd 的 EnvironmentFile，所以要显式引入
sudo -u youzhao bash -c 'set -a; . /etc/youzhao/api.env; set +a; cd /srv/youzhao/app && pnpm server:migrate'
# 6) 前端静态资源（产物在 web/dist，由 nginx 直接托管）
sudo -u youzhao pnpm -C web build
```

`/etc/youzhao/api.env` 的完整键（`<…>` 必须换成本地随机值，建议 `openssl rand -hex 32`）：

```ini
APP_NAME=youzhao
APP_ENV=production
APP_HOST=https://<应用域>
APP_TIMEZONE=Asia/Shanghai
API_HOST=127.0.0.1                 # 由 nginx 反代；直连暴露才改 0.0.0.0
API_PORT=3000
API_PUBLIC_BASE_URL=https://<应用域>
API_JSON_BODY_LIMIT_BYTES=5242880
SESSION_TTL_SECONDS=43200
SESSION_COOKIE_NAME=yz_session
CSRF_ORIGIN_ALLOWLIST=https://<应用域>
RATE_LIMIT_LOGIN_PER_MINUTE=10
RATE_LIMIT_MCP_PER_MINUTE=120
DB_DRIVER=postgres
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=youzhao
POSTGRES_USER=youzhao
POSTGRES_PASSWORD=<随机>
ADMIN_USERNAME=admin               # 仅首次启动、用户表为空时创建所有者
ADMIN_PASSWORD=<随机，≥12 位>
ADMIN_DISPLAY_NAME=系统管理员
PREVIEW_PUBLIC_BASE_PATH=/preview
PREVIEW_STORAGE_PATH=/srv/youzhao/data/previews
PREVIEW_TICKET_SECRET=<随机>
PREVIEW_EMBED_SECRET=<随机 ≥32；留空则嵌入接口 503>
PREVIEW_TICKET_TTL_SECONDS=60
PREVIEW_DOMAIN=https://<预览域>       # 必须与应用域不同源
MCP_ENABLED=true
MCP_MAX_BODY_BYTES=5242880
MCP_PATH=/mcp
```

systemd 单元 `/etc/systemd/system/youzhao-api.service`：

```ini
[Unit]
Description=YouZhao API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=youzhao
Group=youzhao
WorkingDirectory=/srv/youzhao/app/server
EnvironmentFile=/etc/youzhao/api.env
Environment=NODE_OPTIONS=--max-old-space-size=384
ExecStart=/srv/youzhao/app/server/node_modules/.bin/tsx main.ts
Restart=always
RestartSec=3
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/srv/youzhao/data
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

nginx 两个 vhost（Ubuntu 自带 `/etc/nginx/proxy_params`，其它发行版把转发头写进每个 `location`）：

```nginx
# /etc/nginx/conf.d/<应用域>.conf
server {
  listen 443 ssl http2;
  server_name <应用域>;
  ssl_certificate     /etc/letsencrypt/live/<应用域>/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/<应用域>/privkey.pem;
  add_header Strict-Transport-Security "max-age=15552000" always;
  root /srv/youzhao/app/web/dist;
  index index.html;

  location /api/  { proxy_pass http://127.0.0.1:3000; include /etc/nginx/proxy_params; proxy_buffering off; }
  location /mcp   { proxy_pass http://127.0.0.1:3000; include /etc/nginx/proxy_params; proxy_buffering off; proxy_read_timeout 300s; }
  location /preview { return 404; }                  # 预览只在预览域交付
  location /      { try_files $uri $uri/ /index.html; }
}

# /etc/nginx/conf.d/<预览域>.conf
server {
  listen 443 ssl http2;
  server_name <预览域>;
  ssl_certificate     /etc/letsencrypt/live/<预览域>/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/<预览域>/privkey.pem;
  add_header Strict-Transport-Security "max-age=15552000" always;

  location /preview/ { proxy_pass http://127.0.0.1:3000; include /etc/nginx/proxy_params; }
  location /         { return 404; }
}
```

```bash
systemctl daemon-reload && systemctl enable --now youzhao-api
curl -fsS http://127.0.0.1:3000/api/health    # 期望 contractVersion 2.0.0、services.database=up
curl -fsS https://<应用域>/ | grep -o 'assets/index-[^"]*\.js'   # 确认拿到新前端包
```

### 升级（每次发版都是这套顺序）

```bash
sudo -u youzhao git -C /srv/youzhao/app pull --ff-only
sudo -u youzhao bash -c 'cd /srv/youzhao/app && pnpm -C server install && pnpm -C web install'
sudo -u youzhao bash -c 'set -a; . /etc/youzhao/api.env; set +a; cd /srv/youzhao/app && pnpm server:migrate'   # 先迁移
sudo -u youzhao pnpm -C web build                                      # 再构建前端
systemctl restart youzhao-api                                          # 最后重启 API
systemctl is-active youzhao-api && curl -fsS http://127.0.0.1:3000/api/health
```

- **顺序不能换**：api 启动时会校验迁移完整性，发现未执行的迁移会直接拒绝启动（防止新代码跑旧库）。
- 迁移 CLI 若不方便读 env 文件，可用 `DATABASE_URL=postgres://youzhao:<pwd>@127.0.0.1:5432/youzhao` 显式覆盖（CI / 一次性容器常用）。
- 迁移只前进、没有 down 脚本；回滚 = 恢复升级前的 `pg_dump` + 切回旧提交 + 重建前端。
- 升级前先备份：`pg_dump -Fc youzhao > /root/youzhao-predeploy-$(date +%Y%m%d-%H%M%S).dump`，并同步 `cp /etc/youzhao/api.env /root/`。

### 原生安装的三个已知坑

1. **root 残留文件会让 `git pull` / `web build` 失败**：`.git/objects` 或 `web/dist` 里有 root 拥有的文件时报 `insufficient permission ...` 或 `EACCES`；`chown -R youzhao:youzhao /srv/youzhao/app/.git /srv/youzhao/app/web/dist` 后重试。纪律：`git pull` / `pnpm install` / `pnpm build` / `pnpm server:migrate` 一律 `sudo -u youzhao`，只有 `pg_dump`、`systemctl`、`chown` 走 root。
2. **已应用的迁移文件不能再改**：`schema_migrations` 记了每个文件的 sha256，改历史文件会在迁移时报校验失败；要调整就新增一个迁移。
3. **预览域必须与应用域不同源**：`PREVIEW_DOMAIN` 与应用域同源时服务端启动即失败；本地用 `pnpm web:preview-origin`（3001 端口）模拟。

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
