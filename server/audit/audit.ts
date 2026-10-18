/**
 * 审计写入（docs/architecture-design.md §3.8、PRD §10.10）。
 *
 * 纪律：
 * - 审计**不含**口令、令牌明文与产物正文；任何写进来的 detail 先过 `redact` 兜底
 *   （调用方不应主动塞敏感字段，这里只防止手滑与透传上游请求体）；
 * - 审计**不得阻断业务**：写入失败只 `console.error` 一行，不向调用方抛错
 *   （审计库故障不应该让一次正常的登录/授权失败）；
 * - `at` 交给数据库 default now()，避免应用与数据库时钟不一致。
 */
import type { Db } from '../db/types.js';
import { newId } from '../domain/ids.js';

export interface AuditEntry {
  actorType: 'user' | 'token' | 'system';
  actorId?: string | null;
  /** 令牌调用时记下被使用的那把令牌，便于定位「哪个凭证做了什么」（§4.6） */
  tokenId?: string | null;
  requestId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result: 'allow' | 'deny' | 'error';
  errorCode?: string | null;
  detail?: unknown;
  ip?: string | null;
  durationMs?: number | null;
}

/** 命中即整字段替换为 '[redacted]'；大小写不敏感 */
export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'newpassword',
  'oldpassword',
  'token',
  'secret',
  'authorization',
  'cookie',
];

const REDACTED = '[redacted]';
const CIRCULAR = '[circular]';

interface PlainObject {
  [key: string]: unknown;
}

/** 只递归"普通对象"；Date / Buffer / Error 等按原样返回，避免被拆成空对象 */
function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 递归脱敏。`ancestors` 只记录**当前路径**上的对象（进入时加入、返回前移除），
 * 因此真正的环会命中 '[circular]'，而同一个对象在兄弟位置重复出现不算环。
 */
function redactInner(value: unknown, ancestors: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    const items = value.map((item) => redactInner(item, ancestors));
    ancestors.delete(value);
    return items;
  }

  if (isPlainObject(value)) {
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    const output: PlainObject = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEYS.includes(key.toLowerCase())
        ? REDACTED
        : redactInner(item, ancestors);
    }
    ancestors.delete(value);
    return output;
  }

  return value;
}

/** 递归脱敏任意值；循环引用替换为 '[circular]'，其余值原样保留 */
export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>());
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 真正落库的写入：失败会抛，只有下面两个公开入口调用它 */
async function insertAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_logs')
    .values({
      id: newId('aud'),
      actor_type: entry.actorType,
      actor_id: entry.actorId ?? null,
      token_id: entry.tokenId ?? null,
      request_id: entry.requestId ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      result: entry.result,
      error_code: entry.errorCode ?? null,
      detail: redact(entry.detail),
      ip: entry.ip ?? null,
      duration_ms: entry.durationMs ?? null,
    })
    .execute();
}

/**
 * 单条写入（bootstrap 用）。与 createAuditWriter 同一条纪律：**不抛异常**，
 * 失败只打印一行，调用方不必为此加 try/catch。
 */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await insertAudit(db, entry);
  } catch (error) {
    console.error(`✗ 审计写入失败（action=${entry.action}）：${describeError(error)}`);
  }
}

/** 请求级审计器：闭包持有 db，调用点只关心 entry */
export function createAuditWriter(db: Db): (entry: AuditEntry) => Promise<void> {
  return (entry) => writeAudit(db, entry);
}
