# 有招

有招是一个面向数据可视化交付场景的蓝图展示与发布平台。当前版本包含 Vue/PrimeVue 前端、Node.js 后端 API、蓝图预览、用户/权限、MCP Token 与 MCP 蓝图读取/发布接口的 MVP 实现。

## 功能范围

- 蓝图分组展示、搜索、版本选择与预览。
- 蓝图卡片信息维护与分组变更。
- 用户管理、密码重置、功能权限与蓝图权限。
- MCP Token 管理入口。
- Agent 通过 MCP Server 读取蓝图、读取产物、发布蓝图版本。
- 蓝图 HTML 与 Markdown 产物落盘存储。

## 本地启动

要求：

- Node.js 20+
- npm 10+

安装依赖：

```bash
npm install
```

启动后端：

```bash
npm run server:dev
```

启动前端：

```bash
npm run dev
```

访问：

- 前端：http://localhost:5173
- 后端：http://127.0.0.1:4174
- 健康检查：http://127.0.0.1:4174/api/health

内置账号：

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 管理员 | `admin` | `admin123` |
| 蓝图管理者 | `demo.manager` | `demo123` |
| 蓝图查看者 | `viewer` | `viewer123` |

后端开发 MCP Token：

| Token | 权限 |
| --- | --- |
| `yz_mcp_dev_admin` | 读取、发布 |
| `yz_mcp_dev_publish` | 读取、发布 |
| `yz_mcp_dev_viewer` | 读取 |

## MCP Server

有招提供 stdio MCP Server：

```bash
YOUZHAO_API_BASE=http://127.0.0.1:4174 \
YOUZHAO_MCP_TOKEN=yz_mcp_dev_admin \
node server/mcp-server.mjs
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "youzhao": {
      "command": "node",
      "args": ["/opt/youzhao/app/server/mcp-server.mjs"],
      "env": {
        "YOUZHAO_API_BASE": "http://127.0.0.1:4174",
        "YOUZHAO_MCP_TOKEN": "your_mcp_token"
      }
    }
  }
}
```

可用工具：

- `youzhao.list_blueprint_groups`
- `youzhao.list_blueprints`
- `youzhao.get_blueprint`
- `youzhao.get_blueprint_artifact`
- `youzhao.publish_blueprint`

验证：

```bash
YOUZHAO_API_BASE=http://127.0.0.1:4174 \
YOUZHAO_MCP_TOKEN=yz_mcp_dev_admin \
node skills/youzhao-mcp/scripts/youzhao_mcp_smoke_test.mjs server/mcp-server.mjs
```

## 构建

```bash
npm run build
```

构建产物输出到 `dist/`。`dist/` 不提交到 Git，部署时在服务器上构建。

## 服务器部署手册

以下流程适用于单台 Linux 服务器部署当前 MVP。当前后端仍为内存数据模型，蓝图发布产物会持久化到 `YOUZHAO_DATA_DIR`；用户、权限、分组、蓝图元数据在服务重启后会恢复为种子数据。生产级持久化数据库将在后续版本补齐。

### 1. 准备服务器

建议系统：

- Ubuntu 22.04 LTS 或同级 Linux 发行版
- 2C4G 以上配置
- 20GB 以上磁盘

安装基础依赖：

```bash
sudo apt update
sudo apt install -y git curl nginx
```

安装 Node.js 20：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 2. 拉取代码

```bash
sudo mkdir -p /opt/youzhao
sudo chown -R "$USER":"$USER" /opt/youzhao
git clone https://github.com/FlorHop/YouZhao.git /opt/youzhao/app
cd /opt/youzhao/app
```

安装依赖并构建：

```bash
npm ci
npm run build
```

准备数据目录：

```bash
sudo mkdir -p /data/youzhao/previews
sudo chown -R "$USER":"$USER" /data/youzhao
```

### 3. 配置后端服务

创建 systemd 服务：

```bash
sudo tee /etc/systemd/system/youzhao-api.service >/dev/null <<'EOF'
[Unit]
Description=YouZhao API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/youzhao/app
Environment=NODE_ENV=production
Environment=YOUZHAO_API_PORT=4174
Environment=YOUZHAO_DATA_DIR=/data/youzhao
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now youzhao-api
sudo systemctl status youzhao-api
```

验证后端：

```bash
curl http://127.0.0.1:4174/api/health
```

### 4. 配置 Nginx

创建站点配置：

```bash
sudo tee /etc/nginx/sites-available/youzhao >/dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    root /opt/youzhao/app/dist;
    index index.html;

    client_max_body_size 8m;

    location /api/ {
        proxy_pass http://127.0.0.1:4174/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /preview-artifacts/ {
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF
```

启用站点：

```bash
sudo ln -sf /etc/nginx/sites-available/youzhao /etc/nginx/sites-enabled/youzhao
sudo nginx -t
sudo systemctl reload nginx
```

访问服务器公网或内网 IP：

```text
http://<server-ip>/
```

### 5. 发布新版本

服务器部署完成后，后续发布新版本只需要执行更新脚本：

```bash
cd /opt/youzhao/app
bash scripts/update.sh
```

脚本会自动执行：

- 检查工作区是否干净。
- 备份 `/data/youzhao` 到 `/data/youzhao/backups`。
- 拉取 `origin/main` 最新代码。
- 执行 `npm ci`。
- 执行 `npm run build`。
- 重启 `youzhao-api`。
- 检查并重载 Nginx。
- 调用健康检查接口。

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_DIR` | `/opt/youzhao/app` | 应用代码目录 |
| `YOUZHAO_DATA_DIR` | `/data/youzhao` | 数据目录 |
| `YOUZHAO_BACKUP_DIR` | `/data/youzhao/backups` | 备份目录 |
| `YOUZHAO_BRANCH` | `main` | 更新分支 |
| `YOUZHAO_API_SERVICE` | `youzhao-api` | systemd 服务名 |
| `YOUZHAO_HEALTH_URL` | `http://127.0.0.1:4174/api/health` | 健康检查地址 |
| `YOUZHAO_SKIP_BACKUP` | `false` | 设置为 `true` 可跳过备份 |

示例：

```bash
YOUZHAO_SKIP_BACKUP=true bash scripts/update.sh
```

### 6. 数据与备份

当前需要备份：

```text
/data/youzhao/
```

备份命令示例：

```bash
sudo tar -czf /data/youzhao-backup-$(date +%Y%m%d%H%M%S).tar.gz /data/youzhao
```

恢复时停止服务、解压数据目录、重新启动：

```bash
sudo systemctl stop youzhao-api
sudo tar -xzf /path/to/backup.tar.gz -C /
sudo systemctl start youzhao-api
```

### 7. 常见问题

接口返回“接口不存在”：

- 确认后端服务已重启：`sudo systemctl restart youzhao-api`
- 确认 Nginx 代理路径为 `/api/`
- 直连检查：`curl http://127.0.0.1:4174/api/health`
- 代理检查：`curl http://<server-ip>/api/health`

前端刷新后 404：

- 确认 Nginx `location /` 使用了 `try_files $uri $uri/ /index.html;`

蓝图发布产物不可访问：

- 确认 `YOUZHAO_DATA_DIR=/data/youzhao`
- 确认 `/data/youzhao/previews` 目录存在且服务进程有写权限

## 目录说明

```text
docs/       产品、前端、部署约束文档
server/     Node.js 后端 API
src/        Vue 前端源码
public/     前端静态蓝图预览样例
icon/       Logo 原始文件
```

## 重要限制

- 当前版本后端结构化数据仍为内存模型。
- 当前 MCP Server 是 stdio transport，内部复用后端蓝图工具接口。
- 单机生产版 Docker Compose、数据库迁移和 CLI 升级脚本仍在后续建设中。
