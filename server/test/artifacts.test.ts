/**
 * 产物包解包与落盘的安全性测试（docs/architecture-design.md §3.6）。
 *
 * 这一组的价值不在"能读压缩包"，而在**该拒绝的一定拒绝**：路径穿越、符号链接、
 * zip bomb、声明与实际不符、半个产物留在磁盘上。旧实现正是栽在这里。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AppError } from '../domain/errors.js';
import {
  artifactDirFor,
  computeArtifactHash,
  resolveArtifactPath,
  writeArtifactPackage,
} from '../storage/artifacts.js';
import { DEFAULT_ZIP_LIMITS, readZip, requireEntryHtml, type ZipEntry } from '../storage/zip.js';
import { buildZip, SAMPLE_INDEX_HTML } from './zip-builder.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'youzhao-artifacts-'));
}

function expectArtifactInvalid(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError, `期望 AppError，实际 ${String(error)}`);
    assert.equal(error.code, 'ARTIFACT_INVALID');
    return error;
  }
  throw new Error('期望抛出 ARTIFACT_INVALID，实际没有抛错');
}

// ── ZIP 读取 ──────────────────────────────────────────────────────────────

test('zip：store 与 deflate 两种压缩方式都能读取，并规范化路径', () => {
  const zip = buildZip([
    { path: './index.html', data: SAMPLE_INDEX_HTML, method: 0 },
    { path: 'assets/app.js', data: 'console.log(1)', method: 8 },
  ]);
  const files = readZip(zip);
  assert.deepEqual(
    files.map((file) => file.path),
    ['index.html', 'assets/app.js'],
  );
  assert.equal(files[0]!.bytes.toString('utf8'), SAMPLE_INDEX_HTML);
  assert.equal(files[1]!.bytes.toString('utf8'), 'console.log(1)');
});

test('zip：拒绝 `..` 路径穿越', () => {
  const zip = buildZip([{ path: 'assets/../../evil.txt', data: 'x' }]);
  expectArtifactInvalid(() => readZip(zip));
});

test('zip：拒绝绝对路径', () => {
  const zip = buildZip([{ path: '/etc/passwd', data: 'x' }]);
  expectArtifactInvalid(() => readZip(zip));
});

test('zip：拒绝反斜杠穿越（Windows 风格路径）', () => {
  const zip = buildZip([{ path: '..\\evil.txt', data: 'x' }]);
  expectArtifactInvalid(() => readZip(zip));
});

test('zip：拒绝符号链接条目', () => {
  const zip = buildZip([{ path: 'link.html', data: '/etc/passwd', symlink: true }]);
  expectArtifactInvalid(() => readZip(zip));
});

test('zip：拒绝 zip64 标记的压缩包', () => {
  const zip = buildZip([{ path: 'index.html', data: SAMPLE_INDEX_HTML }], { zip64: true });
  expectArtifactInvalid(() => readZip(zip));
});

test('zip：条目数超过上限即拒绝', () => {
  const zip = buildZip([
    { path: 'index.html', data: SAMPLE_INDEX_HTML },
    { path: 'a.txt', data: 'a' },
    { path: 'b.txt', data: 'b' },
  ]);
  expectArtifactInvalid(() => readZip(zip, { ...DEFAULT_ZIP_LIMITS, maxEntries: 2 }));
});

test('zip：单个文件解压后超过上限即拒绝', () => {
  const zip = buildZip([{ path: 'index.html', data: 'x'.repeat(2048) }]);
  expectArtifactInvalid(() => readZip(zip, { ...DEFAULT_ZIP_LIMITS, maxFileBytes: 1024 }));
});

test('zip：解压后总体积超过上限即拒绝', () => {
  const zip = buildZip([
    { path: 'index.html', data: 'x'.repeat(900) },
    { path: 'a.txt', data: 'y'.repeat(900) },
  ]);
  expectArtifactInvalid(() => readZip(zip, { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 1500 }));
});

test('zip：压缩比异常（zip bomb 特征）即拒绝', () => {
  const zip = buildZip([{ path: 'index.html', data: 'A'.repeat(200_000) }]);
  expectArtifactInvalid(() => readZip(zip));
});

test('zip：重复条目即拒绝', () => {
  const zip = buildZip([
    { path: 'index.html', data: 'a' },
    { path: 'index.html', data: 'b' },
  ]);
  expectArtifactInvalid(() => readZip(zip));
});

test('zip：禁止服务端脚本与环境文件进入产物包', () => {
  for (const name of ['server.mjs', 'run.cjs', '.env', 'secret.pem']) {
    const zip = buildZip([
      { path: 'index.html', data: SAMPLE_INDEX_HTML },
      { path: name, data: 'x' },
    ]);
    expectArtifactInvalid(() => readZip(zip));
  }
});

test('zip：中央目录声明的大小与实体不符即拒绝', () => {
  const zip = buildZip([{ path: 'index.html', data: 'hello', declaredSize: 99 }]);
  expectArtifactInvalid(() => readZip(zip));
});

test('zip：入口必须是根级 index.html', () => {
  const nested = readZip(buildZip([{ path: 'sub/index.html', data: SAMPLE_INDEX_HTML }]));
  expectArtifactInvalid(() => requireEntryHtml(nested));
  const root = readZip(buildZip([{ path: 'index.html', data: SAMPLE_INDEX_HTML }]));
  assert.equal(requireEntryHtml(root).path, 'index.html');
});

// ── 路径解析 ──────────────────────────────────────────────────────────────

test('resolveArtifactPath：正常路径落在版本目录内', () => {
  const resolved = resolveArtifactPath({
    root: '/data/previews',
    blueprintId: 'bp_1',
    version: 'v1.0.0',
    relPath: 'assets/app.js',
  });
  assert.equal(resolved, path.resolve('/data/previews/bp_1/v1.0.0/assets/app.js'));
});

test('resolveArtifactPath：拒绝穿越、NUL 与非法段名', () => {
  const base = { root: '/data/previews', blueprintId: 'bp_1', version: 'v1.0.0' };
  expectArtifactInvalid(() => resolveArtifactPath({ ...base, relPath: '../../etc/passwd' }));
  expectArtifactInvalid(() => resolveArtifactPath({ ...base, relPath: 'a\0b.html' }));
  expectArtifactInvalid(() =>
    resolveArtifactPath({ ...base, blueprintId: '../bp_1', relPath: 'index.html' }),
  );
  expectArtifactInvalid(() =>
    resolveArtifactPath({ ...base, version: '..', relPath: 'index.html' }),
  );
});

test('artifactDirFor：版本号里的点开头被拒绝', () => {
  expectArtifactInvalid(() => artifactDirFor('/data/previews', 'bp_1', '..'));
  assert.equal(
    artifactDirFor('/data/previews', 'bp_1', 'v2.0.0'),
    path.resolve('/data/previews/bp_1/v2.0.0'),
  );
});

// ── 落盘 ────────────────────────────────────────────────────────────────

test('writeArtifactPackage：写入文件与 manifest，sha256 与写入顺序无关', async () => {
  const root = await tempRoot();
  const files: readonly ZipEntry[] = readZip(
    buildZip([
      { path: 'index.html', data: SAMPLE_INDEX_HTML },
      { path: 'assets/app.js', data: 'console.log(1)' },
    ]),
  );
  const result = await writeArtifactPackage({
    root,
    blueprintId: 'bp_1',
    version: 'v1.0.0',
    files,
    replace: false,
  });
  assert.equal(
    result.bytes,
    Buffer.byteLength(SAMPLE_INDEX_HTML) + Buffer.byteLength('console.log(1)'),
  );
  const written = await readFile(path.join(result.artifactPath, 'assets/app.js'), 'utf8');
  assert.equal(written, 'console.log(1)');

  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
    blueprintId: string;
    version: string;
    entry: string;
    sha256: string;
    files: { path: string; bytes: number }[];
  };
  assert.equal(manifest.blueprintId, 'bp_1');
  assert.equal(manifest.version, 'v1.0.0');
  assert.equal(manifest.entry, 'index.html');
  assert.equal(manifest.sha256, result.hash);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ['assets/app.js', 'index.html'],
  );

  const shuffled: readonly ZipEntry[] = [files[1]!, files[0]!];
  assert.equal(computeArtifactHash(shuffled), computeArtifactHash(files));
});

test('writeArtifactPackage：同版本重复发布且未声明覆盖 → VERSION_CONFLICT', async () => {
  const root = await tempRoot();
  const files = readZip(buildZip([{ path: 'index.html', data: SAMPLE_INDEX_HTML }]));
  await writeArtifactPackage({ root, blueprintId: 'bp_1', version: 'v1.0.0', files, replace: false });
  await assert.rejects(
    () => writeArtifactPackage({ root, blueprintId: 'bp_1', version: 'v1.0.0', files, replace: false }),
    (error: unknown) => error instanceof AppError && error.code === 'VERSION_CONFLICT',
  );
});

test('writeArtifactPackage：覆盖发布替换目录并保留 .bak 供回滚', async () => {
  const root = await tempRoot();
  const first = readZip(buildZip([{ path: 'index.html', data: 'v1' }]));
  const second = readZip(buildZip([{ path: 'index.html', data: 'v2' }]));
  await writeArtifactPackage({ root, blueprintId: 'bp_1', version: 'v1.0.0', files: first, replace: false });
  const result = await writeArtifactPackage({
    root,
    blueprintId: 'bp_1',
    version: 'v1.0.0',
    files: second,
    replace: true,
  });
  assert.equal(await readFile(path.join(result.artifactPath, 'index.html'), 'utf8'), 'v2');
  assert.ok(result.backupPath !== null);
  assert.equal(await readFile(path.join(result.backupPath, 'index.html'), 'utf8'), 'v1');
});

test('writeArtifactPackage：中途失败不留半成品，也不留临时目录', async () => {
  const root = await tempRoot();
  const files: readonly ZipEntry[] = [{ path: '../escape.html', bytes: Buffer.from('x') }];
  await assert.rejects(() => writeArtifactPackage({
    root,
    blueprintId: 'bp_1',
    version: 'v1.0.0',
    files,
    replace: false,
  }));
  const entries = await readdir(root);
  assert.deepEqual(entries, []);
  await assert.rejects(() => stat(path.join(root, 'bp_1')));
});
