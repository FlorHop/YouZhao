# 有招权限模型与接口契约（设计稿）

本文定义有招的**目标权限模型**、**权限矩阵**与**服务端接口契约**。它是设计文档，不是当前实现说明；文末列出与现有代码的差距和迁移注意事项。

相关文档：

- `docs/demo-platform-prd.md`：产品范围
- `docs/deployment-rules.md`：部署约束
- `docs/frontend-rules.md`：前端规范

## 1. 设计目标

现有权限模型的问题是：`system-settings:manage` 一项权限同时代表“能打开管理页面”和“能管理全平台所有人”，导致同级管理员可以互相撤权、重置密码、停用账号，也可以把权限扩散给自己或他人。

目标模型要解决四件事：

1. **身份与业务能力分离**：管账号的人不一定管蓝图；管蓝图的人不一定管账号。
2. **管理有边界**：每个管理动作都在明确的对象范围和资源范围内生效。
3. **授权不可越级、不可平级互改**：不能授予自己没有的能力，不能修改同级或上级。
4. **唯一所有者不可被架空**：始终恰好一位有效所有者，且不能被普通管理操作移除。

## 2. 身份、业务能力与范围

### 2.1 身份（互斥）

每个用户账号有且只有一个身份。

| 身份 | 标识 | 数量约束 | 说明 |
| --- | --- | --- | --- |
| 平台所有者 | `owner` | 全平台恰好 1 位 | 最高权限；不可被其他身份修改、停用、删除、重置密码 |
| 用户管理员 | `user_admin` | 0..N | 管理**指派给自己的普通用户**；可创建普通用户 |
| 普通用户 | `member` | 0..N | 使用获授权的蓝图；可创建自己的只读 MCP Token |

### 2.2 业务能力（可叠加、必须带范围）

业务能力不是身份，可以授予任意身份的人（通常是 `member` 或 `user_admin`）。

| 能力 | 标识 | 作用 |
| --- | --- | --- |
| 蓝图管理 | `blueprint.manage` | 在指定范围内维护蓝图元数据、分组归属、归档 |
| 蓝图发布 | `blueprint.publish` | 在指定范围内发布新版本 |

规则：

- 授予能力**只有平台所有者**可以操作。
- 能力**必须带资源范围**（分组或单个蓝图），不存在“全局管理所有蓝图”的默认含义，除非所有者显式选择全部分组。
- 业务能力**不带来**任何账号管理权；身份**不带来**任何业务能力。

### 2.3 三种范围

| 范围 | 归属 | 决定什么 |
| --- | --- | --- |
| 管理归属 `managedByUserIds` | 每个普通用户 **0..N** 位用户管理员 | 谁能编辑、停用、重置该用户（任一归属管理员均可） |
| 可委派范围 | 每个用户管理员 | **等于其本人的查看范围**（同一集合，不单独维护）；决定能把哪些分组/单蓝图的**查看权**授予自己管理的用户 |
| 能力范围 `capabilityScopes` | 每个业务能力授予 | 能管理/发布哪些分组的蓝图 |

三者互相独立：能查看某蓝图 ≠ 能把它授权给别人；能管理某用户 ≠ 能给他开放全部蓝图。

## 3. 权限矩阵

图例：`允许` / `拒绝` / `受限（附条件）`

### 3.1 账号管理

| 操作 | 所有者 O | 用户管理员 A | 普通用户 U |
| --- | --- | --- | --- |
| 查看用户列表 | 允许（全平台） | 受限（仅 `managedByUserIds` 含 A 的普通用户） | 拒绝 |
| 创建用户 | 允许（任意身份） | 受限（只能创建 `member`；新用户自动归 A 管理） | 拒绝 |
| 修改用户资料 | 允许 | 受限（仅自己管理的普通用户） | 拒绝（本人资料经「我的账号」自助） |
| 停用 / 启用 | 允许 | 受限（仅自己管理的普通用户） | 拒绝 |
| 重置密码 | 允许 | 受限（仅自己管理的普通用户） | 拒绝（本人改密码经「我的账号」自助） |
| 删除用户 | 允许 | **拒绝**（A 只能停用） | 拒绝 |
| 改派管理归属 | 允许（唯一入口，整体替换归属集合） | 拒绝 | 拒绝 |
| 任命 / 撤销用户管理员 | 允许 | 拒绝 | 拒绝 |
| 移交平台所有者 | **本期不提供**（已裁决暂不设计，见 §8） | 拒绝 | 拒绝 |
| 修改自己的身份 | 拒绝 | 拒绝 | 拒绝 |

补充：`A` 不得管理自己、其他用户管理员或所有者。所有者不可被任何人停用、删除或重置密码。`A` 对自己管理的用户**只能停用，不能删除**——删除用户是所有者专属；一个用户被多位管理员管理时，每位管理员都能停用，但都不能删除。

补充（页面与接口的边界）：普通用户**不可访问「用户」「权限」两个页面**；上表中所有对普通用户记为「拒绝」的行，共同意味着 `/api/users/*` 整个命名空间对 `member` 关闭。本人能力只经 `/api/me/*` 提供，且该命名空间不含任何用户管理或授权能力。

### 3.2 蓝图授权

| 操作 | 所有者 O | 用户管理员 A | 普通用户 U |
| --- | --- | --- | --- |
| 授予 / 撤销查看权 | 允许（任意资源） | 受限（仅其本人查看范围内的资源，且仅 `managedByUserIds` 含 A 的用户） | 拒绝 |
| 查看某用户已有授权 | 允许 | 受限（仅自己管理的用户；**含他人授予的只读项**，用于解释该用户为何能看到某蓝图） | 拒绝（本人经 `GET /api/me` 查看自己的范围） |
| 授予 / 撤销 `blueprint.manage` | 允许 | 拒绝 | 拒绝 |
| 授予 / 撤销 `blueprint.publish` | 允许 | 拒绝 | 拒绝 |

补充：`A` 保存授权时只能提交**本次增删的授权项**，不得以整表覆盖方式删除其他管理员或所有者授予的授权。

### 3.3 蓝图业务操作

| 操作 | 需要的能力 |
| --- | --- |
| 查看蓝图与产物 | 有效查看权（分组或单蓝图） |
| 维护元数据、归档、移动分组 | `blueprint.manage` 覆盖来源分组与目标分组 |
| 发布新版本 | `blueprint.publish` 覆盖目标分组 |
| 归档蓝图 | `blueprint.manage` 覆盖该蓝图；**不物理删除**，可恢复 |
| 归档分组 | `blueprint.manage` 覆盖该分组，且需确认受影响用户范围；**不物理删除**，可恢复 |

### 3.4 MCP Token

| 操作 | 所有者 O | 用户管理员 A | 普通用户 U |
| --- | --- | --- | --- |
| 创建自己的只读 Token | 允许 | 允许 | 允许 |
| 创建自己的发布 Token | 允许 | 受限（需具备 `blueprint.publish`） | 受限（需具备 `blueprint.publish`） |
| 查看自己的 Token 元数据 | 允许 | 允许 | 允许 |
| 停用 / 删除自己的 Token | 允许 | 允许 | 允许 |
| 查看全平台 Token 元数据 | 允许 | 拒绝 | 拒绝 |
| 停用他人的 Token | 允许 | 拒绝 | 拒绝 |
| 替他人创建 Token | 允许（须显式指定绑定用户） | 拒绝 | 拒绝 |
| 查看他人的 Token 元数据 | 允许 | 拒绝 | 拒绝 |

Token 的有效权限**不超过绑定用户当下的权限**：撤销绑定用户的查看权或发布权后，Token 立即失去对应能力，无需等待过期。Token 的最终能力 = **绑定用户当下的权限 ∩ Token 自身 scope**。

## 4. 服务端不变量

以下规则必须在服务端强制，前端隐藏按钮只是体验优化。

1. **唯一所有者**：任何操作都不能产生 0 位或 2 位有效所有者。**本期不提供所有者移交通道**（裁决：暂不设计），因此所有者身份只能由首次初始化和数据库运维变更。
2. **禁止平级与自我管理**：操作者不能修改自己、同级或上级的身份、状态与权限。
3. **对象范围校验**：账号管理动作要求 `managedByUserIds` **包含**操作者。
4. **委派范围校验**：授予查看权时，目标资源必须落在**操作者本人的查看范围**内（可委派范围即其查看范围）。
5. **增量授权**：授权接口只接受 `add` / `remove` 差异，服务端拒绝整表替换。
6. **改派唯一入口**：只有所有者可修改 `managedByUserIds`（整体替换归属集合）。
7. **能力授予唯一入口**：只有所有者可授予业务能力，且必须显式给出资源范围。
8. **状态级联**：停用或删除用户时，其会话与 MCP Token 立即失效。
9. **审计**：每次授权、改派、身份变更、Token 操作记录操作者、目标、变更前后值与时间。
10. **命名空间隔离**：`/api/users/*`、`/api/admins/*`、`/api/owner/*` 拒绝 `member` 身份（含目标为本人）；本人能力只存在于 `/api/me/*`，该命名空间不得出现用户列表、他人数据或授权写入。
11. **归档而非删除**：分组、蓝图、版本的"删除"一律落为**归档**（保留产物与授权记录），并可通过恢复接口还原；物理清理只能是运维动作，不经业务接口暴露。
12. **多归属并集语义**：`managedByUserIds` 含多位管理员时，任一管理员都可执行编辑资料、停用、重置密码、在自己范围内授予查看权，但**都不能删除该用户**，也**都不能改派归属**（只有所有者）。

## 5. 数据模型建议

当前结构化数据保存在 SQLite 的 `app_state` 单表 JSON 快照中，目标模型可先在该快照内扩展，不强制引入关系库。

### 5.1 用户

```jsonc
{
  "id": "user_xxx",
  "username": "zhangsan",
  "displayName": "张三",
  "email": "",
  "phone": "",
  "status": "active",               // active | disabled
  "identity": "member",             // owner | user_admin | member
  "managedByUserIds": ["user_admin1"], // 仅 member；空数组 = 暂未指派；可含多位管理员
  "createdByUserId": "user_admin1", // 审计事实，不随改派变化
  "createdAt": "2026-10-16T00:00:00.000Z"
}
```

### 5.2 查看授权与可委派范围

```jsonc
// 查看授权（替代现有 blueprintPermissions）
"viewGrants": [
  {
    "userId": "user_member1",
    "targetType": "group",        // group | blueprint
    "targetId": "group_invest",
    "grantedByUserId": "user_admin1",
    "grantedByDisplayName": "林知远", // 授予者姓名；前端直接展示「由 林知远 于 2026-02-12 授予」
    "grantedAt": "2026-10-16T00:00:00.000Z"
  }
]

// 可委派范围：不单独存储。
// 用户管理员能委派的资源 = 他自己通过 viewGrants 获得的查看范围；
// 因此"可委派范围"是 viewGrants 的派生视图，避免两处范围不一致。
```

### 5.3 业务能力

```jsonc
"capabilities": [
  {
    "userId": "user_member2",
    "capability": "blueprint.publish",  // blueprint.manage | blueprint.publish
    "targetType": "group",              // group | blueprint
    "targetId": "group_invest",
    "grantedByUserId": "user_owner",
    "grantedAt": "2026-10-16T00:00:00.000Z"
  }
]
```

统一口径：**viewGrant 与 capability 两类条目统一使用 `targetType`/`targetId`**，能力条目不再另设一套目标字段名。

### 5.4 MCP Token

```jsonc
{
  "id": "mcp_token_xxx",
  "name": "我的只读 Token",
  "boundUserId": "user_member1",
  "status": "active",
  "scopes": ["read:blueprint"],   // 可选 read:blueprint | publish:blueprint
  "tokenHash": "...",
  "tokenPreview": "yz_mcp_****abcd",
  "expiresAt": "永不过期",
  "lastUsedAt": "未使用",
  "createdAt": "2026-10-16T00:00:00.000Z"
}
```

## 6. 接口契约

约定：除登录与初始化外，所有接口要求 `Authorization: Bearer <session-token>`。错误响应统一为 `{ "error": { "code", "message", "details?" } }`；成功响应统一为 `{ "data": { … }, "meta": { "requestId": "…" } }` 信封（与 `GET /api/health`、会话响应一致），`meta.requestId` 供日志追溯。

### 6.1 身份与能力

| 方法 | 路径 | 允许者 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/me` | 已登录 | 本人资料、身份、业务能力与自己的有效范围（查看权、可委派范围） |
| — | `/api/setup/*` | — | **不设初始化接口**：所有者由部署时环境变量注入（`ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_DISPLAY_NAME`），首次登录强制改密 |

`GET /api/me` 响应：

```jsonc
{
  "data": {
    "user": { "id": "user_member1", "displayName": "张三", "identity": "member" },
    "capabilities": [
      { "capability": "blueprint.publish", "targetType": "group", "targetId": "group_invest" }
    ],
    "viewGrants": [
      { "targetType": "group", "targetId": "group_invest", "grantedByUserId": "user_owner", "grantedByDisplayName": "林知远", "grantedAt": "2026-10-16T00:00:00.000Z" }
    ],
    "delegableScopes": [] // 派生字段：用户管理员时为自身查看范围（targetType/targetId 列表）；其他身份为空
  },
  "meta": { "requestId": "req_..." }
}
```

### 6.2 用户管理

| 方法 | 路径 | 允许者 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/users` | O / A | O 返回全平台；A 只返回自己管理的普通用户 |
| POST | `/api/users` | O / A | 创建用户；A 只能创建 `member` |
| PATCH | `/api/users/:id` | O / A | 修改资料与状态；**不含**本人自助 |
| POST | `/api/users/:id/password` | O / A | 重置他人密码；本人改密码走 `/api/me/password` |
| DELETE | `/api/users/:id` | 仅 O | 删除用户（A 只能停用，不能删除） |
| PUT | `/api/users/:id/managed-by` | 仅 O | 改派管理归属（**整体替换**归属集合，支持多位管理员） |
| PUT | `/api/users/:id/identity` | 仅 O | 任命 / 撤销用户管理员（`owner` 不能经此接口设定） |
| — | `/api/owner/transfer` | — | **本期不提供**（已裁决暂不设计）；`/api/owner/*` 命名空间保留给所有者保护类端点 |
| GET | `/api/users/:id/grants` | O / A | 查看授权及来源；本人查看自己的范围走 `GET /api/me` |
| POST | `/api/users/:id/grants` | O / A | 增量授予 / 撤销查看权 |
| PUT | `/api/users/:id/capabilities` | 仅 O | 设置业务能力与范围 |
| — | `/api/admins/:id/delegation` | — | **不设此接口**：用户管理员的可委派范围等于其本人的查看范围，随查看授权一起变更 |

创建用户请求：

```jsonc
POST /api/users
{
  "username": "lisi",
  "displayName": "李四",
  "email": "",
  "phone": "",
  "password": "初始密码",
  "viewGrants": [
    { "targetType": "group", "targetId": "group_invest" }
  ]
}
```

增量授权请求：

```jsonc
POST /api/users/user_member1/grants
{
  "add":    [{ "targetType": "group", "targetId": "group_invest" }],
  "remove": [{ "targetType": "blueprint", "targetId": "blueprint_abc" }]
}
```

查看授权响应（`GET /api/users/:id/grants`，节选）：

```jsonc
{
  "data": {
    "items": [
      {
        "targetType": "group",
        "targetId": "group_invest",
        "grantedByUserId": "user_admin1",
        "grantedByDisplayName": "林知远", // 前端直接展示「由 林知远 于 2026-02-12 授予」，无需再查用户表
        "grantedAt": "2026-02-12T00:00:00.000Z"
      }
    ]
  },
  "meta": { "page": 1, "pageSize": 20, "total": 1, "requestId": "req_..." }
}
```

#### 本人自助（`/api/me/*`）

本人能力**不放在 `/api/users/*` 内**，避免“本人”分支成为普通用户进入用户管理接口的侧门。自读入口即 §6.1 的 `GET /api/me`，它同时承担「我的账号」中“我的范围”的只读展示，因此**不另设** `/api/me/scope`。

| 方法 | 路径 | 允许者 | 说明 |
| --- | --- | --- | --- |
| PATCH | `/api/me` | O / A / U | 修改本人资料；**不接受**身份、状态、权限字段 |
| POST | `/api/me/password` | O / A / U | 修改本人密码，需校验原密码 |

`/api/users/*`、`/api/admins/*`、`/api/owner/*` 对 `member` 身份**一律拒绝**，包括目标是自己。

### 6.3 MCP Token

| 方法 | 路径 | 允许者 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/mcp-tokens` | O / A / U | 返回自己的 Token；O 额外可查全部 |
| POST | `/api/mcp-tokens` | O / A / U | 为自己创建（`scopes` 只能选自身具备的能力）；**仅 O** 可为他人创建，须显式传 `bindUserId`（用户管理员不能替名下用户建 Token，与其「只看自己的 Token」一致） |
| PATCH | `/api/mcp-tokens/:id` | 本人 / O | 启用 / 停用 |
| DELETE | `/api/mcp-tokens/:id` | 本人 / O | 删除 |

### 6.4 蓝图与分组

| 方法 | 路径 | 允许者 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/blueprint-groups` | 有查看权者 | 仅返回授权范围内的分组 |
| GET | `/api/blueprints` | 有查看权者 | 仅返回授权范围内的蓝图，含版本列表 |
| GET | `/api/blueprints/:id` | 有该蓝图查看权者 | 单蓝图详情 |
| GET | `/api/blueprints/:id/artifact` | ~~有该蓝图查看权者~~ | ~~取指定版本产物~~ **本期不提供**：产物一律经预览域交付，接口面只保留 `POST /api/preview-tickets` + `/preview/p/...`（见 §6.4 末注）；MCP 侧对应 `youzhao.get_blueprint_artifact`（返回清单 + 入口票据） |
| POST | `/api/blueprints` | `blueprint.publish` 覆盖目标分组 | 创建蓝图并发布首个版本 |
| POST | `/api/blueprints/:id/versions` | `blueprint.publish` 覆盖目标分组 | 发布新版本，并置为最新 |
| PUT | `/api/blueprints/:id/versions/:version` | `blueprint.manage` 覆盖该蓝图 | 覆盖已有版本的产物，版本号不变 |
| DELETE | `/api/blueprints/:id/versions/:version` | `blueprint.manage` 覆盖该蓝图 | 归档某个版本（不物理删除，可恢复）；不得归档最后一个可用版本 |
| PATCH | `/api/blueprints/:id` | `blueprint.manage` 覆盖该蓝图 | 改元数据、移动分组、归档 |
| DELETE | `/api/blueprints/:id` | `blueprint.manage` 覆盖该蓝图 | 归档蓝图及其全部版本；**不物理删除产物**，可恢复 |
| POST | `/api/blueprint-groups` | `blueprint.manage` 覆盖目标范围 | 新建分组 |
| PATCH | `/api/blueprint-groups/reorder` | `blueprint.manage` 覆盖涉及分组 | 调整分组顺序 |
| DELETE | `/api/blueprint-groups/:id` | `blueprint.manage` 覆盖该分组 | 归档分组（不物理删除，可恢复）；其下蓝图回落默认分组 |
| POST | `/api/blueprint-groups/:id/restore` | `blueprint.manage` 覆盖该分组 | 从归档恢复分组 |
| POST | `/api/blueprints/:id/restore` | `blueprint.manage` 覆盖该蓝图 | 从归档恢复蓝图 |
| POST | `/api/blueprints/:id/versions/:version/restore` | `blueprint.manage` 覆盖该蓝图 | 从归档恢复某个版本 |

补充：创建、发布、覆盖的上传内容均为产物包（含入口 `index.html`）；服务端须校验包内路径，拒绝绝对路径与 `..` 穿越。

MCP 暴露面（Q10 已裁决）：允许 `youzhao.create_blueprint_group`（需覆盖目标范围的 `blueprint.manage`），**不暴露**分组排序——排序只在前端由人工操作。

### 6.5 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | 未登录、会话失效 |
| `FORBIDDEN` | 403 | 无该操作权限 |
| `OWNER_PROTECTED` | 403 | 目标为平台所有者，不可修改 |
| `SELF_MANAGE_DENIED` | 403 | 不能管理自己 |
| `PEER_MANAGE_DENIED` | 403 | 不能管理同级或上级 |
| `OUT_OF_MANAGED_SCOPE` | 403 | 目标用户不在自己的管理范围内 |
| `DELEGATION_EXCEEDED` | 403 | 授权目标超出可委派范围 |
| `CAPABILITY_REQUIRED` | 403 | 缺少所需业务能力或范围不足 |
| `LAST_OWNER_PROTECTED` | 409 | 操作会使平台失去唯一所有者 |
| `STALE_PERMISSION_STATE` | 409 | 权限已被他人变更，需刷新后重试 |
| `USERNAME_CONFLICT` | 409 | 用户名已存在 |
| `GROUP_CONFLICT` | 409 | 分组名称已存在 |
| `VERSION_CONFLICT` | 409 | 版本号已存在（覆盖请走覆盖接口） |
| `LAST_VERSION_PROTECTED` | 409 | 不能删除蓝图的最后一个版本 |
| `ARTIFACT_INVALID` | 400 | 上传包缺少入口 `index.html`，或含路径穿越 |
| `PAYLOAD_TOO_LARGE` | 413 | 产物超出体积上限 |
| `INVALID_ARGUMENT` | 400 | 参数不合法 |
| `NOT_FOUND` | 404 | 请求的资源不存在（通用） |
| `BLUEPRINT_NOT_FOUND` / `VERSION_NOT_FOUND` / `GROUP_NOT_FOUND` / `USER_NOT_FOUND` / `TOKEN_NOT_FOUND` | 404 | 资源级「不存在」，便于前端区分对象 |


> **§6.4 末注（产物交付口径）**：本期不为产物提供「按蓝图取文件」的 REST 端点。原因有三：① 产物是发布者可控的 HTML，同源直出会引入存储型 XSS 面（旧实现 `/api/artifacts/...` 正是如此且完全匿名）；② 预览域需要按次校验可见性（归档/撤权/停用即时生效），票据 + 短时 Cookie 是已实现的唯一通路；③ 前端「查看蓝图」直接开预览票据即可，不需要第二个入口。
> 需要原始文件（导出/离线归档）时，走 MCP 的 `youzhao.get_blueprint_artifact`：文本产物内联返回，HTML/多文件产物返回 `files[]` 清单 + 入口票据 + sha256。
> 旧实现的 `/api/artifacts/:blueprintId/:version/index.html` 是**匿名可读**且不校验可见性的，迁移时必须直接下线，不做兼容层。

## 7. 与当前实现的差距

| 目标模型 | 当前实现 | 处理方式 |
| --- | --- | --- |
| `identity` 三身份 | 无身份字段 | 迁移时把现有唯一管理员置为 `owner` |
| 全部 `owner` 保护 | 任意 `system-settings:manage` 可改任何人 | 需重写 `server/index.mjs:1093-1183` 的授权判断 |
| `managedByUserIds` 管理归属 | 不存在 | 新增（数组）与校验；支持多归属 |
| 可委派范围 | 不存在 | **不新增独立字段**：由该管理员本人的查看授权派生 |
| 归档 / 恢复 | 无归档概念（删除分组即物理回落） | 新增 `archivedAt` 与恢复接口；"删除"一律降级为归档 |
| `capabilities` 带范围 | `demo-preview:manage` 是全局开关 | 拆分并补范围 |
| 增量授权 | `PUT /api/admin/users/:id/permissions` 整表覆盖（`server/index.mjs:1149-1182`） | 改为 `add` / `remove` |
| Token 只读档位 | 创建 Token 要求蓝图管理权，且一律给读写（`server/index.mjs:1185-1213`） | 拆开 `scopes` 与所需身份 |
| 全局 Token 视图 | 用户管理员可经响应拿到全局快照 | 收敛响应字段 |

迁移建议顺序：

1. 先落数据字段（`identity`、`managedByUserIds`、`capabilities`、`archivedAt`），保持旧接口可读。
2. 再把 `system-settings:manage` 的全局权限收敛为 `owner`。
3. 然后改造用户与权限接口，最后调整前端页面。

权限改造应与已发现的安全问题一并处理：产物访问缺少授权、嵌入默认密钥、发布版本名未限制路径、会话无有效期。这些属于代码缺陷，不因权限模型调整而自动消失。

## 8. 设计裁决

原「待确认事项」已逐条裁决，成为本文件的既定前提：

| # | 原问题 | 裁决 |
| --- | --- | --- |
| 1 | 普通用户能否同时归属多位用户管理员 | **可以**，多对多；`managedByUserIds` 为数组 |
| 2 | 用户管理员能否删除名下用户 | **只能停用**；删除仅限所有者 |
| 3 | 可委派范围如何指定 | **不单独指定**：等于该管理员本人的查看范围（与其查看授权同一集合） |
| 4 | 分组删除时蓝图与查看权如何处理 | **不物理删除**：分组归档、其下蓝图回落默认分组、授权记录保留，整体可恢复 |
| 5 | 所有者移交是否需要接任者确认 | **本期不设计该功能**（短期内不会发生）；不做移交入口，未来需要时再补「接任者确认」流程 |

Token 侧补充裁决：所有者可为**任意用户**创建 Token（须显式指定绑定用户）；用户管理员与普通用户只能为自己创建；Token 最终能力 = 绑定用户当下权限 ∩ Token scope。
