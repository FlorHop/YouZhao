-- MCP 调用的审计归属：docs/architecture-design.md §4.6 要求审计能追到具体 Token。
-- 之前的 audit_logs 只有 actor（绑定用户），同一用户多个 Token 时无法区分。
alter table audit_logs add column token_id text;

create index audit_logs_token on audit_logs (token_id, at desc)
  where token_id is not null;
