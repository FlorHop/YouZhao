# 有招 · 单机部署与运维（deploy/）

一页看完：拓扑、首次部署、日常运维、备份恢复、预览域、MCP 接入、故障排查。
所有可变项都在 `deploy/.env`（模板：[.env.example](.env.example)，逐项带注释）；本目录不含任何密钥。

---

## 1. 拓扑

```
                        ┌──────────────────────────────────────────┐
   浏览器 / MCP 客户端 →│ gateway  nginx:1.27-alpine（唯一对外入口）│
                        └──────────────────────────────────────────┘
                                   │                        │
             应用域 :80 ${GATEWAY_APP_HOST}      预览域 :8080 ${GATEWAY_PREVIEW_HOST}
             /            → web (SPA 静态)       /preview  → api
             /api/        → api                  /health   → api（探活别名）
             /mcp         → api（关缓冲/长超时）
             /health      → api（探活别名）
             /preview*    → 404（产物不得与应用同源）
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        │  compose 内部网络 youzhao-net（只有 gateway 发布端口）│
        │   web (nginx + /usr/share/nginx/html)   :80           │
        │   api (Fastify + MCP Streamable HTTP)   :3000         │
        │   postgres (PostgreSQL 16)              :5432         │
        └───────────────────────────────────────────────────────┘
   数据落盘（宿主目录，也是备份对象）：
   ${DATA_ROOT:-/data/youzhao}/postgres     ← 命名卷 youzhao-postgres-data（bind）
   ${DATA_ROOT:-/data/youzhao}/previews     ← 命名卷 youzhao-preview-data（bind）
   ${DATA_ROOT:-/data/youzhao}/backups      ← backup.sh 产物
```

- 容器：`youzhao-postgres` / `youzhao-api` / `youzhao-web` / `youzhao-gateway`（compose 项目名 = `COMPOSE_PROJECT_NAME`）。
- 迁移：api 容器启动时执行 `db/migrate.ts`，所以「api 健康」= 迁移完成。
- 预览目录在容器内固定为 `/data/youzhao/previews`，容器内进程是 uid 1000 的 `node`。

| 文件 | 作用 |
|---|---|
| [compose.yaml](compose.yaml) | 四个服务 + 卷 + 网络；全部 `${VAR}` 插值，无密钥明文 |
| [.env.example](.env.example) | 变量清单（`cp` 成 `.env` 后必须替换占位符） |
| [gateway/nginx.conf](gateway/nginx.conf) | 网关配置模板（容器入口脚本 `envsubst` 渲染；TLS 写法见文末注释） |
| [Dockerfile.api](Dockerfile.api) / [Dockerfile.web](Dockerfile.web) | api 镜像 / web 镜像（构建上下文 = 仓库根） |
| [scripts/install.sh](scripts/install.sh) | 首次部署（幂等） |
| [scripts/upgrade.sh](scripts/upgrade.sh) | 升级：先备份 → 构建 → 等健康 → 失败给回滚指引 |
| [scripts/backup.sh](scripts/backup.sh) | 备份：`pg_dump -Fc` + 产物 tar + 配置快照 + 校验和 |
| [scripts/restore.sh](scripts/restore.sh) | 恢复：二次确认 + 恢复前自动再备份 |

---

## 2. 首次部署

前置：Docker Engine（含 compose v2 插件或独立 `docker-compose` 1.29+）、可写 `${DATA_ROOT}`（默认需 root 或已授权）、`80` 与 `8080` 空闲、DNS 已指向本机。

```bash
git clone <repo> && cd youzhao && git checkout rebuild-v2
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env          # 至少改：GATEWAY_APP_HOST / GATEWAY_PREVIEW_HOST /
                             #          API_PUBLIC_BASE_URL / PREVIEW_DOMAIN / ADMIN_PASSWORD
bash deploy/scripts/install.sh            # 本机无证书验收加 --dev；无人值守加 -y
```

`install.sh` 会：校验 docker/compose → 若无 `.env` 则由模板生成并把 `please-change-this-*` 换成随机值（`chmod 600`）→ 校验必填项与生产硬性规则 → 建数据目录 → 检查端口 → `compose build` → `compose up -d` → 等 `/health` → 打印访问地址。

要点：

- 占位符 `please-change-this-…` 在 production 下会被拒（长度 <32）；用 `openssl rand -hex 32` 生成。`server/config.ts` 的 `FORBIDDEN_SECRETS`（`change_me`/`changeme`/`secret`/`123456`）在**任何**环境都会被拒。
- production 必须 `APP_ENV=production`、`DB_DRIVER=postgres`、且 `API_PUBLIC_BASE_URL` 与 `PREVIEW_DOMAIN` 都是 `https://` 且**不同源**。
- 生产环境无证书时：先在 `.env` 用 `*.local` 域名 + `--dev` 跑通，再按 [gateway/nginx.conf](gateway/nginx.conf) 文末步骤启用 TLS 并改回 `production`。
- 首次登录用 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（`ADMIN_PASSWORD` 至少 8 位），登录后立刻改密。

---

## 3. 常用运维命令

```bash
cd deploy
COMPOSE="docker compose -p youzhao -f compose.yaml"    # 独立版则是 docker-compose

$COMPOSE ps                       # 服务与健康状态
$COMPOSE logs -f --tail=100 api   # api 日志（迁移输出在这里）
$COMPOSE restart api              # 重启单个服务
$COMPOSE up -d --no-deps --force-recreate gateway   # api 重建后刷新网关 upstream IP
$COMPOSE down                     # 停服（保留卷与数据）
$COMPOSE config -q                # 只校验配置，不起服务

bash scripts/upgrade.sh           # 升级（会先自动备份）
bash scripts/backup.sh --keep 14  # 手动备份；末行输出备份目录
bash scripts/restore.sh --list    # 列出可用备份
bash scripts/install.sh --help    # 四个脚本都支持 --help
```

定时备份（`crontab -e`）：

```cron
30 3 * * * /path/to/youzhao/deploy/scripts/backup.sh --keep 14 >> /data/youzhao/logs/backup.log 2>&1
```

---

## 4. 备份与恢复

**备份**（`backup.sh`）→ `${DATA_ROOT}/backups/<时间戳>/`：

| 内容 | 说明 |
|---|---|
| `db.dump` | `pg_dump -Fc`（自定义格式，逻辑备份，可跨小版本还原） |
| `previews.tar.gz` / `uploads.tar.gz` | 产物目录 tar（`uploads` 不存在时跳过） |
| `env.backup` | `deploy/.env` 快照（**含密钥**，目录 700 / 文件 600） |
| `compose.yaml` `gateway-nginx.conf` `Dockerfile.*` | 部署配置快照 |
| `MANIFEST` | 时间、版本（git sha）、镜像 ID、库名/用户、卷与路径、各文件 sha256 |
| `SHA256SUMS` | 归档校验和；`restore.sh` 恢复前会 `-c` 校验 |
| `.incomplete` | 只在中途存在；写入完成即删除。存在 = 这份备份不可信 |

**恢复**（`restore.sh <备份目录>`）：校验备份 → 两次确认（`y/N` + 逐字输入 `RESTORE`）→ **自动先把当前状态备份成撤销点** → 停 `api/web/gateway`（postgres 保持运行）→ `DROP DATABASE … WITH (FORCE)` + `CREATE DATABASE` + `pg_restore --single-transaction` → 覆盖 `previews`/`uploads` → 起服务 → 等健康。恢复后 api 启动会把备份里缺失的迁移补上。

```bash
bash scripts/restore.sh /data/youzhao/backups/20261019-033000            # 交互式
bash scripts/restore.sh --list                                          # 有哪些备份
bash scripts/restore.sh <dir> --files-only                              # 只回产物
bash scripts/restore.sh <dir> --force                                   # 跳过确认（演示/CI 专用）
```

注意：恢复是**整库替换**，不是合并；备份早于当前数据时，期间新增数据会消失。`env.backup` 只是快照，`deploy/.env` 不会被覆盖。

**升级**（`upgrade.sh`）：`快照 → 备份 → compose build → up -d → 等 api 健康 → 重建 gateway → 网关自检`。任一步失败都打印回滚指引（升级前 commit/镜像 ID、备份目录、`restore.sh` 命令、日志命令）。回滚三条路：只回镜像（`git checkout <旧 commit>` 再跑一次）、只回数据（`restore.sh <备份>`）、两者都回。

---

## 5. 预览域怎么配

预览产物必须在**不同于应用域**的源上打开（否则产物脚本能拿到会话能力）。三处保持一致：

1. **DNS**：`preview.example.com` 解析到同一台机器；TLS 终止在网关（或云 LB，再转发到 `:8080`）。
2. **`.env`**：`PREVIEW_DOMAIN=https://preview.example.com`（production 必须 https，且与应用域不同源）、`PREVIEW_PUBLIC_BASE_PATH=/preview`（保持默认，**不要改**前缀）、`GATEWAY_PREVIEW_HOST=preview.example.com`、需要时改 `GATEWAY_PREVIEW_HTTP_PORT`（默认 8080）。
3. **网关**：`server_name ${GATEWAY_PREVIEW_HOST}` 的第二个 server 块监听 8080，只放行 `/preview`（前缀原样透传给 api）与 `/health`，其余一律 404。api 侧注册的路由是 `/preview/p/:blueprintId/:version/`，门票 URL 形如 `https://preview.example.com/preview/p/<id>/<v>/?t=<ticket>`。

跨域嵌入门票由 `PREVIEW_TICKET_SECRET` 签发、`PREVIEW_TICKET_TTL_SECONDS` 控制有效期；后台嵌入密钥是 `PREVIEW_EMBED_SECRET`（生产必须 ≥32 位）。

---

## 6. MCP 客户端指向网关

应用域上的 `/mcp` 就是 MCP Streamable HTTP 端点（api 侧路径由 `MCP_PATH` 决定，默认 `/mcp`，网关按该路径分流）。令牌在应用「令牌」页生成，只走 `Authorization: Bearer <token>` 头（不支持查询串）。

```jsonc
// Claude Desktop / Cursor / 兼容 MCP 的客户端
{
  "mcpServers": {
    "youzhao": {
      "type": "http",
      "url": "https://app.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

```bash
# CLI 形式
claude mcp add --transport http youzhao https://app.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

网关对 `/mcp` 已关缓冲（`proxy_buffering off`、`proxy_request_buffering off`）、固定 HTTP/1.1 长连接（`Connection ""`）、读写超时 3600s，并且**不改写** `MCP-Protocol-Version` 与任何 `Mcp-*` 头——这正是 §4.7 的要求。若客户端前面还有 CDN/云 WAF，请同样关闭响应缓冲，否则 SSE 会被攒成一整块。

---

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| **端口占用**（install 报「端口 N 被其他进程占用」） | `ss -ltnp \| grep -E ':(80\|8080)'`；改 `.env` 的 `GATEWAY_HTTP_PORT`/`GATEWAY_PREVIEW_HTTP_PORT`，或释放端口后重跑 `install.sh` |
| **健康检查失败** | `$COMPOSE ps`（谁 unhealthy）→ `$COMPOSE logs --tail=200 api`（迁移/连接错误）→ 常见原因：`.env` 密码含 `#` 或 `$` 未引号包裹、postgres 首次 initdb 还没结束（等了 30s 再试）、`APP_ENV=production` 但用了 http 域名被 config 拒绝、`previews` 目录属主不是 1000 |
| **api 起不来但日志说迁移失败** | `$COMPOSE logs api \| tail -50`；确认 `POSTGRES_*` 与卷没被换过；必要时 `restore.sh <最近备份>` |
| **生产校验报错**（`… 长度至少 32` / `必须 https://` / `不同源`） | 按报错补 `.env`：密钥 ≥32、`https://`、预览域与应用域不同源 |
| **预览域 404** | ① 打开的是应用域 → 设计如此（应用域 `/preview*` 恒 404）；② 漏了 `/preview` 前缀或直接改了前缀 → 用 `.env` 里的 `PREVIEW_PUBLIC_BASE_PATH` 原样访问；③ 产物没落盘 → `docker exec youzhao-api ls /data/youzhao/previews` 并与 `$COMPOSE logs api` 对照 |
| **预览域 403** | 先看 `$COMPOSE logs --tail=100 api` 判断是门票校验还是被拒；常见原因：门票过期（`PREVIEW_TICKET_TTL_SECONDS`）、打开用的域名与签发时 `PREVIEW_DOMAIN` 不一致、中间还有一层代理改写了 Host/前缀 |
| **预览域 502/504** | `$COMPOSE ps` 看 api 是否 healthy；api 重建后网关 upstream IP 会变，执行 `$COMPOSE up -d --no-deps --force-recreate gateway` |
| **SSE / MCP 流式被缓冲** | `curl -N -H "Authorization: Bearer <token>" -H 'Accept: text/event-stream' https://app.example.com/mcp`：若整段一次性到达，说明还有一层代理在缓冲；确认请求确实走 `/mcp`（不是 web），并保留网关里的 `proxy_buffering off` |
| **MCP 401** | 令牌缺失/失效：检查 `Authorization: Bearer` 头（不要放查询串）、令牌是否被吊销 |
| **前端 502 / 静态 404** | `$COMPOSE logs web`；web 容器只服务 `/usr/share/nginx/html`，SPA 回退在 web 侧，网关不再重复配置 |
| **改了 `.env` 不生效** | `$COMPOSE up -d --force-recreate <service>`（`env_file` 只在容器创建时读取） |

---

## 8. 与设计文档的差异（已知，待裁决）

1. `docs/architecture-design.md` §3.9 列了 `APP_HOST`，但仓库中没有任何代码读取它（`server/config.ts` 与 web 侧均无引用）；网关实际由 `GATEWAY_APP_HOST` + `API_PUBLIC_BASE_URL` 决定。本项目保留该变量并在 `.env.example` 注明「文档遗留、网关注入」。
2. 网关使用**静态 `upstream`**（保连接复用），不是 `resolver 127.0.0.11` 动态解析：api 容器重建后必须重建网关（`upgrade.sh` 已自动做，排障表也列了）。
3. 无证书环境默认不用 TLS，应用域与预览域都跑在明文端口（80 / 8080），用于本机验收；TLS 启用步骤写在 [gateway/nginx.conf](gateway/nginx.conf) 文末。
