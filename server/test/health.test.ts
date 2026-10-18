import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION } from '@youzhao/contracts/version';
import { loadConfig } from '../config.js';
import { buildServer } from '../http/app.js';
import type { Db } from '../db/types.js';
import { minimalEnv, unusedDb } from './helpers.js';

const config = loadConfig(minimalEnv());
// 健康检查不读数据库：用会在访问时报错的替身，确保这条纪律不被悄悄破坏
const db = unusedDb() as Db;

test('健康检查：数据库可达 → 200 ok，带契约版本与请求 id', async () => {
  const app = buildServer({ config, db, probeDatabase: async () => 'up' });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-contract-version'], CONTRACT_VERSION);

    const body = response.json();
    assert.equal(body.data.status, 'ok');
    assert.equal(body.data.contractVersion, CONTRACT_VERSION);
    assert.deepEqual(body.data.services, { database: 'up' });
    assert.equal(typeof body.data.time, 'string');
    assert.equal(typeof body.meta.requestId, 'string');
    assert.ok(body.meta.requestId.length > 0);
    assert.equal(response.headers['x-request-id'], body.meta.requestId);
  } finally {
    await app.close();
  }
});

test('健康检查：数据库不可达 → 503 degraded（网关据此摘流量）', async () => {
  const app = buildServer({ config, db, probeDatabase: async () => 'down' });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 503);
    const body = response.json();
    assert.equal(body.data.status, 'degraded');
    assert.deepEqual(body.data.services, { database: 'down' });
  } finally {
    await app.close();
  }
});

test('探针抛异常时按不可达处理，不把异常漏给调用方', async () => {
  const app = buildServer({
    config,
    db,
    probeDatabase: async () => {
      throw new Error('connection refused');
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().data.services.database, 'down');
  } finally {
    await app.close();
  }
});

test('未知路由 → 404 + NOT_FOUND 错误信封', async () => {
  const app = buildServer({ config, db, probeDatabase: async () => 'up' });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(typeof body.error.requestId, 'string');
    assert.equal(body.data, undefined);
  } finally {
    await app.close();
  }
});
