---
name: youzhao-mcp
description: Use when Codex needs to install, configure, or operate the YouZhao 有招 blueprint MCP server for blueprint work: list blueprint groups, list/inspect blueprints, read version artifacts, publish or cover blueprint versions, delete a version, or create a blueprint group — including idempotent retries and MCP Token binding/troubleshooting. Do not use for platform deployment, server upgrades, user administration, or infrastructure operations.
---

# 有招 MCP

有招（YouZhao）把「蓝图」产物交给 MCP 客户端读写，有两条接入路径：

- **远端直连（推荐）**：MCP 客户端 → `https://<部署域名>/mcp`，用 `Authorization: Bearer <Token>` 鉴权，客户端本机不需要装 Node，也不需要本仓库。
- **stdio 桥（离线/内网兜底）**：MCP 客户端 → `server/mcp-server.mjs` → 同一个 `POST /mcp`。

协议实现 `server/mcp/http.ts`、工具 `server/mcp/tools.ts`；协议、鉴权、scope、审计、幂等**全在服务端**，桥只转发字节。

## Scope

覆盖：

- 列出 Token 绑定的用户有权访问的分组与蓝图。
- 查看蓝图元数据、版本列表、自身能力（`capabilities`）。
- 读取版本产物：文本产物内联返回；HTML/多文件产物返回**票据化清单**（`files[]` + 一次性入口 URL）。
- 发布新版本、覆盖指定版本、删除版本、新建分组（均支持 `idempotencyKey`）。

不覆盖：部署/升级、前后端进程启动、Nginx/systemd/Docker/数据库/备份、用户与权限管理 UI、YAML/基础设施操作。

## 能力模型（务必先理解）

```text
实际能力 = 绑定用户的平台权限 ∩ Token scope
```

- Token 明文形态 `yz_mcp_<tokenId>_<secret>`，只在创建时返回一次；服务端只存哈希。泄露即停用（停用立即生效，无需等待过期）。
- scope 只有两个：`read:blueprint`（4 个读工具）、`publish:blueprint`（4 个写工具）。scope 不足返回 `SCOPE_DENIED`（403 + `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`）。
- 写工具还要过平台策略：Token 只是把「绑定用户」带进请求，**不会提权**。绑定用户没有 `blueprint.manage`（或超出其资源范围）时返回 `FORBIDDEN` / `CAPABILITY_REQUIRED`。
- 绑定用户被停用 → `FORBIDDEN`（不是 401）；Token 本身无效/停用/过期 → `UNAUTHENTICATED`（401）。
- `tools/list` 会按当前 Token 的 scope 裁剪：只读 Token 看不到写工具。

## 客户端接入（远端直连优先）

1. 在有招平台创建 MCP Token（普通用户只能给自己创建；平台所有者可为他人创建）。
2. 接入信息读 `GET /api/mcp/connection-info`（返回 `httpUrl`/`path`/`transport`/协议代/工具计数/scope），**不要自己拼地址**。
3. 按客户端能力选一种：

**A. 远端直连（推荐，本机不需要 Node、也不需要本仓库）**

```bash
# Codex CLI：Bearer 从环境变量读，不必手改 TOML
export YOUZHAO_MCP_TOKEN=yz_mcp_xxx_yyy
codex mcp add youzhao --url https://youzhao.florai.cn/mcp --bearer-token-env-var YOUZHAO_MCP_TOKEN
```

```bash
# Claude Desktop 等只支持 stdio 的客户端：用社区桥 mcp-remote
npx -y mcp-remote https://youzhao.florai.cn/mcp --header "Authorization: Bearer yz_mcp_xxx_yyy"
```

支持自定义 Header 的客户端（Cursor / VS Code 等）直接填：

```json
{ "url": "https://youzhao.florai.cn/mcp", "headers": { "Authorization": "Bearer yz_mcp_xxx_yyy" } }
```

**B. stdio 桥（离线/内网兜底，需要本机 Node 与仓库）**

```json
{
  "mcpServers": {
    "youzhao": {
      "command": "node",
      "args": ["/absolute/path/to/youzhao/server/mcp-server.mjs"],
      "env": {
        "YOUZHAO_API_BASE": "https://youzhao.florai.cn",
        "YOUZHAO_MCP_TOKEN": "yz_mcp_xxx_yyy"
      }
    }
  }
}
```

4. 重启客户端验证。也可以先在浏览器里用「连接自检」（`POST /api/mcp-tokens/verify`：收明文 Token、服务端环回跑一次 `initialize` + `tools/list`、3 秒超时、不调 `tools/call`），或跑 `scripts/youzhao_mcp_smoke_test.mjs`。

桥的环境变量：

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `YOUZHAO_API_BASE` | 是 | — | 有招 API 根地址，例如 `https://youzhao.florai.cn`（本机开发用 `http://127.0.0.1:3000`） |
| `YOUZHAO_MCP_TOKEN` | 是 | — | MCP Token 明文 |
| `YOUZHAO_MCP_PATH` | 否 | `/mcp` | 服务端 MCP 端点路径 |
| `YOUZHAO_MCP_TIMEOUT_MS` | 否 | `120000` | 单次转发超时 |

服务端开关（部署侧）：`MCP_ENABLED`（关则 `/mcp` 不存在）、`MCP_PATH`、`MCP_MAX_BODY_BYTES`。

- **stdout 是协议通道**：桥只往 stdout 写 JSON-RPC，日志一律 stderr。
- 直接对 HTTP 端点调用时，现代协议要求每个请求带 `MCP-Protocol-Version`、`Mcp-Method`（`tools/call` 另需 `Mcp-Name`）与 `_meta`；旧代客户端（先 `initialize`）不需要这些头。桥会自动按客户端声明的版本切换，**不要**在网关改写或剥离 `Mcp-*` 头，也不要缓冲 SSE。

## 工具（8 个，顺序确定）

| 工具 | scope | 作用 |
| --- | --- | --- |
| `youzhao.list_blueprint_groups` | read | 列出可访问分组 |
| `youzhao.list_blueprints` | read | 列出可访问蓝图（`keyword`/`groupId`/`status`/`page`/`pageSize`） |
| `youzhao.get_blueprint` | read | 蓝图详情 + 版本列表 + 自身 `capabilities` |
| `youzhao.get_blueprint_artifact` | read | 读版本产物（文本内联 / 票据化清单） |
| `youzhao.publish_blueprint` | publish | 发布新版本；无 `blueprintId` 时新建蓝图 |
| `youzhao.cover_blueprint_version` | publish | 用新产物覆盖指定版本（版本号与发布记录不变） |
| `youzhao.delete_blueprint_version` | publish | 删除指定版本（归档，不物理删除） |
| `youzhao.create_blueprint_group` | publish | 新建分组（**不能**调整排序，按设计不暴露） |

入参/出参逐字段见 `references/mcp-tools.md`。

## 典型流程

1. `youzhao.list_blueprint_groups` 找到目标 `groupId`（发布/新建需要）。
2. `youzhao.list_blueprints` → `youzhao.get_blueprint` 看清版本与自身 `capabilities`。
3. `youzhao.get_blueprint_artifact` 取现有产物。
4. 生成/修改 HTML 与 Markdown。
5. `youzhao.publish_blueprint`（更新已有蓝图带 `blueprintId`；新建则省）。
6. 重新 `youzhao.get_blueprint` 确认最新版本。

## 发布与幂等

- `html` 必填且必须含 `<!doctype html>` 或 `<html`；`markdown` 可选。单文件 `index.html` 是入口；多文件用相对路径引用（相对 `/preview/p/<blueprintId>/<version>/`）。
- 版本号在蓝图内唯一；同一内容重复发布请换版本号，不要靠覆盖。
- **重试用同一个 `idempotencyKey`**：相同 key + 相同请求体 → 回放首次结果；相同 key + 不同请求体 → `VERSION_CONFLICT`；相同 key 且首次仍在处理中 → `VERSION_CONFLICT`（稍后重试）。key 长度 1–128。
- 覆盖（`cover_blueprint_version`）会替换产物，产物不可恢复；删除版本同样保留记录但产物不可用。

## 错误码

| 码 | HTTP | 含义与处理 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Token 缺失/形态非法/无效/停用/过期；重新绑定有效 Token |
| `SESSION_EXPIRED` | 401 | 仅浏览器会话；MCP 不会出现 |
| `SCOPE_DENIED` | 403 | Token scope 不足；换带所需 scope 的 Token |
| `FORBIDDEN` | 403 | 绑定用户权限不足；找所有者授权 |
| `CAPABILITY_REQUIRED` | 403 | 缺少 `blueprint.manage`/`blueprint.publish` 或不在资源范围 |
| `OUT_OF_MANAGED_SCOPE` | 403 | 目标超出绑定用户的管理范围 |
| `BLUEPRINT_NOT_FOUND` | 404 | 不存在**或无权访问**（不区分，避免探测） |
| `VERSION_NOT_FOUND` | 404 | 版本不存在或无权访问 |
| `GROUP_NOT_FOUND` | 404 | 分组不存在或无权访问 |
| `VERSION_CONFLICT` | 409 | 版本已存在 / 幂等键冲突 |
| `INVALID_ARGUMENT` | 400 | 入参校验失败（含 `details`） |
| `INVALID_ARTIFACT` | 400 | HTML/Markdown 不合法（缺 doctype 等） |
| `PAYLOAD_TOO_LARGE` | 413 | 超过 `MCP_MAX_BODY_BYTES` |
| `PUBLISH_FAILED` | 500 | 产物落盘失败 |

## 故障排查

- 客户端连不上：桥的 stderr 有 `有招 MCP stdio 桥已启动 → …`；没有则检查 `YOUZHAO_API_BASE`/`YOUZHAO_MCP_TOKEN` 是否都设置（缺失会 exit 1）。
- `-32020 the request headers and body disagree`：直连 HTTP 时漏了 `MCP-Protocol-Version`，或网关改写了 `Mcp-*` 头。
- 400 且提示缺 `Mcp-Method`：网关没有转发 `Mcp-*` 头。
- `Method not found`（-32601）：现代协议里没有 `initialize`（它属于旧代）；不要手工发 `initialize`。
- 只读 Token 看不到写工具：正常，`tools/list` 按 scope 裁剪。
