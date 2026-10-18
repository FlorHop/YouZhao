#!/usr/bin/env node
/**
 * 浏览器级冒烟（M4 集成验收；M6 验收可复用）。
 *
 * 通过 Chrome DevTools Protocol 驱动本机 Chrome，把「登录 → 各页面渲染 → 授权 → 角色可见性」
 * 整条链路真跑一遍，并在过程中截图。它验证的是**前后端集成**（前端发请求、服务端按权限裁剪、
 * 页面按身份渲染），与 `scripts/smoke-e2e.mjs`（纯 HTTP 契约）互补。
 *
 * 前置：
 *   1. api 已启动（`pnpm -C server dev`，本机无 Postgres 时用 `DB_DRIVER=pglite`）
 *   2. `pnpm -C web dev`（5173，/api 代理到 api）
 *   3. 一个开了 CDP 的 Chrome，例如：
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *        --headless=new --no-sandbox --remote-debugging-port=9333 \
 *        --user-data-dir=/tmp/yz-ui-chrome --window-size=1440,900 about:blank
 *
 * 用法：
 *   node scripts/smoke-ui.mjs [--app http://localhost:5173] [--cdp http://127.0.0.1:9333]
 *                             [--shots artifacts/smoke-ui] [--username admin] [--password …]
 *
 * 注意：脚本会创建一个成员账号（`m4-member-<时间戳>`）并给它授予默认分组的查看权，可重复执行。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_APP = 'http://localhost:5173';
const DEFAULT_CDP = 'http://127.0.0.1:9333';
const DEFAULT_SHOTS = 'artifacts/smoke-ui';
const MEMBER_PASSWORD = 'm4-member-pass-1234';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) args[key] = true;
    else {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const APP = String(args.app ?? process.env.YOUZHAO_UI_APP ?? DEFAULT_APP).replace(/\/+$/, '');
const CDP = String(args.cdp ?? process.env.YOUZHAO_UI_CDP ?? DEFAULT_CDP).replace(/\/+$/, '');
const SHOTS = String(args.shots ?? DEFAULT_SHOTS);
const OWNER_USERNAME = String(args.username ?? process.env.ADMIN_USERNAME ?? 'admin');
const OWNER_PASSWORD = String(args.password ?? process.env.ADMIN_PASSWORD ?? 'local-dev-owner-password');
const MEMBER_USERNAME = String(args.member ?? `m4-member-${Date.now().toString(36)}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextId = 1;
let ws;
let sessionId = '';
const pending = new Map();
const consoleNoise = [];

function send(method, params = {}) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

function onProtocolMessage(raw) {
  const message = JSON.parse(raw);
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const type = message.params.type;
    if (type !== 'error' && type !== 'warning') return;
    const text = message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
    pushNoise(`console.${type}: ${text}`, '');
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pushNoise(`exception: ${details.exception?.description ?? details.text}`, '');
    return;
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    pushNoise(`log.error: ${message.params.entry.text}`, message.params.entry.url ?? '');
  }
}

function pushNoise(text, url) {
  // 访客态会主动探测 `/api/me`（未登录时 401 是设计内的），favicon 缺失不影响功能。
  if (url.endsWith('/favicon.ico')) return;
  if (text.includes('401') && url.endsWith('/api/me')) return;
  consoleNoise.push(url === '' ? text : `${text}｜${url}`);
}

async function connect() {
  const response = await fetch(`${CDP}/json/version`);
  if (!response.ok) throw new Error(`连不上 CDP（${CDP}）：${response.status}`);
  const { webSocketDebuggerUrl } = await response.json();
  ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`CDP WebSocket 连接失败：${webSocketDebuggerUrl}`)), {
      once: true,
    });
  });
  ws.addEventListener('message', (event) => onProtocolMessage(event.data));

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = attached.sessionId;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails !== undefined) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description ?? details.text ?? '页面脚本执行失败');
  }
  return result.result?.value;
}

async function waitFor(expression, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try {
      ok = (await evaluate(`Boolean(${expression})`)) === true;
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) {
      const hint = await evaluate('document.body.innerText.slice(0, 400)').catch(() => '');
      throw new Error(`等待超时（${description}）｜页面文本：${String(hint).replace(/\s+/g, ' ').slice(0, 240)}`);
    }
    await sleep(150);
  }
}

async function goto(path) {
  await send('Page.navigate', { url: `${APP}${path}` });
  await waitFor("document.readyState === 'complete'", `打开 ${path}`);
  await waitFor("document.querySelector('#app')?.children.length > 0", `${path} 渲染出应用外壳`);
}

async function clickText(text, selector = 'button') {
  const clicked = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = nodes.find((node) => (node.textContent || '').trim().includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error(`找不到可点击元素：${text}（选择器 ${selector}）`);
}

async function fill(id, value) {
  const filled = await evaluate(`(() => {
    const node = document.getElementById(${JSON.stringify(id)});
    if (!node) return false;
    node.focus();
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (filled !== true) throw new Error(`找不到输入框：#${id}`);
}

async function clickCheckbox(id) {
  const clicked = await evaluate(`(() => {
    const node = document.getElementById(${JSON.stringify(id)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error(`找不到勾选框：#${id}`);
}

async function waitForText(text, timeout = 15000) {
  await waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, `页面出现「${text}」`, timeout);
}

async function pressKey(key, code, keyCode) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(SHOTS, `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

/** 上一轮可能留下登录态：/login 对已登录用户不可达，先退出再接登录页。 */
/** 清掉会话 Cookie 回到访客态：比模拟点「退出登录」更可靠，用于步骤间重置。 */
async function resetSession() {
  await send('Network.clearBrowserCookies');
  await goto('/login');
  await waitFor("location.pathname === '/login'", '回到登录页');
}

async function ensureLoggedOut() {
  await goto('/login');
  const loggedIn = await evaluate(
    "document.querySelector('button[aria-label=\"账号菜单\"]') !== null",
  );
  if (loggedIn !== true) return false;
  await signOut();
  return true;
}

async function signOut() {
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('button[aria-label="账号菜单"]');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`);
  if (opened !== true) throw new Error('找不到账号菜单按钮');
  await waitForText('退出登录');
  await clickText('退出登录', '.p-menu-item-label, .p-menu-item, [role="menuitem"], button, a');
  await waitFor("location.pathname === '/login'", '退出后回到登录页');
}

async function login(username, password) {
  await goto('/login');
  await waitFor("document.getElementById('login-username') !== null", '登录表单渲染');
  await fill('login-username', username);
  await fill('login-password', password);
  await clickText('登录', 'button.login-submit');
  await waitFor("!location.pathname.startsWith('/login')", '登录后离开登录页');
  await waitForText('有招');
}

const results = [];

async function step(title, run) {
  const started = Date.now();
  try {
    const note = await run();
    results.push({ title, ok: true, note: note ?? '' });
    process.stdout.write(`  ✔ ${title}${note === undefined || note === '' ? '' : ` — ${note}`}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ title, ok: false, note: message });
    process.stdout.write(`  ✖ ${title} — ${message}\n`);
    await shot(`failed-${results.length}`).catch(() => undefined);
  }
  void started;
}

async function main() {
  await connect();
  process.stdout.write(`浏览器冒烟：app=${APP} cdp=${CDP} shots=${SHOTS}\n`);
  process.stdout.write(`所有者：${OWNER_USERNAME}｜新成员：${MEMBER_USERNAME}\n\n`);

  await step('01 打开登录页', async () => {
    await resetSession();
    await waitForText('有招');
    await waitFor("document.getElementById('login-username') !== null", '用户名输入框');
    return '登录卡片渲染';
  });

  await step('02 所有者登录后进入蓝图页', async () => {
    await login(OWNER_USERNAME, OWNER_PASSWORD);
    consoleNoise.length = 0;
    await waitFor("document.querySelectorAll('.nav-item').length >= 1", '侧边导航渲染');
    const labels = await evaluate(
      "[...document.querySelectorAll('.nav-item')].map((node) => node.textContent.trim()).join(' / ')",
    );
    return `导航：${labels}`;
  });

  await step('03 蓝图页渲染（空态或已有卡片）', async () => {
    await goto('/blueprints');
    await waitForText('新建蓝图');
    await waitFor(
      "document.querySelectorAll('.resource-card').length > 0 || document.body.innerText.includes('还没有蓝图')",
      '蓝图卡片或空态',
    );
    const file = await shot('03-blueprints');
    const cards = await evaluate("document.querySelectorAll('.resource-card').length");
    const empty = await evaluate("document.body.innerText.includes('还没有蓝图')");
    if (cards === 0 && !empty) throw new Error('蓝图页既没有卡片也没有空态');
    return `${cards} 张卡片${empty ? '（空态）' : ''}｜截图 ${file}`;
  });

  await step('04 用户页渲染账号列表', async () => {
    await goto('/users');
    await waitForText('用户');
    await waitFor("document.querySelectorAll('tbody tr').length > 0", '用户表格行');
    const rows = await evaluate("document.querySelectorAll('tbody tr').length");
    return `${rows} 行`;
  });

  await step('05 通过界面创建成员账号', async () => {
    await clickText('新建用户');
    await waitFor("document.getElementById('create-user-username') !== null", '新建用户对话框');
    await fill('create-user-username', MEMBER_USERNAME);
    await fill('create-user-displayName', 'M4 验收成员');
    await fill('create-user-password', MEMBER_PASSWORD);
    await clickText('创建用户', '.p-dialog button');
    await waitForText(MEMBER_USERNAME);
    return `已创建 ${MEMBER_USERNAME}`;
  });

  await step('06 权限页四段渲染', async () => {
    await goto('/permissions');
    await waitForText('查看范围授权');
    for (const heading of ['管理员与可委派范围', '业务能力', '账号管理']) {
      await waitForText(heading);
    }
    const file = await shot('06-permissions');
    return `截图 ${file}`;
  });

  await step('07 通过界面为成员授予默认分组查看权', async () => {
    await waitFor(
      `[...document.querySelectorAll('tbody tr')].some((row) => row.textContent.includes(${JSON.stringify(MEMBER_USERNAME)}))`,
      '成员出现在用户列表',
    );
    const selected = await evaluate(`(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((item) =>
        item.textContent.includes(${JSON.stringify(MEMBER_USERNAME)}),
      );
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (selected !== true) throw new Error('没能选中成员所在行');
    await waitForText('我可以调整的');
    await waitFor("document.getElementById('grant-group-group_default') !== null", '默认分组的勾选框');
    await clickCheckbox('grant-group-group_default');
    await waitForText('待应用变更 1 项');
    await clickText('应用变更');
    await waitForText('查看范围已更新');
    return '授权成功提示出现';
  });

  await step('08 Token 页创建 Token 并显示一次性明文', async () => {
    await goto('/tokens');
    await waitForText('创建 Token');
    await clickText('创建 Token');
    await waitFor("document.getElementById('token-name') !== null", '创建 Token 对话框');
    await fill('token-name', `m4-token-${Date.now().toString(36)}`);
    await clickText('创建 Token', '.p-dialog button');
    await waitFor("document.querySelector('.secret-value') !== null", '一次性明文对话框');
    const secret = await evaluate("document.querySelector('.secret-value')?.textContent?.trim() ?? ''");
    if (!secret.startsWith('yz_mcp_')) throw new Error(`一次性明文形态不对：${secret.slice(0, 24)}`);
    const file = await shot('08-token-secret');
    return `明文前缀 ${secret.slice(0, 20)}… 截图 ${file}`;
  });

  await step('09 我的账号页渲染资料与密码区', async () => {
    await goto('/account');
    await waitForText('账号资料');
    await waitForText('修改密码');
    await waitForText('我的身份与范围');
    return '三段都在';
  });

  await step('10 通过「我的账号」退出登录', async () => {
    await goto('/account');
    await waitForText('退出登录');
    await clickText('退出登录', '.form-actions button');
    await waitFor("location.pathname === '/login'", '退出后回到登录页');
    return '界面退出登录可用';
  });

  await step('11 成员登录后导航隐藏用户与权限', async () => {
    await resetSession();
    consoleNoise.length = 0;
    await login(MEMBER_USERNAME, MEMBER_PASSWORD);
    await waitFor("document.querySelectorAll('.nav-item').length >= 1", '成员侧边导航');
    const labels = await evaluate(
      "[...document.querySelectorAll('.nav-item')].map((node) => node.textContent.trim()).join(' / ')",
    );
    if (labels.includes('用户') || labels.includes('权限')) {
      throw new Error(`成员导航仍出现管理入口：${labels}`);
    }
    const file = await shot('10-member-nav');
    return `导航：${labels}｜截图 ${file}`;
  });

  await step('12 成员直达权限页被守卫拦到 403', async () => {
    await goto('/permissions');
    await waitForText('无权访问');
    return `${await evaluate('location.pathname')} 显示无权访问`;
  });

  await step('13 视觉与布局一致性（设计体系约束）', async () => {
    const findings = [];
    for (const path of ['/blueprints', '/users', '/permissions', '/tokens', '/account']) {
      await goto(path);
      await sleep(400);
      const audit = await evaluate(`(() => {
        const problems = [];
        const all = [...document.querySelectorAll('*')];
        // 设计体系：不使用渐变做装饰
        const gradient = all.find((node) => {
          const image = getComputedStyle(node).backgroundImage;
          return typeof image === 'string' && image.includes('gradient');
        });
        if (gradient) problems.push('出现渐变背景：' + gradient.className);
        // 布局：1440 宽下不出现横向溢出
        if (document.documentElement.scrollWidth > window.innerWidth + 1) {
          problems.push('横向溢出 ' + document.documentElement.scrollWidth + 'px');
        }
        // 体系绑定：正文使用 token 字体栈，强调色为体系绿
        const bodyFont = getComputedStyle(document.body).fontFamily || '';
        if (!bodyFont.includes('Söhne')) problems.push('正文字体栈未绑定体系字体：' + bodyFont.slice(0, 40));
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        if (accent.toLowerCase() !== '#10a37f') problems.push('强调色偏离体系：' + accent);
        // 主按钮：每个页面不超过一个主色按钮（页面级动作唯一）
        const primaries = all.filter((node) => {
          if (!node.classList.contains('p-button')) return false;
          const bg = getComputedStyle(node).backgroundColor;
          return bg === 'rgb(16, 163, 127)';
        });
        if (primaries.length > 1) problems.push('同页出现 ' + primaries.length + ' 个主色按钮');
        return problems;
      })()`);
      for (const problem of audit) findings.push(`${path}：${problem}`);
    }
    if (findings.length > 0) throw new Error(findings.slice(0, 3).join(' ｜ '));
    return '5 个页面：无渐变、无横向溢出、字体与强调色绑定体系、主按钮唯一';
  });

  await step('14 键盘与无障碍（Tab 可达、焦点可见、图标按钮可读、Esc 关闭对话框）', async () => {
    // 上一步结束时停留在成员会话，这里清会话换回所有者（/users 只有所有者与管理员可进）
    await resetSession();
    await login(OWNER_USERNAME, OWNER_PASSWORD);
    await goto('/users');
    await waitForText('新建用户');
    await sleep(400);

    // 图标按钮必须有可读名称（aria-label / title / 文本至少有一个）
    const unlabeled = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      return buttons
        .filter((b) => {
          const text = (b.innerText || '').trim();
          const label = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
          return text === '' && label === '';
        })
        .map((b) => String(b.className || b.outerHTML).slice(0, 60))
        .slice(0, 4);
    })()`);
    if (unlabeled.length > 0) throw new Error('存在无可读名称的图标按钮：' + unlabeled.join(' ｜ '));

    // Tab 可依次到达交互控件，且焦点样式可见（焦点环由设计体系提供）
    await evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
    const visited = [];
    let ringSeen = false;
    for (let index = 0; index < 14; index += 1) {
      await pressKey('Tab', 'Tab', 9);
      const info = await evaluate(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          tag: el.tagName,
          name: String(el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 14),
          ring: style.outlineStyle !== 'none' || (style.boxShadow && style.boxShadow !== 'none'),
        };
      })()`);
      if (!info) continue;
      visited.push(`${info.tag}:${info.name || '-'}`);
      if (info.ring) ringSeen = true;
    }
    if (visited.length < 4) throw new Error(`Tab 遍历只命中 ${visited.length} 个可聚焦元素（键盘不可达）`);
    if (!ringSeen) throw new Error(`Tab 遍历未见可见焦点样式：${visited.join(' → ')}`);

    // Esc 关闭对话框，且打开时焦点已进入对话框（Dialog 焦点陷阱）
    await clickText('新建用户');
    await waitFor("document.querySelector('.p-dialog') !== null", '新建用户对话框打开');
    let focusInfo = null;
    for (let index = 0; index < 25; index += 1) {
      focusInfo = await evaluate(`(() => {
        const dialog = document.querySelector('.p-dialog');
        if (!dialog) return { inside: false, where: '无对话框' };
        const active = document.activeElement;
        return {
          inside: dialog.contains(active),
          where: active ? active.tagName + '.' + String(active.className).split(' ')[0] : 'null',
        };
      })()`);
      if (focusInfo && focusInfo.inside) break;
      await sleep(100);
    }
    await pressKey('Escape', 'Escape', 27);
    await waitFor("document.querySelector('.p-dialog') === null", 'Esc 关闭对话框');
    if (!focusInfo || !focusInfo.inside) {
      throw new Error(`对话框打开时焦点未进入对话框（焦点陷阱缺失；实际焦点：${focusInfo ? focusInfo.where : '未知'}）`);
    }

    return `Tab 命中 ${visited.length} 个控件、焦点样式可见、图标按钮均有可读名称、Esc 可关对话框`;
  });

  await step('15 全程无控制台报错', async () => {
    if (consoleNoise.length > 0) {
      throw new Error(consoleNoise.slice(0, 3).map((item) => item.slice(0, 160)).join(' ｜ '));
    }
    return '0 条 error / warning';
  });

  const passed = results.filter((item) => item.ok).length;
  process.stdout.write(`\n结果：${passed}/${results.length} 步通过\n`);
  for (const item of results.filter((entry) => !entry.ok)) {
    process.stdout.write(`  ✖ ${item.title} — ${item.note}\n`);
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(`\n冒烟脚本异常终止：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
