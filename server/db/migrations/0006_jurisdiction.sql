-- 0006_jurisdiction.sql — 「管辖」：管理员的地盘
-- 依据：docs/permission-design.md §2.3（管辖与能力的职责划分）、docs/architecture-design.md §3.3。
--
-- 与 capabilities 的分工（刻意分表，便于审计区分「划地盘」与「开例外」）：
-- - group_managers / blueprint_managers = 所有者划给某位用户管理员的**管辖范围**。
--   分组管辖 ⇒ 该组上的 blueprint.publish + blueprint.manage（并覆盖组内全部蓝图）；
--   蓝图管辖 ⇒ 该蓝图上的 blueprint.manage（不含在其所属分组内新建蓝图）。
-- - capabilities = **例外授权**：可以只给 blueprint.manage（只维护不发版），
--   也可以给 member。判定时两者取并集，管辖不会被能力表削减。
--
-- 约束：管辖只对 user_admin 有意义（所有者隐式全权，普通用户走能力表）；
-- 该约束由应用层校验，数据库不做身份外键检查，避免历史数据回填时被卡住。

create table group_managers (
  group_id text not null references blueprint_groups (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  granted_by text not null references users (id),
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index group_managers_user on group_managers (user_id);

create table blueprint_managers (
  blueprint_id text not null references blueprints (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  granted_by text not null references users (id),
  created_at timestamptz not null default now(),
  primary key (blueprint_id, user_id)
);

create index blueprint_managers_user on blueprint_managers (user_id);
