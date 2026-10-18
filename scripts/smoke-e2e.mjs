#!/usr/bin/env node
/**
 * 端到端冒烟测试（M6 验收用）：对着**一个真的在跑的 api** 走完一条主干链路。
 *
 *   node scripts/smoke-e2e.mjs                        # 默认 http://127.0.0.1:3000
 *   node scripts/smoke-e2e.mjs --base https://youzhao.example.com \
 *        --origin https://youzhao.example.com --preview https://preview.youzhao.example.com
 *
 * 覆盖：健康检查 → 登录 → 会话 → 分组 → 建组 → 建 MCP Token → MCP tools/list →
 * MCP 发布蓝图 → 蓝图列表/详情 → 预览票据 → 换票换 Cookie → 取产物（校验 CSP）→
 * 匿名取产物被拒 → 票据单次 → 删除 Token → 删除后 Token 立即失效。
 *
 * 参数与环境变量：
 *   --base <url>      api 地址（默认 $YOUZHAO_SMOKE_BASE 或 http://127.0.0.1:3000）
 *   --preview <url>   预览域地址（默认与 --base 相同；本地跑 dev:preview-origin 时传 http://127.0.0.1:3001）
 *   --origin <url>    写请求带的 Origin，必须在服务端 CSRF_ORIGIN_ALLOWLIST 里（默认 http://127.0.0.1:5173）
 *   --username/--password  所有者账号（默认取 $ADMIN_USERNAME/$ADMIN_PASSWORD）
 *   --keep           不删除本次创建的 MCP Token（默认删除，顺带验证删除后立即失效）
 *
 * 只用 node 内置能力（fetch + crypto），不依赖任何三方包，退出码非 0 表示失败。
 */
// ── 参数 ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'keep') {
      out.keep = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`参数 --${key} 缺少取值`);
    out[key] = value;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = trimSlash(args.base ?? process.env.YOUZHAO_SMOKE_BASE ?? 'http://127.0.0.1:3000');
const previewBase = trimSlash(args.preview ?? base);
const origin = trimSlash(args.origin ?? 'http://127.0.0.1:5173');
const username = args.username ?? process.env.ADMIN_USERNAME ?? 'admin';
const password = args.password ?? process.env.ADMIN_PASSWORD ?? 'local-dev-owner-password';

function trimSlash(value) {
  return value.replace(/\/+$/, '');
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ── 极简 Cookie 罐（node fetch 不保存 Cookie）──────────────────────────
/** path → value；同一路径重复出现时后者覆盖 */
const cookies = new Map();

function cookieHeaderFor(path) {
  const pairs = [];
  for (const [cookiePath, value] of cookies) {
    if (path.startsWith(cookiePath)) pairs.push(value);
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function storeCookies(path, response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (eq <= 0) continue;
    const value = pair.slice(0, eq).trim() + '=' + pair.slice(eq + 1).trim();
    const pathAttr = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('path='));
    cookies.set(pathAttr ? pathAttr.slice(5) : '/', value);
  }
}

// ── 步骤框架 ─────────────────────────────────────────────────────────
const results = [];
let stepIndex = 0;

async function step(title, run) {
  stepIndex += 1;
  const label = `${String(stepIndex).padStart(2, '0')}. ${title}`;
  const startedAt = Date.now();
  try {
    const note = await run();
    results.push({ label, ok: true, note: note ?? '' });
    console.log(`✓ ${label}${note ? ` — ${note}` : ''} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    results.push({ label, ok: false, note: error instanceof Error ? error.message : String(error) });
    console.error(`✗ ${label} — ${error instanceof Error ? error.message : String(error)}`);
  }
  return results.at(-1).ok;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 带 Cookie 与 Origin 的请求；`allowRedirect: false` 用来观察 303。 */
async function request(target, { method = 'GET', body, headers = {}, allowRedirect = true, expect } = {}) {
  const url = new URL(target);
  const cookie = cookieHeaderFor(url.pathname);
  const init = {
    method,
    redirect: allowRedirect ? 'follow' : 'manual',
    headers: {
      Accept: 'application/json',
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, init);
  storeCookies(url.pathname, response);
  if (expect !== undefined && response.status !== expect) {
    const text = await response.text().catch(() => '');
    throw new Error(`${method} ${url.pathname} 期望 ${expect}，实际 ${response.status}：${text.slice(0, 240)}`);
  }
  return response;
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 240)}`);
  }
}

async function api(path, options = {}) {
  return request(`${base}${path}`, options);
}

/** 解析 MCP 的 SSE 或 JSON 响应体，返回第一条 JSON-RPC 报文。 */
function parseMcpPayload(contentType, text) {
  if (contentType.includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    assert(line !== undefined, 'SSE 响应里没有 data: 帧');
    return JSON.parse(line.slice(6));
  }
  return JSON.parse(text);
}

async function mcpCall(token, message) {
  const response = await request(`${base}/mcp`, {
    method: 'POST',
    body: message,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
    },
  });
  const text = await response.text();
  return { status: response.status, message: parseMcpPayload(response.headers.get('content-type') ?? '', text) };
}

// ── 主干链路 ─────────────────────────────────────────────────────────
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** 每轮冒烟都造一组带戳的唯一名字，便于重复执行 */
const names = {
  group: `冒烟分组 ${stamp}`,
  blueprint: `冒烟蓝图 ${stamp}`,
  version: `1.0.${Date.now() % 1000}`,
  token: `冒烟 Token ${stamp}`,
};

let sessionUserId = '';
let groupId = '';
let tokenId = '';
let token = '';
let blueprintId = '';
let ticket = '';
let ticketUrl = '';

const script = [
  [
    '健康检查',
    async () => {
      const envelope = await json(await api('/api/health', { expect: 200 }));
      assert(envelope.data.status === 'ok', `status=${envelope.data.status}`);
      assert(envelope.data.services.database === 'up', `database=${envelope.data.services.database}`);
      return `契约版本 ${envelope.data.contractVersion}`;
    },
  ],
  [
    '登录（所有者）',
    async () => {
      const envelope = await json(
        await api('/api/auth/login', { method: 'POST', body: { username, password }, expect: 200 }),
      );
      sessionUserId = envelope.data.user.id;
      assert(sessionUserId.startsWith('usr_'), `用户 id 形状异常：${sessionUserId}`);
      return `${envelope.data.user.displayName}（${envelope.data.user.identity}）`;
    },
  ],
  [
    '读取会话',
    async () => {
      const envelope = await json(await api('/api/me', { expect: 200 }));
      assert(envelope.data.user.id === sessionUserId, '会话用户与登录用户不一致');
      return 'Cookie 会话有效';
    },
  ],
  [
    '列出蓝图分组',
    async () => {
      const envelope = await json(await api('/api/blueprint-groups', { expect: 200 }));
      assert(Array.isArray(envelope.data.items), 'items 不是数组');
      const hasDefault = envelope.data.items.some((item) => item.isDefault === true);
      assert(hasDefault, '缺少默认分组（group_default）');
      return `${envelope.data.items.length} 个分组`;
    },
  ],
  [
    '创建分组',
    async () => {
      const envelope = await json(
        await api('/api/blueprint-groups', { method: 'POST', body: { name: names.group }, expect: 200 }),
      );
      groupId = envelope.data.group.id;
      assert(groupId.startsWith('grp_'), `分组 id 形状异常：${groupId}`);
      return groupId;
    },
  ],
  [
    '创建 MCP Token（明文只出现一次）',
    async () => {
      const envelope = await json(
        await api('/api/mcp-tokens', {
          method: 'POST',
          body: { name: names.token, scopes: ['read:blueprint', 'publish:blueprint'] },
          expect: 201,
        }),
      );
      token = envelope.data.token;
      tokenId = envelope.data.id;
      assert(token.startsWith('yz_mcp_'), `Token 明文形状异常：${token.slice(0, 12)}…`);
      assert(!JSON.stringify(envelope.data).includes('token_hash'), '响应里出现了 token_hash');
      return `${envelope.data.tokenPrefix}…`;
    },
  ],
  [
    'MCP tools/list',
    async () => {
      const { status, message } = await mcpCall(token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });
      assert(status === 200, `HTTP ${status}`);
      const tools = message.result?.tools ?? [];
      assert(tools.length === 8, `工具数 ${tools.length}，期望 8`);
      assert(tools.every((tool) => tool.outputSchema !== undefined), '存在没有 outputSchema 的工具');
      return `${tools.length} 个工具，均带入/出参 schema`;
    },
  ],
  [
    'MCP 发布蓝图（内联 HTML → 服务端打包）',
    async () => {
      const { status, message } = await mcpCall(token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'youzhao.publish_blueprint',
          arguments: {
            name: names.blueprint,
            groupId,
            version: names.version,
            html: `<!doctype html><html><body><h1>${names.blueprint}</h1><p>冒烟测试产物</p></body></html>`,
            summary: '端到端冒烟测试生成',
          },
        },
      });
      assert(status === 200, `HTTP ${status}`);
      assert(message.result?.isError !== true, `工具返回错误：${JSON.stringify(message.result).slice(0, 240)}`);
      const structured = message.result?.structuredContent ?? {};
      blueprintId = structured.blueprint?.id ?? '';
      assert(blueprintId.startsWith('bp_'), `蓝图 id 形状异常：${blueprintId}`);
      return `${blueprintId} @ ${structured.version?.version}`;
    },
  ],
  [
    '蓝图列表与详情',
    async () => {
      const list = await json(await api('/api/blueprints', { expect: 200 }));
      assert(
        list.data.items.some((item) => item.id === blueprintId),
        '新建的蓝图没有出现在列表里',
      );
      const detail = await json(await api(`/api/blueprints/${blueprintId}`, { expect: 200 }));
      const versions = detail.data.versions ?? [];
      assert(versions.some((item) => item.version === names.version), '版本没有出现在详情里');
      assert(detail.data.capabilities.canPublish === true, '所有者应具备发布能力');
      return `${list.data.items.length} 个蓝图 / ${versions.length} 个版本`;
    },
  ],
  [
    '申请预览票据',
    async () => {
      const envelope = await json(
        await api('/api/preview-tickets', {
          method: 'POST',
          body: { blueprintId, version: names.version, purpose: 'preview' },
          expect: 200,
        }),
      );
      ticket = envelope.data.ticket;
      ticketUrl = envelope.data.url;
      assert(ticket.startsWith('yz_pt_'), `票据形状异常：${ticket.slice(0, 12)}…`);
      assert(ticketUrl.includes('/preview/'), `预览地址异常：${ticketUrl}`);
      return new URL(ticketUrl).host;
    },
  ],
  [
    '票据换 Cookie（应 303）',
    async () => {
      const url = new URL(ticketUrl);
      const response = await request(`${previewBase}${url.pathname}${url.search}`, {
        allowRedirect: false,
        expect: 303,
      });
      const location = response.headers.get('location') ?? '';
      assert(location.includes(`/preview/p/${blueprintId}/`), `Location 异常：${location}`);
      assert([...cookies.values()].some((value) => value.startsWith('yz_preview=')), '没有下发预览 Cookie');
      return location;
    },
  ],
  [
    '带 Cookie 取产物（校验 CSP 与 nosniff）',
    async () => {
      const response = await request(`${previewBase}/preview/p/${blueprintId}/${names.version}/`, { expect: 200 });
      const html = await response.text();
      assert(html.includes(names.blueprint), '产物内容不是刚发布的那份');
      const csp = response.headers.get('content-security-policy') ?? '';
      assert(csp.includes('sandbox'), `缺少 sandbox：${csp}`);
      assert(csp.includes('default-src'), `缺少 default-src：${csp}`);
      assert(response.headers.get('x-content-type-options') === 'nosniff', '缺少 nosniff');
      assert(response.headers.get('cache-control') === 'no-store', '缺少 no-store');
      return `${html.length} 字节`;
    },
  ],
  [
    '匿名取产物被拒（应 403）',
    async () => {
      const response = await fetch(`${previewBase}/preview/p/${blueprintId}/${names.version}/`, {
        redirect: 'manual',
      });
      assert(response.status === 403, `匿名访问返回 ${response.status}，期望 403`);
      return '未持票据/Cookie 时拒绝';
    },
  ],
  [
    '票据单次有效（二次换票应 403）',
    async () => {
      const url = new URL(ticketUrl);
      const response = await request(`${previewBase}${url.pathname}${url.search}`, { allowRedirect: false });
      assert(response.status === 403, `二次换票返回 ${response.status}，期望 403`);
      return '重放被拒';
    },
  ],
  [
    '删除 Token',
    async () => {
      if (args.keep) return '按 --keep 保留';
      await api(`/api/mcp-tokens/${tokenId}`, { method: 'DELETE', expect: 200 });
      return '已删除';
    },
  ],
  [
    '删除后 Token 立即失效（应 401）',
    async () => {
      if (args.keep) return '按 --keep 跳过';
      const { status } = await mcpCall(token, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
      assert(status === 401, `已删除的 Token 仍返回 ${status}，期望 401`);
      return '401';
    },
  ],
];

console.log(`有招端到端冒烟 → api ${base}｜预览域 ${previewBase}｜Origin ${origin}\n`);

for (const [title, run] of script) {
  await step(title, run);
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 步通过`);
if (failed.length > 0) {
  console.error(`\n失败步骤：\n${failed.map((item) => `  ✗ ${item.label} — ${item.note}`).join('\n')}`);
  process.exit(1);
}
console.log('冒烟测试通过：主干链路（登录 → 分组 → Token → MCP 发布 → 预览 → 撤权即时生效）全部可用');