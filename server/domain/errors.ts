/**
 * 错误码与统一错误信封（docs/architecture-design.md §6.2）。
 *
 * 纪律：
 * - 错误码是**前端分支依据**，一旦发布就只能新增、不能改语义；
 * - 500 类错误不把内部信息（SQL、堆栈、路径）写进响应体，只进日志；
 * - 领域层只抛 `AppError`，HTTP 层由 `http/app.ts` 的 errorHandler 统一转换。
 */

export const ERROR_CODES = [
  // 400
  'INVALID_ARGUMENT',
  'ARTIFACT_INVALID',
  'INVALID_ARTIFACT',
  // 401
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'TOKEN_INVALID',
  // 403
  'FORBIDDEN',
  'SELF_MANAGE_DENIED',
  'PEER_MANAGE_DENIED',
  'CAPABILITY_REQUIRED',
  'OUT_OF_MANAGED_SCOPE',
  'DELEGATION_EXCEEDED',
  'SCOPE_DENIED',
  'OWNER_PROTECTED',
  // 404
  'NOT_FOUND',
  'BLUEPRINT_NOT_FOUND',
  'VERSION_NOT_FOUND',
  'GROUP_NOT_FOUND',
  'USER_NOT_FOUND',
  'TOKEN_NOT_FOUND',
  // 409
  'USERNAME_CONFLICT',
  'GROUP_CONFLICT',
  'VERSION_CONFLICT',
  'LAST_OWNER_PROTECTED',
  'LAST_VERSION_PROTECTED',
  'STALE_PERMISSION_STATE',
  // 413 / 429
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  // 500 / 503
  'SERVICE_UNAVAILABLE',
  'MCP_DISABLED',
  'PUBLISH_FAILED',
  'INTERNAL_ERROR',
  'CONFIG_INVALID',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  ARTIFACT_INVALID: 400,
  INVALID_ARTIFACT: 400,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  SELF_MANAGE_DENIED: 403,
  PEER_MANAGE_DENIED: 403,
  CAPABILITY_REQUIRED: 403,
  OUT_OF_MANAGED_SCOPE: 403,
  DELEGATION_EXCEEDED: 403,
  SCOPE_DENIED: 403,
  OWNER_PROTECTED: 403,
  NOT_FOUND: 404,
  BLUEPRINT_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  GROUP_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  TOKEN_NOT_FOUND: 404,
  USERNAME_CONFLICT: 409,
  GROUP_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  LAST_OWNER_PROTECTED: 409,
  LAST_VERSION_PROTECTED: 409,
  STALE_PERMISSION_STATE: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  MCP_DISABLED: 503,
  PUBLISH_FAILED: 500,
  INTERNAL_ERROR: 500,
  CONFIG_INVALID: 500,
};

const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  INVALID_ARGUMENT: '请求参数不合法',
  ARTIFACT_INVALID: '上传的产物包不合法',
  UNAUTHENTICATED: '请先登录',
  SESSION_EXPIRED: '登录状态已过期，请重新登录',
  TOKEN_INVALID: '令牌无效、已停用或已过期',
  FORBIDDEN: '当前账号没有执行该操作的权限',
  SELF_MANAGE_DENIED: '不能通过用户管理接口管理自己的账号，请使用「我的账号」',
  PEER_MANAGE_DENIED: '不能管理与你同级或更高级别的账号',
  CAPABILITY_REQUIRED: '缺少所需的业务能力，或能力不覆盖该资源',
  OUT_OF_MANAGED_SCOPE: '目标用户不在你的管理范围内',
  DELEGATION_EXCEEDED: '授权范围超出你的可委派范围',
  SCOPE_DENIED: '凭证的作用范围不足',
  OWNER_PROTECTED: '平台所有者账号受保护，不能被修改或停用',
  NOT_FOUND: '请求的资源不存在',
  TOKEN_NOT_FOUND: '令牌不存在或已删除',
  USERNAME_CONFLICT: '该用户名已存在',
  GROUP_CONFLICT: '该分组名称已存在',
  VERSION_CONFLICT: '该版本号已存在，如需替换请使用覆盖接口',
  LAST_OWNER_PROTECTED: '平台必须保留一个所有者',
  LAST_VERSION_PROTECTED: '不能删除蓝图的最后一个版本',
  STALE_PERMISSION_STATE: '权限已发生变化，请刷新后重试',
  PAYLOAD_TOO_LARGE: '内容超出体积上限',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  SERVICE_UNAVAILABLE: '服务暂时不可用',
  MCP_DISABLED: '未开启 MCP 接入（MCP_ENABLED=false）',
  INTERNAL_ERROR: '服务器内部错误',
  CONFIG_INVALID: '服务配置不合法，已拒绝启动',
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? DEFAULT_MESSAGES[code] ?? code);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toBody(requestId: string): ErrorBody {
    const body: ErrorBody = {
      error: { code: this.code, message: this.message, requestId },
    };
    if (this.details !== undefined) body.error.details = this.details;
    return body;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

interface FastifyLikeError {
  code?: unknown;
  statusCode?: unknown;
  validation?: unknown;
  message?: unknown;
}

/**
 * 任意抛出物 → 错误信封 + HTTP 状态码。
 * Fastify 自身的校验/解析错误在此归一到契约错误码，避免前端看到框架私有错误码。
 */
export function toErrorBody(error: unknown, requestId: string): ErrorBody {
  if (isAppError(error)) return error.toBody(requestId);

  const candidate = (error ?? {}) as FastifyLikeError;
  const frameworkCode = typeof candidate.code === 'string' ? candidate.code : '';
  const statusCode = typeof candidate.statusCode === 'number' ? candidate.statusCode : 0;

  const fail = (code: ErrorCode, details?: Record<string, unknown>): ErrorBody =>
    new AppError(code, undefined, details).toBody(requestId);

  if (Array.isArray(candidate.validation) && candidate.validation.length > 0) {
    const fields = candidate.validation.map((item) => {
      const record = (item ?? {}) as { instancePath?: unknown; params?: unknown; message?: unknown };
      const instancePath = typeof record.instancePath === 'string' ? record.instancePath : '';
      const params =
        record.params !== null && typeof record.params === 'object'
          ? (record.params as Record<string, unknown>)
          : {};
      const missing = typeof params.missingProperty === 'string' ? params.missingProperty : undefined;
      return {
        path: missing === undefined ? instancePath || '/' : `${instancePath}/${missing}`,
        message: typeof record.message === 'string' ? record.message : '参数不合法',
      };
    });
    return fail('INVALID_ARGUMENT', { fields });
  }

  if (
    frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
    frameworkCode === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' ||
    statusCode === 413
  ) {
    return fail('PAYLOAD_TOO_LARGE');
  }

  if (statusCode === 429 || frameworkCode === 'FST_ERR_RATE_LIMIT') {
    return fail('RATE_LIMITED');
  }

  if (
    frameworkCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
    frameworkCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    frameworkCode === 'FST_ERR_CTP_INVALID_JSON_BODY'
  ) {
    return fail('INVALID_ARGUMENT');
  }

  if (statusCode === 404 || frameworkCode === 'FST_ERR_NOT_FOUND') {
    return fail('NOT_FOUND');
  }

  if (statusCode === 401) return fail('UNAUTHENTICATED');
  if (statusCode === 403) return fail('FORBIDDEN');

  return fail('INTERNAL_ERROR');
}

/** 与 `toErrorBody` 对应的 HTTP 状态码 */
export function httpStatusFor(error: unknown): number {
  if (isAppError(error)) return error.status;
  const candidate = (error ?? {}) as FastifyLikeError;
  const statusCode = typeof candidate.statusCode === 'number' ? candidate.statusCode : 0;
  const body = toErrorBody(error, '');
  return statusCode >= 400 && statusCode < 500 ? statusCode : ERROR_STATUS[body.error.code];
}
