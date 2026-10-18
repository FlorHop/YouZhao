/**
 * MCP 写工具幂等（docs/architecture-design.md §4.5「写操作必须带 idempotencyKey」）。
 *
 * Agent 侧的重试很常见（网络抖动、超时未回包）。对**发布版本**，重复执行会被
 * `(blueprint_id, version)` 唯一约束挡住（安全失败）；但「新建蓝图」「新建分组」
 * 没有天然唯一键，重复执行会真的多出一份数据。这里用 (token_id, idempotency_key)
 * 去重：同 key 同请求体 → 回放首次响应；同 key 不同请求体 → 409。
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/types.js';
import { AppError } from '../domain/errors.js';

/** 稳定序列化（对象键排序）：保证语义相同的请求体得到相同哈希。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export interface IdempotencyInput<T> {
  readonly db: Db;
  readonly tokenId: string;
  /** 缺省表示调用方未提供 key：直接执行，不做去重（读工具路径不会走这里）。 */
  readonly key?: string | undefined;
  readonly payload: unknown;
  readonly execute: () => Promise<T>;
}

export async function withIdempotency<T>(input: IdempotencyInput<T>): Promise<T> {
  const { db, tokenId, key } = input;
  if (key === undefined || key === '') return input.execute();

  const requestHash = hashRequest(input.payload);
  const claimed = await db
    .insertInto('mcp_idempotency')
    .values({
      token_id: tokenId,
      idempotency_key: key,
      request_hash: requestHash,
      response: null,
    })
    .onConflict((oc) => oc.columns(['token_id', 'idempotency_key']).doNothing())
    .returning('token_id')
    .executeTakeFirst();

  if (claimed !== undefined) {
    const result = await input.execute();
    await db
      .updateTable('mcp_idempotency')
      .set({ response: JSON.stringify(result) })
      .where('token_id', '=', tokenId)
      .where('idempotency_key', '=', key)
      .execute();
    return result;
  }

  const existing = await db
    .selectFrom('mcp_idempotency')
    .select(['request_hash', 'response'])
    .where('token_id', '=', tokenId)
    .where('idempotency_key', '=', key)
    .executeTakeFirstOrThrow();
  if (existing.request_hash !== requestHash) {
    throw new AppError('VERSION_CONFLICT', '同一个 idempotencyKey 被用于了不同的请求体');
  }
  if (existing.response === null) {
    // 极窄窗口：同 key 的前一次请求仍在执行中（占位已写、响应未回填）。
    throw new AppError('VERSION_CONFLICT', '相同 idempotencyKey 的请求正在处理中，请稍后重试');
  }
  const stored =
    typeof existing.response === 'string' ? (JSON.parse(existing.response) as unknown) : existing.response;
  return stored as T;
}
