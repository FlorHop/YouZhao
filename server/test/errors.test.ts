import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, ERROR_STATUS, httpStatusFor, isAppError, toErrorBody } from '../domain/errors.js';

test('AppError 映射到契约错误信封与状态码', () => {
  const error = new AppError('OUT_OF_MANAGED_SCOPE', undefined, { outOfManagedScope: ['user-9'] });
  const body = toErrorBody(error, 'req-1');

  assert.equal(error.status, 403);
  assert.equal(body.error.code, 'OUT_OF_MANAGED_SCOPE');
  assert.equal(body.error.message, '目标用户不在你的管理范围内');
  assert.equal(body.error.requestId, 'req-1');
  assert.deepEqual(body.error.details, { outOfManagedScope: ['user-9'] });
  assert.equal(isAppError(error), true);
});

test('错误码与状态码表对齐文档 §6.2', () => {
  assert.equal(ERROR_STATUS['PEER_MANAGE_DENIED'], 403);
  assert.equal(ERROR_STATUS['STALE_PERMISSION_STATE'], 409);
  assert.equal(ERROR_STATUS['PAYLOAD_TOO_LARGE'], 413);
  assert.equal(ERROR_STATUS['RATE_LIMITED'], 429);
  assert.equal(ERROR_STATUS['PUBLISH_FAILED'], 500);
});

test('Fastify 参数校验错误 → INVALID_ARGUMENT，并指出字段', () => {
  const fastifyError = {
    code: 'FST_ERR_VALIDATION',
    statusCode: 400,
    validation: [
      { instancePath: '/username', message: 'must NOT have fewer than 1 characters' },
      { instancePath: '', message: "must have required property 'password'", params: { missingProperty: 'password' } },
    ],
  };
  const body = toErrorBody(fastifyError, 'req-2');
  assert.equal(body.error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(body.error.details?.['fields'], [
    { path: '/username', message: 'must NOT have fewer than 1 characters' },
    { path: '/password', message: "must have required property 'password'" },
  ]);
});

test('请求体过大 / 限流 / 媒体类型错误 → 对应错误码', () => {
  assert.equal(
    toErrorBody({ code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 }, 'r').error.code,
    'PAYLOAD_TOO_LARGE',
  );
  assert.equal(toErrorBody({ statusCode: 429 }, 'r').error.code, 'RATE_LIMITED');
  assert.equal(
    toErrorBody({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }, 'r').error.code,
    'INVALID_ARGUMENT',
  );
});

test('未知异常 → INTERNAL_ERROR 且不泄漏内部信息', () => {
  const body = toErrorBody(new Error('relation "users" does not exist at /srv/app/db.ts:42'), 'req-3');
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.message, '服务器内部错误');
  assert.doesNotMatch(body.error.message, /relation|db\.ts/);
  assert.equal(httpStatusFor(new Error('boom')), 500);
});

test('httpStatusFor 对 4xx 框架错误保留原状态码', () => {
  assert.equal(httpStatusFor({ code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 }), 413);
  assert.equal(httpStatusFor({ statusCode: 429 }), 429);
  assert.equal(httpStatusFor(new AppError('FORBIDDEN')), 403);
});
