/**
 * `storage/zip.ts::buildZip` 的往返测试。
 *
 * 存在的理由：MCP 发布路径（内联 HTML/Markdown → 进程内打 ZIP → 同一个
 * `writeArtifactPackage` 入口）**只**经过这个写入器，而 M2 的 artifacts 测试用的是
 * `test/zip-builder.ts` 的测试用写入器，等于这条生产路径长期无覆盖——它确实坏了：
 * ZIP 中央目录的 external attributes 用 `0o100644 << 16` 计算，JS 32 位有符号位运算溢出成
 * 负数，Node 直接抛 `ERR_OUT_OF_RANGE`（首次 MCP 发布实测到）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildZip, readZip } from '../storage/zip.js';

const INDEX = '<!doctype html><html><body>hello</body></html>';

test('buildZip → readZip：单文件往返', () => {
  const zip = buildZip([{ path: 'index.html', content: INDEX }]);
  const files = readZip(zip);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, 'index.html');
  assert.equal(files[0]?.bytes.toString('utf8'), INDEX);
});

test('buildZip → readZip：多文件（含子目录）往返，顺序保持', () => {
  const zip = buildZip([
    { path: 'index.html', content: INDEX },
    { path: 'assets/app.css', content: 'body{color:#0d0d0d}' },
    { path: 'README.md', content: '# 说明' },
  ]);
  const files = readZip(zip);
  assert.deepEqual(
    files.map((item) => item.path),
    ['index.html', 'assets/app.css', 'README.md'],
  );
  assert.equal(files[1]?.bytes.toString('utf8'), 'body{color:#0d0d0d}');
});

test('buildZip：空输入与重复路径被拒', () => {
  assert.throws(() => buildZip([]));
  assert.throws(() =>
    buildZip([
      { path: 'index.html', content: INDEX },
      { path: 'index.html', content: INDEX },
    ]),
  );
});

test('buildZip：中文文件名往返（UTF-8 标志位）', () => {
  const zip = buildZip([{ path: 'index.html', content: INDEX }, { path: '文档/说明.md', content: '# 中文' }]);
  const files = readZip(zip);
  assert.equal(files[1]?.path, '文档/说明.md');
  assert.equal(files[1]?.bytes.toString('utf8'), '# 中文');
});
