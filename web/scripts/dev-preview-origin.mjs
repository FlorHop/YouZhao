#!/usr/bin/env node
/**
 * 本地「预览域」辅助脚本（仅开发用，不参与构建产物）。
 *
 * 为什么需要它：产物 iframe 必须与工作台**不同源**——生产里预览域是独立域名
 * （`PREVIEW_DOMAIN`），`sandbox` 属性与预览 Cookie 的跨站语义只有在不同源时才成立。
 * 本地如果让 iframe 直接指向 http://127.0.0.1:3000，就变成同源，那些行为在开发期
 * 永远测不到，上线才发现。所以开发期用这个进程在 127.0.0.1:3001 上扮演预览域。
 *
 * 两种模式：
 *   1. 静态模式（默认）：把 `PREVIEW_STORAGE_PATH` 下的产物按
 *      `/preview/p/{blueprintId}/{version}/{文件路径}` 当静态文件发出去，
 *      方便在没有后端的情况下调产物页面本身。
 *      代价：**跳过了票据鉴权**，所以它不能用来验证「产物是否匿名可读」。
 *   2. 代理模式（`--proxy`）：只把 `/preview` 前缀原样转发给应用服务，
 *      票据兑换、HttpOnly Cookie、303 跳转、CSP 响应头都走真实链路，
 *      只是换了端口，相对主应用仍然不同源。验证权限与票据行为请用这个模式。
 *
 * 环境变量：
 *   PREVIEW_STORAGE_PATH          产物目录，默认 ../server/.data/previews
 *   YOUZHAO_PREVIEW_ORIGIN_PORT   监听端口，默认 3001
 *   YOUZHAO_API_TARGET            代理目标（api），默认 http://127.0.0.1:3000
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_STORAGE = resolve(SCRIPT_DIR, '..', '..', 'server', '.data', 'previews');
const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_API_TARGET = process.env.YOUZHAO_API_TARGET ?? 'http://127.0.0.1:3000';
/** 与生产一致：产物通过 /preview/p/{blueprintId}/{version}/... 暴露。 */
const PREVIEW_BASE_PATH = '/preview';
const REQUEST_PREFIX = `${PREVIEW_BASE_PATH}/p/`;
const MAX_LISTED_VERSIONS = 500;

/** 逐跳首部不能透传（RFC 9110 §7.6.1）。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const HELP = `本地预览域辅助脚本（开发用，两种模式）

作用
  在独立端口上扮演「预览域」，让本地也有「预览域 ≠ 主应用域」的跨域效果。
  应用域默认 http://127.0.0.1:5173（Vite），预览域默认 http://127.0.0.1:3001。

用法
  node web/scripts/dev-preview-origin.mjs [选项]

选项
  --storage <目录>   静态模式的产物根目录（默认 $PREVIEW_STORAGE_PATH，
                     再默认 ../server/.data/previews），目录不存在会明确报错
  --port <端口>      监听端口，默认 ${DEFAULT_PORT}（$YOUZHAO_PREVIEW_ORIGIN_PORT）
  --host <地址>      监听地址，默认 ${DEFAULT_HOST}
  --proxy [源]       代理模式：只把 /preview 转发给应用服务
                     （默认 $YOUZHAO_API_TARGET，即 ${DEFAULT_API_TARGET}）
  -h, --help         显示本说明

示例
  pnpm -C web dev:preview-origin                       # 静态模式打开预览域首页
  node web/scripts/dev-preview-origin.mjs --proxy      # 代理模式，验证票据与权限

提示
  · 静态模式跳过了票据鉴权，只用于调样式；验证权限/票据请用代理模式。
  · 产物目录布局为 {根}/{blueprintId}/{version}/index.html 及其它静态资源。
  · 在应用里测试时，把上面打印的地址配成 VITE_PREVIEW_ORIGIN。
`;

function parseArgs(argv) {
  const options = {
    storage: process.env.PREVIEW_STORAGE_PATH ?? DEFAULT_STORAGE,
    port: Number(process.env.YOUZHAO_PREVIEW_ORIGIN_PORT ?? DEFAULT_PORT),
    host: DEFAULT_HOST,
    proxy: false,
    proxyTarget: DEFAULT_API_TARGET,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const next = argv[index + 1];
    const takeValue = () => {
      if (next !== undefined && !next.startsWith('-')) {
        index += 1;
        return next;
      }
      return undefined;
    };
    if (arg === '--storage') {
      options.storage = takeValue() ?? options.storage;
      continue;
    }
    if (arg === '--port') {
      options.port = Number(takeValue() ?? options.port);
      continue;
    }
    if (arg === '--host') {
      options.host = takeValue() ?? options.host;
      continue;
    }
    if (arg === '--proxy') {
      options.proxy = true;
      options.proxyTarget = takeValue() ?? options.proxyTarget;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const [flag, value] = arg.split(/=(.*)/s);
      if (flag === '--storage') options.storage = value ?? options.storage;
      else if (flag === '--port') options.port = Number(value);
      else if (flag === '--host') options.host = value ?? options.host;
      else if (flag === '--proxy') {
        options.proxy = true;
        options.proxyTarget = value === undefined || value === '' ? options.proxyTarget : value;
      } else {
        process.stderr.write(`未知参数：${arg}\n\n${HELP}`);
        process.exit(2);
      }
      continue;
    }
    process.stderr.write(`未知参数：${arg}\n\n${HELP}`);
    process.exit(2);
  }
  return options;
}

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.wasm', 'application/wasm'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
]);

/** 生产中服务端给产物页设的响应头，本地保持一致，便于排查 sandbox 相关问题。 */
const ARTIFACT_HEADERS = {
  'content-security-policy': 'sandbox allow-scripts allow-popups',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(text);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(html);
}

/**
 * 把请求路径映射到产物目录里的真实文件，并挡住目录穿越与非法段。
 * 返回 { kind: 'file', path } / { kind: 'not-found' } / { kind: 'invalid' }。
 */
async function resolveRequest(storageRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname.slice(REQUEST_PREFIX.length));
  } catch {
    return { kind: 'invalid' };
  }
  if (decoded.includes('\0')) return { kind: 'invalid' };
  const segments = decoded.split('/').filter((segment) => segment !== '');
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      return { kind: 'invalid' };
    }
  }
  const blueprintId = segments[0];
  const version = segments[1];
  if (blueprintId === undefined || version === undefined) return { kind: 'invalid' };
  const relativeParts = segments.length > 2 ? segments.slice(2) : ['index.html'];
  const versionDir = join(storageRoot, blueprintId, version);
  const filePath = join(versionDir, ...relativeParts);
  // 双保险：解析后的路径必须仍在版本目录内。
  if (filePath !== versionDir && !filePath.startsWith(versionDir + sep)) return { kind: 'invalid' };
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      const indexPath = join(filePath, 'index.html');
      const indexInfo = await stat(indexPath);
      return indexInfo.isFile() ? { kind: 'file', path: indexPath } : { kind: 'not-found' };
    }
    return info.isFile() ? { kind: 'file', path: filePath } : { kind: 'not-found' };
  } catch {
    return { kind: 'not-found' };
  }
}

/** 列出产物目录下的 蓝图/版本，方便直接粘贴地址。 */
async function listArtifacts(storageRoot, origin) {
  const rows = [];
  let entries;
  try {
    entries = await readdir(storageRoot, { withFileTypes: true });
  } catch {
    return rows;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let versions;
    try {
      versions = await readdir(join(storageRoot, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!version.isDirectory() || version.name.startsWith('.')) continue;
      rows.push({
        blueprintId: entry.name,
        version: version.name,
        url: `${origin}${REQUEST_PREFIX}${entry.name}/${version.name}/`,
      });
      if (rows.length >= MAX_LISTED_VERSIONS) return rows;
    }
  }
  return rows;
}

function renderIndex(storageRoot, origin, rows) {
  const items = rows
    .map(
      (row) =>
        `<li><a href="${escapeHtml(row.url)}">${escapeHtml(row.blueprintId)} / ${escapeHtml(row.version)}</a></li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>本地预览域（开发用）</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.7; padding: 24px; max-width: 900px">
<h1>本地预览域（开发用）</h1>
<p>产物目录：<code>${escapeHtml(storageRoot)}</code></p>
<p>把这个地址配成 <code>VITE_PREVIEW_ORIGIN</code>：<code>${escapeHtml(origin)}</code></p>
<p>可打开的产物（共 ${rows.length} 项${rows.length >= MAX_LISTED_VERSIONS ? '，已达展示上限' : ''}）：</p>
<ul>${items === '' ? '<li>（这里还没有任何产物）</li>' : items}</ul>
<p>注意：静态模式跳过了票据鉴权，仅用于调样式；验证权限与票据请用 <code>--proxy</code>。</p>
</body>
</html>`;
}

/** 代理模式：只转发 /preview，保留 303 跳转与 Set-Cookie。 */
function proxyPreview(request, response, target, targetPort) {
  const url = request.url ?? PREVIEW_BASE_PATH;
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  // host 必须重写成目标主机的，否则服务端按来源域判断会走错分支。
  headers.host = `${target.hostname}:${targetPort}`;
  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: targetPort,
      method: request.method,
      path: url,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      for (const name of Object.keys(responseHeaders)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) delete responseHeaders[name];
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    process.stderr.write(`[preview-origin] 转发失败：${error.message}\n`);
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    response.end('预览域转发失败，请确认应用服务已启动。\n');
  });
  request.pipe(upstream);
}

function serveStatic(request, response, storageRoot, origin) {
  const pathname = (request.url ?? '/').split('?')[0] ?? '/';
  if (pathname === '/' || pathname === '/index.html' || pathname === PREVIEW_BASE_PATH) {
    void listArtifacts(storageRoot, origin).then((rows) => {
      sendHtml(response, 200, renderIndex(storageRoot, origin, rows));
    });
    return;
  }
  if (!pathname.startsWith(REQUEST_PREFIX)) {
    sendText(
      response,
      404,
      `未找到 ${pathname}。产物路径形如 ${REQUEST_PREFIX}{blueprintId}/{version}/\n`,
    );
    return;
  }
  void resolveRequest(storageRoot, pathname).then((result) => {
    if (result.kind === 'invalid') {
      sendText(response, 400, '路径不合法。\n');
      return;
    }
    if (result.kind === 'not-found') {
      sendText(
        response,
        404,
        `产物不存在：${pathname}\n请确认该蓝图与版本在 ${storageRoot} 下已经生成。\n`,
      );
      return;
    }
    response.writeHead(200, {
      'content-type': contentTypeFor(result.path),
      ...ARTIFACT_HEADERS,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(result.path);
    stream.on('error', () => {
      response.destroy();
    });
    stream.pipe(response);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    process.stderr.write(`端口不合法：${String(options.port)}\n`);
    process.exit(2);
  }
  const storageRoot = resolve(options.storage);
  let target = null;
  let targetPort = 0;
  if (options.proxy) {
    let parsed;
    try {
      parsed = new URL(options.proxyTarget);
    } catch {
      process.stderr.write(`代理目标不是合法地址：${options.proxyTarget}\n`);
      process.exit(2);
      return;
    }
    target = parsed;
    targetPort = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  } else {
    let info;
    try {
      info = await stat(storageRoot);
    } catch {
      process.stderr.write(
        `产物目录不存在：${storageRoot}\n` +
          '请确认已经发布过产物，或用 --storage <目录> / 环境变量 PREVIEW_STORAGE_PATH 指定正确路径。\n' +
          '服务端默认写入 server/.data/previews（生产为 /data/youzhao/previews）。\n',
      );
      process.exit(1);
    }
    if (!info.isDirectory()) {
      process.stderr.write(`产物路径不是目录：${storageRoot}\n`);
      process.exit(1);
    }
  }
  const origin = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}`;

  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, '只支持 GET / HEAD\n', { allow: 'GET, HEAD' });
      return;
    }
    if (target !== null) {
      const pathname = (request.url ?? '/').split('?')[0] ?? '/';
      if (!pathname.startsWith(PREVIEW_BASE_PATH)) {
        sendText(
          response,
          404,
          `这个端口只转发 ${PREVIEW_BASE_PATH} 前缀（开发用预览域）。应用请访问 http://127.0.0.1:5173\n`,
        );
        return;
      }
      proxyPreview(request, response, target, targetPort);
      return;
    }
    serveStatic(request, response, storageRoot, origin);
  });

  server.on('error', (error) => {
    process.stderr.write(`启动失败：${error.message}\n`);
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    if (target === null) {
      process.stdout.write(`[preview-origin] 静态模式：${origin}/ ← ${storageRoot}\n`);
      process.stdout.write(`[preview-origin] 产物地址形如 ${origin}${REQUEST_PREFIX}{blueprintId}/{version}/\n`);
      process.stdout.write(
        '[preview-origin] 提示：静态模式跳过了票据鉴权，验证权限/票据请改用 --proxy\n',
      );
    } else {
      process.stdout.write(
        `[preview-origin] 代理模式：${origin}${PREVIEW_BASE_PATH} → ${options.proxyTarget}${PREVIEW_BASE_PATH}\n`,
      );
    }
    process.stdout.write(`[preview-origin] VITE_PREVIEW_ORIGIN=${origin}\n`);
  });
}

await main();
