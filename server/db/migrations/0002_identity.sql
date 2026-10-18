-- 0002_identity.sql — M1 身份与权限底座
-- 依据：docs/architecture-design.md §3.3 数据模型、§3.4 凭证与会话、§3.5 授权引擎；
--       docs/permission-design.md §4 十二条服务端不变量。
-- 约定：id 为应用层生成的不透明字符串（`usr_…` / `grp_…` 等），不使用自增列，便于审计与迁移。

-- 用户主体。注意：**归属不在此表**（见 user_managers，S7 多对多）。
create table users (
  id text primary key,
  username text not null unique,
  display_name text not null,
  email text,
  phone text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  password_hash text not null,
  must_change_password boolean not null default true,
  created_by_user_id text references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 互斥身份（不变量 1）：一人一行；owner 全库唯一（不变量 2 的结构部分）。
create table user_identity (
  user_id text primary key references users (id) on delete cascade,
  identity text not null check (identity in ('owner', 'user_admin', 'member')),
  granted_by text references users (id),
  granted_at timestamptz not null default now()
);

create unique index user_identity_single_owner
  on user_identity (identity)
  where identity = 'owner';

-- 管理归属（不变量 12）：多对多；无行 = 暂未指派。
-- 增加/删除行仅由所有者执行（改派 = 整体替换集合），应用层判定。
create table user_managers (
  user_id text not null references users (id) on delete cascade,
  manager_user_id text not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, manager_user_id),
  constraint user_managers_not_self check (user_id <> manager_user_id)
);

-- 蓝图分组。M2 会用到的完整字段先落这里，因为查看授权与业务能力都以分组为资源目标。
create table blueprint_groups (
  id text primary key,
  name text not null unique,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index blueprint_groups_single_default
  on blueprint_groups (is_default)
  where is_default;

-- 蓝图查看范围（不变量 7 只增不覆盖由接口层保证）。
-- 同时是用户管理员的可委派范围（S1）：不另设 admin_delegations 表。
create table view_grants (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  target_type text not null check (target_type in ('group', 'blueprint')),
  target_id text not null,
  granted_by text not null references users (id),
  created_at timestamptz not null default now(),
  unique (user_id, target_type, target_id)
);

create index view_grants_user on view_grants (user_id);
create index view_grants_target on view_grants (target_type, target_id);

-- 业务能力（不变量 6：必须带资源范围；与身份正交，S4）。
create table capabilities (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  capability text not null check (capability in ('blueprint.manage', 'blueprint.publish')),
  target_type text not null check (target_type in ('group', 'blueprint')),
  target_id text not null,
  granted_by text not null references users (id),
  created_at timestamptz not null default now(),
  unique (user_id, capability, target_type, target_id)
);

create index capabilities_user on capabilities (user_id);
create index capabilities_target on capabilities (target_type, target_id);

-- 浏览器会话：只存哈希；可立刻吊销（§3.4 规则 2）。
create table sessions (
  id text primary key,
  token_hash text not null unique,
  user_id text not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  user_agent text,
  ip text
);

create index sessions_user_active on sessions (user_id)
  where revoked_at is null;

-- 审计（对齐 PRD §10.10）。不记录口令、令牌明文与产物正文。
create table audit_logs (
  id text primary key,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'token', 'system')),
  actor_id text,
  request_id text,
  action text not null,
  target_type text,
  target_id text,
  result text not null check (result in ('allow', 'deny', 'error')),
  error_code text,
  detail jsonb,
  ip text,
  duration_ms integer
);

create index audit_logs_at on audit_logs (at desc);
create index audit_logs_actor on audit_logs (actor_id, at desc);

-- 初始化即存在的默认分组（deployment-rules §15）。
insert into blueprint_groups (id, name, is_default, sort_order)
values ('group_default', '默认', true, 0)
on conflict (id) do nothing;
