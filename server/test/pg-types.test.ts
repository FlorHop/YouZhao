/**
 * 驱动层回归：`pg` 默认把 int8/bigint 返回成字符串，而本机测试用的 PGlite 返回数字。
 * 这处差异曾让真库上的 `GET /api/blueprints` 500（fast-json-stringify 报
 * `latestVersion` 与 schema 不匹配）。这里锁住「建池即安装数字解析器」的行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { installPgTypeParsers } from '../db/pool.js';

test('pg 驱动：安装后 int8/bigint 按数字解析（与 PGlite 一致）', () => {
  installPgTypeParsers();
  const parseInt8 = pg.types.getTypeParser(20) as (value: string) => unknown;
  assert.equal(parseInt8('1024'), 1024);
  assert.equal(typeof parseInt8('33554432'), 'number', '产物大小上限 32MiB 应得到数字');
  assert.equal(parseInt8('0'), 0);
});

test('pg 驱动：int4 本来就是数字，不受影响', () => {
  installPgTypeParsers();
  const parseInt4 = pg.types.getTypeParser(23) as (value: string) => unknown;
  assert.equal(parseInt4('42'), 42);
});
