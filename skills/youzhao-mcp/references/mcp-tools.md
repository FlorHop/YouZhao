# 有招 MCP 工具参考

权威定义在 `packages/contracts/schemas/mcp/*.json`（入参）与 `*-output.json`（出参）；本文件是给 Agent 读的摘要。
工具名与顺序固定；`tools/list` 会按 Token scope 裁剪（只读 Token 只见 4 个读工具）。

通用约定：

- `idempotencyKey`（可选，1–128 字符）：**只有 3 个写工具**（`publish_blueprint`、`cover_blueprint_version`、`delete_blueprint_version`、`create_blueprint_group`）接受；同一 key + 同一请求体回放首次结果。
- 时间字段是 ISO 8601 字符串；`artifactBytes` / `latestVersion` / `archivedAt` 可为 `null`。
- 出参同时出现在 `structuredContent`（本文件描述的结构）与 `content[0].text`（同一 JSON 的字符串）。
- 失败时 `isError: true`，`content[0].text` 为 `{"error":{"code","message","details"}}`，`structuredContent` 同形。

---

## `youzhao.list_blueprint_groups`（read）

入参：无（`{}`）。

出参：

```json
{ "groups": [ { "id": "grp_…", "name": "默认", "isDefault": true, "sortOrder": 0,
                "archivedAt": null, "blueprintCount": 3 } ] }
```

## `youzhao.list_blueprints`（read）

入参：`keyword`、`groupId`、`status`（`active`|`archived`）、`page`、`pageSize`（全部可选）。

出参：

```json
{ "items": [ { "id": "bp_…", "name": "招商驾驶舱", "summary": "…", "tags": ["招商"],
               "groupId": "grp_…", "groupName": "默认", "status": "active",
               "versionCount": 2, "latestVersion": "v1.1.0",
               "createdAt": "2026-06-12T09:00:00.000Z", "updatedAt": "…", "archivedAt": null } ],
  "groups": [ { "id": "grp_…", "name": "默认", "isDefault": true, "sortOrder": 0, "blueprintCount": 3 } ] }
```

`groups` 是**用于筛选的分组清单**（与 items 同一次查询返回），不要与 `list_blueprint_groups` 的字段混用。

## `youzhao.get_blueprint`（read）

入参：`blueprintId`（必填）；`version`（可选，用于确认某个版本存在）。

出参：

```json
{ "blueprint": { …BlueprintSummary… },
  "versions": [ { "version": "v1.1.0", "isLatest": true, "status": "available",
                  "publishSource": "manual", "publishNote": "…",
                  "deployedAt": "…", "artifactBytes": 2048, "archivedAt": null } ],
  "capabilities": { "canManage": true, "canPublish": false } }
```

`capabilities` 是**绑定用户在目标蓝图上的实际能力**（已算入 scope）——发布前先看 `canPublish`。

## `youzhao.get_blueprint_artifact`（read）

入参：`blueprintId`（必填）；`version`（可选，默认最新）。

出参（两种形态）：

```json
// 文本产物（单文件且 ≤ 512 KiB，扩展名 html/md/markdown/txt/json/css/js/svg）
{ "blueprintId": "bp_…", "version": "v1.1.0", "entry": "index.html",
  "files": [ { "path": "index.html", "bytes": 2048 } ],
  "text": "<!doctype html>…" }

// 其他情况：票据化清单（不返回裸路径，不内联大文件）
{ "blueprintId": "bp_…", "version": "v1.1.0", "entry": "index.html",
  "files": [ { "path": "index.html", "bytes": 2048 }, { "path": "assets/app.js", "bytes": 900 } ],
  "url": "http://127.0.0.1:4174/preview/p/bp_…/v1.1.0/index.html?ticket=…",
  "expiresAt": "2026-06-12T10:30:00.000Z" }
```

- `url` 是**一次性**票据入口：首次访问换 Cookie 并 303 到真实相对路径；过期或已用请重新调用本工具。
- 清单里的 `files[].path` 是产物内相对路径，配合 `url` 的目录前缀拼子资源；**不要**把它当文件系统路径。
- 产物不可用（版本已删除/蓝图已归档且无权限）返回 `VERSION_NOT_FOUND`/`BLUEPRINT_NOT_FOUND`。

## `youzhao.publish_blueprint`（publish）

入参：`name`、`groupId`、`version`、`html`（四个必填）；`blueprintId`、`summary`、`tags`、`markdown`、`publishNote`、`idempotencyKey`（可选）。

- 带 `blueprintId` → 发布该蓝图的新版本；不带 → 新建蓝图（`name`/`groupId`/`version` 用于建号）。
- `html` 必须含 `<!doctype html>` 或 `<html`；服务端会把它打成单文件（含 `markdown` 时同一包里加 `README.md`）后走与网页上传**完全相同**的校验与落盘路径。
- 多文件蓝图请用网页上传 ZIP；MCP 只提交内联文本。

出参：

```json
{ "blueprint": { …BlueprintSummary… },
  "version": { "version": "v1.1.0", "isLatest": true, "status": "available",
               "publishSource": "mcp", "publishNote": "…", "deployedAt": "…",
               "artifactBytes": 2048, "archivedAt": null } }
```

## `youzhao.cover_blueprint_version`（publish）

入参：`blueprintId`、`version`、`html`（必填）；`markdown`、`publishNote`、`idempotencyKey`（可选）。

用新产物覆盖**已存在的版本**，版本号与发布记录不变，原产物不可恢复。出参同 `publish_blueprint`。

## `youzhao.delete_blueprint_version`（publish）

入参：`blueprintId`、`version`（必填）；`idempotencyKey`（可选）。

删除即归档（记录保留，产物标记不可用，可恢复）。出参同 `publish_blueprint`（返回删除后的蓝图与版本快照）。

## `youzhao.create_blueprint_group`（publish）

入参：`name`（必填）；`idempotencyKey`（可选）。**没有** `description`、**不能**调整排序。

出参：

```json
{ "group": { "id": "grp_…", "name": "新分组", "isDefault": false,
             "sortOrder": 5, "archivedAt": null },
  "movedBlueprintIds": [] }
```

需要 `blueprint.manage`（不是 `blueprint.publish`）；成员 Token 调它会得到 `CAPABILITY_REQUIRED`。

---

## 错误码到 HTTP 的映射

| 码 | HTTP | 何时出现 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Token 缺失/形态非法/查不到/哈希不符/已停用/已过期；绑定用户不存在 |
| `SESSION_EXPIRED` | 401 | 浏览器会话专用，MCP 不出现 |
| `SCOPE_DENIED` | 403 | Token 缺 `read:blueprint` 或 `publish:blueprint` |
| `FORBIDDEN` | 403 | 绑定用户被停用，或策略拒绝 |
| `CAPABILITY_REQUIRED` | 403 | 缺 `blueprint.manage`/`blueprint.publish` 或不在资源范围 |
| `OUT_OF_MANAGED_SCOPE` | 403 | 超出绑定用户的管理范围 |
| `PEER_MANAGE_DENIED` | 403 | 试图管理同级/上级用户 |
| `BLUEPRINT_NOT_FOUND` / `VERSION_NOT_FOUND` / `GROUP_NOT_FOUND` | 404 | 不存在或无权访问（**合并语义**，不区分） |
| `VERSION_CONFLICT` | 409 | 版本已存在；幂等键被不同请求体复用；同键请求处理中 |
| `INVALID_ARGUMENT` | 400 | 入参校验失败（`details` 指出字段） |
| `INVALID_ARTIFACT` | 400 | HTML 缺 doctype、产物校验失败 |
| `PAYLOAD_TOO_LARGE` | 413 | 超过 `MCP_MAX_BODY_BYTES`（默认 5 MiB） |
| `PUBLISH_FAILED` | 500 | 产物写入/替换失败 |
| `INTERNAL_ERROR` | 500 | 未预期错误（详情只进日志） |

## 协议层细节（直连 HTTP 时才需要）

- 端点：`POST <YOUZHAO_API_BASE><MCP_PATH>`（默认 `/mcp`），每个请求 `Authorization: Bearer <token>`。
- 现代协议（`2026-07-28`）：每请求带 `MCP-Protocol-Version`、`Mcp-Method`；`tools/call` 另带 `Mcp-Name`；`params._meta` 必须含 `io.modelcontextprotocol/protocolVersion` 与 `io.modelcontextprotocol/clientCapabilities`。头与体声明的版本不一致 → `-32020`。
- 旧代客户端：先 `initialize`（`2025-xx-xx`），**不要**带 `Mcp-*` 头；响应是 SSE（`text/event-stream`）。
- 现代协议**没有** `initialize`（会得到 `-32601 Method not found`）。
- 响应可能是 SSE；解析时取所有 `data:` 帧。日志/诊断走 stderr。
