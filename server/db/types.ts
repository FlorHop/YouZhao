/**
 * Kysely 表类型（docs/architecture-design.md §3.3 数据模型、§3.4 凭证与会话）。
 *
 * **列定义必须与迁移文件保持同步**：唯一事实来源是 `db/migrations/*.sql` ——
 * `0001_init.sql` 建 `app_settings`；`0002_identity.sql` 建 users / user_identity /
 * user_managers / blueprint_groups / view_grants / capabilities / sessions / audit_logs；
 * `0003_blueprints_tokens.sql` 建 blueprints / blueprint_versions / mcp_tokens /
 * preview_tickets；`0004_mcp_idempotency.sql` 建 mcp_idempotency；`0005_audit_token.sql`
 * 给 audit_logs 加 token_id；`0006_jurisdiction.sql` 建 group_managers / blueprint_managers
 * （管理员管辖范围，与 capabilities 的例外授权分表）；`schema_migrations` 由
 * `db/migrate.ts` 的 ensureMigrationsTable 建。
 * 改列时先写新迁移文件（历史迁移不可修改），再同步本文件；两边不一致会让 Kysely
 * 在编译期放过实际会失败的语句（或拒绝合法的写入）。
 *
 * 映射约定：
 * - `timestamptz` → `ColumnType<Date, Date | string | undefined, Date | string>`（读 Date，
 *   写可给 Date 或 ISO 字符串；带 default 的列插入时可省略）；
 * - 可空列写成 `T | null`，插入/更新类型再并上 `null`（读出来就是 `T | null`）；
 * - `jsonb` → `unknown`：内容不进类型系统，读时按需收窄；
 * - `boolean` / `integer` / `text` 直译（带 CHECK 的 text 列也用 `string`，
 *   取值约束由数据库与领域层负责，避免跨模块赋值时被迫强转）。
 */
import type { ColumnType, Insertable, Kysely, Selectable, Updateable } from 'kysely';

/** 非空 timestamptz */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** 可空 timestamptz */
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export interface UsersTable {
  id: string;
  username: string;
  display_name: string;
  /** email text（可空） */
  email: string | null;
  /** phone text（可空） */
  phone: string | null;
  /** check (status in ('active','disabled')) */
  status: string;
  password_hash: string;
  must_change_password: boolean;
  /** 审计事实：谁创建的这个账号，不随改派变化 */
  created_by_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** 互斥身份单行表（不变量 1）；owner 由部分唯一索引保证全库唯一 */
export interface UserIdentityTable {
  user_id: string;
  /** check (identity in ('owner','user_admin','member')) */
  identity: string;
  granted_by: string | null;
  granted_at: Timestamp;
}

/** 管理归属多对多（不变量 12）；无行 = 暂未指派 */
export interface UserManagersTable {
  user_id: string;
  manager_user_id: string;
  created_at: Timestamp;
}

/** 蓝图分组；默认分组不可归档且 is_default 全库唯一 */
export interface BlueprintGroupsTable {
  id: string;
  name: string;
  is_default: boolean;
  sort_order: number;
  archived_at: NullableTimestamp;
  created_at: Timestamp;
}

/** 蓝图查看范围（不变量 7 只增不覆盖）；同时是用户管理员的可委派范围（S1） */
export interface ViewGrantsTable {
  id: string;
  user_id: string;
  /** check (target_type in ('group','blueprint')) */
  target_type: string;
  target_id: string;
  granted_by: string;
  created_at: Timestamp;
}

/** 业务能力（不变量 6：必须带资源范围；与身份正交，S4） */
export interface CapabilitiesTable {
  id: string;
  user_id: string;
  /** check (capability in ('blueprint.manage','blueprint.publish')) */
  capability: string;
  /** check (target_type in ('group','blueprint')) */
  target_type: string;
  target_id: string;
  granted_by: string;
  created_at: Timestamp;
}

/** 分组管辖（0006）：管理员的地盘，派生发布 + 维护能力并覆盖组内蓝图 */
export interface GroupManagersTable {
  group_id: string;
  user_id: string;
  granted_by: string;
  created_at: Timestamp;
}

/** 单个蓝图的管辖（0006）：只派生 blueprint.manage，不派生「在该组内新建」 */
export interface BlueprintManagersTable {
  blueprint_id: string;
  user_id: string;
  granted_by: string;
  created_at: Timestamp;
}

/** 浏览器会话：只存 token 哈希，可立刻吊销（§3.4 规则 2） */
export interface SessionsTable {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  last_seen_at: NullableTimestamp;
  user_agent: string | null;
  ip: string | null;
}

/** 审计（PRD §10.10）：不含口令、令牌明文与产物正文 */
export interface AuditLogsTable {
  id: string;
  /** 由数据库 default now() 生成，写入时省略 */
  at: Timestamp;
  /** check (actor_type in ('user','token','system')) */
  actor_type: string;
  actor_id: string | null;
  /** 令牌调用时记录所用令牌；MCP 调用必带（迁移 0005） */
  token_id: string | null;
  request_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  /** check (result in ('allow','deny','error')) */
  result: string;
  error_code: string | null;
  detail: unknown;
  ip: string | null;
  duration_ms: number | null;
}

/** 平台级键值配置（0001_init.sql） */
export interface AppSettingsTable {
  key: string;
  value: unknown;
  updated_at: Timestamp;
}

/** 迁移记录（由 db/migrate.ts 建表：列名以那里为准） */
export interface SchemaMigrationsTable {
  version: number;
  name: string;
  checksum: string;
  applied_at: Timestamp;
}

/** blueprints（0003）：蓝图本体；"删除"只写 archived_at（不变量 11）。 */
export interface BlueprintsTable {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  group_id: string;
  /** check (status in ('active','archived')) */
  status: string;
  created_by_user_id: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: NullableTimestamp;
}

/** blueprint_versions（0003）：一个蓝图多个版本；每个蓝图最多一行 is_latest。 */
export interface BlueprintVersionsTable {
  id: string;
  blueprint_id: string;
  version: string;
  is_latest: boolean;
  /** check (status in ('available','missing')) */
  status: string;
  /** 入口文件相对路径，固定为 index.html */
  entry_path: string;
  /** 版本产物根目录（绝对路径，落在 PREVIEW_STORAGE_PATH 下） */
  artifact_path: string;
  artifact_hash: string | null;
  artifact_bytes: ColumnType<number | null, number | string | null | undefined, number | string | null>;
  /** check (publish_source in ('mcp','web','web-cover')) */
  publish_source: string;
  publish_note: string;
  deployed_at: Timestamp;
  archived_at: NullableTimestamp;
}

/** mcp_tokens（0003）：明文只在创建响应出现一次，库里只存哈希。 */
export interface McpTokensTable {
  id: string;
  name: string;
  token_hash: string;
  /** 明文前缀，用于界面识别（如 yz_mcp_tok_1a2b） */
  token_prefix: string;
  bound_user_id: string;
  created_by_user_id: string;
  /** check 逐项在 ('read:blueprint','publish:blueprint')；空数组 = 无任何能力 */
  scopes: string[];
  /** check (status in ('active','disabled')) */
  status: string;
  expires_at: NullableTimestamp;
  last_used_at: NullableTimestamp;
  created_at: Timestamp;
}

/** preview_tickets（0003）：一次性、短 TTL，换取预览域受限 Cookie。 */
export interface McpIdempotencyTable {
  token_id: string;
  idempotency_key: string;
  request_hash: string;
  /** 首次执行前为 null（占位），执行完成后回填响应体 JSON */
  response: unknown;
  created_at: Timestamp;
}

export interface PreviewTicketsTable {
  id: string;
  ticket_hash: string;
  blueprint_id: string;
  version: string;
  issued_to_user_id: string | null;
  /** check (purpose in ('preview','embed')) */
  purpose: string;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  user_identity: UserIdentityTable;
  user_managers: UserManagersTable;
  view_grants: ViewGrantsTable;
  capabilities: CapabilitiesTable;
  group_managers: GroupManagersTable;
  blueprint_managers: BlueprintManagersTable;
  sessions: SessionsTable;
  audit_logs: AuditLogsTable;
  blueprint_groups: BlueprintGroupsTable;
  blueprints: BlueprintsTable;
  blueprint_versions: BlueprintVersionsTable;
  mcp_tokens: McpTokensTable;
  preview_tickets: PreviewTicketsTable;
  mcp_idempotency: McpIdempotencyTable;
  app_settings: AppSettingsTable;
  schema_migrations: SchemaMigrationsTable;
}

/** Kysely 实例类型：应用层只依赖它，不依赖具体驱动 */
export type Db = Kysely<Database>;

// 常用别名：领域/用例层读行、写行时直接引用，避免每次都写 Selectable<XTable>
export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserPatch = Updateable<UsersTable>;

export type UserIdentityRow = Selectable<UserIdentityTable>;
export type NewUserIdentity = Insertable<UserIdentityTable>;

export type UserManagerRow = Selectable<UserManagersTable>;
export type NewUserManager = Insertable<UserManagersTable>;

export type ViewGrantRow = Selectable<ViewGrantsTable>;
export type NewViewGrant = Insertable<ViewGrantsTable>;

export type CapabilityRow = Selectable<CapabilitiesTable>;
export type NewCapability = Insertable<CapabilitiesTable>;

export type GroupManagerRow = Selectable<GroupManagersTable>;
export type NewGroupManager = Insertable<GroupManagersTable>;

export type BlueprintManagerRow = Selectable<BlueprintManagersTable>;
export type NewBlueprintManager = Insertable<BlueprintManagersTable>;

export type SessionRow = Selectable<SessionsTable>;
export type NewSession = Insertable<SessionsTable>;

export type AuditLogRow = Selectable<AuditLogsTable>;
export type NewAuditLog = Insertable<AuditLogsTable>;

export type BlueprintGroupRow = Selectable<BlueprintGroupsTable>;
export type NewBlueprintGroup = Insertable<BlueprintGroupsTable>;

export type AppSettingRow = Selectable<AppSettingsTable>;
export type SchemaMigrationRow = Selectable<SchemaMigrationsTable>;
