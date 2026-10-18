-- 0004：MCP 写工具的幂等去重（docs/architecture-design.md §4.5）
--
-- 背景：MCP 客户端（Agent）在网络重试时会重复发送同一 `idempotencyKey`。
-- 没有这张表时，「创建蓝图组」「新建蓝图」这类**没有天然唯一键**的写操作
-- 重试就会真的执行两次（发布版本还能靠 (blueprint_id, version) 唯一约束挡住）。
--
-- 语义：以 (token_id, idempotency_key) 为主键，记录请求体哈希与首次响应体。
--   * 同 key 同哈希 → 直接回放存储的响应，不重复执行；
--   * 同 key 不同哈希 → 409 VERSION_CONFLICT（客户端复用了 key，属调用方错误）；
--   * 记录保留期由 `mcp_idempotency_created_idx` 支撑的清理任务处理（本期不自动清理）。
create table mcp_idempotency (
  token_id text not null references mcp_tokens (id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  request_hash text not null,
  -- 首次执行前先占位写 null；执行完成后回填 JSON 响应体
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (token_id, idempotency_key)
);

create index mcp_idempotency_created_idx on mcp_idempotency (created_at);
