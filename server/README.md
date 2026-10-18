# server —— 有招平台后端（M0 骨架）

Fastify + PostgreSQL（`pg` + Kysely）的 HTTP 服务，并与 MCP 共用 `app/`、`domain/`、`storage/`。
设计依据：`docs/architecture-design.md`（§3.1 技术选型、§3.2 目录、§3.9 配置、§6.2 错误信封）。

当前进度：**M0–M6 已完成**（契约与骨架 / 身份与权限底座 / 蓝图与产物 + 预览嵌入 / MCP 服务 / 前端重构在 `web/` / 旧数据迁移 / 根目录切流与验收），
version: **2.0.0**。切流后本机复跑：`pnpm verify` 全绿（server 213 tests、web 17 tests、lint/typecheck 干净）、`pnpm smoke:e2e` 16/16、`pnpm smoke:ui` 14/14（浏览器级身份裁剪与设计体系约束）。**唯一未做的是真实容器化验收**——需要运行中的 docker 守护（本机 colima 未启动）。

## 命令

```bash
pnpm -C packages/contracts install
pnpm -C server install

pnpm -C server migrate      # 应用 migrations/ 下尚未执行的迁移（失败即非零退出）
pnpm -C server dev          # tsx watch main.ts
pnpm -C server start        # tsx main.ts
pnpm -C server test         # node:test（迁移用 PGlite，不需要外部数据库）
pnpm -C server typecheck    # tsc --noEmit
pnpm -C server lint         # eslint
```

仓库根还有便捷脚本（根目录在 M5 前仍是 npm 应用，两个包管理器都能跑）：

```bash
npm run verify          # 或 pnpm verify：契约同步 + 两个包的测试 + 后端 lint/类型检查
npm run contracts:gen   # 改完 packages/contracts/schemas/*.json 后重新生成产物
```

## 端到端冒烟

api 起来之后（无论真 Postgres 还是内存库），仓库根有一条主干链路冒烟：

```bash
pnpm smoke:e2e                                  # 默认 http://127.0.0.1:3000
pnpm smoke:e2e --base https://youzhao.example.com --origin https://youzhao.example.com \
               --preview https://preview.youzhao.example.com --username admin --password '…'
```

覆盖：健康检查 → 登录 → 会话 → 分组 → 建组 → 建 MCP Token → MCP `tools/list` → MCP 发布蓝图 →
蓝图列表/详情 → 预览票据 → 换票换 Cookie → 取产物（断言 CSP/nosniff/no-store）→ 匿名被拒 →
票据单次 → 删除 Token → 删除后 401。全程只用 node 内置能力，退出码非 0 即失败。

## 启动前置

- Node ≥ 20（本机 24.21.0）。
- 必需环境变量（缺失或非法时**启动即失败**，并把所有问题一次列全）：见 `config.ts`。
  关键几项：`API_PUBLIC_BASE_URL`、`CSRF_ORIGIN_ALLOWLIST`、`POSTGRES_{HOST,PORT,DB,USER,PASSWORD}`、
  `PREVIEW_STORAGE_PATH`、`PREVIEW_TICKET_SECRET`、`PREVIEW_DOMAIN`、`ADMIN_{USERNAME,PASSWORD,DISPLAY_NAME}`。
  开发期可参考 `docs/architecture-design.md` §3.9 的 `.env` 模板。
- 数据库：`main.ts` 启动时会先做迁移自检（有未执行迁移则拒绝启动），再连接 PostgreSQL。
  本机没启动容器时，可用任意可达的 PostgreSQL 16；纯跑测试则不需要数据库。

### 本机没有 Postgres 时：用内存库把 api 跑起来

```bash
cp server/.env.example server/.env      # 改 DB_DRIVER=pglite，并调整 ADMIN_PASSWORD 等
pnpm -C server dev                      # 内存库启动：数据重启即清空
```

`DB_DRIVER=pglite` 只用于本地开发/测试，`APP_ENV=production` 时会被 `config.ts` 直接拒绝
（见 `docs/architecture-design.md` §3.1.1）。生产、容器化验收一律使用真实 PostgreSQL 16。

`pnpm -C server migrate` 的配置来源与主进程一致（`loadConfig()` 读 `POSTGRES_*`）；
CI 或容器编排里也可以用 `DATABASE_URL` 显式覆盖连接串。

```bash
GET /api/health   # → { status, time, services: { database } }，响应头带 x-contract-version 与 x-request-id
```

## M0 期间的三个临时决定（都有明确退出点）

| 决定 | 原因 | 何时撤掉 |
| --- | --- | --- |
| server 用 `link:../packages/contracts` 而不是 `file:` | pnpm 对 `file:` 依赖是**复制**到虚拟仓库，改契约后不重装就看不到变化；`link:` 是符号链接，改动即时生效，且其依赖能从真实路径解析到 | M4 引入根 pnpm workspace 后改为 `workspace:*` |
| server 只从子路径引入契约：`@youzhao/contracts/schemas`、`/version` | 全量 `index` 会拉进 `generated/types.ts`，它 `import type { FromSchema } from 'json-schema-to-ts'`；在 pnpm 的复制式布局下该裸模块名解析不到 | 同上；根 workspace 落地后可直接用 `@youzhao/contracts` |
| **TypeScript 锁 6.0.3**（不是 7.x） | `typescript-eslint` 8.x 明确拒绝 TS 7（`typescript-eslint does not support TS 7.0`），类型检查与 lint 会互相打架 | typescript-eslint / vue-tsc 支持 TS 7 后统一升级 |

另外：`server/pnpm-workspace.yaml` 只有一行 `allowBuilds: esbuild: true`——pnpm 12 默认拦下所有依赖的
安装脚本，`tsx` 依赖的 esbuild 必须放行（`pnpm approve-builds` 生成）。这是包级配置，不是 workspace 声明。

## 旧数据迁移（M5）

把旧应用（`main` @ `ff69340`）的 SQLite `app_state` 快照 + 磁盘产物迁到新栈。**先看计划，再动手**：

```bash
# 1) 只读旧数据，打印「迁移前后可见范围对照」，并写一份 JSON 报告
pnpm -C server migrate:legacy -- --data-dir /data/youzhao --owner admin \
  --dry-run --report /tmp/legacy-report.json

# 2) 确认无误后落库（目标库必须为空，否则加 --replace 清业务表；schema_migrations 永不清）
pnpm -C server migrate:legacy -- --data-dir /data/youzhao --owner admin \
  --report /tmp/legacy-report.json

# 旧数据目录来自别处时也可直接给快照与产物目录
pnpm -C server migrate:legacy -- --state /tmp/legacy-state.json --artifacts /data/youzhao/previews
```

参数：`--data-dir`（含 `youzhao.sqlite` 与 `previews/`，或 `$YOUZHAO_LEGACY_DATA_DIR`）、`--state <json>`、
`--artifacts <dir>`、`--skip-artifacts`、`--owner <username>`、`--default-group <id>`、`--report <file>`、
`--dry-run`、`--replace`。目标库连接与 api 同源（`loadConfig()` 读 `POSTGRES_*`，可用 `DATABASE_URL` 覆盖）。

迁移后**必须人工处理**的事（CLI 会逐条打印，也写进报告）：

- **发布能力**：旧模型把发布并入 `demo-preview:manage`，迁移**不自动授予** `blueprint.publish`；每个内容管理者都会进入
  `publishDecisions`，需在所有者的「权限」页按分组逐个授予。
- **口令**：旧口令是明文，迁移时换成 scrypt 且 `must_change_password=true`；旧库没有口令记录的用户会写入随机口令，
  需管理员重置一次。
- **管理归属**：旧模型没有这个概念，迁移后用户都不归属任何用户管理员，需在「权限」页批量指派。
- **Token**：旧 Token 明文不可回收，一律迁为**停用**占位，需重建。
- **分组归属**：原分组已被删除的蓝图会落到占位分组「原分组已删除（迁移占位）」，需手动归位。
- **可见范围变宽的人**：报告里逐人点名（旧模型是「函数级 + 资源级」双闸门，且旧代码会在建分组时给管理员补授权），
  必须复核后再放行。

已知旧模型缺陷（L1–L5）与对应修正随报告一起打印，见 `docs/architecture-design.md` §8.1。回归用例：
`server/test/legacy-migration.test.ts`（计划器纯函数 + 读取 + 真落库/真搬产物）。

## 迁移纪律

- 文件名 `NNNN_name.sql`，版本号递增；**已发布文件不得修改**（迁移器记录校验和，改动即失配报错）。
- 必须可重复执行（`if not exists` 等），由 `schema_migrations` 记录；单个文件在**一个事务**内执行。
- 不写破坏性语句（`drop` / `truncate`），除非是显式的数据迁移。
- 数据库里存在本地没有的迁移版本时拒绝启动（防止用旧代码写新库）。
