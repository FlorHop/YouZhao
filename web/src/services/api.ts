/**
 * 唯一的 HTTP 出口。
 *
 * 约定（见 `docs/architecture-design.md` §6.2）：
 *   - 成功：`{ data, meta: { requestId } }`；列表：`{ data: { items }, meta: { page, pageSize, total, requestId } }`
 *   - 失败：`{ error: { code, message, details?, requestId } }`
 *   - 会话凭证是 HttpOnly Cookie，前端**不**接触令牌（产物 iframe 因此读不到会话）
 *
 * 所有页面必须经此模块访问服务端：不得在组件里直接 `fetch`，
 * 也不得在前端做权限过滤当作安全边界（服务端逐接口校验）。
 */

import type { ErrorResponse } from '@youzhao/contracts/types';

export interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}

export interface ListEnvelope<T> {
  data: { items: T[] };
  meta: { page: number; pageSize: number; total: number; requestId: string };
}

/** 服务端错误码的语义分组（前端据此选择呈现方式与下一步动作）。 */
export const AUTH_ERROR_CODES = ['UNAUTHENTICATED', 'SESSION_EXPIRED'] as const;
export const FORBIDDEN_ERROR_CODES = [
  'FORBIDDEN',
  'OWNER_PROTECTED',
  'SELF_MANAGE_DENIED',
  'PEER_MANAGE_DENIED',
  'OUT_OF_MANAGED_SCOPE',
  'DELEGATION_EXCEEDED',
  'CAPABILITY_REQUIRED',
  'SCOPE_DENIED',
] as const;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** 会话失效：调用方应跳登录页。 */
  get isAuthError(): boolean {
    return (AUTH_ERROR_CODES as readonly string[]).includes(this.code);
  }

  get isForbidden(): boolean {
    return (FORBIDDEN_ERROR_CODES as readonly string[]).includes(this.code);
  }

  /** 字段级校验错误（就地展示在字段下方）。 */
  get fieldErrors(): Record<string, string> {
    const raw = this.details?.fields;
    if (raw === null || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON 请求体；与 `form` 互斥。 */
  json?: unknown;
  /** multipart 请求体（压缩包上传）；不设置 content-type，由浏览器带 boundary。 */
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 网关/代理返回的非 JSON 错误页：保留原文，便于定位
    return { error: { code: 'INVALID_RESPONSE', message: text.slice(0, 400) } };
  }
}

function toApiError(status: number, body: unknown): ApiError {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const error = (body as ErrorResponse).error;
    return new ApiError(status, error.code, error.message, error.details, error.requestId);
  }
  return new ApiError(status, 'UNKNOWN_ERROR', `请求失败（HTTP ${status}）`);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  };
  if (options.json !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(options.json);
  }
  if (options.form !== undefined) init.body = options.form;
  if (options.signal !== undefined) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务端，请检查网络或稍后重试');
  }

  const body = await readBody(response);
  if (!response.ok) throw toApiError(response.status, body);
  return body as T;
}

/** 取信封里的 `data`（大多数接口）。 */
export async function apiData<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const envelope = await apiRequest<Envelope<T>>(path, options);
  return envelope.data;
}

/** 取列表信封（同时返回分页 meta）。 */
export function apiList<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ListEnvelope<T>> {
  return apiRequest<ListEnvelope<T>>(path, options);
}
