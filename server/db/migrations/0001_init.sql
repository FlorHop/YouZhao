-- 0001_init: M0 基线
--
-- 只建立平台级键值配置表：后续里程碑的领域表（users / blueprint_groups / blueprints /
-- blueprint_versions / view_grants / capabilities / mcp_tokens / preview_tickets /
-- audit_logs ...）在各自迁移里新增，见 docs/architecture-design.md §3.3。
--
-- 迁移文件纪律：
-- - 文件名 `NNNN_name.sql`，版本号递增，已发布文件不得修改（校验和会失配）；
-- - 必须可重复执行（用 IF NOT EXISTS / 幂等语句），迁移器也会记录 schema_migrations；
-- - 不写 DROP/TRUNCATE 之类破坏性语句，除非是显式的数据迁移。

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table app_settings is '平台级键值配置（默认分组、功能开关等），值是 jsonb';
