# MCP 客户端接入优化设计（v1）

> 状态：**待评审**（2026-10-19）
> 触发：用户反馈「MCP 客户端接入里还是本地地址，是否有问题」+ 外部用户用 Codex 接入「难度较大」。
> 关联：`docs/architecture-design.md` §4（MCP 服务）、§4.7（部署与客户端）、`skills/youzhao-mcp/SKILL.md`、`web/src/components/tokens/McpClientSnippet.vue`。

---

## 0. 结论摘要（先行）

1. **是有问题，而且是当前接入困难的主因**：应用内的接入片段把用户导向「克隆仓库 → 本地 Node 跑仓库里的 `server/mcp-server.mjs` → `YOUZHAO_API_BASE=http://127.0.0.1:4174`」三件套。在**云端部署**下这三件全不成立：用户没有仓库、未必装 Node、`127.0.0.1:4174` 是**旧站端口**（v2 是 3000），而且指向的是用户自己机器上的服务而非有招服务器。
2. **正解已经过实测验证**：现代 MCP 客户端只需 **`https://youzhao.florai.cn/mcp` + `Authorization: Bearer <token>`**，不需要仓库、不需要本地桥。已用生态标准桥 `mcp-remote@0.15.1` 实测通过（`initialize` + `tools/list`，只读 Token 返回且仅返回 4 个读工具），并用本机 Codex CLI 0.162.1 实测 `codex mcp add --url … --bearer-token-env-var …` 可用。
3. **优化方案三层**：后端暴露真实接入信息 → 前端改成「按客户端一键生成可粘贴配置 + 就地造 Token + 服务端自检」→ 技能/文档同步（清掉所有 `127.0.0.1:4174`）。

---

## 1. 现状问题（含证据）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | 接入片段写死旧站本地地址 | `web/src/components/tokens/McpClientSnippet.vue`：`"command": "node"`、`"args": ["/absolute/path/to/youzhao/server/mcp-server.mjs"]`、`env.YOUZHAO_API_BASE = "http://127.0.0.1:4174"`；页面文案还写「换成你的服务端地址（本地默认 `http://127.0.0.1:4174`）」 | 用户照抄必失败：地址指向自己机器、端口还是旧站的 |
| P2 | 要求克隆仓库 + 本地 Node + 手填仓库绝对路径 | 同文件：`args` 用绝对路径，正文提示先执行 `realpath server/mcp-server.mjs` | 门槛极高；Claude Desktop / Codex 用户不一定会 Node |
| P3 | 界面拿不到部署的真实地址 | `server/config.ts:14/200/303` 有 `AppConfig.publicBaseUrl`（来自 `API_PUBLIC_BASE_URL`），但**没有任何 HTTP 路由把它暴露出去**（仅 `server/main.ts:77` 打日志） | 前端无法渲染正确地址，只能硬编码 |
| P4 | 客户端兼容性坑未说明 | 实测 401 响应带 `www-authenticate: Bearer realm="youzhao", error="invalid_token"`；而 `GET /.well-known/oauth-protected-resource` → **404**、`/.well-known/oauth-authorization-server` → **404** | 只支持 OAuth 的客户端（如 Claude Desktop 的「自定义连接器」）会停在「OAuth 发现失败」，报错与真实原因无关 |
| P5 | Token 明文只在创建瞬间可见，且与接入片段脱节 | Token 页与「接入」说明是两个地方；用户要来回跳、手动拼 `Bearer` | 抄错、漏抄、只好重建 Token |
| P6 | 工具数量在三处不一致 | `McpClientSnippet.vue` 注释写「4 读 + 4 写」、`skills/youzhao-mcp/SKILL.md` 写「5 读 / 3 写」、实际 8（4 读 + 4 写，实测只读 Token 只见 4 个读工具） | 用户按错的预期排障 |
| P7 | 无「Token 是否真的可用」的自检 | 现状只能靠客户端报错反推 | 排障靠猜，用户体感「难度大」 |

---

## 2. 本次已实测的事实（设计依据）

| 项 | 实测结果 | 结论 |
|---|---|---|
| 第三方 stdio 桥 `mcp-remote@0.15.1` | `mcp-remote http://127.0.0.1:3000/mcp --allow-http --header "Authorization: Bearer <只读token>"` → `initialize` 返回 `protocolVersion 2025-06-18`、`serverInfo {name: youzhao, version: 2.0.0}`、`capabilities ["tools"]`；`tools/list` 返回 **4 个且仅 4 个读工具** | **只给 URL + Header 即可接入**，且 scope 过滤在传输层真实生效 |
| Codex CLI 0.162.1 | `codex mcp add youzhao --url https://youzhao.florai.cn/mcp --bearer-token-env-var YOUZHAO_MCP_TOKEN` → `Added global MCP server 'youzhao'.`；写入 `~/.codex/config.toml`：`[mcp_servers.youzhao]` / `url = "…"` / `bearer_token_env_var = "YOUZHAO_MCP_TOKEN"`；`codex mcp list` 显示 `Auth: Bearer token` | Codex **支持远端 HTTP + Bearer Token**，且**用官方命令即可，无需手改 TOML**（第三方文档说「必须手改 header」不适用于此版本） |
| Codex CLI 参数面 | `codex mcp add [OPTIONS] <NAME> (--url <URL> \| -- <COMMAND>...)`；`--bearer-token-env-var <ENV_VAR>`（仅 streamable HTTP）；`--env <KEY=VALUE>`（仅 stdio） | 接入片段应给「命令 + 环境变量」两步，而不是 stdio 写法 |
| 现代协议（`2026-07-28`） | 带 `MCP-Protocol-Version: 2026-07-28` + `Mcp-Method: tools/list` + `params._meta` 中**命名空间键** `io.modelcontextprotocol/protocolVersion`、`io.modelcontextprotocol/clientCapabilities` → 正常返回工具列表；缺 envelope 键 → `400 -32602`，`data.envelope.missing` 精确列出缺失键 | 现代协议已正确实现，且报错信息对 Agent 友好；**legacy（initialize）与 modern 两个时代都可用** |
| 13 个客户端的写法差异 | Claude Desktop 自定义连接器只填 URL（OAuth 自动发现）；`mcp-remote` 是 stdio-only 客户端的标准兜底 | 接入向导必须**按客户端分支**给片段，不能只给一种 |

---

## 3. 设计

### 3.1 后端：新增 `GET /api/mcp/connection-info`

**为什么**：地址必须由**服务端配置**给出（`config.publicBaseUrl` + `config.mcp.path`），而不是前端硬编码或取请求 Host（后者可被 Host 头注入）。

- 鉴权：需要登录会话（不返回任何秘密；未登录返回 401）。
- 契约：新增 `packages/contracts/schemas/mcp/connection-info.json`（遵守「JSON Schema 单一事实来源」，与 §6.1 的信封约定一致）。
- 响应（`data` 内）：

```json
{
  "httpUrl": "https://youzhao.florai.cn/mcp",
  "transport": "streamable-http",
  "path": "/mcp",
  "authHeader": "Authorization",
  "authScheme": "Bearer",
  "protocol": { "modern": "2026-07-28", "legacySupported": true, "negotiated": "由客户端 initialize 决定" },
  "oauth": { "enabled": false, "note": "本服务只支持 Bearer Token；需要 OAuth 的客户端请用 npx mcp-remote 兜底" },
  "tokenPagePath": "/settings/tokens"
}
```

- 落地要点：`httpUrl = originOf(config.publicBaseUrl) + config.mcp.path`；`MCP_ENABLED=false` 时该端点返回 `503 MCP_DISABLED`（与既有错误码一致）。

### 3.2 后端：新增 `POST /api/mcp-tokens/verify`（已实现）

**为什么**：把「Token 能不能用」从客户端报错反推，变成一键自检。

> **实现修订（落地时改动，已生效）**：路径从 `/api/mcp-tokens/:tokenId/verify` 改为 `/api/mcp-tokens/verify`，**明文 Token 放在请求体**。
> 原因：库里只落 `token_hash`（sha256），服务端无法从 `tokenId` 反推明文，而自检必须用真凭据环回；归属校验改为解析明文得到的 `tokenId` 后走既有 `token` 资源策略（本人或被绑定者，或所有者）。

- 鉴权：仅 Token 归属者本人或所有者可调用（`assertAuthorized(context, 'token.verify', tokenResource(row))`）。
- 请求体：`{ "token": "yz_mcp_…" }`（1–300 字符）。
- 行为：服务端用该 Token 对自己的 `/mcp` 发一次 legacy `initialize` + `tools/list`（**只读探测，不调用 `tools/call`，因此不产生 `mcp.*` 业务审计噪音**），返回信封 `{ data, meta: { requestId } }`，`data` 形如：

```json
{
  "ok": true,
  "tokenId": "tok_…",
  "tokenPrefix": "yz_mcp_tok_…",
  "scopes": ["read:blueprint", "publish:blueprint"],
  "serverInfo": { "name": "youzhao", "version": "2.0.0" },
  "protocolVersion": "2025-06-18",
  "toolCount": 4,
  "tools": [{ "name": "youzhao.list_blueprints", "title": "列出蓝图", "scope": "read:blueprint" }],
  "latencyMs": 12
}
```

- 失败语义要可分辨：`401 TOKEN_INVALID`（格式不合法/不存在/哈希不符/已停用/已过期，文案区分但不泄露细节）、`403 FORBIDDEN`（不是自己的 Token）、`503 MCP_DISABLED`（`MCP_ENABLED=false`）/`503 SERVICE_UNAVAILABLE`（本进程未监听、上游不可达、响应无法解析）。这条「三态可分」正是当前生产部署缺的能力。
- 实现注意：`/mcp` 走的是 `toNodeHandler` + `reply.hijack()`，`fastify.inject()` 未必兼容 → 采用「回环真实 HTTP 请求 + 短超时（3s）」，并用集成测试固定住这个行为。
- 落地位置：契约 `packages/contracts/schemas/tokens/verify.json` + `tokens/verify-response.json`（契约 52 个 schema）；错误码 `server/domain/errors.ts` 新增 `TOKEN_INVALID`(401)；策略动作 `token.verify` 加在 `server/domain/entities.ts` 与 `server/domain/policy.ts`；探针 `server/mcp/verify.ts`（`createMcpTokenProbe`，回环基址取 `app.server.address()` 而非 `publicBaseUrl`，便于测试用临时端口、不依赖 nginx/TLS）；用例 `server/app/tokens.ts::verifyMcpToken`；路由 `server/http/routes/tokens.ts`；测试 `server/test/token-verify.test.ts`（11 用例，覆盖 401/403/503 三态、快乐路径、只读 Token 只见 4 个读工具、以及「不写 `mcp.*` 审计」）。
- 审计：自检本身留一条 `token.verify` 记录（成功 allow / 失败 deny+code），**不产生** `mcp.*` 业务审计。

### 3.3 前端：`McpConnectPanel`（替换 `McpClientSnippet.vue`）

结构（自下而上）：

1. **顶部：真实接入地址**（来自 3.1），一行 `https://youzhao.florai.cn/mcp` + 「复制」；旁边一行 `Authorization: Bearer <你的 Token>`。
2. **客户端选项卡**：`Claude Code` / `Codex CLI` / `Claude Desktop` / `Cursor` / `VS Code` / `通用 HTTP`；末尾折叠「自建 stdio 桥（高级，离线/内网）」。
3. **就地造 Token**：点「生成配置」时打开内联对话框（名称默认 `<客户端>-YYYYMMDD`、默认 scope `read:blueprint`、可勾选 `publish:blueprint`、有效期），创建成功后把明文**直接嵌进片段**，并显示一次性的「我已保存 / 重新生成」确认——消除 P5 的来回跳。
4. **一键自检**：调用 3.2，显示 `✓ 连接正常 · 可见 4 个工具（只读）` 或 `✗ Token 无效`；排在客户端片段**之前**，让用户在动客户端之前就知道 Token 对不对。
5. **scope 语义提示**：只读 Token 只能看到 4 个读工具、发布 Token 才有 4 个写工具（修掉 P6 的表述不一致）。

### 3.4 各客户端片段（可直接粘贴；生产地址用配置里的真实值代入）

**Codex CLI（已实测）**
```bash
export YOUZHAO_MCP_TOKEN=yz_mcp_…
codex mcp add youzhao --url https://youzhao.florai.cn/mcp --bearer-token-env-var YOUZHAO_MCP_TOKEN
```
等价的手写配置（`~/.codex/config.toml`）：
```toml
[mcp_servers.youzhao]
url = "https://youzhao.florai.cn/mcp"
bearer_token_env_var = "YOUZHAO_MCP_TOKEN"
```

**Claude Desktop（stdio-only → 用生态标准桥）**
```json
{
  "mcpServers": {
    "youzhao": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://youzhao.florai.cn/mcp",
               "--header", "Authorization: Bearer yz_mcp_…"]
    }
  }
}
```

**Cursor（`.cursor/mcp.json`）/ VS Code（`mcp.json`）**
```json
{
  "mcpServers": {
    "youzhao": {
      "url": "https://youzhao.florai.cn/mcp",
      "headers": { "Authorization": "Bearer yz_mcp_…" }
    }
  }
}
```

**通用 HTTP（排障用）**
```bash
curl -sS -X POST https://youzhao.florai.cn/mcp \
  -H 'Authorization: Bearer yz_mcp_…' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

**自建/离线（高级，折叠）**：仅当需要在没有公网客户端支持的场景跑仓库里的 stdio 薄桥时使用，且 `YOUZHAO_API_BASE` 必须是**部署地址**：
```bash
YOUZHAO_API_BASE=https://youzhao.florai.cn YOUZHAO_MCP_TOKEN=yz_mcp_… node server/mcp-server.mjs
```

> Claude Code（`claude mcp add --transport http … --header …`）与 Cursor/VS Code 的字段名以**本机 CLI/客户端实测**为准，实现该选项卡时逐条验证后再定稿（我在设计阶段只实测了 Codex 与 mcp-remote 两条路径）。

### 3.5 文档与技能同步

- `skills/youzhao-mcp/SKILL.md`：改为**远程 HTTP 优先**；`http://127.0.0.1:4174`（`:45`、`:59`、`:121`）全部替换为部署地址占位 `<部署地址>/mcp`；stdio 桥降级为「自建/离线」一节。
- `docs/architecture-design.md` §4.7：补「接入引导」小节与 OAuth 不在本期范围的原因；工具数量统一为 **8 = 4 读 + 4 写**。
- `web/src/components/tokens/McpClientSnippet.vue` 头部注释里「4 读 + 4 写 vs 5 读 + 3 写」的矛盾按实际值改写。

### 3.6 兼容性补强（本期小项）

| 项 | 做法 | 备注 |
|---|---|---|
| 只支持 OAuth 的客户端 | 片段里给 `mcp-remote` 兜底；401 文案补一句「不支持 OAuth，请用 Bearer Token 或 `npx mcp-remote`」 | 可选进阶：提供 `GET /.well-known/oauth-protected-resource` 返回 `{resource, bearer_methods_supported:["header"], authorization_servers:[]}`，**先实测客户端行为再定** |
| Codex 手改 TOML 的旧说法 | 文档改为官方命令 `--bearer-token-env-var` | 已实测 |
| 现代协议 envelope 报错 | 保持现状（`data.envelope.missing` 已很明确），在「通用 HTTP」片段里附一句说明 | 已实测 |

---

## 4. 验收标准

1. **零上下文接入**：一个新用户只从页面复制「一段配置 + 一个 Token」即可接入 Codex / Claude Code / Claude Desktop 之一，全程不克隆仓库、不手填路径。
2. `GET /api/mcp/connection-info` 返回的 `httpUrl` 与生产实际 MCP 地址一致，且**全仓库不再出现 `127.0.0.1:4174`**。
3. 自检端点能区分 401 / 403 / 超时三态，并在页面给出中文原因。
4. `smoke:e2e` 增加一条：`connection-info` 返回的地址在 HTTP 层可达（对 `/mcp` 发 `initialize` 得 200）。
5. 三处工具数量表述一致（8 = 4 + 4），只读 Token 的界面提示与实测一致（只见 4 个读工具）。

---

## 5. 实施分步与影响面

| 步 | 范围 | 大小 | 影响面 / 风险 | 状态 |
|---|---|---|---|---|
| 1 | 契约 `mcp/connection-info.json` + `GET /api/mcp/connection-info` + 测试 | 小 | 新增只读端点；`MCP_ENABLED=false` 时 503 | ✅ 已完成（6 用例；契约 50 schema） |
| 2 | `POST /api/mcp-tokens/verify` + 测试（三态） | 小 | 回环 HTTP 探测；**注意不触发业务审计**；需要 3s 超时 | ✅ 已完成（11 用例；契约 52 schema） |
| 3 | 前端 `McpConnectPanel`（替换 `McpClientSnippet.vue`）+ 内联造 Token + 自检 + 客户端分支 | 中 | 触及 Token 页与「我的账号」入口；需补 vitest | 进行中（数据层 `web/src/services/endpoints.ts` 已就位；视觉改由 Open Design 出稿：run#1 `mcp-b3f0` 已完成、run#2 `mcp-connect-panel-openai-800b` 在跑） |
| 4 | `skills/youzhao-mcp/SKILL.md`、`docs/architecture-design.md` §4.7、组件注释同步 | 小 | 纯文档 | ✅ 已完成（`SKILL.md` 接入段改「远端直连优先」；`mcp-tools.md` 写工具 3→4；`mcp-server.mjs` 默认地址改部署域名；架构文档新增 §4.7.1；文档中讲「问题现象/旧站事实」的 4174 原样保留） |
| 5 | 验证：本机 `mcp-remote` 回归 + Codex CLI 实测 + 生产复跑冒烟 | 小 | Codex 实测需真实 Token | 待做 |

**建议顺序**：1 → 2 → 4 → 3（先让地址与自检能力就位，再改界面），最后 5。

---

## 6. 待确认

1. 自检端点是否需要保留一条**审计记录**（`mcp.verify`）？默认建议**不写**（避免噪音），仅记录请求日志。
2. 是否本期就补 `/.well-known/oauth-protected-resource`（避免 OAuth-only 客户端停在发现失败）？建议**先实测**再定。
3. Claude Code / Cursor / VS Code 的片段是否本期全部提供，还是先做 Codex + Claude Desktop 两条（覆盖已知的真实用户）？
4. 页面入口位置：放在「我的账号」还是保留在「Token」页并加个「连接 Agent」主按钮？
