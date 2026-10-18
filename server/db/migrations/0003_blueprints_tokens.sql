-- M2/M3 数据模型：蓝图、版本、MCP Token、预览票据。
-- 分组表（blueprint_groups）已在 0002 建好，这里只补业务表。
-- 归档语义（不变量 11）：所有"删除"只写 archived_at，产物与授权记录保留。

create table blueprints (
  id text primary key,
  name text not null check (length(name) between 1 and 120),
  summary text not null default '',
  tags text[] not null default '{}',
  group_id text not null references blueprint_groups (id),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by_user_id text not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index blueprints_group_idx on blueprints (group_id);
create index blueprints_status_idx on blueprints (status);

create table blueprint_versions (
  id text primary key,
  blueprint_id text not null references blueprints (id) on delete cascade,
  version text not null check (length(version) between 1 and 64),
  is_latest boolean not null default false,
  status text not null default 'available' check (status in ('available', 'missing')),
  entry_path text not null,
  artifact_path text not null,
  artifact_hash text,
  artifact_bytes bigint,
  publish_source text not null check (publish_source in ('mcp', 'web', 'web-cover')),
  publish_note text not null default '',
  deployed_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (blueprint_id, version)
);

create index blueprint_versions_blueprint_idx on blueprint_versions (blueprint_id);

-- 每个蓝图最多一个"最新版本"（发布新版本时在同一事务里换旗）。
create unique index blueprint_versions_single_latest
  on blueprint_versions (blueprint_id)
  where is_latest;

create table mcp_tokens (
  id text primary key,
  name text not null check (length(name) between 1 and 80),
  token_hash text not null unique,
  token_prefix text not null,
  bound_user_id text not null references users (id) on delete cascade,
  created_by_user_id text not null references users (id),
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'disabled')),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index mcp_tokens_bound_user_idx on mcp_tokens (bound_user_id);

-- 预览票据：默认 60 秒一次性换取，换取后在预览域下发 30 分钟受限 Cookie。
create table preview_tickets (
  id text primary key,
  ticket_hash text not null unique,
  blueprint_id text not null references blueprints (id) on delete cascade,
  version text not null,
  issued_to_user_id text references users (id) on delete set null,
  purpose text not null default 'preview' check (purpose in ('preview', 'embed')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index preview_tickets_expires_idx on preview_tickets (expires_at);
