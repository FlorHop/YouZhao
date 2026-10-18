import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runGenerator(cwd, args = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/generate.mjs', ...args],
      { cwd },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }),
    );
  });
}

/** 复制一份最小契约包（scripts + schemas + package.json）用于反向用例 */
async function makeTempPackage(schemas = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'youzhao-contracts-'));
  await cp(path.join(pkgRoot, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  await mkdir(path.join(dir, 'schemas'), { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp-contracts', version: '0.0.1', type: 'module' }),
    'utf8',
  );
  for (const [name, schema] of Object.entries(schemas)) {
    await writeFile(path.join(dir, 'schemas', name), JSON.stringify(schema, null, 2), 'utf8');
  }
  return dir;
}

const validSchema = (overrides = {}) => ({
  $id: 'thing',
  title: 'Thing',
  type: 'object',
  properties: { a: { type: 'string' } },
  required: ['a'],
  additionalProperties: false,
  ...overrides,
});

test('check 模式：当前生成物与 schemas 同步', async () => {
  const result = await runGenerator(pkgRoot, ['--check']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已同步/);
});

test('生成产物是确定性的：连续两次生成的字节一致', async () => {
  const before = await readFile(path.join(pkgRoot, 'generated/schemas.ts'), 'utf8');
  const result = await runGenerator(pkgRoot);
  assert.equal(result.code, 0, result.stderr);
  const after = await readFile(path.join(pkgRoot, 'generated/schemas.ts'), 'utf8');
  assert.equal(before, after);
});

test('$id 与文件路径不一致 → 生成失败并指出问题', async () => {
  const dir = await makeTempPackage({ 'thing.json': validSchema({ $id: 'wrong/id' }) });
  try {
    const result = await runGenerator(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /\$id 必须是 "thing"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺少 additionalProperties:false → 生成失败（响应必须按 schema 裁剪）', async () => {
  const dir = await makeTempPackage({ 'thing.json': validSchema({ additionalProperties: true }) });
  try {
    const result = await runGenerator(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /additionalProperties/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('title 重复 → 生成失败（类型名会冲突）', async () => {
  const dir = await makeTempPackage({
    'a.json': validSchema({ $id: 'a', title: 'Same' }),
    'b.json': validSchema({ $id: 'b', title: 'Same' }),
  });
  try {
    const result = await runGenerator(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /title "Same" 与 a 重复/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('同文件 $defs + $ref → 生成成功且产物原样保留 $defs', async () => {
  const dir = await makeTempPackage({
    'thing.json': validSchema({
      $defs: {
        Inner: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: ['x'],
          additionalProperties: false,
        },
      },
      properties: { a: { $ref: '#/$defs/Inner' } },
    }),
  });
  try {
    const result = await runGenerator(dir);
    assert.equal(result.code, 0, result.stderr);
    const generated = await readFile(path.join(dir, 'generated/schemas.ts'), 'utf8');
    assert.match(generated, /"\$defs"/);
    assert.match(generated, /"\$ref": "#\/\$defs\/Inner"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('跨文件或非法形式的 $ref → 生成失败', async () => {
  const refs = ['./other.json', 'https://example.com/x.json#/$defs/A', '#/definitions/Inner'];
  for (const ref of refs) {
    const dir = await makeTempPackage({
      'thing.json': validSchema({ properties: { a: { $ref: ref } } }),
    });
    try {
      const result = await runGenerator(dir);
      assert.equal(result.code, 1, `${ref} 应当生成失败`);
      assert.match(result.stderr, /只支持同文件引用/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('$ref 指向不存在的 $defs → 生成失败并列出缺失的名字', async () => {
  const dir = await makeTempPackage({
    'thing.json': validSchema({
      $defs: { Present: { type: 'string' } },
      properties: { a: { $ref: '#/$defs/Missing' } },
    }),
  });
  try {
    const result = await runGenerator(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /指向不存在的 \$defs "Missing"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('生成物过期时 check 会失败（CI 门禁）', async () => {
  const dir = await makeTempPackage({ 'thing.json': validSchema() });
  try {
    const generated = await runGenerator(dir);
    assert.equal(generated.code, 0, generated.stderr);
    assert.equal((await runGenerator(dir, ['--check'])).code, 0);

    // 新增 schema 但不重新生成 → check 必须失败并提示运行 gen
    await writeFile(
      path.join(dir, 'schemas', 'extra.json'),
      JSON.stringify(validSchema({ $id: 'extra', title: 'Extra' }), null, 2),
      'utf8',
    );
    const stale = await runGenerator(dir, ['--check']);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /不同步/);
    assert.match(stale.stderr, /pnpm -C packages\/contracts gen/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
