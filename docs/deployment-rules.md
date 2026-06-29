# 单机生产版部署约束

本文档约束有招单机生产版部署方案。目标是让平台可以在一台 Linux 服务器上通过 Docker Compose 一键部署、升级、备份和恢复，尽量减少环境处理成本。

命名约定：产品统一称为“蓝图”；历史 API 字段中的 `demoId` 可在兼容期继续读取，新接口和新部署路径优先使用 `blueprintId`。

## 1. 部署目标

单机生产版面向小团队、内网私有化、售前演示和轻量生产场景。

部署目标：

- 一台 Linux 服务器即可运行完整平台。
- 仅强依赖 Docker 与 Docker Compose。
- 使用统一入口访问前端、API 和蓝图预览。
- 所有配置通过 `.env` 管理。
- 所有业务数据通过 volume 持久化。
- 数据库迁移与初始化自动执行。
- 支持一键安装、升级、备份、恢复。
- 支持后续平滑扩展 worker、对象存储、自动构建服务。

非目标：

- 不在 MVP 阶段引入 Kubernetes。
- 不要求用户手工安装 Node.js、Python、Java 等运行环境。
- 不要求用户手工执行 SQL 初始化。
- 不要求用户手工配置前端静态资源路径。

## 2. 部署拓扑

```text
用户浏览器
  ↓
Gateway: Caddy 或 Nginx
  ├─ /                 Web 前端工作台
  ├─ /api              API 服务
  ├─ /preview          蓝图预览静态产物
  ├─ /assets           静态资源
  └─ /health           平台健康检查

应用服务
  ├─ web               前端静态服务
  ├─ api               后端 API
  ├─ worker            异步任务服务，MVP 可暂不启用
  └─ preview-storage   蓝图预览产物挂载目录

基础服务
  └─ postgres          PostgreSQL 数据库
```

MVP 最小服务：

```text
gateway
web
api
postgres
```

后续扩展服务：

```text
worker
redis
minio
```

## 3. 服务划分

### 3.1 gateway

职责：

- 提供平台统一访问入口。
- 反向代理前端与 API。
- 暴露蓝图预览静态产物。
- 处理 HTTP 到 HTTPS。
- 提供统一健康检查入口。

建议：

- 单机生产版优先使用 Caddy。
- 内网不需要自动证书时，可使用 Nginx。
- HTTPS 证书、域名和端口通过 `.env` 控制。

路径规则：

| 路径 | 转发目标 |
| --- | --- |
| `/` | web |
| `/api/*` | api |
| `/preview/*` | preview volume |
| `/health` | api health 或 gateway health |

### 3.2 web

职责：

- 提供 Vue / PrimeVue 前端工作台。
- 不直接连接数据库。
- 不直接读取宿主机文件。
- 所有业务请求通过 `/api` 访问后端。

约束：

- 前端不得写死 API 域名。
- 前端使用运行时配置或相对路径访问 API。
- 前端镜像构建后应可在不同域名下运行。

### 3.3 api

职责：

- 提供用户、权限、蓝图、分组、版本等 API。
- 执行数据库迁移。
- 执行系统初始化。
- 返回蓝图预览地址。
- 提供健康检查。

约束：

- 不得将配置写死在代码中。
- 所有配置来自环境变量。
- 启动时必须等待数据库可用。
- 数据库迁移必须可重复执行。
- 初始化默认数据必须幂等。
- 所有日志输出到 stdout/stderr。

### 3.4 postgres

职责：

- 存储平台结构化数据。

约束：

- 数据目录必须挂载到 named volume 或宿主机目录。
- 默认账号和密码必须来自 `.env`。
- 不允许使用容器内临时存储作为生产数据目录。

### 3.5 preview-storage

职责：

- 存储已部署 蓝图版本的静态产物。

路径建议：

```text
/data/youzhao/previews/{blueprintId}/{version}/
```

对外访问：

```text
/preview/{blueprintId}/{version}/
```

约束：

- 蓝图预览地址必须由后端返回。
- 前端不得拼接预览 URL。
- 蓝图 静态产物必须通过 volume 持久化。
- 删除 蓝图 或版本时，本期不自动物理删除产物，避免误删；后续可增加清理任务。

## 4. 推荐目录结构

项目部署目录：

```text
deploy/
├─ docker-compose.yml
├─ docker-compose.prod.yml
├─ .env.example
├─ install.sh
├─ upgrade.sh
├─ backup.sh
├─ restore.sh
├─ gateway/
│  ├─ Caddyfile
│  └─ nginx.conf
└─ README.md
```

服务器数据目录：

```text
/data/youzhao/
├─ postgres/
├─ previews/
├─ backups/
├─ logs/
└─ uploads/
```

说明：

- `/data/youzhao/postgres` 存储数据库数据。
- `/data/youzhao/previews` 存储 蓝图 静态预览产物。
- `/data/youzhao/backups` 存储备份文件。
- `/data/youzhao/uploads` 存储上传文件，MVP 可暂不使用。
- 日志优先输出到容器 stdout/stderr，`logs` 目录仅用于确需落盘的任务日志。

## 5. 环境变量规范

必须提供 `.env.example`，生产部署时复制为 `.env`。

变量命名：

- 使用大写字母和下划线。
- 布尔值使用 `true` / `false`。
- 时间统一使用秒。
- URL 不以 `/` 结尾。

基础变量：

```env
APP_NAME=youzhao
APP_ENV=production
APP_HOST=http://localhost
APP_PORT=8080
APP_TIMEZONE=Asia/Shanghai
```

网关变量：

```env
GATEWAY_HTTP_PORT=80
GATEWAY_HTTPS_PORT=443
GATEWAY_ENABLE_HTTPS=false
GATEWAY_DOMAIN=localhost
```

数据库变量：

```env
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=youzhao
POSTGRES_USER=youzhao
POSTGRES_PASSWORD=change_me
```

API 变量：

```env
API_PORT=3000
API_PUBLIC_BASE_URL=http://localhost
API_JWT_SECRET=change_me
API_TOKEN_EXPIRES_IN=86400
```

管理员初始化变量：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change_me
ADMIN_DISPLAY_NAME=系统管理员
ADMIN_EMAIL=admin@example.com
```

预览产物变量：

```env
PREVIEW_PUBLIC_BASE_PATH=/preview
PREVIEW_STORAGE_PATH=/data/youzhao/previews
```

安全要求：

- `.env` 不得提交到 Git。
- `.env.example` 不得包含真实密码。
- 生产部署时必须修改默认密码。
- `API_JWT_SECRET` 生产环境必须修改。
- 首次登录后应提示管理员修改默认密码。

## 6. Docker Compose 约束

Compose 文件必须满足：

- 所有服务设置明确的 `container_name` 或稳定服务名。
- 业务服务配置 `restart: unless-stopped`。
- 数据服务必须配置持久化 volume。
- API 必须依赖 PostgreSQL 健康检查。
- Gateway 必须依赖 web 和 api。
- 不使用宿主机网络模式。
- 不将数据库端口暴露到公网，除非明确用于调试。

建议服务名：

```text
youzhao-gateway
youzhao-web
youzhao-api
youzhao-postgres
youzhao-worker
```

健康检查建议：

```text
api:       GET /api/health
web:       GET /
gateway:   GET /health
postgres:  pg_isready
```

## 7. 初始化规则

平台首次启动必须自动完成初始化。

初始化内容：

- 数据库迁移。
- 创建默认管理员。
- 创建默认分组“默认”。
- 创建功能权限定义。
- 为默认管理员授予系统设置管理权限。
- 为默认管理员授予 蓝图预览管理权限。
- 可选：创建示例 蓝图 和示例版本。

幂等要求：

- 重复启动不得重复创建默认分组。
- 重复启动不得覆盖已修改管理员信息。
- 重复启动不得重置管理员密码。
- 重复启动不得清空业务数据。
- 初始化失败必须在日志中输出明确错误。

默认分组约束：

- 默认分组名称：`默认`。
- 默认分组必须存在。
- 默认分组不可删除。

## 8. 安装脚本约束

安装入口：

```bash
./deploy/install.sh
```

安装脚本职责：

- 检查 Docker 是否存在。
- 检查 Docker Compose 是否存在。
- 检查端口占用。
- 检查 `.env` 是否存在。
- 若 `.env` 不存在，基于 `.env.example` 生成。
- 创建 `/data/youzhao` 数据目录。
- 拉取或构建镜像。
- 启动服务。
- 等待健康检查通过。
- 输出访问地址和管理员账号。

脚本约束：

- 脚本失败时必须退出非 0 状态码。
- 不得静默吞掉错误。
- 不得默认删除已有数据目录。
- 如需覆盖配置，必须提示用户确认。

安装完成输出示例：

```text
有招已启动
访问地址：http://localhost:8080
默认管理员：admin
请首次登录后修改默认密码
```

## 9. 升级脚本约束

升级入口：

```bash
./deploy/upgrade.sh
```

升级流程：

```text
检查当前服务状态
→ 执行升级前备份
→ 拉取或构建新镜像
→ 停止业务服务
→ 启动数据库
→ 执行迁移
→ 启动业务服务
→ 健康检查
→ 输出升级结果
```

约束：

- 升级前必须自动备份数据库。
- 升级失败必须提示恢复方式。
- 迁移失败不得继续启动新版本业务服务。
- 不得自动删除旧备份。

## 10. 备份与恢复

### 10.1 备份

备份入口：

```bash
./deploy/backup.sh
```

备份内容：

- PostgreSQL 数据。
- 蓝图预览静态产物。
- 上传文件。
- `.env` 配置文件。

备份文件命名：

```text
youzhao-backup-{yyyyMMdd-HHmmss}.tar.gz
```

备份存储：

```text
/data/youzhao/backups/
```

约束：

- 备份脚本必须输出备份文件路径。
- 备份失败必须退出非 0 状态码。
- 备份不得影响在线访问，除非明确提示。

### 10.2 恢复

恢复入口：

```bash
./deploy/restore.sh /data/youzhao/backups/youzhao-backup-20260612-120000.tar.gz
```

恢复流程：

```text
校验备份文件
→ 提示将覆盖当前数据
→ 停止业务服务
→ 恢复数据库
→ 恢复预览产物和上传文件
→ 恢复配置
→ 启动服务
→ 健康检查
```

约束：

- 恢复必须要求用户确认。
- 恢复前建议自动创建当前数据快照。
- 恢复失败必须保留错误日志。

## 11. 蓝图预览部署约束

蓝图版本产物结构：

```text
/data/youzhao/previews/
└─ {demoId}/
   └─ {version}/
      ├─ index.html
      ├─ assets/
      └─ manifest.json
```

`manifest.json` 建议结构：

```json
{
  "demoId": "demo_001",
  "version": "v1.0.0",
  "entry": "index.html",
  "createdAt": "2026-06-12T00:00:00+08:00"
}
```

访问规则：

```text
/preview/{demoId}/{version}/
```

约束：

- 后端保存版本记录时必须保存实际预览地址。
- 后端返回给前端的 `previewUrl` 必须可直接打开。
- 前端点击卡片时只能使用后端返回的 `previewUrl`。
- 不可用版本必须标记状态，不得返回无效地址。

## 12. 健康检查与可观测性

API 健康检查：

```text
GET /api/health
```

返回建议：

```json
{
  "status": "ok",
  "time": "2026-06-12T00:00:00+08:00",
  "services": {
    "database": "ok"
  }
}
```

日志约束：

- 容器日志输出到 stdout/stderr。
- 错误日志必须包含时间、服务名、错误码、错误信息。
- 不在日志中输出明文密码、JWT、数据库密码。

监控建议：

- MVP 阶段使用 Docker 自带日志和健康检查。
- 后续可扩展 Prometheus、Grafana、Loki。

## 13. 安全约束

- 管理员默认密码必须允许在 `.env` 中配置。
- 首次登录应提示修改默认密码。
- API 必须启用鉴权。
- 系统设置接口必须校验系统设置管理权限。
- 蓝图修改类接口必须校验 蓝图预览管理权限。
- 蓝图查询接口必须按 蓝图权限过滤。
- 蓝图预览地址不应暴露未授权数据；如预览内容敏感，后续需增加带签名的访问控制。
- 数据库端口默认不暴露到宿主机公网。
- `.env`、备份文件、数据库目录不得被 gateway 暴露。

## 14. 开发实现约束

为了支持单机一键部署，开发阶段必须遵守：

- 前端 API 请求使用相对路径 `/api`。
- 后端统一生成 蓝图预览地址。
- 后端所有配置来自环境变量。
- 所有持久化文件写入挂载目录。
- 数据库 schema 变更必须通过迁移脚本。
- 初始化脚本必须幂等。
- 服务启动失败必须明确报错。
- 所有服务必须支持容器内运行。
- 不依赖本机全局安装的运行时或工具。

## 15. 验收标准

单机生产版部署完成后必须满足：

- 仅安装 Docker 和 Docker Compose 即可启动平台。
- 执行 `./deploy/install.sh` 后平台可访问。
- 首次部署自动创建默认管理员。
- 首次部署自动创建默认分组。
- 前端可通过 gateway 正常访问。
- API 可通过 `/api/health` 正常返回。
- 蓝图预览产物可通过 `/preview/{demoId}/{version}/` 打开。
- 重启服务器后数据不丢失。
- 执行 `./deploy/backup.sh` 可生成备份文件。
- 执行 `./deploy/restore.sh` 可恢复备份。
- 升级前会自动执行备份。

## 16. 后续演进

当单机生产版稳定后，可按需扩展：

- 引入 Redis 承载任务队列和缓存。
- 引入 worker 执行 蓝图 构建、DSL 渲染、产物发布。
- 引入 MinIO 替代本地 preview volume。
- 增加 HTTPS 自动证书。
- 增加操作审计。
- 增加 蓝图访问统计。
- 增加 Helm Chart 支持集群部署。
