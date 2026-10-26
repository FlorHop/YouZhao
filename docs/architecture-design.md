# 有招平台 · 整体架构与前后端框架设计

## 0. 文档信息

| 项 | 值 |
| --- | --- |
| 文档版本 | v1.0（整体性设计，待评审） |
| 状态 | 设计稿，未进入实现 |
| 适用范围 | 有招平台的重新开发：后端框架、前端框架、前后端配合模式、MCP 服务 |
| 前置文档 | `docs/demo-platform-prd.md`（需求）、`docs/permission-design.md`（权限模型与接口契约）、`docs/frontend-design.md`（页面级设计）、`docs/deployment-rules.md`（部署约束）、`docs/frontend-rules.md`（前端约束）、`docs/prototype-interaction-review.md`（原型交互审核） |

### 0.1 本文档与既有文档的关系

本文档是**框架级**设计，不重复页面级与权限级细节：

| 主题 | 权威文档 | 本文档的角色 |
| --- | --- | --- |
| 需求范围、MCP 工具语义 | `docs/demo-platform-prd.md` | 引用，不重写 |
| 身份/能力/范围、接口允许者、服务端不变量、错误码 | `docs/permission-design.md` | 引用；本文档只补"如何落地"（数据模型、策略层） |
| 页面结构、区段、可见性、交互 | `docs/frontend-design.md` | 引用；本文档只补"用什么框架与组件实现" |
| 部署拓扑、目录、环境变量 | `docs/deployment-rules.md` | **部分修订**（见 §9） |
| 前端技术基线、PrimeVue 规则 | `docs/frontend-rules.md` | **部分修订**（见 §9：视觉取值基线改为原型） |
| 原型交互缺陷 | `docs/prototype-interaction-review.md` | 转成前端实现约束（§5.7）与验收项 |

### 0.2 本次设计要回答的问题

1. 后端怎么分层、用什么运行时与数据库、权限判断放在哪里。
2. 前端用什么框架，怎么把"已确认样式的原型"落到 PrimeVue 上。
3. 前后端怎么配合：契约、错误、并发、分页、鉴权边界、产物交付。
4. MCP 服务在后续后端怎么设计，与服务端如何共用领域层而不是绕过权限。

### 0.3 用户已确认的语义（本设计的输入）

| 编号 | 结论 |
| --- | --- |
| S1 | 用户管理员的**可委派范围 = 本人的查看范围**（同一集合，不再区分两套范围） |
| S2 | 用户管理员只能看到**自己创建/名下的 Token**；所有者可看到全部 Token，并可**为他人创建** Token |
| S3 | Token 的权限 = **绑定用户的权限** ∩ Token 自身 scope |
| S4 | 用户管理员**可以被叠加业务能力**（身份与业务能力正交） |
| S5 | 演示用的"身份切换器"仅用于原型验证，**生产实现中不保留** |
| S6 | 用户管理员对名下用户**只能停用，不能删除**；删除用户是所有者专属动作（Q2） |
| S7 | 一个成员**可以归属多个用户管理员**（多对多）；改派仍只有所有者可做（Q3） |
| S8 | 删除分组 / 蓝图 / 版本**不做物理删除**，一律转为归档且**可恢复**（Q4） |
| S9 | 全平台**只保留一位所有者**；本期**不提供移交入口**（Q5 裁决：暂不设计），变更只能经数据库运维 |
| S10 | 预览使用**独立域名**（Q6） |
| S11 | 迁移期**不并行保留旧接口**，直接切换到本设计的接口（Q7） |
| S12 | 本期**需要** ECharts（Q8） |
| S13 | 破坏性动作与校验错误**引入受限危险色**（Q9，见 §5.3） |
| S14 | MCP **可以创建分组**，但**不暴露分组排序**（Q10） |

---

## 1. 设计目标与约束

### 1.1 目标

1. **权限可证明**：每个写操作的允许者由一份集中策略决定，服务端逐接口校验，不依赖前端门控。
2. **契约优先**：接口 schema 是唯一事实来源，同时驱动 HTTP 校验、MCP 工具定义与前端类型。
3. **产物可撤回**：蓝图产物不再匿名可读；撤权、归档、停用后立即不可访问。
4. **可运维**：单机一键部署、迁移可重复执行、初始化幂等、日志结构化。
5. **可演进**：先满足单机生产版，再按 deployment-rules §16 扩展 worker / Redis / MinIO。

### 1.2 硬约束（来自既有文档）

| 约束 | 来源 |
| --- | --- |
| 前端使用 Vue 3 + Vite + PrimeVue v4 Styled Mode + Pinia + Vue Router + TypeScript | `docs/frontend-rules.md` §1 |
| 网关统一入口：`/` web、`/api` api、`/preview` 产物、`/health` | `docs/deployment-rules.md` §3.1 |
| 前端 API 使用相对路径 `/api`，不写死域名；预览地址由后端返回，前端不拼接 | §3.2、§11、§14 |
| 所有配置来自环境变量，不硬编码 | §3.3、§14 |
| 结构化数据存 PostgreSQL；schema 变更走迁移脚本 | §3.4、§14 |
| 持久化文件写入挂载目录 `/data/youzhao/*` | §4、§14 |
| 结构化列表用 DataTable（dataKey、>20 行分页、远程 lazy、行操作末列） | `docs/frontend-rules.md` §4.2 |
| 所有异步动作有状态反馈；高风险二次确认 | §8、§5.3 |

### 1.3 现状与目标的差距（为什么不能增量修）

当前实现是一个"单文件 JSON 快照 + 手写路由"的原型后端（`server/index.mjs` 1458 行，`node:http` + `node:sqlite` 单表 `app_state` 存整份 JSON），前端是单开 `src/state.ts`（659 行）+ PrimeVue。权限判断散落在各 handler，产物匿名可读，会话无 TTL。逐条修补会继续把权限逻辑留在路由层，因此本次按"重新开发"处理：保留数据与产物格式约定，重建分层。

---

## 2. 总体架构

### 2.1 服务拓扑

```text
浏览器 / Agent(MCP 客户端)
        │
        ▼
Gateway (Caddy / Nginx)
  ├─ /                     → web        前端静态资源（SPA）
  ├─ /api/*                → api        业务接口 + 会话
  ├─ /mcp/*                → api        MCP Streamable HTTP 入口
  ├─ /preview/*            → api        预览产物（鉴权后回源，不再由网关直出目录）
  └─ /health               → api        健康检查
        │
        ▼
api 进程
  ├─ HTTP 层（Fastify）
  ├─ MCP 会话层（Streamable HTTP）
  ├─ 应用服务层（用例）
  ├─ 领域层（策略引擎、蓝图/版本/分组/用户/Toke…）
  └─ 数据访问层（Kysely + pg）
        │
        ├─ PostgreSQL        结构化数据
        └─ previews/         产物卷 /data/youzhao/previews/{blueprintId}/{version}/
```

**与 deployment-rules 的差异**：`/preview/*` 的转发目标由"网关直出挂载目录"改为"api 鉴权后回源"（§9 给出修订条款）。理由是权限设计要求产物请求必须鉴权，网关静态服务无法做按用户判断。

### 2.2 分层与职责

| 层 | 职责 | 不得做的事 |
| --- | --- | --- |
| HTTP/传输层 | 路由、schema 校验、会话解析、错误信封、限流、安全头 | 不写权限判断，不碰 SQL |
| MCP 会话层 | MCP 协议握手、工具注册、工具入参校验、把调用映射为应用服务调用 | 不反向调用自己的 HTTP 接口 |
| 应用服务层（用例） | 编排事务、调用策略、写审计、幂等 | 不直接访问 HTTP 上下文 |
| 领域层 | 实体不变量、权限策略、范围解析、发布校验 | 不依赖 Fastify/请求对象 |
| 数据访问层 | Kysely 查询、事务、行到实体的映射 | 不含业务规则 |

### 2.3 三条关键请求路径

1. **浏览器读写**：Cookie 会话 → HTTP 层解析 `requestContext` → 应用服务 → `authorize(ctx, action, resource)` → 数据访问 → 审计。
2. **预览产物**：前端持会话换取**预览票据** → iframe 指向 `/preview/p/{blueprintId}/{version}/?t=<ticket>` → api 校验票据（签名 + 过期 + 范围是单个蓝图版本）→ 设预览域受限 Cookie → 后续子资源请求靠该 Cookie 鉴权，逐请求校验路径归属。
3. **MCP 调用**：Agent 带 `Authorization: Bearer yz_mcp_*` → MCP 会话层解析 Token → 得到绑定用户与 scope → 复用与应用服务**完全相同**的策略判断 → 返回结构化结果并写审计。

### 2.4 关键架构决策

| # | 决策 | 理由 | 备选与代价 |
| --- | --- | --- | --- |
| A1 | 数据库用 PostgreSQL（放弃 SQLite JSON 快照） | 权限模型需要多表外键约束、事务、行级并发控制；JSON 快照是当前一系列一致性缺陷的根因；deployment-rules §3.4 已要求 | 继续 node:sqlite：零依赖，但需要自己实现并发与约束，且与部署规则冲突 |
| A2 | HTTP 层用 Fastify，schema 优先 | 路由 JSON Schema 可**同时**作为 MCP 工具 inputSchema 与前端类型来源，直接满足"契约优先"；自带校验、结构化日志、限流、multipart | 继续手写 `node:http`：无依赖，但校验/日志/上传都要自己写一遍 |
| A3 | 会话用**服务端不透明令牌 + DB 行**，不用 JWT | 需要立刻吊销（停用用户、改密、移出管理员）；JWT 需额外 jti 黑名单 | JWT（deployment-rules §5 的 `API_JWT_SECRET`）：无状态但吊销困难 → 需修订该条款 |
| A4 | 产物访问改为**票据 + 受限域 Cookie** | iframe 子资源无法携带 Authorization 头；同源 Cookie 又会让产物共享应用会话（XSS 风险） | 直接同源 Cookie：简单但产物可读会话；纯签名 URL：多文件子资源签名麻烦 |
| A5 | MCP 与 api **同进程、共领域层**（另提供 stdio 入口） | 权限模型只有一份实现；避免"MCP 反向 HTTP 自调用"的权限绕过与延迟 | 独立 MCP 服务 + 内部 API：进程隔离更彻底，但权限会出现第二份实现 |
| A6 | 前端视觉以**原型为取值基线**，通过 PrimeVue preset 落地 | 用户已确认样式以原型为准；PrimeVue Styled Mode 支持自定义 preset，无需引入第二套控件语言 | 自研组件层：样式更自由，但违反 frontend-rules §4.1"必须封装 PrimeVue" |
| A7 | 前端状态用 Pinia（现有 `src/state.ts` 单例改造成 store） | frontend-rules §1 要求 Pinia；会话与权限需要跨路由共享且可测 | 保留单例：与规则冲突 |

---

## 3. 后端框架设计

### 3.1 技术选型

| 项 | 选择 | 版本/说明 |
| --- | --- | --- |
| 运行时 | Node.js（容器内固定 LTS） | 本机 v24.21.0；容器内用 `node:22-slim` 或 24 |
| 语言 | TypeScript（`tsx` 直跑或 `tsc` 类型检查），ESM。**本期锁 6.0.3** | 与前端共享类型；不用 7.x：`typescript-eslint` 8.x 明确拒绝 TS 7，类型检查与 lint 无法并存 |
| HTTP 框架 | Fastify + `@fastify/cookie`、`@fastify/multipart`、`@fastify/rate-limit`、`@fastify/cors`（仅预览域按需） | schema 优先 |
| 数据库 | PostgreSQL 16 + `pg` + Kysely | 迁移为纯 SQL 文件 |
| 密码哈希 | `node:crypto` scrypt（N=2^15, r=8, p=1，32 字节盐） | 零原生依赖；若允许原生依赖可换 argon2id |
| 会话 | 不透明随机令牌（256bit），DB 存哈希 | 见 §3.4 |
| 校验 | JSON Schema（Fastify 内置）+ 出参 schema | 与 MCP 工具 schema 同源 |
| 日志 | `pino`（Fastify 内置）输出 stdout，key=value JSON | 不含密码/令牌/产物正文 |
| 测试 | `node:test` + `supertest` 风格注入（Fastify `inject`） | 权限矩阵做参数化用例 |

#### 3.1.1 M0 落地注记（临时决定与退出点）

| 决定 | 原因 | 退出点 |
| --- | --- | --- |
| 后端以 `link:../packages/contracts` 引用契约包 | pnpm 对 `file:` 依赖是**复制**进虚拟仓库：改契约后不重装看不到变化，且其自身依赖不在上层目录、裸模块名解析不到 | 引入根 pnpm workspace 后改 `workspace:*` |
| 后端只从子路径引入：`@youzhao/contracts/schemas`、`/version` | 全量 `index` 会拉进 `generated/types.ts`（`import type { FromSchema } from 'json-schema-to-ts'`），在上述复制式布局下解析失败 | 同上；根 workspace 落地后可用全量入口 |
| 迁移与健康检查测试用 **PGlite**（真 PostgreSQL 的 WASM 构建），而非容器 | 本机 docker 守护未运行；M0 要求「迁移可重复执行」是可验证的，不该被本机环境阻塞 | 容器化验收（M6）时改为对真实 PostgreSQL 16 跑同一套断言 |
| 根 `package.json` 设 `pnpm.verifyDepsBeforeRun = false` | 根目录在 M5 切流前仍是 npm 管理的旧应用；pnpm 12 默认在 `run` 前校验依赖，会让根脚本 `pnpm verify` 去安装 root 的 vue/vite 并因依赖脚本被拦而失败 | M5 切流、根目录也交给 pnpm 管理后删除 |
| `server/pnpm-workspace.yaml` 仅声明 `allowBuilds: esbuild: true` | pnpm 12 默认拦下所有依赖安装脚本，`tsx` 依赖的 esbuild 必须放行（由 `pnpm approve-builds` 生成） | 根 workspace 落地后并入统一配置 |
| 上传路径**保留自研** `multipart/form-data` 解析器（`server/http/routes/blueprints.ts`），**不启用** `@fastify/multipart` | ① 引入它的动机（缺注册）已由边界测试消解；② 真正的安全校验一直在 `server/storage/zip.ts`（拒绝 `..`/绝对路径/符号链接/超限/危险扩展名），解析器只负责拆分字段与文件 | **已收口（M2）**：边界由路由级测试证明——`test/blueprint-routes.test.ts` 场景 8b（缺 zip → 400）、8c（无根级 index.html → 400）、8d（`..`/绝对路径 → 400）、13a（损坏分段/非法 tags → 400，不再回落 500）、13b（文件字节内含 `--boundary` 不产生伪分段）、14（超限 → 413 PAYLOAD_TOO_LARGE）。**仅当**这些用例被删或失败时才重新评估换成 `@fastify/multipart` |
| 服务端支持 `DB_DRIVER=pglite`（默认 `postgres`） | M4 前端集成验收需要真 api，而本地无 Postgres、容器守护未运行；PGlite 已在迁移/路由测试中验证同一套 SQL 与 Kysely 适配器 | **生产被硬拒**（`config.ts`：`pglite` + `APP_ENV=production` 直接启动失败）；容器化验收（M6）与 M5 部署仍跑真实 PostgreSQL 16，本地开发若也装 Postgres 把该值留空/设回 `postgres` 即回到生产同构 |
| 测试套件串行执行（`--test-concurrency=1`） | 每个测试文件各自启动一个 PGlite（WASM PostgreSQL）实例，并行调度下资源争抢会产生 17 个**假失败**（串行 121/121 全绿，并行 104/121） | 改为共享测试库或容器化 PostgreSQL 后可放开并发 |

### 3.2 目录与模块

```text
server/
├─ main.ts                    # 组装：配置、DB、Fastify、MCP、优雅退出
├─ config.ts                  # 环境变量读取与校验（缺必填项直接启动失败）
├─ db/
│  ├─ migrations/             # 0001_init.sql …（可重复执行）
│  ├─ migrate.ts              # 迁移执行器（记录 schema_migrations）
│  └─ types.ts                # Kysely 表类型
├─ http/
│  ├─ plugins/                # session、requestContext、errors、securityHeaders、audit
│  └─ routes/                 # me.ts users.ts admins.ts owner.ts groups.ts
│                             # blueprints.ts versions.ts tokens.ts preview.ts embed.ts health.ts
├─ mcp/
│  ├─ session.ts              # MCP 握手与会话
│  ├─ tools.ts                # 工具注册表（schema 复用 http/routes 的 schema）
│  ├─ stdio.ts                # 本地 Agent 的 stdio 入口（新行分隔 JSON-RPC）
│  └─ auth.ts                 # MCP Token → 绑定用户 + scope
├─ app/                       # 应用服务层（用例）：usecases/*.ts
├─ domain/
│  ├─ entities.ts             # User/Group/Blueprint/Version/Token 实体与不变量
│  ├─ policy.ts               # authorize() 单一策略入口 + 不变量实现
│  ├─ scopes.ts               # 范围解析（managed/delegable/capability）
│  └─ errors.ts               # 领域错误 → 错误码映射
├─ storage/
│  ├─ artifacts.ts            # 产物读写（路径安全、清单、清理）
│  └─ zip.ts                  # 压缩包解包与校验
└─ audit/audit.ts             # 审计写入
```

MCP 与 HTTP 共享 `app/`、`domain/`、`storage/`，**不共享** HTTP 上下文对象。

### 3.3 数据模型

替代当前的"单表 `app_state` 存整份 JSON"。表清单（列为主线，完整 DDL 在迁移脚本）：

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `users` | `id, username UNIQUE, display_name, email, phone, status(active/disabled), password_hash, must_change_password, created_by_user_id, created_at, updated_at` | 用户主体；**归属不在此表**（见 `user_managers`） |
| `user_managers` | `user_id → users.id, manager_user_id → users.id, created_at`，主键 `(user_id, manager_user_id)` | 归属关系**多对多**（S7）：一个用户可被多位用户管理员管理；无行 = 暂未指派。只有所有者可增删行（改派 = 整体替换集合） |
| `user_identity` | `user_id PK → users.id, identity(owner/user_admin/member), granted_by, granted_at` | 互斥身份单行表；`owner` 全库唯一（部分唯一索引） |
| `view_grants` | `id, user_id, target_type(group/blueprint), target_id, granted_by, created_at`，唯一键 `(user_id,target_type,target_id)` | 蓝图查看范围；**同时是用户管理员的可委派范围**（S1） |
| `capabilities` | `id, user_id, capability(blueprint.manage/blueprint.publish), target_type(group/blueprint), target_id, granted_by, created_at`，唯一键 `(user_id,capability,target_type,target_id)` | **例外**业务能力，必须带资源范围（常规写权来自管辖，见下两行） |
| `group_managers` | `group_id → blueprint_groups.id, user_id → users.id, granted_by, created_at`，主键 `(group_id,user_id)` | 分组管辖（地盘，迁移 `0006_jurisdiction.sql`）：派生该组上的 `blueprint.publish` + `blueprint.manage` 与可见；只对 `user_admin` 生效，仅所有者可写 |
| `blueprint_managers` | `blueprint_id → blueprints.id, user_id → users.id, granted_by, created_at`，主键 `(blueprint_id,user_id)` | 单蓝图管辖：只派生该蓝图的 `blueprint.manage` + 可见，**不**派生「在该分组内新建」 |
| `mcp_tokens` | `id, name, token_hash, token_prefix, bound_user_id, created_by_user_id, scopes TEXT[], status(active/disabled), expires_at NULL, last_used_at, created_at` | 明文只在创建响应中出现一次；绑定用户由创建者指定（O 可为他人创建，S6） |
| `sessions` | `id, token_hash, user_id, created_at, expires_at, revoked_at NULL, last_seen_at, user_agent, ip` | 支持立刻吊销 |
| `blueprint_groups` | `id, name UNIQUE, is_default, sort_order, created_at, archived_at NULL` | 默认分组不可归档、恒首位；归档非默认分组时其下蓝图回落默认分组（同事务） |
| `blueprints` | `id, name, summary, tags TEXT[], group_id → blueprint_groups.id, status(active/archived), created_by_user_id, created_at, updated_at` | |
| `blueprint_versions` | `id, blueprint_id, version, is_latest, status(available/missing), entry_path, artifact_path, publish_source(mcp/web/web-cover), publish_note, deployed_at, artifact_hash, artifact_bytes` | `version` 与 `blueprint_id` 唯一 |
| `preview_tickets` | `id, ticket_hash, blueprint_id, version, issued_to_user_id, expires_at, used_at, purpose(preview/embed)` | 一次性/短 TTL |
| `audit_logs` | `id, at, actor_type(user/token/system), actor_id, request_id, action, target_type, target_id, result, error_code, detail JSONB, ip, duration_ms` | 对齐 PRD §10.10 字段 |
| `schema_migrations` | `version PK, applied_at` | 迁移可重复执行 |

关系要点：

- 一个用户最多一个身份（`user_identity` 单行）；`owner` 全库恰好一个（部分唯一索引 + 应用层 `LAST_OWNER_PROTECTED`）。
- 归属（`user_managers`，**多对多**）与身份（`user_identity`）**分开**：被指派给一位或多位用户管理员的用户，其身份通常是 `member`；任一归属管理员都能管理它，但只有所有者能改派或删除（S2、S7）。
- 业务能力（`capabilities`）与身份**正交**：用户管理员也可以被叠加 `blueprint.manage`（S4）。
- 管辖（`group_managers` / `blueprint_managers`）与例外授权**分表**：管辖由所有者「划地盘」，只在 `user_admin` 上生效并派生写权；`capabilities` 只做加法。有效能力 = 两者并集（`docs/permission-design.md` §2.3）。
- 查看范围（`view_grants`）与可委派范围是**同一集合**（S1）：**不设** `admin_delegations` 表，用户管理员的可委派范围 = 他在 `view_grants` 中的有效查看范围；他只能在这个集合内为自己管理的用户授予查看权。

**范围解析**（`domain/scopes.ts` 唯一实现）：

```text
effectiveViewScope(user)      = view_grants(user)                  // 分组 ∪ 蓝图
delegableScope(userAdmin)     = view_grants(userAdmin)            // = 其查看范围（S1）
jurisdiction(userAdmin)       = group_managers(user) ∪ blueprint_managers(user)
effectiveCapabilities(user)   = capabilities(user)                 // 例外授权
                              ∪ derive(jurisdiction(user))         // 分组⇒publish+manage；单蓝图⇒manage
                              // 并集去重，管辖不被能力表削减；owner 由 policy 短路隐式全权
canView(user, blueprint)      = blueprint ∈ effectiveViewScope(user)
                               ∨ blueprint ∈ businessCapabilityResources(user)
```

### 3.4 凭证与会话

三类凭证，互不复用：

| 凭证 | 使用者 | 载体 | 存储 | 生命周期 |
| --- | --- | --- | --- | --- |
| 浏览器会话 | 工作台用户 | `Authorization: session`（HTTP-only Cookie，`SameSite=Lax`，生产 `Secure`） | `sessions.token_hash` | TTL（默认 12h，可在 .env 配置）+ 可立刻吊销 |
| MCP Token | Agent | `Authorization: Bearer yz_mcp_<...>` | `mcp_tokens.token_hash`（只用哈希） | 可选过期；停用即失效 |
| 预览票据 | iframe / 嵌入页面 | 短时票据 → 预览域受限 Cookie | `preview_tickets.ticket_hash` | 默认 60s 换取，换取后 Cookie 30min 且绑定单个蓝图版本 |

规则：

1. 登录成功后 `sessions` 落一行，返回 Cookie；**不把会话令牌放进 localStorage**（与现状 `src/api.ts` 的 localStorage bearer 相对）。
2. 会话校验：查 `sessions` → 校验未过期未吊销 → 载入用户 → 组装 `requestContext`（身份、能力、范围）。用户被停用、改密、移出管理员时，**同时吊销该用户全部会话**。
3. 所有状态变更请求校验 `Origin`/`Referer` 允许列表；Cookie 为 `SameSite=Lax`。
4. 初始化：不再暴露"用户表为空即开放"的 `/api/setup/admin`。改为从环境变量注入初始所有者（deployment-rules §5 的 `ADMIN_USERNAME`/`ADMIN_PASSWORD`），首次登录强制改密（`must_change_password`）。
5. 登录失败按用户名 + IP 双维度限流（`@fastify/rate-limit`），失败响应不区分"用户不存在/密码错误"。
6. 密码策略：scrypt 哈希；新建用户使用一次性初始密码并要求首登修改；禁止默认密码 `123456` 出现在初始化路径。

### 3.5 授权引擎（唯一策略入口）

`domain/policy.ts` 暴露唯一函数：

```ts
authorize(ctx: RequestContext, action: Action, resource: Resource): Decision
// Decision = { allow: true } | { allow: false, code: ErrorCode, reason: string }
```

`ctx` 由会话/Token 解析产出，包含：`identity`、`userId`、`managedUserIds`、`viewScope`、`delegableScope`、`capabilities[]`（**有效能力** = 管辖派生 ∪ 例外授权）、`jurisdiction`（仅展示/审计用）、`tokenScopes`（MCP 时）。

动作分类与判定要点：

| 动作 | 判定 |
| --- | --- |
| `user.create` | 所有者（可指定归属与身份）或用户管理员（只能创建 `member`，自动归自己） |
| `user.update` / `user.resetPassword` | 所有者：任意非所有者；用户管理员：仅 `managed_by = 自己` 的 `member` |
| `user.disable` / `user.delete` | 所有者：任意非所有者；用户管理员：仅自己名下 `member`（是否允许删除见 §10 待决 Q2） |
| `user.setRole` / `user.assignOwner` | 仅所有者；目标不得为自己；不得移除最后一个所有者 |
| `admin.manage`（指派用户管理员的委派范围） | 仅所有者 |
| `grant.view.add` / `grant.view.remove` | 所有者；或用户管理员且**目标用户在自己名下**且**授权资源 ⊆ 自己的可委派范围**（S1） |
| `capability.grant`（`blueprint.manage` / `blueprint.publish`） | 仅所有者（用户管理员不得授予业务能力；其自身能力由所有者叠加） |
| `jurisdiction.read` / `jurisdiction.set`（管辖） | 仅所有者；`set` 的目标必须是 `user_admin`（所有者隐式全权、普通用户走例外授权），整体替换两张管辖表（`docs/permission-design.md` §2.3） |
| `group.create` | 任一被授权资源上的 `blueprint.manage`（新分组自动落在其范围内，或由所有者显式授权） |
| `group.delete` / `group.reorder` | 该分组上的 `blueprint.manage`；删除需同时校验分组内全部蓝图的 `blueprint.manage` |
| `blueprint.create` | 目标分组上的 `blueprint.publish` |
| `blueprint.update`（名称/概述/标签/归档/移动分组） | 该蓝图上的 `blueprint.manage`；移动分组需**源 + 目标**两处 `blueprint.manage` |
| `version.publish` | 该蓝图上的 `blueprint.publish` |
| `version.cover`（同版本号覆盖产物） | 该蓝图上的 `blueprint.manage` |
| `version.delete` | 该蓝图上的 `blueprint.manage`，且不得删除最后一个版本 |
| `blueprint.delete` | 该蓝图上的 `blueprint.manage` |
| `token.list` | 所有者（全部）；其他（仅自己创建的，S2） |
| `token.create` | 所有者可为任意用户创建（S2）；普通用户可自建**只读** Token；创建者必须对被绑定用户有管理权或为本人 |
| `token.disable` / `token.delete` | Token 创建者、被绑定用户本人、所有者 |
| `mcp.call(read:*)` | Token 未停用未过期 ∧ scope 命中 ∧ 绑定用户对目标资源可见 |
| `mcp.call(publish:*)` | 同上 ∧ 绑定用户对目标资源有 `blueprint.publish` |

**两条落地约定**（实现期确认，补记于此）：

- **所有者隐式拥有全部业务能力**：身份 `owner` 视为在所有资源上持有 `blueprint.manage` 与 `blueprint.publish`，无需也不应给自己写入 `capabilities` 行（否则平台无法自举，且会与「身份与能力正交」在语义上打架：正交描述的是*可被叠加*，不是*必须显式授予*）。
- **命名空间拒绝与同级拒绝用不同错误码**：`member` 访问 `/api/users/*`、`/api/admins/*`、`/api/owner/*` 一律 `FORBIDDEN`；用户管理员触碰同级/上级用 `PEER_MANAGE_DENIED`；碰自己名外的用户用 `OUT_OF_MANAGED_SCOPE`；触碰所有者用 `OWNER_PROTECTED`；碰自己（经用户管理接口）用 `SELF_MANAGE_DENIED`。这几个码必须各归其位，否则前端无法区分「你没资格用这个页面」和「这个用户不归你管」。

**十二条服务端不变量**（`docs/permission-design.md` §4）在实现中的落点：

| 不变量 | 落点 |
| --- | --- |
| 1 身份互斥 | `user_identity` 单行 + 唯一约束 |
| 2 所有者唯一且受保护 | 部分唯一索引 + `setRole` 判定 + `LAST_OWNER_PROTECTED` |
| 3 同级不可互管 | `authorize` 中"目标必须是自己的被管理者"分支（`PEER_MANAGE_DENIED`） |
| 4 不得超过委派范围 | `grant.view.*` 的 `⊆ delegableScope` 检查（`OUT_OF_MANAGED_SCOPE`） |
| 5 不得自我提权 | 所有 `grant/capability/identity` 动作拒绝 `target === ctx.userId` |
| 6 能力必须带范围 | `capabilities` 表 NOT NULL 约束 + 判定时按资源匹配 |
| 7 只增不覆盖式授权 | 授权接口只接受 `add`/`remove` 增量，服务端不替换整份范围 |
| 8 资源移动视为授权变更 | 分组变更需源 + 目标双权限；分组**归档**时同事务处理其授权与蓝图归属（回落默认分组） |
| 9 令牌不越过绑定用户 | `mcp.call` 双重判定：token scope ∩ 绑定用户权限 |
| 10 命名空间隔离 | 路由层：`/api/users/*`、`/api/admins/*`、`/api/owner/*` 对 `member` 整体拒绝；本人能力只在 `/api/me/*` |
| 11 归档而非删除 | 所有"删除"接口只写 `archived_at`（分组/蓝图/版本），产物与授权记录保留；恢复接口回写 `NULL`；物理清理不暴露为业务接口 |
| 12 多归属并集语义 | `user_managers` 多行时任一管理员可编辑/停用/重置/在自身范围内授权；删除与改派仅所有者（`PEER_MANAGE_DENIED`） |

**错误契约**：统一信封（§6.2），权限相关错误码使用 `docs/permission-design.md` §6.5 定义（`OWNER_PROTECTED`、`PEER_MANAGE_DENIED`、`OUT_OF_MANAGED_SCOPE`、`DELEGATION_EXCEEDED`、`LAST_OWNER_PROTECTED`、`STALE_PERMISSION_STATE` 等），领域错误到 HTTP 状态码的映射只在 `domain/errors.ts` 一处完成。

### 3.6 蓝图与产物

**目录约定**（保持与 deployment-rules §11 一致）：

```text
/data/youzhao/previews/{blueprintId}/{version}/
├─ index.html        入口（必需）
├─ assets/…          任意子目录与文件
└─ manifest.json     { blueprintId, version, entry, files[], sha256, createdAt }
```

**上传（压缩包）**：

1. `@fastify/multipart` 接收 ZIP，先落临时目录，边读边限制总大小（`PAYLOAD_TOO_LARGE`）。
2. 解包校验：拒绝绝对路径、`..`、符号链接、路径长度超限、条目数超限；必须包含根级 `index.html`，否则 `ARTIFACT_INVALID`。
3. 入口 `index.html` 读取时限制类型与大小；产物**不允许**包含服务端可执行脚本（如 `*.mjs`、`*.cjs`）与 `.env` 类文件。
4. 校验通过后写临时目录 → 计算全量 sha256 → **原子 rename** 到最终版本目录（同分区），失败回滚，不留半成品。
5. 覆盖（`version.cover`）走同一流程：先写临时目录，成功后替换目标目录（旧目录改名保留一份 `.bak`，供回滚），版本号与发布记录不变。

**路径安全**：所有产物读取经 `storage/artifacts.ts::resolveArtifactPath(blueprintId, version, relPath)`，内部 `path.resolve` 后断言结果仍在 `{root}/{blueprintId}/{version}` 前缀内，且 `relPath` 经过 URL 解码**一次**并拒绝空段/`..`/NUL。

**访问控制（关键修订）**：产物不再匿名可读。

- 请求 `/preview/p/{blueprintId}/{version}/{relPath}`。
- 校验：票据/Cookie 有效 ∧ 票据范围覆盖该 `blueprintId`+`version` ∧ 资源当前状态为可预览。归档、撤权、停用、过期一律 `403`。
- 响应头：`Content-Type` 白名单（`text/html`、`text/css`、`application/javascript`、图片、字体、`application/json`、`text/markdown`），`X-Content-Type-Options: nosniff`，`Content-Security-Policy: sandbox allow-scripts allow-popups; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors <工作台域>`。产物一律按 `Content-Disposition: inline` 但不允许被同源父页面读取（预览域与应用域分离，见 §3.7）。

**实现注记（M2 落地时发现，两处与原文不同的必要偏离）**：

1. **CSP 必须显式放行预览域 origin，不能只写内联来源**。上面的 `sandbox` 指令会让文档处于**不透明来源**（opaque origin），此时 `'self'` 匹配不到任何东西；而多文件产物的 `assets/*.css`、`assets/*.js` 是子资源请求，若只放行 `'unsafe-inline'`，样式与脚本会被全部拦掉。故 HTML 产物的策略里把 `<previewOrigin>` 显式加进 `script-src`/`style-src`/`img-src`/`font-src`/`media-src`；非 HTML 产物用 `default-src 'none'` 即可。`frame-ancestors` 取 `CSRF_ORIGIN_ALLOWLIST`（为空则 `'none'`）。
2. **预览 Cookie 在生产必须是 `SameSite=None`**。同一原因：不透明来源文档发起的子资源请求被浏览器判为**跨站**，`SameSite=Lax` 会让 `assets/*` 丢掉 `yz_preview` Cookie 而 403。故 `setPreviewCookie` 取 `sameSite = purpose === 'embed' || secure ? 'none' : 'lax'`、`secure = appEnv === 'production'`。代价：**http 开发环境**下无法用 `None`（浏览器要求 `Secure`），因此多文件产物在本地 http 下子资源可能 403，单文件内联产物不受影响；这条限制已记入 `server/README.md`。

**安全头的分工（实现约束）**：`server/http/plugins/security-headers.ts` 对**除预览域前缀外**的响应统一加 `nosniff`/`referrer-policy`/`X-Frame-Options: DENY`/`default-src 'none'; frame-ancestors 'none'`/`/api/` 前缀 `no-store`；命中 `PREVIEW_PUBLIC_BASE_PATH` 前缀的响应**直接放行**，由产物路由自行给出上面那套。两类响应的内嵌需求相反，全局兜底不得覆盖产物头（M2 曾因此把 iframe CSP 打成 `frame-ancestors 'none'`，预览打不开）。

### 3.7 预览与嵌入（统一票据模型）

现状有两个割裂入口（应用内 iframe 与 embed ticket），统一为**一套票据 + 一个预览域**：

| 环节 | 说明 |
| --- | --- |
| 申请票据 | `POST /api/preview-tickets { blueprintId, version?, purpose }`：需对目标蓝图有查看权（应用内）或持有合法嵌入票据（嵌入场景） |
| 票据属性 | 绑定单个 `blueprintId`（嵌入时 version 可固定）、TTL 默认 60s、一次性使用、`purpose=preview/embed` |
| 换票 | `GET /preview/p/{id}/{version}/?t=<ticket>` → 校验并作废票据 → 下发**预览域**受限 Cookie（30min，HttpOnly，`Path=/preview`，`SameSite=None` 仅嵌入需要） |
| 子资源 | 同目录下 `assets/*` 由预览域 Cookie 鉴权，逐请求校验路径归属 |
| 隔离 | iframe 必须 `sandbox="allow-scripts allow-popups"`（**不给** `allow-same-origin`）；预览域与应用域不同源；产物无法读取应用会话 |
| 嵌入 | 嵌入秘钥从环境变量注入（**删除**硬编码回退值），票据 TTL 与用途区分；嵌入页面只渲染单一蓝图，不出现站内导航 |
| 失败呈现 | 区分"票据过期/无权/版本不存在/产物缺失"，前端按 `docs/frontend-design.md` P3 的四态呈现 |

### 3.8 审计与可观测

- 审计表 `audit_logs`，写入口只有一个 `audit/audit.ts::record(event)`，在应用服务层调用（不是 HTTP 钩子，避免漏记 MCP 调用）。
- 记录字段对齐 PRD §10.10；MCP 调用额外记 `token_id`、`bound_user_id`、`idempotency_key`、产物大小与哈希。
- 敏感处理：不记令牌明文、不记密码、不记产物正文与完整 Markdown。
- 日志：pino JSON 输出 stdout；每请求一个 `request_id`（回传响应头 `x-request-id`）。
- 健康检查：`GET /api/health` 返回 `{ status, time, services: { database } }`（对齐 deployment-rules §12）。
- 启动自检：迁移未完成、数据库不可达、必需环境变量缺失 → 明确报错退出（对齐 §3.3"启动失败必须明确报错"）。

### 3.9 配置规范（统一命名）

现状使用 `YOUZHAO_*`，deployment-rules 使用 `APP_*`/`API_*`/`POSTGRES_*`/`PREVIEW_*`。统一到 deployment-rules 前缀，并在 `config.ts` 做启动校验：

```env
APP_NAME=youzhao
APP_ENV=production
# APP_HOST 已移除（M5 落地时发现）：应用侧没有任何代码读取它。
# 对外地址由 API_PUBLIC_BASE_URL（api 生成预览 URL 用）决定；
# 网关的两个域名由 GATEWAY_APP_HOST / GATEWAY_PREVIEW_HOST 决定（deploy/.env.example）。
APP_TIMEZONE=Asia/Shanghai

API_HOST=0.0.0.0
API_PORT=3000
API_PUBLIC_BASE_URL=https://youzhao.example.com
API_JSON_BODY_LIMIT_BYTES=5242880
SESSION_TTL_SECONDS=43200            # 替代 API_TOKEN_EXPIRES_IN
SESSION_COOKIE_NAME=yz_session
CSRF_ORIGIN_ALLOWLIST=https://youzhao.example.com
RATE_LIMIT_LOGIN_PER_MINUTE=10
RATE_LIMIT_MCP_PER_MINUTE=120        # MCP 调用限流，按 Token 维度（§4.5）

DB_DRIVER=postgres                   # postgres（生产唯一选择）| pglite（仅本地开发/测试）
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=youzhao
POSTGRES_USER=youzhao
POSTGRES_PASSWORD=change_me

ADMIN_USERNAME=admin
ADMIN_PASSWORD=change_me
ADMIN_DISPLAY_NAME=系统管理员

PREVIEW_PUBLIC_BASE_PATH=/preview
PREVIEW_STORAGE_PATH=/data/youzhao/previews
PREVIEW_TICKET_SECRET=change_me       # 预览/嵌入票据签名密钥（必填，无回退值）
PREVIEW_EMBED_SECRET=change_me        # 嵌入换票共享密钥（生产必填且 ≥32；开发/测试留空=未启用嵌入，返回 503）
PREVIEW_TICKET_TTL_SECONDS=60
PREVIEW_DOMAIN=https://preview.youzhao.example.com   # 预览域（与应用域不同源）

MCP_ENABLED=true
MCP_MAX_BODY_BYTES=5242880
MCP_PATH=/mcp                        # 挂载路径；网关把该前缀转发到 api
```

**删除**的旧配置：`YOUZHAO_EMBED_SECRET` 的硬编码回退值（改为必填）、`YOUZHAO_*` 全部旧名。

---

## 4. MCP 服务设计

### 4.1 现状与问题

| 现状 | 问题 |
| --- | --- |
| `server/mcp-server.mjs`（220 行）用 `Content-Length` 分帧读写 stdio | MCP 的 stdio 传输要求**逐行 JSON-RPC**（新行分隔），当前分帧不是规范实现，标准客户端无法对接 |
| 协议版本硬编码 `'2024-11-05'` | 落后三个修订（`2025-06-18`、`2025-11-25`、`2026-07-28`），既无版本协商，也没有 `server/discover` |
| 工具定义（5 个，含各自的 `inputSchema`）写在 shim 里 | 后端 `mcpToolHandlers`（`server/index.mjs:883-888`）另有一份工具名与实现。当前两侧名字一致（同为 5 个），但 schema 与描述在两地维护 → **漂移风险**，且新增工具要改两处 |
| shim 通过 HTTP 回调后端 `/api/mcp/tools/{tool}` | 多一跳；工具元数据与实际校验分离 |
| 只有 stdio 一种传输 | 远程/容器内 Agent 无法接入 |
| 未校验 `Origin`、无请求体上限、无调用限流 | 规范要求 HTTP 传输必须校验 `Origin`（防 DNS rebinding），并对工具调用限流 |

### 4.2 传输与协议（对齐 MCP 规范的两个 era）

官方规范当前分为两个 **era**：

| era | 代表版本 | 连接建立 | 版本 / 能力位置 | 会话 |
| --- | --- | --- | --- | --- |
| 现代 modern | `2026-07-28` | 无握手 | 每个请求的 `_meta.io.modelcontextprotocol/*` | 无 |
| 握手 legacy | `2025-11-25` 及更早 | `initialize` + `notifications/initialized` | 握手时一次 | `Mcp-Session-Id` |

`2026-07-28` 移除了：`initialize`、`ping`、`logging/setLevel`、`resources/subscribe|unsubscribe`、HTTP `GET` 流、`Mcp-Session-Id`、SSE 可恢复（`Last-Event-ID`）；服务端不再主动发 JSON-RPC 请求，改为 **MRTR**（返回 `resultType: "input_required"` + `inputRequests`，客户端带 `inputResponses` 重试）；错误码 `-32002` 退役（改用 `-32602`）。因此"是否无状态"不是本项目的选择，而是现代 era 的规定——**它天然无状态**，与本项目"逐调用判定权限"的需求正好一致。

| 场景 | 传输 | 端点 |
| --- | --- | --- |
| 远端 / 容器内 Agent、Web 端 Agent | **Streamable HTTP**（单端点，仅 POST） | `/mcp` |
| 本机 Agent（Claude Desktop、Codex 等） | **stdio**（新行分隔 JSON-RPC） | `server/mcp/stdio.ts` |

**Streamable HTTP 要点（规范强制）**

- 每个 JSON-RPC 请求（或通知）各自一个 POST；`Accept` 必须同时含 `application/json` 与 `text/event-stream`。
- 必需头：`MCP-Protocol-Version`（**必须**与 body 的 `_meta.io.modelcontextprotocol/protocolVersion` 一致）、`Mcp-Method`（所有请求）、`Mcp-Name`（`tools/call`、`resources/read`、`prompts/get`）；不一致 → `400` + `-32020 HeaderMismatch`。
- 版本不支持 → `400` + `-32022 UnsupportedProtocolVersionError`（`data.supported` 列出服务端支持的版本）；未知方法 → `404` + `-32601`。
- 通知类请求 → `202 Accepted` 空体。
- 响应可以是单个 JSON 对象，也可以是**请求级 SSE 流**（只能承载该请求相关的 `notifications/progress` / `notifications/message`，最终响应终止流）；SSE 响应应带 `X-Accel-Buffering: no`，否则反向代理会缓冲。
- 兼容旧客户端：对端点发 `GET` / `DELETE` → `405 Method Not Allowed`；收到 `Mcp-Session-Id` 或 `Last-Event-ID` → 忽略，不铸造也不回显会话 id。
- **必须校验 `Origin`**（防 DNS rebinding），非法 → `403`；本地部署只绑定 `127.0.0.1`。
- 必须实现 `server/discover`：客户端据此探明服务端 era 与受支持版本；客户端在 HTTP 上则以"先发现代请求、看 `400` 响应体是否现代错误"判别 era。
- 长连接通知走 `subscriptions/listen` 的 SSE 流（本项目本期不使用）。

**stdio 要点**

- 消息**新行分隔、不得含内嵌换行**，每行一条 JSON-RPC（现有 `Content-Length` 分帧必须改掉）。
- stdout 只允许 MCP 消息，日志一律走 stderr；stdin 关闭即优雅退出。
- 校验 `Origin` 不适用；凭证来自环境变量（规范明确 stdio 传输**不应**走 HTTP 的 OAuth 授权规范，与本设计一致）。

**era 策略**（已按官方 SDK v2 核实，见 §4.8）

- 双 era 由**同一个服务端入口**提供，不需要维护两套代码：现代 `2026-07-28` 与握手 `2025-11-25` 都走同一个工厂产出的实例。
  - HTTP：`createMcpHandler(buildServer, { legacy: 'stateless' })` —— 默认姿势即"每个 legacy 请求由一个新建实例处理，无会话"；legacy 的 `GET`（单机 SSE 流）与 `DELETE`（结束会话）返回 `405`。
  - stdio：`serveStdio(buildServer, { legacy: 'serve' })` —— 默认姿势即"首个 legacy 开局把该连接钉在一个 legacy 实例上"。
  - 两个入口都要**显式传入** `legacy` 选项（不依赖默认值），并在测试中固定断言两种 era 都能服务。
- **不使用** `@modelcontextprotocol/server-legacy`：它只是 v1 的 HTTP+SSE 传输与 OAuth 授权服务器帮助器的冻结副本，已标记 deprecated，且**不提供**握手 era 的回退能力。
- 若将来必须支持"sessionful 的 legacy 客户端"，用 `isLegacyRequest` 在自己的路由层分流，前面挂 `legacy: 'reject'` 的现代处理器 —— 不要为此引入 v1 SDK 双跑。
- 不声明 `resources` / `prompts` 能力，只声明 `tools`；**不使用** roots / sampling / logging（三者已在 `2026-07-28` 标记弃用，最早 `2027-07-28` 移除；日志改用 stderr / OpenTelemetry）。

**结果与错误封装**

- 成功：`resultType: "complete"` + `content[]`（人类可读文本）+ `structuredContent`（机器可读，符合工具 `outputSchema`）。
- 工具执行类失败（业务/校验）：`isError: true`，文本给出可自纠的信息，结构化字段带**领域错误码**（`FORBIDDEN`、`SCOPE_DENIED`、`VERSION_CONFLICT` 等）。
- 协议类错误（未知工具、请求结构不合法）：用 JSON-RPC `error`（未知工具 = `-32602`）。
- 请求体上限 `MCP_MAX_BODY_BYTES`（默认 5 MB，对齐 PRD §10.3）；超限 → `413 PAYLOAD_TOO_LARGE`。

### 4.3 服务形态与共用领域层

- MCP 会话层是 api 进程内的模块（`server/mcp/`），与应用服务层、领域层、存储层**同进程共用**（决策 A5）。
- 唯一策略入口仍是 `domain/policy.ts::authorize()`：MCP 调用只是"上下文的来源不同"（Token 绑定用户 + scope），判定逻辑与 HTTP 完全一致。
- 不得重复实现的东西：范围解析、发布/覆盖校验、产物落盘与路径安全、审计写入、错误码映射。MCP 层只负责：协议、参数校验、上下文构造、结果封装。

#### 4.3.1 M3 落地注记（与本文其它处的口径差异，以实现为准）

| 事项 | 落地做法 | 原因 / 退出点 |
| --- | --- | --- |
| 挂载方式 | 官方 `@modelcontextprotocol/fastify` **不采用**（它只导出 `createMcpFastifyApp()`，另起一个 Fastify 实例）；改用 `@modelcontextprotocol/server::createMcpHandler(factory,{legacy:'stateless'})` + `@modelcontextprotocol/node::toNodeHandler`，在既有 app 上 `app.all(MCP_PATH)`、`reply.hijack()` 后交给 Node handler | 平台只有一个 Fastify 实例，中间件/错误码/鉴权上下文都想复用；`/mcp` 也需与 `/api` 同源 |
| 依赖版本 | `@modelcontextprotocol/server` 2.3.1、`@modelcontextprotocol/node` 2.1.1、`zod` 4.6.7 | `@modelcontextprotocol/node` 没有 2.3.x，只有 2.1.1（`fastify` 适配包 2.0.1 未装） |
| 契约同源 | 工具的 `inputSchema`/`outputSchema` 由 `fromJsonSchema(契约 JSON Schema)` 转换，入参与 HTTP 路由同一份 `packages/contracts/schemas/**`；出参 schema 新增 `schemas/mcp/*-output.json`（8 份） | §6.1 契约单一来源 |
| 出参坑 | MCP 的 `structuredContent` 由 SDK **直接按 outputSchema 校验**（HTTP 侧由 fast-json-stringify 序列化），因此：领域层返回的 `Date` 必须自行 `toISOString()`；出参不得多字段/少字段（`additionalProperties:false`） | 回归见 `server/test/mcp-routes.test.ts`「8 个工具全部可调用」；`expiresAt`、`list_blueprints` 的 `page/pageSize/total`、分组的 `blueprintCount` 都由此发现 |
| scope 闸门 | `domain/policy.ts::TOKEN_TOOL_SCOPES` 只映射 5 个**写**动作 → `publish:blueprint`；读动作由 `assertToolScope(ctx,'read:blueprint')` 单独把关（浏览器会话直接放行）。`authorize()` 内部先过 scope 闸门，再交给 `judge()` 判身份/范围/能力 | 读工具没有「动作」可挂，若给读也造动作会让动作表膨胀 |
| 幂等存储 | 新表 `mcp_idempotency(token_id, idempotency_key)`（主键）+ `request_hash` + `response jsonb`（`0004_mcp_idempotency.sql`）；同键不同体 → `VERSION_CONFLICT`；同键仍在处理中 → `VERSION_CONFLICT`（稍后重试）；完成 → 回放首次响应 | 发布/覆盖/删除/建分组四个写工具都接 `idempotencyKey` |
| 审计归属 | `audit_logs` 增 `token_id`（`0005_audit_token.sql`）；MCP 调用的审计仍由用例层的 `audited()` 统一写入，MCP 层不拼 SQL | §4.6 |
| era 行为（实测） | 现代（`2026-07-28`）**没有 `initialize`**（发了得 `-32601`）；每请求必须带 `MCP-Protocol-Version` + `Mcp-Method`（`tools/call` 另需 `Mcp-Name`）+ `params._meta`；缺头 → 400，头体版本不一致 → `-32020`。旧代先 `initialize` 且**不得**带现代头，响应为 SSE | `legacy:'stateless'` 让两条 era 都可用；网关不得改写/剥离 `Mcp-*` |
| stdio 桥 | `server/mcp-server.mjs` 重写为薄桥：换行分隔 JSON-RPC ↔ `POST /mcp`，SSE 解帧，stdout 只写协议、诊断走 stderr；env `YOUZHAO_API_BASE`/`YOUZHAO_MCP_TOKEN`/`YOUZHAO_MCP_PATH`/`YOUZHAO_MCP_TIMEOUT_MS` | 旧的 `references/http-tools.md` 与 `POST /api/mcp/tools/{tool}` 契约已删除；`SKILL.md`、`references/mcp-tools.md`、`scripts/youzhao_mcp_smoke_test.mjs` 已同步（冒烟脚本进 CI） |
| 工具集裁剪 | `tools/list` 按 Token scope 过滤（只读 Token 只见 4 个读工具），顺序固定 | §4.5 |

### 4.4 凭证与鉴权

**Token 形态**：`yz_mcp_<tokenId>_<secret>`；`tokenId` 用于索引，`secret` 只存哈希（`mcp_tokens.token_hash`），明文仅在创建响应中出现一次。

**判定链**（每次工具调用）：

```text
1 解析 Authorization → 查 mcp_tokens → 校验未停用、未过期
2 校验工具要求的 scope ⊆ token.scopes            → 否则 SCOPE_DENIED
3 以"绑定用户"构造 RequestContext（身份/范围/能力）
4 调用 authorize(ctx, action, resource)          → 否则 FORBIDDEN
5 更新 last_used_at，写审计（token_id、bound_user_id、tool、结果、耗时、产物哈希）
```

关键约束（S3）：**Token 的能力 = 绑定用户的能力 ∩ Token scope**，不存在"Token 权限高于绑定用户"的情况。所有者可为他人创建 Token 时，Token 立即按被绑定用户的权限生效；被绑定用户被停用/降权，Token 同步失效。

**与规范授权模型的关系（明确偏离项）**：规范的 HTTP 授权定义为 OAuth 2.1 资源服务器模型（RFC 9728、RFC 8707、Bearer 使用等），并要求 401/403 与 `WWW-Authenticate` 语义。本项目使用**平台自签静态 Token**，不实现 OAuth 授权服务器发现与动态客户端注册——这是有意的简化，需在实现文档中标注为偏离项。但错误语义对齐规范：凭证缺失/无效/过期 → `401`；scope 不足 → `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="<所需 scope>"`（便于将来接入标准客户端）；`Authorization: Bearer` 必须出现在**每个**请求，**禁止**放在 query string。

### 4.5 工具集与权限映射

保留 PRD §10.3 的 5 个工具名称（`youzhao.` 前缀，向后兼容），并按新的能力模型补齐：

| Tool | Token scope | 绑定用户需要的权限 | 状态 |
| --- | --- | --- | --- |
| `youzhao.list_blueprint_groups` | `read:blueprint` | 任一看得见的资源（分组/蓝图） | 保留 |
| `youzhao.list_blueprints` | `read:blueprint` | 查看权（服务端按范围过滤） | 保留 |
| `youzhao.get_blueprint` | `read:blueprint` | 该蓝图查看权 | 保留 |
| `youzhao.get_blueprint_artifact` | `read:blueprint` | 该蓝图查看权 | 保留，**改为**：文本产物（Markdown）内联返回；HTML/多文件产物返回**票据化清单**（`files[]` + 入口票据 URL + sha256），不返回裸路径、不内联大文件 |
| `youzhao.publish_blueprint` | `publish:blueprint` | 目标分组上 `blueprint.publish`（新建）或该蓝图 `blueprint.publish`（发新版） | 保留 |
| `youzhao.cover_blueprint_version` | `publish:blueprint` | 该蓝图 `blueprint.manage` | **新增**（对齐页内"覆盖版本"） |
| `youzhao.delete_blueprint_version` | `publish:blueprint`（或独立 `manage` scope） | 该蓝图 `blueprint.manage` | **新增**（不得删除最后一个版本） |
| `youzhao.list_blueprint_groups` / `youzhao.create_blueprint_group` | — / `publish:blueprint` | `blueprint.manage` 覆盖目标范围 | Q10 已裁决：**允许创建分组**；**不暴露分组排序**（排序只在前端人工操作） |

工具通用约束（沿用 PRD §10.3、§10.9）：

- 入参 schema 与 HTTP 路由 schema **同源**（§6.1），未知字段忽略但不影响权限判断。
- 返回值不含令牌明文、密码哈希、服务端绝对路径、其他用户的授权信息。
- 发布/覆盖必须支持 `idempotencyKey`，重复调用返回同一结果。
- 每个工具提供 `outputSchema`，并按它返回 `structuredContent`；`tools/list` 的返回顺序必须确定（利于客户端缓存与 prompt cache）。
- 规范允许工具集随请求携带的凭证变化：本期用它做**按 Token scope 过滤工具**；资源级权限仍逐调用判定（不把"能列出"误当"能操作"）。
- 规范要求的工具侧安全项：校验全部入参、实施访问控制、**对工具调用限流**、清理输出。
- 错误码沿用 PRD §10.9，并补齐新能力对应的错误码（`LAST_VERSION_PROTECTED`、`ARTIFACT_INVALID` 等）。

### 4.6 审计

对齐 PRD §10.10：调用时间、`request_id`、`token_id`、绑定用户、Tool 名、参数摘要、`idempotencyKey`、操作对象、结果、错误码、客户端标识、IP、耗时、产物大小与哈希。

实现要点：审计写入在应用服务层（与 HTTP 调用共用同一 `audit.record()`），MCP 层不得自行拼 SQL；不记录完整 Token、不解码产物正文。

### 4.7 部署与配置

```env
MCP_ENABLED=true
MCP_MAX_BODY_BYTES=5242880
MCP_PATH=/mcp                 # 网关把 /mcp/* 转发到 api
```

- 网关新增一条转发：`/mcp/* → api`。
- 网关对 `/mcp/*` 的额外要求：不得缓冲 SSE（透传 `X-Accel-Buffering`）、不得改写 `MCP-Protocol-Version` 与 `Mcp-*` 头、按需放宽请求体上限与长连接超时。
- `skills/youzhao-mcp/SKILL.md` 需要同步更新（端点、鉴权方式、工具清单、分帧修正）。
- 本机 stdio 客户端配置：`YOUZHAO_API_BASE` + `YOUZHAO_MCP_TOKEN`（沿用现有环境变量名，语义不变）。

#### 4.7.1 客户端接入引导（远端优先）

真实用户的机器上通常没有仓库、也可能没有 Node，因此**默认引导直连远端**，stdio 薄桥降级为兜底：

| 客户端类型 | 推荐接法 |
|---|---|
| Codex CLI | `export YOUZHAO_MCP_TOKEN=… && codex mcp add youzhao --url <API_PUBLIC_BASE_URL>/mcp --bearer-token-env-var YOUZHAO_MCP_TOKEN` |
| Claude Desktop（stdio-only） | `npx -y mcp-remote <API_PUBLIC_BASE_URL>/mcp --header "Authorization: Bearer <Token 明文>"` |
| 支持自定义 Header 的客户端 | JSON 里写 `{"url": "<…>/mcp", "headers": {"Authorization": "Bearer <Token 明文>"}}` |
| 离线 / 内网（无公网入口） | 仓库自带薄桥 `server/mcp-server.mjs`（`YOUZHAO_API_BASE` + `YOUZHAO_MCP_TOKEN`，必要时 `YOUZHAO_MCP_PATH` / `YOUZHAO_MCP_TIMEOUT_MS`） |

配套两个只服务于「接入引导」的端点（都要求会话，见 `docs/mcp-onboarding-design.md`）：

- `GET /api/mcp/connection-info`：返回 `httpUrl`（由服务端用 `API_PUBLIC_BASE_URL` + `MCP_PATH` 拼出）、`path`、`transport`、认证方式、两个 era 的可用性、工具计数（8 = 4 读 + 4 写）与 scope 列表。`MCP_ENABLED=false` → 503 `MCP_DISABLED`。**前端不得自己拼接入地址。**
- `POST /api/mcp-tokens/verify`：请求体收一次明文 Token（库中只有 `token_hash`，服务端无法反推），随后由服务端环回调用自己的 `/mcp` 跑 `initialize` + `tools/list`（不调 `tools/call`，因此不产生业务审计），3 秒超时；失败语义 401 `TOKEN_INVALID` / 403 `FORBIDDEN` / 503 `MCP_DISABLED`|`SERVICE_UNAVAILABLE`。

### 4.8 规范核实结果

| 待核项 | 结论 |
| --- | --- |
| 最新协议版本与 era | 现代 `2026-07-28`（无握手、无会话、逐请求元数据）；握手最新 `2025-11-25`。必须实现 `server/discover` |
| 标准请求头 | `MCP-Protocol-Version`（且必须与 body `_meta` 一致）、`Mcp-Method`、`Mcp-Name`；不一致 = `400` `-32020` |
| 会话与流 | 现代 era 已移除 `Mcp-Session-Id`、HTTP `GET` 流、`Last-Event-ID`；SSE 只做请求级流 |
| 授权 | 规范为 OAuth 2.1 资源服务器模型（可选）；本项目用自签静态 Token = **明确偏离项**，错误语义按规范对齐 |
| 结构化输出 | `structuredContent` + `outputSchema`；执行错误 `isError: true`；协议错误用 JSON-RPC `error`（未知工具 `-32602`） |
| 官方 SDK | v2 线：`@modelcontextprotocol/server` **2.3.1**（2026-10-05），自述 "v2 of the MCP TypeScript SDK, the stable release line, implementing the 2026-07-28 MCP spec"，取代 v1 的单一包；同批 `client` / `core` / `server-legacy` / `codemod` 亦为 2.3.1，另有 `express` / `fastify` / `hono` / `node` 适配器。v1 线 `@modelcontextprotocol/sdk` 停在 **1.32.1**（仅旧项目沿用） |
| SDK 的 era 支持 | **双 era 已由官方 SDK 一等支持**，具体入口与选项见 §4.2 |
| 实现期残余风险 | 见下方四点清单 |

**已确认（原"实现前仍需确认的唯一一项"的答复）**：`createMcpHandler` / `serveStdio` 就是"同一入口服务两个 era"的官方实现，`legacy` 选项只决定**要不要继续接待 legacy 客户端**，不限制现代 era 的能力。因此既不需要自建 HTTP 传输层，也不需要为了兼容而退化为"仅握手 era 交付"。

**实现期需固化的四点**（非阻塞，进入实现时逐条验收）：

1. **现代 era 不是"默认就上线"**：v2 里手写的 `Server` / `McpServer` 仍按 2025 握手协议说话，必须经上面两个入口获得现代 era —— 这也是要在测试中固定断言 `server/discover` 与现代请求可用的原因。
2. **legacy 是无状态的**：默认姿势没有 `Mcp-Session-Id` 会话、没有独立 `GET` SSE 流与 `DELETE`（均返回 `405`）。若将来必须支持 sessionful 的旧客户端，按 §4.2 的 `isLegacyRequest` 方案自行分流。
3. **运行时与依赖门槛**：v2 要求 **Node ≥ 20**（本机 24.21.0，满足）、**zod ≥ 4.2**（v1 可接受 zod 3.25 或 4；本设计统一用 zod 定义契约，直接锁 zod 4）；包为 Apache-2.0。
4. **TypeScript ≥ 6.0 的注意项**：TS 6 起不再自动引入 `@types/*`，必须显式 `"types": ["node"]`（后端 `server/tsconfig.json` 已配置）。本期后端、契约包与前端统一锁 TS 6.0.3（前端用 `vue-tsc` 3.3.13 做类型检查，见 §5.8）。

---

## 5. 前端框架设计

### 5.1 技术基线

| 项 | 选择 | 依据 |
| --- | --- | --- |
| 框架 / 构建 | Vue 3 + Vite | frontend-rules §1（现状已满足） |
| 语言 | TypeScript（`vue-tsc` 门禁） | §1、§12 |
| UI 库 | PrimeVue v4 Styled Mode + PrimeIcons | §1、§4.1 |
| 主题 | 自定义 preset（由原型 token 生成），禁用默认 Aura 外观 | §5（取值基线改为原型，见 §9） |
| 状态 | Pinia（替代现有 `src/state.ts` 单例） | §1 |
| 路由 | Vue Router（含守卫） | §1 |
| 图表 | ECharts 封装为内部组件（Token 用量/蓝图统计用） | §1 |
| 样式 | PrimeVue design token 优先，业务 CSS 次之，不深层覆盖内部类名 | §1、§5 |

**保留的现状资产**：`src/api.ts`（改为会话 Cookie + 统一错误信封）、`src/types.ts`（迁移到共享契约包）、`src/pages/BlueprintPreviewPage.vue`（改造成预览域容器）、`src/pages/EmbedLaunchPage.vue`（并入票据流程）。

### 5.2 目录结构

```text
src/
├─ app/
│  ├─ main.ts              # 应用装配
│  ├─ router.ts            # 路由表 + 守卫
│  ├─ primevue.ts          # PrimeVue 初始化与 preset
│  └─ layouts/             # AppShell.vue（工作台）、BlankShell.vue（预览/嵌入）
├─ components/
│  ├─ common/              # AppPageHeader AppToolbar AppDataTable AppEmptyState
│  │                       # AppForbidden AppStatusTag AppConfirmDialog AppToastHost
│  ├─ workspace/           # BlueprintCard BlueprintGroupSection VersionSelect
│  │                       # PermissionPanel ViewScopeEditor CapabilityEditor
│  │                       # ManagedUserTable TokenTable TokenCreateDialog
│  └─ preview/             # PreviewFrame（iframe + sandbox + 票据申请）PreviewToolbar
├─ stores/                 # session.ts blueprints.ts users.ts permissions.ts tokens.ts ui.ts
├─ services/               # 按领域拆分的 API 客户端（生成或手写自契约）
├─ pages/                  # BlueprintsPage UsersPage PermissionsPage TokensPage
│                          # AccountPage LoginPage ForbiddenPage PreviewPage PreviewTicketPage
├─ styles/
│  ├─ tokens.css           # 设计令牌（原型取值）
│  └─ base.css             # 排版与容器基础样式
└─ types/                  # 本地类型（共享契约优先）
```

与 frontend-rules §11 的差异：去掉该文档为"原型 DSL 渲染器"预留的 `dsl/`（本平台不再承担 DSL 渲染职责，见 §9 修订）。

### 5.3 主题与设计令牌

**取值来源**：原型（`admin-console.html`）使用的设计体系，即 Open Design 内置的 `openai` 体系（`design-systems/openai/tokens.css`）。本次前端视觉**以原型为最终取值基线**，因此 `docs/frontend-rules.md` §5.2 中 `--app-primary: #2563eb` 等蓝色系取值作废（见 §9）。

**三层令牌**（PrimeVue Styled Mode 的 preset 结构）：

| 层 | 内容 | 例子 |
| --- | --- | --- |
| primitive | 原始取值 | `--bg #ffffff`、`--surface #f5f5f5`、`--fg #0d0d0d`、`--muted #6e6e6e`、`--border #e5e5e5`、`--accent #10a37f`、`--danger #ef4146` |
| semantic（映射到 PrimeVue） | `primary` / `surface` / `content` / `border` / `formField` / `focusRing` / `overlay` | `primary.color = {accent}`、`content.background = {bg}`、`content.border.color = {border}` |
| component | 仅在有明确需要时覆盖单组件 | 按钮圆角、表格行高、Tag 配色 |

原型取值（`admin-console.html` 的 `:root`，直接照抄进 `src/styles/tokens.css` 并映射到 preset）：

| 令牌角色 | 原型变量与取值 | 用途 |
| --- | --- | --- |
| 页面背景 | `--bg #ffffff` | 工作区底色 |
| 表面 / 次级表面 | `--surface #f5f5f5`、`--surface-warm #fafafa` | 卡片、表格斑马、次级容器 |
| 主文本 / 次文本 | `--fg #0d0d0d`、`--fg-2 #1a1a1a` | 标题、正文 |
| 次级 / 元信息文本 | `--muted #6e6e6e`、`--meta #6e6e6e` | 说明、表格次要列 |
| 分隔线 / 弱分隔线 | `--border #e5e5e5`、`--border-soft #ededed` | 表格、卡片、区段 |
| 品牌强调（唯一彩色） | `--accent #10a37f`（hover `#0a7a5e`，active `color-mix(accent, black 14%)`，`--accent-on #ffffff`） | 主操作、链接、选中态 |
| 语义状态 | `--success #10a37f`、`--warn #6e6e6e`，`--danger` **改用受限危险色**（Q9 已裁决） | 原型把危险/警示做成中性色；已裁决为破坏性动作与校验错误**新增一个受限危险色语义令牌**，只用于错误文案、危险按钮与危险确认弹窗，不改动其它设计语言；该 token 需在 preset 中登记，仍禁止页面内裸 hex |
| 焦点环 | `--focus-ring 0 0 0 3px rgba(16,163,127,.2)` | 键盘焦点 |
| 字体 | 显示 `Signifier → Source Serif Pro/Georgia`；正文 `Söhne → Inter/system-ui`；等宽 `Söhne Mono` | 按设计体系**原样使用**（含商业字体，已确认）；**不引入新字体文件**；回退链仅用于缺字体环境 |
| 字号 | `12 / 13 / 16 / 18 / 20 / 28 / 40 / 56`；正文 16px、行高 1.65；标题 tracking `-0.02em` | `h1 clamp(28px,3vw,36px)`、`h2 21px`、`h3 16px` |
| 间距 | `4/8/12/16/20/24/32/48/64`；区块节奏 96/64/48 | — |
| 圆角 | `--radius-sm 12px`（控件）、`--radius-md/lg 16px`（卡片）、`--radius-pill 9999px` | 与 frontend-rules"卡片不超过 8px"冲突，按原型执行（§9） |
| 阴影 | `--elev-flat none`、`--elev-ring 0 0 0 1px var(--border)`、`--elev-raised 0 4px 16px rgba(13,13,13,.06)` | 静态卡片无阴影，弹窗/悬浮层用 raised |
| 动效 | `150ms` / `220ms`，`cubic-bezier(.16,1,.3,1)` | 过渡统一 |
| 容器 | `--container-max 1440px`，gutter 32 / 24 / 20 | 工作台内容宽度 |

**约束**：`--accent` 只用于主操作、链接与焦点；其余一律中性色。禁止在页面内新增裸 hex，禁止绕过 preset 直接改组件内部样式（frontend-rules §5）。深色模式保留 `.app-dark` 类切换，但**本期只交付浅色**（原型仅浅色）。

**已裁决（Q9）**：原型把 `--danger` 定义为近黑色，错误文案（`.field-error`）因此也是黑字。作为工作台，破坏性动作与校验错误缺少颜色警示会削弱可用性，因此**引入一个受限危险色语义令牌**：只服务于错误文案、危险按钮与危险确认弹窗的强调，取值在 preset 中登记一次，页面内不得出现裸 hex，也不得扩散到普通组件。这一改动是在"忠实原型"与"可用性"之间的一次明确取舍，已由用户裁决，不再是待决项。

### 5.4 组件层

原型元素到 PrimeVue 的落地映射（**不新增控件语言**，frontend-rules §4.0）：

| 原型元素 | 落地组件 | 备注 |
| --- | --- | --- |
| 左侧导航 | `PanelMenu`（折叠）+ `AppShell` | 导航项由身份与能力装配（§5.5） |
| 顶栏（身份、账号菜单） | `Toolbar` + `Menu`（`popup`） | 账号入口 = 头像菜单；演示身份切换器删除（S5） |
| 数据表（用户/管理员/能力/Token） | `DataTable` + `Column` + `Paginator` | 强制 `dataKey`、远程 `lazy`、行操作末列；列定义来自常量（修正原型列数错位） |
| 明细弹窗 | `Dialog` + `AppConfirmDialog`（高风险） | 危险动作走 `ConfirmDialog` |
| 输入控件 | `InputText` `Textarea` `Select` `MultiSelect` `Checkbox` `ToggleSwitch` `DatePicker` | 与原型字段一一对应 |
| 反馈 | `Toast` `Message` `InlineMessage` `ProgressSpinner` `Skeleton` | 字段级错误显示在字段附近 |
| 状态标签 | `Tag`（`severity` 映射语义色） | 身份、Token 状态、版本状态 |
| 蓝图卡片 | `BlueprintCard`（平台组件，内部用 `Card` 语义但**不用**默认 Card 样式） | frontend-rules §4.0 明确禁止默认 Card 铺页 |
| 版本选择 | `VersionSelect`（`Select` + 徽标） | 卡片内切换只影响浏览，不写回 |
| 上传 | `FileUpload`（`mode="basic"`、`accept=".zip"`、`customUpload`） | 走自定义 multipart 上传，带进度与校验错误映射 |
| 预览 | `PreviewFrame` | 见 §5.7 |
| 空状态 / 无权限 | `AppEmptyState` / `AppForbidden` | 统一视觉（frontend-rules §5.3） |

**受控扩展**（原型已有、PrimeVue 无直接对应，允许以平台组件实现）：`AppShell` 侧栏折叠态、`BlueprintGroupSection` 分组区头（可折叠 + 排序 + 计数）、`PermissionPanel` 四区段容器、`StickyActions` 底部固定操作条、`TokenRevealPanel`（一次性明文展示）、`ConflictBanner`（状态冲突提示条）。

### 5.5 路由与页面

| 路由 | 页面 | 布局 | 身份可见性 | 需要的服务端能力 |
| --- | --- | --- | --- | --- |
| `/login` | 登录 | Blank | 未登录 | — |
| `/blueprints` | 蓝图展示（P2） | AppShell | 全部 | 查看权；操作区按能力装配 |
| `/blueprints/:id/preview` | 蓝图预览（P3） | Blank | 有查看权 | 查看权 → 预览票据 |
| `/users` | 用户（P4） | AppShell | 所有者、用户管理员 | `user.create` 等 |
| `/permissions` | 权限（P5） | AppShell | 所有者、用户管理员 | 授权动作；区段按身份裁剪 |
| `/tokens` | MCP Token（P6） | AppShell | 全部（数据范围不同） | `token.*` |
| `/account` | 我的账号（P8） | AppShell（无导航入口） | 全部 | `/api/me/*` |
| `/preview/p/:id/:version` | 预览票据页 | Blank（预览域） | 持票据 | 票据校验 |
| `/embed/launch` | 嵌入启动 | Blank | 持嵌入票据 | 票据校验 |
| `/403` | 无权限 | Blank | 全部 | — |

规则（与 `docs/frontend-design.md` §4 一致）：

1. `用户` / `权限` 对普通用户**不渲染入口**，路由守卫拦截，直达 URL 一律 `/403`；服务端逐接口再校验（§6.5）。
2. 页面内部区段按身份裁剪：`权限` 页在所有者视角三个区段（查看范围分配 / 管理员与可委派范围 / 业务能力），用户管理员视角只有第一段且仅含其可委派范围（S1）；**所有者移交区段本期不提供**（Q5 裁决）。
3. 页面标题不显示"被拒绝的资源数量"，避免泄露资源存在性。

### 5.6 状态与权限

| Store | 内容 | 关键约束 |
| --- | --- | --- |
| `session` | 当前用户、身份、`viewScope`、`delegableScope`、`capabilities[]`、`managedUserIds` | 唯一来源是 `GET /api/me`；**任何权限 UI 判断只能读它** |
| `blueprints` | 分组、蓝图卡片、分页游标、选中版本 | 列表一次拿全卡片字段（禁止 N+1 详情补拉）；服务端过滤 |
| `users` | 用户列表（按身份的范围） | 用户管理员的列表由服务端裁剪为"我管理的用户" |
| `permissions` | 某用户的授权草稿、变更集、冲突状态 | 提交前保留草稿；`STALE_PERMISSION_STATE` → 显示冲突条并允许放弃/刷新重放 |
| `tokens` | Token 列表 + 一次性明文 | 明细只展示一次，离开页面即丢弃 |
| `ui` | Toast、对话框、加载态 | — |

**权限判定的前端形态**：

```ts
const can = useCan();
can('blueprint.publish', { blueprintId })   // 装配按钮
can('user.create')                          // 装配页头主操作
```

- `can()` 的实现只读 `session` store 的身份/能力/范围，**不允许**出现 `if (identity === 'xxx')` 的业务分支（原型审核中的主要缺陷来源：以 role 硬编码代替能力判断）。
- 前端判定仅决定**呈现**，不决定**授权**。所有写操作仍可能在服务端被拒；收到 `403`/权限错误码时，前端刷新 `session` 并就地提示，不静默失败。
- 会话失效（401）统一跳转登录并保留返回地址；`/api/me` 在路由切换时若超过 TTL 缓存则重新拉取。

### 5.7 交互规范（含原型缺陷的修正要求）

原型审核（`docs/prototype-interaction-review.md`）确认的缺陷，在实现中以规则固化：

| 原型问题 | 实现规则 |
| --- | --- |
| 按钮靠 `hidden` 属性隐藏，但样式覆盖 DOM 语义（`display:flex` 压过 `[hidden]`）→ 无权限者看到入口 | 不用属性显隐做权限；无权限时**不渲染**节点（`v-if`），并统一用 `AppEmptyState`/`AppForbidden` |
| 表格列头与行单元格数量不一致（Token 表 7 列头 / 6 单元格） | 列定义集中在常量或配置，`DataTable` 用同一份列定义生成表头与行 |
| 身份切换后权限视图残留（页面不重算） | 身份/范围变化一律走 `session` store 的响应式重算；不在页面内缓存权限分支 |
| 路由守卫在刷新后失效（守卫内抛出未定义变量导致中断） | 守卫只做**纯函数**判定并返回目标路由；守卫内禁止访问未初始化状态 |
| 列表逐条补拉详情 | 列表接口一次返回卡片所需字段；超过上限用分页/加载更多，不静默截断 |
| 撤权后仍渲染本地缓存 | 撤权、归档、停用后前端作废相关缓存（`store` 置脏 + 重新拉取），不渲染陈旧数据 |
| 版本选择器写回服务端 | 卡内版本切换只影响当前浏览，不写回、不改变"最新版本"判定 |
| 覆盖版本缺少不可逆提示 | 覆盖确认框必须写明"版本号与发布记录不变、原产物无法恢复" |
| 上传无进度、失败无原因 | 上传显示进度；错误映射为明确文案（缺入口/超限/穿越/冲突） |

通用交互要求（frontend-rules §7、§8 的具体化）：

1. 列表页：`PageHeader + Toolbar + DataTable`；筛选默认单行，复杂筛选进 `Drawer`；行操作末列；>20 行分页（远程 `lazy`）。
2. 表单：字段有 label、必填有校验、错误在字段附近、提交按钮 loading 防重复。
3. 一次性信息（Token 明文、初始密码）：只展示一次，提供复制；关闭后不可再取回。
4. 危险动作：`ConfirmDialog` + 后果清单（如"删除分组将使其下蓝图回落到默认分组，并移除该分组的授权"）。
5. 预览页：四态（票据/无权/版本不存在/产物缺失）各有下一步动作；iframe 一律 `sandbox="allow-scripts allow-popups"`。
6. 无障碍：交互控件可键盘到达；图标按钮带 `aria-label`；`Dialog` 焦点陷阱在可见性判断上使用真实可见性（修正原型用 `[hidden]` 判断的缺陷）。
7. 页面预算：页头 ≤72px、每页最多一个主按钮、管理类次要动作 `outlined`/`text`（frontend-rules §5.3）。

### 5.8 M4 落地注记（实现约束与偏离）

| 落地项 | 说明 | 退出点 |
| --- | --- | --- |
| 前端版本锁定 | `web/package.json`：Vue 3.5.44 / vue-router 4.6.4 / Pinia 3.0.4 / PrimeVue **4.5.5** / `@primeuix/themes` 1.2.5 / primeicons 7.0.0 / ECharts 6.1.0 / Vite 6.4.4 / TS 6.0.3 / vitest 3.2.7 / eslint 10.13.0。**刻意不取 PrimeVue 5 / Vite 8**，避免与 `frontend-rules` 的 PrimeVue v4 + Styled Mode 基线漂移 | M6 之后统一升级并重跑视觉审计 |
| 设计令牌唯一实现处 | `web/src/styles/tokens.css` 是 OpenAI 设计体系在前端的**唯一**色值来源（`--accent #10a37f`、`--fg #0d0d0d`、`--surface #f5f5f5`、`--border #e5e5e5`、`--radius-sm 12px` / `--radius-md 16px`、focus ring `3px rgba(16,163,127,.12)`）；`web/src/app/primevue.ts` 的 PrimeVue preset 只引用变量，不复制色值；eslint `no-restricted-syntax` 禁止业务文件写裸十六进制色值（`src/styles/**`、`src/app/primevue.ts` 豁免） | 需要新色时先加 token |
| 受限危险色 | 设计体系本身是单色（`--danger` 近黑），按用户裁决 m00687 引入 `--danger #ef4146` 与 `--warn #f5a623`，**仅**用于删除/不可逆动作与校验错误；工具型动作（复制、刷新）一律 `outlined`/`text` | 设计体系若给出官方语义色则替换 |
| 前端不是安全边界 | 页面只按 `useSessionStore()` 裁剪**入口**，每个接口由服务端再次校验；页面内不出现 `identity === …` 形式的业务分支（只有 store 暴露的 `isOwner` 等判定） | 不退出 |
| 本地预览域同构 | `web/scripts/dev-preview-origin.mjs`（零依赖 `node:http`，端口 3001，只转发 `/preview`）让本地 iframe 也跨源，否则会**把预览 Cookie 的 `SameSite=None` 行为测成假的**；`PREVIEW_DOMAIN` 必须指向它 | 有真实独立域名后删除 |
| 浏览器级冒烟 | `scripts/smoke-ui.mjs`（零依赖：Node 内置 fetch + CDP WebSocket 驱动本机 Chrome）覆盖登录 → 蓝图页渲染 → 建成员 → 授权 → 建 Token → 账号页 → 退出 → 成员登录（导航裁剪）→ 直连 403 → 设计体系约束审计（无渐变、无横向溢出、字体与强调色绑定体系、每页主按钮唯一）→ **键盘与无障碍**（Tab 遍历可达、焦点环可见、图标按钮有可读名称、对话框焦点陷阱 + Esc 关闭）→ 无控制台报错。`pnpm smoke:ui`；15/15 通过 | 保留（M6 回归复用） |
| P7 从前端移除 | 嵌入票据 = `POST /api/embed/tickets` 返回预览 URL，产物由 api 交付（一次性票据 → 303 → 预览 Cookie），不再需要前端中间页 | 不退出 |
| 前端测试范围 | `web` 的 vitest 覆盖 store / 守卫 / 工具函数 / 接入面板（29 例，5 文件；`happy-dom` + **挂真实 PrimeVue 插件**——用桩组件会让 `trigger` 同时触发组件事件与根元素原生事件，回调计数翻倍）；页面级行为仍由 `smoke:ui` 在真浏览器验证 | 不退出 |
| `:on-retry` / `:on-action` 是死键（已修） | `StateBlock.vue` 的自定义回调必须写 `@retry=` / `@action=`。写成 `:on-retry="load"` 时编译器把它放进 vnode props 的**字面量键** `on-retry`，属性解析会驼峰化成 `onRetry`（看起来「有值」），但 `emit('retry')` 查的是 `vnode.props.onRetry`（驼峰）→ 查不到、事件静默丢弃、按钮变死键。该写法曾出现在 6 处（`CreateTokenDialog.vue`、`McpConnectPanel.vue`、`BlueprintsPage.vue` ×3、`PermissionsPage.vue`、`TokensPage.vue`），只在 error/empty 态渲染，`smoke:ui` 15/15 全绿也没能发现 | 不退出；新增自定义事件组件一律用 `@event` 绑定，`StateBlock.vue` 注释已记录该坑 |
| MCP 接入面板替换旧片段 | `web/src/components/tokens/McpClientSnippet.vue` 删除，改为 `McpConnectPanel.vue` + `client-snippets.ts`；接入地址来自 `GET /api/mcp/connection-info`（前端不拼地址），Token 明文嵌进片段并支持 `POST /api/mcp-tokens/verify` 自检；视觉基准取自 Open Design 项目 `mcp-connect-panel-openai-800b`，落地只用 PrimeVue + `tokens.css`/`base.css` | 不退出 |

---

## 6. 前后端配合模式

### 6.1 契约优先与共享类型

**唯一事实来源**：每个动作一份 JSON Schema，落在 `packages/contracts/schemas/*.json`（入参与出参）。同一份 schema 同时驱动：

| 消费方 | 用法 |
| --- | --- |
| HTTP 路由 | Fastify `schema.body` / `schema.response` 直接引用（请求校验、响应裁剪、文档生成） |
| MCP 工具 | `tools/list` 的 `inputSchema` 直接复用同一份入参 schema（避免工具表与接口表漂移） |
| 前端类型 | `pnpm contracts:gen` 生成 `packages/contracts/generated/*.ts`，前端与服务端共同引用 |
| 数据库写入 | 字段级约束（长度、枚举）与 schema 保持一致，避免两套校验规则 |

配套规则：

1. 新增动作的顺序是"先加 schema → 再加权限矩阵行 → 再写用例 → 最后加界面"。
2. CI 校验生成物与 schema 同步（生成物过期即失败）。
3. `GET /api/health` 返回 `contractVersion`；响应头回传 `x-contract-version`，便于排查版本错位。
4. 前端**不手写**请求/响应类型，只用生成类型；允许在其上做本地视图模型。

### 6.2 统一响应与错误信封

成功：

```json
{ "data": { }, "meta": { "requestId": "..." } }
```

列表：

```json
{ "data": [ ], "meta": { "page": 1, "pageSize": 20, "total": 137, "requestId": "..." } }
```

失败（所有非 2xx）：

```json
{
  "error": {
    "code": "OUT_OF_MANAGED_SCOPE",
    "message": "授权范围超出你的可委派范围",
    "details": { "outOfScope": ["group_invest"] },
    "requestId": "..."
  }
}
```

| HTTP | 典型错误码 |
| --- | --- |
| 400 | `INVALID_ARGUMENT`、`ARTIFACT_INVALID`、`INVALID_ARTIFACT` |
| 401 | `UNAUTHENTICATED`、`SESSION_EXPIRED` |
| 403 | `FORBIDDEN`、`PEER_MANAGE_DENIED`、`OUT_OF_MANAGED_SCOPE`、`DELEGATION_EXCEEDED`、`SCOPE_DENIED`、`OWNER_PROTECTED` |
| 404 | `NOT_FOUND`（未命中任何路由）、`BLUEPRINT_NOT_FOUND`、`VERSION_NOT_FOUND`、`GROUP_NOT_FOUND`、`USER_NOT_FOUND` |
| 409 | `USERNAME_CONFLICT`、`GROUP_CONFLICT`、`VERSION_CONFLICT`、`LAST_OWNER_PROTECTED`、`LAST_VERSION_PROTECTED`、`STALE_PERMISSION_STATE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 500 | `PUBLISH_FAILED`、`INTERNAL_ERROR` |

前端处理规则：`services/http.ts` 统一解析信封，抛出带 `code`/`details`/`requestId` 的 `ApiError`；页面按 `code` 决定呈现（如 `STALE_PERMISSION_STATE` → 冲突条；`VERSION_CONFLICT` → 字段级提示版本号已存在；`PAYLOAD_TOO_LARGE` → 上传区错误），**不允许**用 `message` 文本做分支。

### 6.3 并发与状态一致性

| 机制 | 约定 |
| --- | --- |
| 乐观并发 | 用户、授权、蓝图、版本的读接口返回 `version`（递增整数）或 `etag`；写请求带 `expectedVersion`；不匹配返回 `409 STALE_PERMISSION_STATE`，并在 `details.current` 中带**服务端当前状态**，供前端展示差异 |
| 增量授权 | 授权写入只接受 `{ add: [...], remove: [...] }`；服务端在单事务内应用并返回新的完整范围（避免"整份覆盖"造成他人变更被抹掉） |
| 事务边界 | 跨表一致性动作（删除分组 → 其下蓝图回落默认分组 + 移除该分组授权；换所有者 → 身份与委派同步更新）在同一事务内完成 |
| 产物与数据库一致性 | 顺序：写临时目录 → 校验 → 原子改名 → DB 事务提交版本行；覆盖时旧目录改名为 `.bak` 后再提交，失败回滚。任何阶段失败都不留下 `available` 但不可读的版本 |
| 幂等 | 创建与发布类接口接受 `idempotencyKey`；服务端在 `audit_logs` 或独立幂等表记录，重复请求返回同一结果（MCP 发布同理） |
| 前端草稿 | 权限编辑页保留本地草稿；冲突时给"放弃本地 / 刷新并重放"两个动作，重放前重新拉取当前状态 |

### 6.4 列表查询协议

- 通用查询参数：`page`（默认 1）、`pageSize`（默认 20，上限 100）、`keyword`、`sort`、`order`，以及领域过滤（`groupId`、`status`、`tag`、`identity`、`tokenStatus`）。
- 一律服务端过滤与分页；前端不在本地做全量过滤（避免"列表上限 100 后静默截断"）。
- **列表响应必须包含该列表呈现所需的全部字段**（卡片/行内字段 + 行操作所需的能力标记），不允许逐条补拉详情。
- 列表响应可带 `permissions` 摘要（如 `canMaintain`、`canPublish`），但**仅供参考**；写操作仍以服务端判定为准。
- 预览地址、产物地址、票据地址由服务端生成并返回（`previewUrl` 等），前端不拼接（deployment-rules §11、§14）。

### 6.5 鉴权边界（三层）

| 层 | 必须做 | 禁止做 |
| --- | --- | --- |
| Gateway | TLS、路径转发、按路径限流 | 不做业务鉴权，不直出产物目录 |
| API | 解析凭证 → 组装上下文 → 逐接口 `authorize` → 命名空间隔离 → 审计 | 不信任前端传入的身份/权限字段；不接受"前端已判断"的跳过标记 |
| 前端 | 按 `can()` 装配界面、隐藏无权入口、处理 401/403 | 不把前端判断当授权依据；不缓存过期权限后继续渲染 |

**新接口准入规则**：任何新增接口必须先有权限矩阵行（`docs/permission-design.md` §3–§4）与 schema，否则视为未实现。命名空间规则：`/api/users/*`、`/api/admins/*`、`/api/owner/*` 对 `member` 整体拒绝；本人能力只在 `/api/me/*`。

### 6.6 产物与预览交付

```text
前端：POST /api/preview-tickets { blueprintId, version? }
      ← { data: { url: "https://preview…/p/{id}/{v}/?t=…", expiresInSeconds: 60 } }
前端：<iframe src={url} sandbox="allow-scripts allow-popups" />
预览域：校验票据 → 下发受限 Cookie → 直接服务 index.html 与 assets/*
```

- 前端**不构造** `/preview/...` 路径，只用后端返回值（与 deployment-rules §11/§14 一致）。
- 票据换取失败按原因区分呈现：`TICKET_EXPIRED`（重新申请）、`FORBIDDEN`（无权）、`VERSION_NOT_FOUND`、`ARTIFACT_MISSING`。
- 嵌入（第三方系统）走同一模型，只是票据来源换为共享密钥签发的嵌入会话。

### 6.7 开发与部署配合

| 环境 | 约定 |
| --- | --- |
| 本地开发 | `web` 的 Vite `server.proxy` 代理 `/api` 与 `/mcp` 到 `YOUZHAO_API_TARGET`（默认 `http://127.0.0.1:3000`）；**预览不走代理**，由 `web/scripts/dev-preview-origin.mjs` 在 3001 端口只转发 `/preview`，使本地 iframe 也跨源（与生产的独立预览域名同构）；服务端本机无 Postgres 时用 `DB_DRIVER=pglite`（§3.1.1）；`.env.local` 只放非敏感开关 |
| 冒烟 | `pnpm smoke:e2e`（HTTP 契约 16 步，见 `scripts/smoke-e2e.mjs`）与 `pnpm smoke:ui`（浏览器级 15 步：功能 + 视觉审计 + 键盘与无障碍，见 `scripts/smoke-ui.mjs`）；两者都零三方依赖 |
| 构建 | 前端构建产物与域名无关：不写死 API 域名，全部走相对路径 `/api`；运行时配置只从接口获取 |
| 生产 | 同源部署 `/` + `/api`；预览域独立（域名或端口）；SPA 由网关 `try_files` 回退到 `index.html` |
| 升级 | `deploy/upgrade.sh` 先备份再迁移；迁移可重复执行；回滚依赖备份与产物 `.bak` |
| 健康 | `/api/health` 供网关与人工检查；容器 `HEALTHCHECK` 指向它 |

---

## 7. 安全设计（审计发现 → 架构对策）

| # | 已确认问题（现实现） | 架构对策 | 落点 |
| --- | --- | --- | --- |
| 1 | 产物路由完全匿名，撤权/归档后仍可读 | 票据 + 预览域 Cookie + 逐请求鉴权；归档/撤权/停用一律 403 | §3.6、§3.7 |
| 2 | 产物路径两段 `decodeURIComponent` 后 `path.join` → 编码穿越 | 统一 `resolveArtifactPath`：单次解码 + 规范化后前缀断言 + 拒绝空段/`..`/NUL | §3.6 |
| 3 | 发布 `versionName` 仅长度校验即用于建目录 | 版本号做字符集白名单；目录名由服务端生成（`{id}-{version}`），不复用用户输入做路径段 | §3.6 |
| 4 | 硬编码回退 embed secret | `PREVIEW_TICKET_SECRET` 必填，启动校验失败即退出 | §3.9 |
| 5 | 发布者可控 HTML 同源进 iframe，会话在 localStorage → 存储型 XSS 可窃取高权限会话 | 预览域与应用域不同源；iframe `sandbox` 不含 `allow-same-origin`；产物响应带 CSP；会话改 HTTP-only Cookie | §3.4、§3.6、§3.7 |
| 6 | Token 接口响应携带全量 `adminSnapshot` | 引入 DTO 层：响应只序列化白名单字段；服务端不做"实体直出" | §6.2 |
| 7 | 会话无 TTL、无法吊销 | `sessions` 表 + TTL + 停用/改密/移权即吊销 | §3.4 |
| 8 | 用户表为空即开放 setup；明文口令；默认密码 `123456`；无登录限流 | 初始所有者由环境变量注入；scrypt 哈希；新建用户一次性初始密码 + 强制改密；登录双维度限流 | §3.4 |
| 9 | 前端 `isAuthenticated` 仅凭本地 userId；撤权后仍渲染缓存 | 会话与权限只来自 `GET /api/me`；401 统一处理；撤权后作废缓存 | §5.6、§6.2 |
| 10 | 同级可互撤权限、可重置口令、可移除最后管理员；`manage` 混淆多种动作；删除分组改变可见性 | 策略表（§3.5）+ 十二条不变量 + 增量授权 + 事务化资源移动 | §3.5 |
| 11 | 上传包未校验（新增能力带来的新面） | ZIP 校验：拒绝绝对路径/`..`/符号链接、条目数与总大小上限、必需入口、禁止可执行文件；原子落盘 | §3.6 |
| 12 | 日志与审计可能泄露敏感内容 | 日志脱敏（不记令牌/密码/产物正文）；审计只记哈希与大小 | §3.8 |

补充要求：审计只追加不修改；备份包含数据库 + 产物（deployment-rules §10）；限流覆盖登录、票据申请、发布与上传；所有错误响应不回显服务端绝对路径。

---

## 8. 落地计划

| 阶段 | 交付物 | 验收 |
| --- | --- | --- |
| M0 契约与骨架 | `packages/contracts`（schema + 生成器）、Fastify 骨架、配置校验、迁移器、健康检查、CI（类型 + lint + 生成物同步） | `GET /api/health` 通；迁移可重复执行；缺配置启动即失败 |
| M1 身份与权限底座 | users/identity/grants/capabilities/sessions、`domain/policy.ts`、审计 | 权限矩阵参数化测试全绿；十二条不变量各有失败用例 |
| M2 蓝图与产物 | 分组/蓝图/版本、ZIP 上传与覆盖、多文件产物服务、预览票据与预览域、**归档与恢复** | 未持票据访问产物 403；撤权后立即 403；穿越用例全部拒绝；覆盖可回滚；"删除"一律落为归档且可恢复，产物不被物理删除 |
| M3 MCP 服务 | Streamable HTTP 端点、Token 校验、工具集、审计、stdio 入口 | 规范握手与工具调用通过；MCP 调用的权限结果与 HTTP 完全一致 |
| M4 前端重构 | preset/tokens、AppShell、P2/P3/P4/P5/P6/P8、冲突与一次性信息交互 | 原型交互缺陷逐条复核通过；无 `identity ===` 业务分支；表头与行列一致 |
| M5 部署与数据迁移 | docker compose、install/upgrade/backup/restore、**预览独立域名**、`app_state` JSON → 关系表迁移脚本、产物迁移 | 单机一键部署通过；旧数据迁移后权限结果与迁移前**显式对照**（含已知缺陷的修正说明）；**直接切换到新接口，不保留并行旧接口**（Q7） |
| M6 验收 | 安全回归（§7 全表复测）、性能（列表 1000 条分页）、无障碍与键盘操作 | 全部通过并留档 |

**当前进度**：M0–M6 已完成（M6 除「真实容器化验收」，验收证据见 §8.4）。切流后本机复跑 **`pnpm verify` 全绿**（契约 49 schema + 9 测试、server **247 tests / 247 pass**、web **29 tests**、lint/typecheck 干净），`smoke:e2e` **16/16**、`smoke:ui` **15/15**（浏览器级功能 + 视觉审计 + 键盘与无障碍）；M6 三项验收（§7 安全回归 12 用例、1000 条分页性能 2 用例、无障碍与键盘操作）全部通过并留档于 §8.4。M5 的**数据迁移已落地并实跑**（`pnpm -C server migrate:legacy`，14 个回归用例 + 合成旧快照与**旧应用真跑出的真快照**各一次完整 CLI 实跑，含产物搬运与前后可见范围对照），**部署产物已落地**（`deploy/`：compose / 网关 / 安装升级备份恢复脚本，见 §8.2）。**M6 切流已完成**（见 §8.3）：旧应用已从 `rebuild-v2` 分支删除、根 `package.json` 与 `README.md` 已改写为 v2、根 `node_modules` 已删除（子包各自独立安装，已复验契约/server/web 三门禁在本机仍全绿）。**真实容器化验收已完成（2026-10-23，本机 colima，见 §8.6）**：四容器 healthy、网关 `/health` 200、SPA 200、`smoke:e2e` **16/16**、全栈重启后数据留存、`backup.sh`/`restore.sh` 演练通过；过程中修掉 4 个只在真实容器里暴露的部署产物缺陷（pnpm `--frozen-lockfile` 布尔形式、`.dockerignore` 排除 `deploy`、umask 077 导致 `package.json` 不可读、网关静态 `upstream` 的 DNS 缓存）。**阿里云生产部署与真实旧数据迁移已完成并行验证（2026-10-19，见 §8.5）**：ECS 原生安装（PostgreSQL 16 + Node 24 + systemd `youzhao-api.service`），旧站真实快照迁移后 `users=4 groups=4 blueprints=15 versions=29 grants=27 tokens=4`，真机 `smoke:e2e` **16/16**、`smoke:ui` **15/15**；真库冒烟发现并修复了 2 个「只在本机 PGlite 测不出」的 int8 缺陷（§8.5），生产版配置 `/etc/youzhao/api.env.prod` 已通过 `loadConfig` 校验。**切流已同日完成**（预览域 A 记录 + certbot + 生产 vhost + 公网双冒烟 **16/16** / **15/15**），**旧 v1 站点已退役下线**（实验 vhost 9443/8444 已删、VM103 `youzhao-api.service` 已 `stop`+`disable`、SSH 隧道已停；详见 §8.5）。当前生产库基线：`users=5 groups=4 blueprints=15 versions=29 grants=6 tokens=5 tickets=0`（含授权一致性修正与冒烟残留清理）。

**数据迁移要点**（旧 `app_state` JSON → 关系表，实现见 §8.1）：

- `users` + `credentials` → `users`：旧口令是**明文**，迁移时一次性换成 scrypt（`must_change_password` 一律为 `true`）；旧凭据表里没有口令的用户，迁移时写入**随机不可知口令**并逐条警告「需管理员重置一次」，不写空哈希（空哈希会被当成可登录）。
- `functionPermissions` 中的 `system-settings:manage` → `user_identity = user_admin`（**不**自动升级为 `owner`；`owner` 由 `--owner` 明确指定，缺省时仅当旧库恰好只有一个全局管理员才可推断，否则报错要求显式指定——这正是旧模型 L1 缺陷的暴露点）；`system-settings:view` 与 `demo-preview:view` 没有对应档位，**丢弃并逐条记录**。
- `blueprintPermissions` → `view_grants`；`demo-preview:manage` → 对应资源上的 `capabilities(blueprint.manage)`；**发布能力不自动授予**（旧模型把发布并入 manage），逐人进入 `publishDecisions` 待人工确认授予范围。
- 旧模型「新建分组时把全部 `demo-preview:manage` 用户写入该分组授权」的隐式行为必须**补齐**，否则迁移后管理员的可见范围会凭空缩小；补齐造成的变宽在对照表里标 `widened` 并点名要求复核。
- 旧分组被删除后其下蓝图回落到默认分组（L3）：迁移不沿用这个语义，改为**不携带任何授权的占位分组**「原分组已删除（迁移占位）」（`group_legacy_orphan`），并在报告里要求手动归位——落默认分组会让持有默认分组授权的人凭空多看见这些蓝图。
- 旧 `mcpTokens` → `mcp_tokens`：只迁元数据且一律建为 **停用**占位（`token_hash` 写为永不匹配的占位值），旧 Token 无法复原，需重建；这与 S3 的"Token 绑定被创建人权限"一致。
- 产物目录结构不变（`<root>/<blueprintId>/<version>/`），补写 `manifest.json` 的 `files`/`sha256`；旧库把 README 正文存在**行内 `markdown` 字段**里，迁移时落成产物内的 `README.md`，避免文案丢失；产物缺失只影响该版本（标 `missing`），不中断整次迁移。
- 旧 `auditLogs` **不迁移**（没有可用的时间戳字段，也不含新模型要求的 request_id/actor 语义），审计从新栈启用日重新累计。
- 生产构建不包含演示身份切换器（S5）。

### 8.1 M5 落地注记（迁移实现）

| 决策/实现 | 取舍与理由 |
| --- | --- |
| 三段式：`server/db/legacy/model.ts`（读，含 IO）→ `plan.ts`（**纯函数**映射 + 对照）→ `apply.ts`（落库 + 产物搬运） | 计划器不碰 IO 才能对旧快照做穷举用例；执行层与读取层各自有独立用例（`server/test/legacy-migration.test.ts`，14 例） |
| 迁移工具是**一次性 CLI**（`server/db/migrate-legacy.ts`，`pnpm -C server migrate:legacy`），不是 api 内置接口 | 迁移要在 api 起不来（旧库占端口/数据未就绪）时也能跑；且必须能先 `--dry-run` 只看计划再动手 |
| `--dry-run` 只读旧数据、打印计划与可见范围对照、写 JSON 报告，**不碰目标库** | 迁移前必须能审阅"谁看得见什么"的变化，这是 §8 验收项「迁移前后显式对照」的载体 |
| 目标库非空即拒绝，需显式 `--replace` | 避免把真实数据冲掉；`--replace` 只清业务表（`schema_migrations` 绝不清），且按子表→父表顺序删 |
| 空库判定放宽为「无用户 **且** 无任何非默认分组」，并允许 `--replace` 时接管迁移预置的默认分组 | 迁移 `0002_identity.sql` 本身会 `insert` 一行 `group_default`，若把它当"已有数据"会让全新库也拒绝迁移 |
| 产物来源缺失时，版本**不预置为 `available`** | 先按 `missing` 落库，只有真正写入成功才改 `available`：否则会出现"数据库说产物在、磁盘上没有"的假象 |
| 版本行内 `markdown` → 产物内 `README.md`；`entry_path` 固定 `index.html`；`publish_source` 一律 `web` | 复用 M2 的 `writeArtifactPackage`（先校验后建目录、临时目录 + 原子 rename），旧数据没有等价字段 |
| 所有者在迁移计划里不生成 `view_grants`/`capabilities` 行，也不进 `publishDecisions` | 新模型里 owner 隐式拥有全部业务能力与可见范围（§3.5 不变量）；给他写行只会让"谁能看什么"的报表变脏 |
| `blueprints.created_by_user_id`、`granted_by` 统一记为所有者 | 旧模型不记录创建者；记为所有者可保证用户管理员无法撤销"他人授予"的项 |
| 旧模型没有"管理归属"（`user_managers`） | 迁移后所有用户不归属任何用户管理员，报告里逐条提醒在所有者的「权限」页批量指派——不猜 |
| 报告同时输出人类可读摘要与 JSON（`--report <file>`：`source/ownerUserId/counts/comparison/publishDecisions/warnings/dropped/knownLegacyDefects/applied`） | 迁移要留档、要能在验收时逐项对照 |
| `KNOWN_LEGACY_DEFECTS`（L1–L5）随报告一起打印 | §8 要求"含已知缺陷的修正说明"：把旧模型的 5 个缺陷与新模型的对应约束并列，运维改完能核对 |

### 8.2 M5 落地注记（部署产物）

| 项 | 实现与取舍 |
| --- | --- |
| 编排 | `deploy/compose.yaml`（`name: youzhao`）：`postgres`(postgres:16-alpine) + `api` + `web` + `gateway`(nginx:1.27-alpine)。数据目录挂宿主机 `DATA_ROOT`（默认 `/data/youzhao`：`postgres/`、`previews/`、`backups/`、`logs/`），**重启不丢数据**是 §15 验收项 |
| 镜像 | `deploy/Dockerfile.api`（多阶段；构建期跑 `packages/contracts/scripts/generate.mjs` 保证契约与代码同步；`USER node`；启动 `db/migrate.ts` → `main.ts`，迁移幂等故可重复启动）、`deploy/Dockerfile.web`（Vite 构建 → nginx 服务 SPA 静态） |
| 入口分离（§7） | `deploy/gateway/nginx.conf`：应用域（80）`/`→web、`/api/`→api、`/mcp`→api、**`/preview*` 一律 404**；预览域（8080）只提供 `/preview`→api。产物因此只在**与应用不同源**的域执行，应用域不存在同源旁路 |
| MCP 透传（§4.7） | `/mcp` 关闭响应缓冲（`proxy_buffering off`）、`proxy_read_timeout 3600s`、`Connection` 按 Upgrade 切换；**不写任何 `proxy_set_header Mcp-*/MCP-Protocol-Version`**——nginx 默认透传非逐跳头，写了反而覆盖客户端原值 |
| 运维脚本 | `install.sh`（校验 docker/compose → 生成/校验 `.env`（占位密钥换随机值）→ 建目录并修预览目录属主为容器内 uid 1000 → 查端口占用 → build/up → 等健康 → 打印地址与管理员账号）、`upgrade.sh`（**先备份** → build/up → 等 api 健康 → 重建 gateway 刷新 upstream）、`backup.sh`（`pg_dump` 自定义格式 + 产物 `tar` + `.env` 快照，按 `BACKUP_KEEP` 修剪）、`restore.sh`（二次确认，停 api/web/gateway、`DROP/CREATE` + `pg_restore`、覆盖产物根，`--force` 仅供演示/CI） |
| 三条已记录差异 | ① `APP_HOST` 是文档遗留（无人读取），已从 §3.9 环境块移除，网关域名改用 `GATEWAY_APP_HOST`/`GATEWAY_PREVIEW_HOST`；② 网关用**静态 `upstream`**（换取连接复用）而非 `resolver 127.0.0.11` 动态解析，故 api 容器重建后必须重建 gateway（`upgrade.sh` 已自动做，排障表也有该条）；③ 无证书环境默认明文 80/8080（本机验收用），TLS 启用步骤写在 `gateway/nginx.conf` 文末 |
| 验收边界 | 本机无 docker 守护（`colima` 未运行）与 `nginx`/`hadolint`/`shellcheck` 二进制，故本阶段只做**语法级**验收（`bash -n` 四个脚本、YAML 结构解析、配置文件静态审阅）；**真实容器化验收留给 M6**（§15 的 docker-only 安装、重启不丢数据、备份/恢复演练） |

### 8.3 M6 落地注记（根目录切流）

| 项 | 处置与理由 |
| --- | --- |
| 删除（旧应用） | 旧 `server/index.mjs`（1458 行 node:http 后端）、根 `src/`（Vue 3 工作台）、根 `public/`（含旧种子产物 `preview-artifacts/`）、根 `index.html`、根 `vite.config.ts`、根 `tsconfig.json`、根 `eslint.config.js`、`scripts/update.sh`、根 `package-lock.json`、`tsconfig.tsbuildinfo`、`dist/`。全部用 `git rm` 删除且只发生在 `rebuild-v2` 分支，`main` 仍保留完整旧应用（`git checkout ff69340 -- <path>` 可单文件回退） |
| 保留 | `server/mcp-server.mjs` **是新版 stdio 桥**（M3 重写，非旧物）；`icon/`（无代码引用，作为品牌资源保留）；`.pnpm-store`（子包 `node_modules` 的硬链接源，删除会破坏已装依赖） |
| 依赖与锁 | 根 `package.json` 收窄为纯编排脚本（`contracts:*`/`server:*`/`web:*`/`smoke:*`/`verify`），删除全部旧 `dependencies`/`devDependencies`；根 `node_modules`（380M 旧 Vue/Vite 依赖）删除——子包各自独立安装（`packages/contracts`、`server`、`web` 各有自己的 `node_modules`） |
| `node_modules` 取消跟踪 | 旧仓库曾把 `node_modules` 提交进版本库（HEAD 4843 个条目）；已 `git rm -r --cached node_modules` 并确认 `.gitignore` 覆盖，工作区文件不再进入提交 |
| 迁移期数据 | 删除 `public/preview-artifacts/` 前把旧种子产物备份到 `/tmp/yz-seed-artifacts`，并并入 M5 保真度复核用的真快照——**旧产物在切流后仍可被迁移工具处理**，不因删除旧代码而丢失 |
| Q7（不保留并行旧接口） | 已核对：新版只由 `server/main.ts` 启动，旧 `server/index.mjs` 不被任何新代码引用；不存在两套接口并行暴露的窗口 |
| 切流后验收 | `pnpm verify`（契约 check+test → server lint/typecheck/test → web lint/typecheck/test）、`pnpm smoke:e2e`（HTTP 16 步）、`pnpm smoke:ui`（浏览器 14 步）在本机 PGlite 环境复跑 |

---

## 8.4 M6 验收记录（2026-10-19，本机 PGlite 环境）

| 验收项（§8 的 M6 行） | 证据 | 结果 |
| --- | --- | --- |
| 安全回归：§7 全表复测 | `server/test/security-regression.test.ts`（12 用例）：#1 匿名取产物 403 + 撤权后已签发预览会话立刻失效／#2 编码穿越与非法路径段被拒／#3 版本号字符集白名单（`..` 进不了路径段）／#4 缺 `PREVIEW_TICKET_SECRET` 即启动失败（无硬编码回退，生产要求 ≥32）／#5 预览 Cookie HttpOnly + 产物 CSP 含 `sandbox` 且不含 `allow-same-origin`／#6 响应只序列化白名单字段（无口令哈希、令牌哈希、全量快照；令牌只暴露前缀）／#7 停用用户既有会话立即失效／#8 无 `/api/setup/*` 开放初始化、初始口令 scrypt 落库且首登改密、登录限流／#9 身份与权限只来自 `/api/me`／#10 同级管理员不可互管、所有者账号整体受保护／#12 审计不记敏感内容、错误不回显服务端绝对路径 | 12/12 通过 |
| 性能：列表 1000 条分页 | `server/test/performance.test.ts`（2 用例）。实测（PGlite，WASM 单线程；真 PG 更快）：蓝图 1000 条 首页 28ms / 第 25 页 19ms / 第 50 页 16ms；用户 1003 条 首页 10ms / 第 50 页 6ms | 2/2 通过；深页不劣化 ⇒ 分页在 SQL 层完成，未整表加载 |
| 无障碍与键盘操作 | `pnpm smoke:ui` 第 14 步：Tab 遍历 14 个控件、焦点环可见、图标按钮均有可读名称（`aria-label`/`title`）、对话框打开时焦点进入对话框且 Esc 可关闭（等待入场动画后断言，避免误报） | 通过 |
| 门禁汇总 | `pnpm verify`：契约 49 schema + 9 测试；server **227 tests / 227 pass**（串行）＋ lint/typecheck 干净；web vitest 17/17 ＋ lint/typecheck 干净 | 全绿 |
| 端到端冒烟 | `pnpm smoke:e2e`（HTTP 契约 16 步）、`pnpm smoke:ui`（浏览器 15 步，含视觉审计与键盘无障碍） | 16/16、15/15 |
| 真实容器化验收 | 本机 colima + `deploy/scripts/install.sh -y --dev` 起四容器（postgres/api/web/gateway，`18080->80`、`18081->8080`）：`smoke:e2e` 16/16、全栈重启后数据不变、`backup.sh`/`restore.sh` 演练通过——详见 **§8.6** | 通过（2026-10-23） |

**§8.4 遗留项（下一轮清理，不影响 M6 结论）**

1. **创建接口状态码不统一**：`POST /api/users`、`POST /api/blueprints`、`POST /api/blueprint-groups` 返回 200，`POST /api/mcp-tokens` 返回 201。REST 语义应统一为 201 + `Location`；涉及 3 个路由的响应 schema 键与若干测试断言。
2. **两个定义但未使用的错误码**：`LAST_OWNER_PROTECTED`（所有者账号整体不可被停用/删除，服务端不可达）、`STALE_PERMISSION_STATE`（授权走增量 `add`/`remove`，服务端不产生该码；前端 `PermissionsPage.vue` 已有冲突分支）。保留为契约备用；若下一轮仍无使用点则从契约删除。
3. **根 `node_modules`**（旧应用的 Vue/Vite 依赖）待删除：根 `package.json` 已收窄为编排脚本，子包各自安装；旧仓库曾把它提交进版本库，已 `git rm -r --cached` 取消跟踪。
4. **`@fastify/multipart` 未采用**：保留自研 multipart 解析器，边界由 `server/test/blueprint-routes.test.ts` 场景 8b/8c/8d/13a/13b/14 锁定（§3.1.1 记录了退出条件）。

---

## 8.5 阿里云生产部署与旧数据迁移验收记录（2026-10-19）

首次把 v2 部署到真实生产机（阿里云 ECS，与旧站**并行**运行，旧站未动），并迁移真实旧数据。

**目标机与形态**

| 项目 | 实际值 |
| --- | --- |
| 主机 | 阿里云 ECS `100.116.86.115`（公网 EIP `8.136.181.191`，Ubuntu 24.04、2 vCPU、1.6 GiB 内存） |
| 运行时 | **原生安装**（非容器）：PostgreSQL 16.15 + Node v24.22.0 + pnpm 12.14.0；2 GiB swap + `vm.swappiness=20`；journald 上限 `SystemMaxUse=200M` |
| 代码 | `git clone --branch rebuild-v2 --depth 1` → `/srv/youzhao/app`（系统用户 `youzhao`） |
| 配置 | `/etc/youzhao/api.env`（`root:youzhao` 640）；生产版 `/etc/youzhao/api.env.prod` 已生成并通过 `loadConfig` 校验（`appEnv=production`、`publicBaseUrl=https://youzhao.florai.cn`、`previewDomain=https://preview.youzhao.florai.cn`、`originAllowlist=[https://youzhao.florai.cn]`、`embedSecret` 64 字符） |
| 进程 | `youzhao-api.service`（`User=youzhao`、`Environment=NODE_OPTIONS=--max-old-space-size=384`、`ProtectSystem=strict`、`ReadWritePaths=/srv/youzhao/data`、`Restart=always`） |
| 数据 | `/srv/youzhao/data/previews` + PostgreSQL 库 `youzhao`（迁移 0001–0005） |

**旧数据迁移（真实旧站快照，非合成）**

旧站实际跑在 **VM103 `192.168.1.13`**（ECS 的 `youzhao.florai.cn` vhost 只是 frp 隧道回内网），数据在 `/data/youzhao`（`youzhao.sqlite` 430 080 字节、`pragma integrity_check=ok`、`previews/` 4.1 M）。搬运 `tar` → `scp` → `tar -xzf … -C data`（**归档根是 `youzhao/`**，就地解压会散落）。迁移结果：`users=4 groups=4 blueprints=15 versions=29 grants=27 tokens=4 capabilities=0`，产物 15 个蓝图目录 / 4.1 M（该 27 行中含所有者行，属迁移语义偏差，见下文「授权一致性修正」）。可见范围对照唯一变化：`demo`（member）4 → 8 蓝图**变宽**（旧模型要求函数级 `demo-preview:view` **且** 资源级授权，新模型只看资源级）。未迁移：`functionPermission(admin) demo-preview:manage`（owner 隐式全能力）、119 条旧 `auditLogs`（缺可用时间与 `request_id`）、`publishResultsByKey`。迁移用户口令由旧明文口径改为 scrypt，`must_change_password=true`。

**真库冒烟发现的两个「只在本机 PGlite 测不出」的缺陷（已修）**

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `GET /api/blueprints` → 500，日志 `TypeError: The value of '#/$defs/BlueprintSummary/properties/latestVersion' does not match schema definition.`（fast-json-stringify） | `artifact_bytes` 是 **`bigint`(int8)**，node-postgres 把 int8 返回成**字符串**，而契约是 `integer\|null`；PGlite 返回数字 ⇒ 本机测不出 | `server/db/pool.ts` 新增 `installPgTypeParsers()`（`pg.types.setTypeParser(20, Number)`），两个连接工厂都调用；新增 `server/test/pg-types.test.ts` |
| 2 | MCP `youzhao.publish_blueprint` 出参校验失败：`data/blueprint/latestVersion/artifactBytes must be integer,null` | 同一根因（SDK 对 `structuredContent` 按 `outputSchema` 严格校验，比 HTTP 侧更早暴露） | 同上，一处修复两侧受益 |

**验收结果（真机、真库、真迁移数据）**

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| HTTP 契约端到端（隧道期，历史） | `smoke-e2e.mjs --base http://127.0.0.1:9443 --preview http://127.0.0.1:8444 --origin http://127.0.0.1:9443` | **16/16** |
| 浏览器级功能 + 视觉 + 无障碍（隧道期，历史） | `smoke-ui.mjs --app http://127.0.0.1:9443`（走 SSH 隧道） | **15/15**（11 张蓝图卡片、4 行用户、四段权限页、成员导航裁剪、`/403` 守卫、零控制台报错） |
| 迁移忠实度 | 迁移前后可见范围对照 + 真快照实跑 | 27 条授权、29 个版本、产物可预览；唯一变化为上述 `demo` 变宽（已确认可接受） |

**并行验证的临时入口（已于同日删除，历史记录）**：`/etc/nginx/conf.d/youzhao-v2-test.conf`（9443：静态 `web/dist` + `/api` 反代 + `= /mcp` 关闭缓冲）、`youzhao-v2-preview-test.conf`（8444：只放 `/preview/`）；线上 80/443 vhost 未改。静态资源需 nginx worker（`www-data`）可遍历：`chmod o+x /srv /srv/youzhao /srv/youzhao/app /srv/youzhao/app/web` + `chmod -R a+rX …/web/dist`。两份 vhost 已删除（删除前备份在 ECS `/root/youzhao-backup-20261019144016/nginx/`），`nginx -t` 通过后 `reload` 两次以释放 9443/8444 监听。

**教学点：PGlite 与真 pg 的类型强制不等价**。PGlite（本机测试/开发驱动）把 `bigint` 返回为 JS number，node-postgres 默认返回字符串；凡把数值列序列化进 JSON Schema（`integer`）或 `outputSchema` 的地方，两端行为不同。**门禁（PGlite）全绿不代表真库通过**——真机冒烟是 M6 的必需环节。同类差异还有 `numeric`/`decimal`（默认返回字符串）与 `date` 精度，新增数值列时优先用 `integer`/`bigint` + 显式 `Number()`，或统一在 `pool.ts` 的类型解析器里收敛。

**切流完成（同日）**：① 用户在阿里云加 `preview.youzhao.florai.cn` A 记录 → `8.136.181.191`（223.5.5.5 / 8.8.8.8 / 1.1.1.1 三家一致）；② `certbot --webroot` 为预览域签发证书（`/etc/letsencrypt/live/preview.youzhao.florai.cn`）；③ `api.env.prod` 覆盖 `/etc/youzhao/api.env` 并重启 api（`APP_ENV=production` ⇒ Cookie `Secure`，必须全程 https；`/api/health` 报 `appEnv: "production"`）；④ 生产 vhost 替换旧 vhost（`youzhao.florai.cn` 应用域，`/preview*` 一律 404；`preview.youzhao.florai.cn` 只放 `/preview/`，其余 404）；⑤ 切后在**公网 https** 上重跑两条冒烟：`smoke-e2e` **16/16**、`smoke-ui` **15/15**；⑥ `docs/deployment-rules.md` 记录原生安装形态与 frp 拓扑。
**切流后待办 → 已完成（同日执行）**：① 停用旧机（VM103 `192.168.1.13`）`youzhao-api.service`：`systemctl stop` + `disable`，端口 4174 不再监听，数据 `/data/youzhao`（33 M）原样保留，**unit 文件保留**以便回滚（`systemctl enable --now youzhao-api`）；② 删除并行验证用的临时 vhost（9443/8444）与本机 SSH 隧道；③ 清理生产库中的冒烟残留对象（清回基线，先备份至 ECS `/root/youzhao-backup-20261019144207/`）。

**旧 v1 站点退役记录与验证（2026-10-19）**

退役后在生产上复验：`https://youzhao.florai.cn/` **200**、`/api/health` ok（契约 2.0.0）、无 Token `POST /mcp` **401**、`https://preview.youzhao.florai.cn/` **404**（该域只放 `/preview/`）、**公网 `smoke:e2e` 16/16**。回滚路径：VM103 `systemctl enable --now youzhao-api` + 恢复 vhost 备份（`/root/youzhao-backup-20261019144016/nginx/`）。

**残留（有意保留，待用户显式确认）**：PVE 宿主 `/opt/frp/frpc-service.toml` 第 23 行仍注册着 `youzhao-web` 隧道——它与 `nas.florai.cn`、`hermes.florai.cn` **共用同一个 frpc 进程**（clientID `0711127c9d604a69`），改动会让两个在线站瞬断；且 ECS nginx 已不再把 `youzhao.florai.cn` 转给 `frps:8080`，该隧道已是死隧道、无暴露面。因此**暂不动**，等确认后再清理。另：Codex CLI 已注册 `youzhao` MCP（streamable HTTP + Bearer，`codex mcp add … --bearer-token-env-var`），但 **Agent 侧真实调用未跑**——阻塞于本机 `codex login`（需用户本人登录）。

**客户端缺陷修复：分享蓝图必然报「票据已被使用」（2026-10-20，`689a1da`）**

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 蓝图预览页点「分享」→ 浏览器直接显示 `{"error":{"code":"FORBIDDEN","message":"票据已被使用",…}}` | `BlueprintPreviewPage.vue::openInNewWindow()` 复用 iframe **已兑换过**的 `frameSrc`；预览票据**单次有效**（首次兑换即作废并发 30 分钟预览 Cookie），第二次兑换在 `server/app/preview.ts` 抛 `FORBIDDEN/票据已被使用`。且旧实现用 `window.open('', '_blank', 'noopener,noreferrer')`，`noopener` 使其返回 `null`，白窗永不跳转 | 每次分享**新签**一张票据；同步 `window.open('about:blank', '_blank')`（不带 `noopener` 才拿得到句柄）→ `opener=null` → `location.replace(ticket.url)`；被拦截/失败分别给中文 toast |
| 2 | 预览域的错误以 JSON 呈现给浏览器 | 预览路由只返回 JSON 错误体 | `server/http/routes/preview.ts` 新增 `wantsHtml()`/`escapeHtml()`/`previewErrorCopy()`/`sendPreviewErrorPage()`：浏览器导航（`Accept: text/html`）得到 403/404/500 中文页（`no-store` + CSP），子资源请求仍返回 JSON 信封 |

验收（生产、真库）：同一票据连兑两次 → 第 1 次 **303**、第 2 次 `Accept: text/html` 得 403 中文页（含「这个预览链接已经用过了」）、`Accept: application/json` 仍 JSON；CDP 带 `userGesture` 真实点击两次分享，两次都新开标签页并渲染出产物。门禁：server **247/247**、preview **14/14**、web typecheck/lint 干净、vitest **29/29**。

**已知取舍（未改）**：`PREVIEW_TICKET_TTL_SECONDS=60` 且票据单次有效 ⇒ 分享出去的链接**只在 60 秒内可用**，适合「在新窗口打开」，不适合发给同事；若要真正的「分享给他人」，需另设长时票据或改用「预览域登录态」。**验收经验**：CDP 驱动点击必须带 `userGesture: true`，否则依赖 `window.open` 的 UI 会假失败（`newTargets=0`）。

**复核：同一条报错再被反馈（2026-10-23）——先查 `requestId`，再看服务端进程**

用户再次反馈同一段 `{"error":{"code":"FORBIDDEN","message":"票据已被使用","requestId":"fc790ba8-80b0-4b5c-bf31-a4a79f97ede1"}}`。溯源方式：`journalctl -u youzhao-api | grep <requestId>` 直接命中 **2026-10-20 11:53:35**（pid **1827960**，即修复前那次启动），URL `/preview/p/blueprint_9ad0fef1/v3.2.1/?t=yz_pt_b888…`，栈里只有 `serve`、没有 `serveFriendly` —— 说明这是**修复上线前**的旧请求，修复提交 `689a1da` 为 11:58:49、api 于 **12:03:31** 以新 pid 1837886 重启。**教训：`requestId` 能定性「是不是新问题」，比复现省事得多**；同时说明 60 秒单次票据的**旧报错会被用户长期留存、隔几天再贴回来**，不要一看到就当成回归。

同一现象在生产上的真实剩余发生率：切流后 24 天里「票据已被使用」共 12 次（10-19 八次、10-20 三次、10-22 一次），**2026-10-22 13:20:36** 那次已经是新代码（栈里有 `serveFriendly`）→ 浏览器拿到的是 403 中文页而不是 JSON；两次同票请求相隔 3 秒（`?t=` 被刷新/重复打开），属「单次票据」的预期行为。

**顺带修掉的两处「不是 500 的 500」**：`server/http/routes/preview.ts::previewErrorCopy()` 原来只认「票据已被使用 / 不匹配 / 预览会话 / NOT_FOUND」，**票据过期**与**票据无效**掉进兜底分支 → 浏览器拿到 `500 预览暂时打不开`（文案还劝用户「联系管理员」）。现补两条 403 分支：「这个预览链接已经过期了」（提示有效期 60 秒）与「这个预览链接无效」。测试 `server/test/preview-routes.test.ts` 增补浏览器 `Accept: text/html` 的断言，并复验生产：嵌入票据首兑 **303**、同票复用 **403 中文页**、重新签发的第二张票仍 **303**（即「再点一次分享」永远可用）。

**授权一致性修正（切流后复核生产库发现，已在生产库执行）**

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | 迁移计划为**所有者**生成 `view_grants` 行，与本文档「所有者在迁移计划里不生成 `view_grants`/`capabilities` 行」相矛盾 | `server/db/legacy/plan.ts` 的授权循环跳过 `perm.userId === ownerUserId`，并计入 `dropped` 与警告 |
| 2 | 新建分组时把新分组**授予全部持 `blueprint.manage` 的用户**（旧模型遗留的自动授权），越出其能力范围；同时对所有者写冗余行 | `server/app/blueprints.ts::createBlueprintGroup` 改为**只授予创建者本人**，并跳过所有者 |
| 3 | 发布蓝图时给创建者补的蓝图授权，对所有者同样冗余 | 同一处跳过所有者 |

生产库已按新语义修正（先备份 `view_grants` 到 `/root/youzhao-backup-20261019/`，再删除悬挂行与所有者行）：清除后 `view_grants` = **4 行**（`demo` 2 + `xinje` 1 + `yl` 1；所有者隐式全可见，无需行）。悬挂行（3 蓝图 + 3 分组）是清理冒烟对象时只删对象未删授权所致。

**管辖功能上线（2026-10-26，`2a4d553`）**

新增迁移 `0006_jurisdiction.sql`（`group_managers` / `blueprint_managers` 两表，语义见 `docs/permission-design.md` §2.3），
API 启动自检要求迁移先行，因此原生安装形态的升级顺序是：
**备份 → `git pull` → `pnpm install --frozen-lockfile` → `pnpm -C server migrate`（用 `/etc/youzhao/api.env` 的 DB 变量）→ `pnpm -C web build` → `systemctl restart youzhao-api` → 健康检查**。
本次库基线（升级前）：`users=6 groups=6 blueprints=17 versions=34 view_grants=6 capabilities=0 mcp_tokens=7`，
两新表初始均为 0 行（管辖是「划地盘」，历史授权一并留在 `capabilities` 例外表里）。健康检查返回 `contractVersion 2.0.0`。

两处**原生安装特有的坑**（都因历史上用 root 跑过运维命令）：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `git pull` 报 `insufficient permission for adding an object to repository database .git/objects` | 早先以 root 执行过拉取，`.git/objects/*` 部分目录属 root | `chown -R youzhao:youzhao /srv/youzhao/app/.git` 后再拉 |
| `pnpm -C web build` 报 `EACCES: permission denied, '/srv/youzhao/app/web/dist/assets'` | 早先以 root 构建过，`web/dist` 下残留 root 文件，vite 清目录时被拒 | `chown -R youzhao:youzhao /srv/youzhao/app/web/dist` 后重建 |

**纪律**：`git pull`、`pnpm install`、`pnpm -C web build`、`pnpm -C server migrate` 一律以 `youzhao` 身份执行（`sudo -u youzhao`），
只有 `pg_dump`、`systemctl restart`、`chown` 这类需要特权的步骤才走 root。

---

---

## 8.6 真实容器化验收记录（2026-10-23，本机 colima）

补齐 §8.4 里「未在本机执行」的那一项：本机 colima（Docker 29.2.1，2 vCPU / 3 GiB / 30 GiB）跑
`deploy/scripts/install.sh -y --dev`，起 `postgres` + `api` + `web` + `gateway` 四容器
（`18080->80`、`18081->8080`）。

| 验收项 | 证据 | 结果 |
| --- | --- | --- |
| 栈健康 | 四容器 `healthy`；网关 `/health` → `{"data":{"status":"ok","contractVersion":"2.0.0","services":{"database":"up"}}}`（注意是信封，不是裸对象） | 通过 |
| SPA | `GET /` → 200、598 字节、`<title>有招</title>` | 通过 |
| 端到端 | `node scripts/smoke-e2e.mjs --base http://127.0.0.1:18080 --preview http://127.0.0.1:18081 --origin http://localhost:18080` | **16/16** |
| 重启留存 | 全栈 `restart` 前后 `blueprints=1 groups=2 users=1 tokens=0` 不变，`/health` 200 | 通过 |
| 备份 | `deploy/scripts/backup.sh` → `backups/20261023-101811/`：`db.dump`（40 K）、`previews.tar.gz`、`uploads.tar.gz`、`env.backup`、`compose.yaml`、`gateway-nginx.conf`、`MANIFEST`、`SHA256SUMS` | 通过 |
| 恢复 | 先插入标记分组（`groups` 2→3），`restore.sh <备份绝对路径> --force` → 自动撤销点 `20261023-101844` → 标记消失、`groups=2`；恢复后复跑 `smoke:e2e` **16/16** | 通过 |

**由此修掉的 4 个部署产物缺陷**（本机 `pnpm verify` + vite dev + PGlite 全绿也测不出来）

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 构建期 `error: unexpected value 'false' for '--frozen-lockfile' found; no more were expected` | Dockerfile 写的 `pnpm install --frozen-lockfile=false`，pnpm 12 不接受布尔值形式 | 两个 Dockerfile 改 `--no-frozen-lockfile` |
| 2 | `COPY deploy/web/nginx.conf` 报 `file not found in build context or excluded by .dockerignore` | 根 `.dockerignore` 排除了 `deploy` | 追加 `!deploy/web/nginx.conf`（`deploy/.env` 仍排除） |
| 3 | api 容器崩溃 `Error: Cannot read package config /app/server/package.json: permission denied.`（`ERR_INVALID_PACKAGE_CONFIG`） | 宿主 umask 077 使 `package.json` 为 0600，`COPY` 后 root:0600，`USER node`(1000) 读不到 | `USER node` 前 `RUN chmod -R a+rX /app`；web 同理 `chmod -R a+rX /usr/share/nginx/html` |
| 4 | api 重建后全站 502，直到重启网关：`connect() failed (111: Connection refused) … upstream: "http://172.18.0.4:3000/api/health"` | 网关用静态 `upstream { server api:3000; }`，DNS 只在启动时解析一次；容器重建换 IP 后仍打旧 IP | 删 `upstream` 块，改 `resolver 127.0.0.11 valid=10s ipv6=off;` + 各 server 块 `set $youzhao_api api:3000; set $youzhao_web web:80;`，`proxy_pass` 全部变量化（代价：放弃 upstream keepalive，单机规模可接受） |

另新增可选构建参数 `NPM_REGISTRY`（两个 Dockerfile + `compose.yaml` 的 `build.args` + `.env.example` 说明），
用于容器内 `registry.npmjs.org` 不可达时改走镜像站（本机实测 `registry.npmmirror.com` 可用）。

**环境侧两个坑（与项目代码无关，但会挡住验收）**

1. 本机只有独立 `docker-compose` 5.1.3，没有 `docker compose` v2 插件——`install.sh` 的 `detect_compose()` 已能回退；
   手工执行时 `COMPOSE_PROJECT_NAME` 放在 `--env-file` 里**不生效**，必须显式 `-p youzhao-accept`。
2. colima 只共享 `/Users/flor/**`——`DATA_ROOT` 指到 `/tmp` 会让 postgres 卷 `failed to populate volume: … no such file or directory`；
   改到 `artifacts/acceptance` 并把子目录 `chmod 777`（postgres 只校验 PGDATA 子目录属主）。

**经验**：容器化验收必须真跑。上表 4 个缺陷全部落在「打包 / 文件属主 / 容器 DNS」这些只有真实镜像与容器网络才暴露的层面；
本机 PGlite + vite dev 全绿不构成证据。（这也是 §8.5 那个 int8 缺陷的同一类教训：**验证环境与目标环境不同构，
就会漏掉整类缺陷**。）

## 9. 对现有文档的修订清单

### 9.1 `docs/deployment-rules.md`

| 条款 | 修订 |
| --- | --- |
| §3.1 路径规则表 | `/preview/*` 转发目标由"preview volume"改为"api（鉴权后回源）" |
| §3.3 api 职责 | 增补"产物鉴权、票据签发与校验" |
| §5 环境变量 | 删除 `API_JWT_SECRET`、`API_TOKEN_EXPIRES_IN`；新增 `SESSION_TTL_SECONDS`、`SESSION_COOKIE_NAME`、`PREVIEW_TICKET_SECRET`、`PREVIEW_TICKET_TTL_SECONDS`、`PREVIEW_DOMAIN`、`RATE_LIMIT_LOGIN_PER_MINUTE`、`RATE_LIMIT_MCP_PER_MINUTE`、`MCP_ENABLED`、`MCP_PATH` |
| §11 访问规则 | `/preview/{blueprintId}/{version}/` 增补"必须携带有效票据或预览域 Cookie；否则 403"；产物结构补多文件与 `manifest.json.sha256` |
| §13 安全约束 | "蓝图预览地址不应暴露未授权数据（后续）"升级为**硬要求**：产物默认鉴权；`PREVIEW_TICKET_SECRET` 无默认值 |
| §15 验收标准 | "蓝图预览产物可通过 `/preview/{id}/{v}/` 打开"改为"持票据可打开，未持票据返回 403" |
| §4/§14 部署形态与拓扑 | 记录实机事实（§8.5）：生产机采用**原生安装**（PostgreSQL 16 + Node 24 + systemd），`deploy/` 容器方案保留为可选；ECS 上 `youzhao.florai.cn` 是 frp 隧道回内网 VM103 `192.168.1.13` 的 `youzhao-api.service`（端口 4174，`YOUZHAO_DATA_DIR=/data/youzhao`），**迁移源数据即该机**；预览域必须是独立子域（`preview.youzhao.florai.cn`），无泛解析 |

### 9.2 `docs/frontend-rules.md`

| 条款 | 修订 |
| --- | --- |
| §5 主题 | 默认 preset 由 Aura 改为**自定义 preset**（取值来自原型）；`--app-*` 取值表按 §5.3 替换 |
| §5 视觉约束 | "卡片圆角不超过 8px"改为按原型（卡片 16px / 控件 12px） |
| §4.2 DataTable | 增补"列定义集中维护，表头与行共享同一来源" |
| §3 页面结构 | 增补两种布局：工作台 `AppShell` 与预览 `BlankShell`（预览域） |
| §9、§10 DSL | 标注"本期不适用"（本平台不再承担 DSM/原型 DSL 渲染职责；若保留，需单独立项） |
| §11 目录 | 去掉 `dsl/`；新增 `components/preview`、`stores`（Pinia 落地） |

### 9.3 `docs/demo-platform-prd.md`

| 条款 | 修订 |
| --- | --- |
| §9.2 功能权限 | 由"查看/管理"两级模型改为权限设计的能力 + 范围模型 |
| §9.4 MCP 服务权限 | 删除"Token 创建不允许选择其他用户"；改为 S2（所有者可代建）；普通用户可自建只读 Token；权限计算按 S3（Token 权限 = 绑定用户权限 ∩ scope） |
| §11 权限矩阵 | 由 `docs/permission-design.md` 的矩阵取代 |
| §10 MCP 服务 | 协议修订声明更新为现代 era `2026-07-28`（并说明对 `2025-11-25` 的回退）；补充"每次请求声明版本与能力、无会话"的约束 |
| §12.4 用户模型 | 用户状态枚举 `enabled\|disabled` 统一为 `active\|disabled`，与 `users.status` 契约一致 |
| §12.7 MCP Token | `McpToken.status` 的 `enabled` 统一为 `active`（与 `mcp_tokens.status` 契约一致） |

### 9.4 无需修改

`docs/permission-design.md`（权限权威）、`docs/frontend-design.md`（页面权威）、`docs/prototype-interaction-review.md`（审核记录，作为验收输入）。

---

## 10. 设计裁决记录

`m00687` 对 Q1–Q10 的逐条裁决（已同步写回 §0.3、§4.2、§4.5、§5.3、§8 与两份配套文档）：

| # | 问题 | 裁决 | 落点 |
| --- | --- | --- | --- |
| Q1 | 可委派范围是否即查看范围 | **是**，同一集合 | permission-design §3.3/§5.2；frontend-design P5 区段二改为只读派生 |
| Q2 | A 对名下用户能否删除 | **只能停用**，删除是所有者专属 | permission-design §3.2/§6.2 |
| Q3 | 成员是否可多归属 | **可以**，多对多 | permission-design §3.1/§5.1；frontend-design P4 |
| Q4 | 删除分组/蓝图/产物是否物理删除 | **不物理删除**，转归档且可恢复 | permission-design §6.4；frontend-design P2 |
| Q5 | 是否需要多个所有者 / 是否提供移交 | **只保留一位**，且**本期不提供移交入口**（暂不设计） | §0.3 S9、permission-design §8 |
| Q6 | 预览域形态 | **独立域名** | §9.1（`PREVIEW_DOMAIN`）、§8 M5 |
| Q7 | 迁移期是否并行旧接口 | **不并行**，直接切换 | §8 M5 |
| Q8 | ECharts 本期是否必要 | **需要** | §5.1、§9.2 |
| Q9 | 是否引入危险色 | **引入受限危险色** | §5.3、frontend-design §2 |
| Q10 | MCP 是否暴露分组写工具 | **可创建分组，不暴露排序** | §4.5、permission-design §6.4 |

**仍需确认（不阻塞设计）**：暂无。实现期如发现偏差，以本文件与 `docs/permission-design.md`、`docs/frontend-design.md` 三份文档的同时更新为准。


