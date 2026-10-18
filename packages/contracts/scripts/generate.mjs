#!/usr/bin/env node
/**
 * 契约生成器（docs/architecture-design.md §6.1）
 *
 *   schemas/**\/*.json  ──►  generated/schemas.ts   运行时 schema 对象（as const）
 *                            generated/types.ts      FromSchema 推导的 TS 类型
 *                            generated/version.ts    契约版本（= 本包 package.json version）
 *                            generated/index.ts      统一出口
 *
 * 用法：
 *   pnpm gen             生成（覆盖 generated/）
 *   pnpm check           只校验生成物是否与 schema 同步（CI 用，过期即失败）
 *
 * 约束（校验不通过直接失败，避免"契约漂移"悄悄发生）：
 *   1. `$id` 必须等于文件相对路径（去掉 .json），例如 schemas/auth/login.json → "auth/login"
 *   2. 顶层必须有 `title`（作为生成的 TS 类型名）且全局唯一
 *   3. 顶层必须 `"type": "object"` 且 `"additionalProperties": false`
 *      —— 响应会被 Fastify 按 schema 裁剪，未声明的字段不会漏给前端
 *   4. 允许顶层 `$defs` 与**同文件** `$ref`（只接受 `#/$defs/<name>`）：
 *      `$defs` 的键必须是合法标识符，`$ref` 必须指向存在的 def；
 *      跨文件引用（`./x.json`、`http…`）仍报错退出
 *      —— 生成物原样保留 `$defs`/`$ref`（Ajv 与 json-schema-to-ts 都原生支持）
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemasDir = path.join(pkgRoot, 'schemas');
const generatedDir = path.join(pkgRoot, 'generated');
const checkOnly = process.argv.includes('--check');

const BANNER =
  '// ⚠️ 本文件由 packages/contracts/scripts/generate.mjs 生成，请勿手工修改。\n' +
  '// 契约的唯一事实来源是 packages/contracts/schemas/**/*.json。\n' +
  '// 修改契约后运行：pnpm -C packages/contracts gen\n';

/** 递归收集 schema 文件，返回按相对路径排序的绝对路径 */
async function listSchemaFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listSchemaFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

const words = (value) => value.split(/[^A-Za-z0-9]+/).filter(Boolean);
const pascal = (value) => words(value).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const camel = (value) => {
  const p = pascal(value);
  return p ? p[0].toLowerCase() + p.slice(1) : p;
};

/** `$defs` 的键必须是合法 TS/JSON Schema 标识符 */
const DEF_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 唯一允许的 `$ref` 形式：同文件内引用 */
const LOCAL_REF_RE = /^#\/\$defs\/([A-Za-z_][A-Za-z0-9_]*)$/;

/** 深度收集所有 `$ref`（含 `$defs` 内部），返回 [{ trail, value }] */
function collectRefs(value, trail = '$', found = []) {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) collectRefs(item, `${trail}[${i}]`, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref') found.push({ trail: `${trail}.$ref`, value: child });
      else collectRefs(child, `${trail}.${key}`, found);
    }
  }
  return found;
}

/**
 * 校验同文件 `$defs` / `$ref`：
 *   - `$defs`（可选）必须是对象，键为合法标识符；
 *   - 每个 `$ref` 只能是 `#/$defs/<name>`，且 `<name>` 必须已声明。
 */
function checkDefs(rel, schema, problems) {
  const defs = schema.$defs;
  const names = new Set();
  if (defs === undefined) {
    // 没有 $defs：只要出现 $ref 就会在下面报"名字不存在"
  } else if (defs === null || typeof defs !== 'object' || Array.isArray(defs)) {
    problems.push(`${rel}: $defs 必须是对象（键为 def 名）`);
  } else {
    for (const name of Object.keys(defs)) {
      if (DEF_NAME_RE.test(name)) names.add(name);
      else problems.push(`${rel}: $defs 的键 ${JSON.stringify(name)} 不是合法标识符（${DEF_NAME_RE}）`);
    }
  }

  for (const { trail, value } of collectRefs(schema)) {
    if (typeof value !== 'string') {
      problems.push(`${rel}: ${trail} 必须是字符串`);
      continue;
    }
    const matched = LOCAL_REF_RE.exec(value);
    if (!matched) {
      problems.push(
        `${rel}: ${trail} 只支持同文件引用 "#/$defs/<name>"，不支持跨文件或其他形式的 $ref` +
          `（实际是 ${JSON.stringify(value)}）`,
      );
      continue;
    }
    if (!names.has(matched[1])) {
      problems.push(`${rel}: ${trail} 指向不存在的 $defs ${JSON.stringify(matched[1])}（请补进 $defs）`);
    }
  }
}

async function readSchemas() {
  const files = await listSchemaFiles(schemasDir);
  if (files.length === 0) throw new Error(`没有找到任何 schema：${schemasDir}`);
  const schemas = [];
  const problems = [];
  const titles = new Map();

  for (const file of files) {
    const rel = path.relative(schemasDir, file).split(path.sep).join('/').replace(/\.json$/, '');
    const raw = await readFile(file, 'utf8');
    let schema;
    try {
      schema = JSON.parse(raw);
    } catch (error) {
      problems.push(`${rel}: JSON 解析失败 — ${error.message}`);
      continue;
    }
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      problems.push(`${rel}: 顶层必须是对象`);
      continue;
    }
    if (schema.$id !== rel) {
      problems.push(`${rel}: $id 必须是 "${rel}"，实际是 ${JSON.stringify(schema.$id)}`);
    }
    if (typeof schema.title !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(schema.title)) {
      problems.push(`${rel}: 缺少合法的 title（需为 TS 标识符，用作生成的类型名）`);
    } else if (titles.has(schema.title)) {
      problems.push(`${rel}: title "${schema.title}" 与 ${titles.get(schema.title)} 重复`);
    } else {
      titles.set(schema.title, rel);
    }
    if (schema.type !== 'object') problems.push(`${rel}: 顶层 type 必须是 "object"`);
    if (schema.additionalProperties !== false) {
      problems.push(`${rel}: 顶层必须声明 "additionalProperties": false（响应按 schema 裁剪）`);
    }
    checkDefs(rel, schema, problems);
    schemas.push({ rel, title: schema.title, schema });
  }

  if (problems.length > 0) {
    throw new Error(`schema 校验失败：\n  - ${problems.join('\n  - ')}`);
  }
  return schemas;
}

function renderSchemas(schemas) {
  const chunks = schemas.map(({ rel, schema }) => {
    const constName = `${camel(rel)}Schema`;
    const body = JSON.stringify(schema, null, 2)
      .split('\n')
      .map((line, index) => (index === 0 ? line : `  ${line}`))
      .join('\n');
    return `/** ${schema.title} — schemas/${rel}.json */\nexport const ${constName} = ${body} as const satisfies JsonSchema;`;
  });
  return [
    BANNER,
    "import type { JsonSchema } from '../src/json-schema.js';",
    '',
    chunks.join('\n\n'),
    '',
  ].join('\n');
}

function renderTypes(schemas) {
  const imports = schemas.map(({ rel }) => `  ${camel(rel)}Schema,`).join('\n');
  const aliases = schemas
    .map(({ rel, title }) => `export type ${title} = FromSchema<typeof ${camel(rel)}Schema>;`)
    .join('\n');
  return [
    BANNER,
    "import type { FromSchema } from 'json-schema-to-ts';",
    '',
    'import {',
    imports,
    "} from './schemas.js';",
    '',
    aliases,
    '',
  ].join('\n');
}

function renderVersion(version) {
  return [
    BANNER,
    '/** 契约版本：随本包 package.json 的 version 变化；健康检查会回传它 */',
    `export const CONTRACT_VERSION = ${JSON.stringify(version)};`,
    '',
  ].join('\n');
}

function renderIndex() {
  return [
    BANNER,
    "export * from './schemas.js';",
    "export * from './version.js';",
    "export type * from './types.js';",
    '',
  ].join('\n');
}

function renderReadme(schemas) {
  const rows = schemas
    .map(({ rel, title }) => `| \`schemas/${rel}.json\` | \`${title}\` | \`${camel(rel)}Schema\` |`)
    .join('\n');
  return [
    '# @youzhao/contracts',
    '',
    '契约的唯一事实来源是 `packages/contracts/schemas/**/*.json`（本文件由生成器维护）。',
    '',
    '## 当前契约',
    '',
    '| 文件 | 生成的类型 | 生成的运行时 schema |',
    '| --- | --- | --- |',
    rows,
    '',
    '## 命令',
    '',
    '```bash',
    'pnpm -C packages/contracts gen      # 重新生成 generated/',
    'pnpm -C packages/contracts check    # 校验生成物是否同步（CI 用）',
    '```',
    '',
    '## 新增一个动作的顺序（docs/architecture-design.md §6.1）',
    '',
    '1. 加 schema（入参 + 出参各一份，`$id` = 文件相对路径）',
    '2. 加权限矩阵行（docs/permission-design.md）',
    '3. 写用例',
    '4. 最后加界面',
    '',
    '## 约束',
    '',
    '- `$id` 必须等于文件相对路径；顶层必须有 `title`（唯一）与 `additionalProperties: false`。',
    '- 支持顶层 `$defs` 与同文件 `$ref`（只接受 `#/$defs/<name>`，名字须是合法标识符且已声明）；跨文件引用不支持。',
    '- `generated/` 提交进仓库；CI 会在生成物过期时失败。',
    '',
  ].join('\n');
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(pkgRoot, 'package.json'), 'utf8'));
  const schemas = await readSchemas();
  const outputs = new Map([
    ['schemas.ts', renderSchemas(schemas)],
    ['types.ts', renderTypes(schemas)],
    ['version.ts', renderVersion(pkg.version)],
    ['index.ts', renderIndex()],
    ['README.md', renderReadme(schemas)],
  ]);

  if (checkOnly) {
    const stale = [];
    for (const [name, content] of outputs) {
      const target = path.join(generatedDir, name);
      let current = null;
      try {
        current = await readFile(target, 'utf8');
      } catch {
        current = null;
      }
      if (current !== content) stale.push(name);
    }
    if (stale.length > 0) {
      console.error(
        `✗ 契约生成物与 schemas/ 不同步：${stale.join(', ')}\n  请运行：pnpm -C packages/contracts gen`,
      );
      process.exit(1);
    }
    console.log(`✓ 契约生成物已同步（${schemas.length} 个 schema）`);
    return;
  }

  await mkdir(generatedDir, { recursive: true });
  for (const [name, content] of outputs) {
    await writeFile(path.join(generatedDir, name), content, 'utf8');
  }
  console.log(
    `✓ 已生成 ${outputs.size} 个文件（${schemas.length} 个 schema，契约版本 ${pkg.version}）`,
  );
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
