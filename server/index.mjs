import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.YOUZHAO_API_PORT ?? process.env.PORT ?? 4174);
const dataDir = path.resolve(process.env.YOUZHAO_DATA_DIR ?? path.join(rootDir, 'data', 'youzhao'));
const dbPath = path.resolve(process.env.YOUZHAO_DB_PATH ?? path.join(dataDir, 'youzhao.sqlite'));
const artifactRoot = path.join(dataDir, 'previews');
const maxJsonBytes = 5 * 1024 * 1024;
const maxHtmlBytes = 2 * 1024 * 1024;
const maxMarkdownBytes = 512 * 1024;

const defaultGroupId = 'group_default';
const appVersion = '1.2.2';

let users = [];

let credentials = new Map();

let groups = [
  { id: defaultGroupId, name: '默认', isDefault: true, order: 0, createdAt: '2026-06-12 09:00' },
  { id: 'group_city', name: '城市治理', isDefault: false, order: 10, createdAt: '2026-06-12 09:10' },
  { id: 'group_invest', name: '招商引资', isDefault: false, order: 20, createdAt: '2026-06-12 09:20' }
];

let blueprints = [
  {
    id: 'demo_invest_001',
    name: '招商驾驶舱',
    summary: '展示招商线索、在谈项目、签约金额与落地进展。',
    tags: ['招商', '驾驶舱', '大屏', '项目'],
    groupId: 'group_invest',
    status: 'active',
    createdAt: '2026-06-12 09:30',
    updatedAt: '2026-06-12 09:30',
    versions: [
      {
        id: 'ver_invest_101',
        blueprintId: 'demo_invest_001',
        version: 'v1.1.0',
        isLatest: true,
        status: 'available',
        previewUrl: '/blueprints/demo_invest_001/preview?version=v1.1.0',
        artifactUrl: '/preview-artifacts/demo_invest_001/v1.1.0/index.html',
        markdown: '# 招商驾驶舱 v1.1.0\n\n## 蓝图说明\n\n展示招商线索、在谈项目、签约金额与落地进展。\n\n## 页面模块\n\n- 核心指标总览\n- 招商阶段漏斗\n- 区域项目分布\n- 重点项目推进\n- 风险与待办提醒\n\n## 版本说明\n\n优化项目进度模块，补充风险提示和转化率指标。',
        deployedAt: '2026-06-12 12:00'
      },
      {
        id: 'ver_invest_100',
        blueprintId: 'demo_invest_001',
        version: 'v1.0.0',
        isLatest: false,
        status: 'available',
        previewUrl: '/blueprints/demo_invest_001/preview?version=v1.0.0',
        artifactUrl: '/preview-artifacts/demo_invest_001/v1.0.0/index.html',
        markdown: '# 招商驾驶舱 v1.0.0\n\n## 蓝图说明\n\n首版招商驾驶舱，覆盖项目总量、签约金额、落地项目与区域排名。\n\n## 页面模块\n\n- 指标卡片\n- 区域排行\n- 项目列表\n- 趋势分析',
        deployedAt: '2026-06-11 12:00'
      }
    ]
  },
  {
    id: 'demo_city_001',
    name: '城市运行总览',
    summary: '面向领导驾驶舱的城市运行态势、事件、指标和预警总览。',
    tags: ['城市治理', '态势感知', '预警'],
    groupId: 'group_city',
    status: 'active',
    createdAt: '2026-06-12 09:35',
    updatedAt: '2026-06-12 09:35',
    versions: [
      {
        id: 'ver_city_101',
        blueprintId: 'demo_city_001',
        version: 'v1.1.0',
        isLatest: true,
        status: 'available',
        previewUrl: '/blueprints/demo_city_001/preview?version=v1.1.0',
        artifactUrl: '/preview-artifacts/demo_city_001/v1.1.0/index.html',
        markdown: '# 城市运行总览 v1.1.0\n\n## 蓝图说明\n\n面向城市治理场景，展示运行态势、事件、指标和预警。',
        deployedAt: '2026-06-12 13:00'
      }
    ]
  },
  {
    id: 'demo_default_001',
    name: '项目交付进度看板',
    summary: '展示项目阶段、风险、评审、原型版本和交付物状态。',
    tags: ['交付', '项目管理', '看板'],
    groupId: defaultGroupId,
    status: 'active',
    createdAt: '2026-06-12 09:40',
    updatedAt: '2026-06-12 09:40',
    versions: [
      {
        id: 'ver_delivery_100',
        blueprintId: 'demo_default_001',
        version: 'v1.0.0',
        isLatest: true,
        status: 'available',
        previewUrl: '/blueprints/demo_default_001/preview?version=v1.0.0',
        artifactUrl: '/preview-artifacts/demo_default_001/v1.0.0/index.html',
        markdown: '# 项目交付进度看板 v1.0.0\n\n## 蓝图说明\n\n展示项目阶段、风险、评审、原型版本和交付物状态。',
        deployedAt: '2026-06-12 14:00'
      }
    ]
  }
];

let functionPermissions = [];

let blueprintPermissions = [];

let mcpTokens = [];

const sessions = new Map();
let publishResultsByKey = new Map();
let auditLogs = [];

function createMcpTokenSeed(id, name, boundUserId, token, scopes) {
  return {
    id,
    name,
    boundUserId,
    status: 'enabled',
    scopes,
    tokenHash: sha256(token),
    tokenPreview: `${token.slice(0, 7)}****${token.slice(-4)}`,
    expiresAt: '2026-12-31 23:59',
    lastUsedAt: '未使用',
    createdAt: '2026-06-12 15:00'
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function byteSize(value) {
  return Buffer.byteLength(value, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function isSetupRequired() {
  return users.length === 0;
}

function publicBlueprint(blueprint) {
  const latest = blueprint.versions.find((version) => version.isLatest);
  return {
    id: blueprint.id,
    name: blueprint.name,
    summary: blueprint.summary,
    tags: blueprint.tags,
    groupId: blueprint.groupId,
    status: blueprint.status ?? 'active',
    latestVersion: latest?.version ?? null,
    updatedAt: blueprint.updatedAt
  };
}

function publicVersion(version) {
  return {
    id: version.id,
    version: version.version,
    isLatest: version.isLatest,
    status: version.status,
    previewUrl: version.previewUrl,
    artifactUrl: version.artifactUrl,
    artifacts: ['html', 'markdown'],
    publishedAt: version.deployedAt
  };
}

function mapToEntries(map) {
  return Array.from(map.entries());
}

function entriesToMap(entries) {
  return new Map(Array.isArray(entries) ? entries : []);
}

function serializeState() {
  return {
    users,
    credentials: mapToEntries(credentials),
    groups,
    blueprints,
    functionPermissions,
    blueprintPermissions,
    mcpTokens,
    publishResultsByKey: mapToEntries(publishResultsByKey),
    auditLogs
  };
}

mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
const getStateStmt = db.prepare('SELECT value FROM app_state WHERE key = ?');
const upsertStateStmt = db.prepare(`
  INSERT INTO app_state (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

function persistState() {
  upsertStateStmt.run('main', JSON.stringify(serializeState()), nowIso());
}

function loadPersistedState() {
  const row = getStateStmt.get('main');
  if (!row?.value) {
    persistState();
    return;
  }
  const state = JSON.parse(row.value);
  users = Array.isArray(state.users) ? state.users : users;
  credentials = entriesToMap(state.credentials);
  groups = Array.isArray(state.groups) ? state.groups : groups;
  blueprints = Array.isArray(state.blueprints) ? state.blueprints : blueprints;
  functionPermissions = Array.isArray(state.functionPermissions) ? state.functionPermissions : functionPermissions;
  blueprintPermissions = Array.isArray(state.blueprintPermissions) ? state.blueprintPermissions : blueprintPermissions;
  mcpTokens = Array.isArray(state.mcpTokens) ? state.mcpTokens : mcpTokens;
  publishResultsByKey = entriesToMap(state.publishResultsByKey);
  auditLogs = Array.isArray(state.auditLogs) ? state.auditLogs : auditLogs;
  blueprints.forEach((blueprint) => {
    if (!blueprint.status) blueprint.status = 'active';
  });
}

function sortGroups(items) {
  return [...items].sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.order - b.order || String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

function getUserPermissions(userId) {
  return functionPermissions.filter((permission) => permission.userId === userId);
}

function hasModulePermission(userId, module, minLevel = 'view') {
  return getUserPermissions(userId).some((permission) => {
    if (permission.module !== module) return false;
    return minLevel === 'view' ? ['view', 'manage'].includes(permission.level) : permission.level === 'manage';
  });
}

function canAccessGroup(userId, groupId) {
  return blueprintPermissions.some(
    (permission) => permission.userId === userId && permission.targetType === 'group' && permission.targetId === groupId
  );
}

function grantGroupToBlueprintManagers(groupId) {
  const managerIds = functionPermissions
    .filter((permission) => permission.module === 'demo-preview' && permission.level === 'manage')
    .map((permission) => permission.userId);
  managerIds.forEach((userId) => {
    if (!canAccessGroup(userId, groupId)) {
      blueprintPermissions.push({ userId, targetType: 'group', targetId: groupId });
    }
  });
}

function canAccessBlueprint(userId, blueprint) {
  if ((blueprint.status ?? 'active') !== 'active' && !hasModulePermission(userId, 'demo-preview', 'manage')) {
    return false;
  }
  if (!hasModulePermission(userId, 'demo-preview', 'view')) return false;
  return blueprintPermissions.some((permission) => {
    if (permission.userId !== userId) return false;
    if (permission.targetType === 'group') return permission.targetId === blueprint.groupId;
    return permission.targetId === blueprint.id;
  });
}

function accessibleBlueprints(userId) {
  return blueprints.filter((blueprint) => canAccessBlueprint(userId, blueprint));
}

function accessibleGroups(userId, includeEmpty = true) {
  const allowedGroupIds = new Set(
    blueprintPermissions
      .filter((permission) => permission.userId === userId && permission.targetType === 'group')
      .map((permission) => permission.targetId)
  );
  const blueprintGroupIds = new Set(accessibleBlueprints(userId).map((blueprint) => blueprint.groupId));
  return sortGroups(groups.filter((group) => {
    if (allowedGroupIds.has(group.id)) return includeEmpty || blueprintGroupIds.has(group.id);
    return blueprintGroupIds.has(group.id);
  }));
}

function authenticateSession(req) {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const session = sessions.get(token);
  if (!session) return null;
  const user = users.find((item) => item.id === session.userId && item.status === 'enabled');
  return user ? { token, user } : null;
}

function authenticateMcp(req) {
  const auth = req.headers.authorization ?? '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const tokenHash = sha256(rawToken);
  const token = mcpTokens.find((item) => item.tokenHash === tokenHash);
  if (!token) throw apiError(401, 'UNAUTHENTICATED', 'Token 缺失或无效');
  if (token.status !== 'enabled') throw apiError(401, 'UNAUTHENTICATED', 'Token 已停用');
  if (token.expiresAt && Date.parse(token.expiresAt) < Date.now()) {
    throw apiError(401, 'UNAUTHENTICATED', 'Token 已过期');
  }
  const user = users.find((item) => item.id === token.boundUserId && item.status === 'enabled');
  if (!user) throw apiError(401, 'UNAUTHENTICATED', '绑定用户不可用');
  token.lastUsedAt = nowIso();
  persistState();
  return { token, user };
}

function requireScope(token, scope) {
  if (!token.scopes.includes(scope)) throw apiError(403, 'SCOPE_DENIED', `Token 缺少 ${scope}`);
}

function requireBlueprintRead(user) {
  if (!hasModulePermission(user.id, 'demo-preview', 'view')) {
    throw apiError(403, 'FORBIDDEN', '绑定用户无蓝图查看权限');
  }
}

function requireBlueprintManage(user) {
  if (!hasModulePermission(user.id, 'demo-preview', 'manage')) {
    throw apiError(403, 'FORBIDDEN', '绑定用户无蓝图管理权限');
  }
}

function requireSystemManage(user) {
  if (!hasModulePermission(user.id, 'system-settings', 'manage')) {
    throw apiError(403, 'FORBIDDEN', '无系统设置管理权限');
  }
}

function apiError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

async function parseJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxJsonBytes) throw apiError(413, 'PAYLOAD_TOO_LARGE', '请求体超过大小限制');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw apiError(400, 'INVALID_ARGUMENT', '请求体不是合法 JSON');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  });
  res.end();
}

function sendError(res, error) {
  sendJson(res, error.status ?? 500, {
    error: {
      code: error.code ?? 'INTERNAL_ERROR',
      message: error.message ?? '服务异常',
      details: error.details
    }
  });
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '';
}

function summarizeParams(params) {
  const clone = { ...params };
  if ('html' in clone) clone.html = `[html:${byteSize(String(params.html ?? ''))}bytes]`;
  if ('markdown' in clone) clone.markdown = `[markdown:${byteSize(String(params.markdown ?? ''))}bytes]`;
  return clone;
}

async function auditMcp(req, context, params, startedAt, result, errorCode, extra = {}) {
  auditLogs.unshift({
    id: `mcp_audit_${randomUUID()}`,
    requestId: context.requestId,
    tokenId: context.token?.id,
    boundUserId: context.user?.id,
    tool: context.tool,
    params: summarizeParams(params),
    targetType: extra.targetType,
    targetId: extra.targetId,
    idempotencyKey: params?.idempotencyKey,
    result,
    errorCode,
    clientIp: getClientIp(req),
    durationMs: Date.now() - startedAt,
    htmlHash: extra.htmlHash,
    markdownHash: extra.markdownHash,
    htmlSize: extra.htmlSize,
    markdownSize: extra.markdownSize,
    createdAt: nowIso()
  });
  auditLogs = auditLogs.slice(0, 1000);
  persistState();
}

function validateText(value, field, { required = false, max = 100 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw apiError(400, 'INVALID_ARGUMENT', `${field} 必填`);
    return undefined;
  }
  if (typeof value !== 'string') throw apiError(400, 'INVALID_ARGUMENT', `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw apiError(400, 'INVALID_ARGUMENT', `${field} 超过 ${max} 字符`);
  if (required && !trimmed) throw apiError(400, 'INVALID_ARGUMENT', `${field} 必填`);
  return trimmed;
}

function validateTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw apiError(400, 'INVALID_ARGUMENT', 'tags 必须是数组');
  if (tags.length > 10) throw apiError(400, 'INVALID_ARGUMENT', 'tags 最多 10 个');
  return tags.map((tag) => validateText(tag, 'tag', { required: true, max: 24 }));
}

function validateBlueprintPatch(body) {
  const status = validateText(body.status, 'status', { max: 20 });
  if (status && !['active', 'archived'].includes(status)) {
    throw apiError(400, 'INVALID_ARGUMENT', 'status 仅支持 active 或 archived');
  }
  return {
    name: validateText(body.name, 'name', { max: 80 }),
    summary: validateText(body.summary, 'summary', { max: 200 }),
    tags: body.tags === undefined ? undefined : validateTags(body.tags),
    groupId: validateText(body.groupId, 'groupId', { max: 64 }),
    status
  };
}

function validateArtifact(html, markdown) {
  if (typeof html !== 'string' || !html.trim()) throw apiError(400, 'INVALID_ARTIFACT', 'HTML 不能为空');
  const lowered = html.slice(0, 4096).toLowerCase();
  if (!lowered.includes('<!doctype html') && !lowered.includes('<html')) {
    throw apiError(400, 'INVALID_ARTIFACT', 'HTML 必须包含 doctype 或 html 标签');
  }
  if (typeof markdown !== 'string' || !markdown.trim()) throw apiError(400, 'INVALID_ARTIFACT', 'Markdown 不能为空');
  if (byteSize(html) > maxHtmlBytes) throw apiError(413, 'PAYLOAD_TOO_LARGE', 'HTML 超过大小限制');
  if (byteSize(markdown) > maxMarkdownBytes) throw apiError(413, 'PAYLOAD_TOO_LARGE', 'Markdown 超过大小限制');
}

function findBlueprintOrThrow(user, blueprintId) {
  const blueprint = blueprints.find((item) => item.id === blueprintId);
  if (!blueprint || !canAccessBlueprint(user.id, blueprint)) {
    throw apiError(404, 'BLUEPRINT_NOT_FOUND', '蓝图不存在或不可访问');
  }
  return blueprint;
}

function findVersionOrThrow(blueprint, versionName) {
  const version = versionName
    ? blueprint.versions.find((item) => item.version === versionName)
    : blueprint.versions.find((item) => item.isLatest);
  if (!version || !['available', 'draft'].includes(version.status)) {
    throw apiError(404, 'VERSION_NOT_FOUND', '版本不存在或不可访问');
  }
  return version;
}

function validateUserPayload(body, { partial = false } = {}) {
  const username = validateText(body.username, 'username', { required: !partial, max: 60 });
  const displayName = validateText(body.displayName, 'displayName', { required: !partial, max: 60 });
  const email = validateText(body.email, 'email', { max: 120 }) ?? '';
  const phone = validateText(body.phone, 'phone', { max: 30 }) ?? '';
  const status = validateText(body.status, 'status', { required: !partial, max: 20 });
  if (status && !['enabled', 'disabled'].includes(status)) {
    throw apiError(400, 'INVALID_ARGUMENT', 'status 仅支持 enabled 或 disabled');
  }
  return { username, displayName, email, phone, status };
}

function validateFunctionPermissionPayload(permissions) {
  if (!Array.isArray(permissions)) throw apiError(400, 'INVALID_ARGUMENT', 'functionPermissions 必须是数组');
  const seenModules = new Set();
  return permissions.map((permission) => {
    const module = validateText(permission.module, 'module', { required: true, max: 40 });
    const level = validateText(permission.level, 'level', { required: true, max: 20 });
    if (!['demo-preview', 'system-settings'].includes(module)) {
      throw apiError(400, 'INVALID_ARGUMENT', '未知功能模块');
    }
    if (module === 'system-settings' && level !== 'manage') {
      throw apiError(400, 'INVALID_ARGUMENT', '系统设置仅支持管理权限');
    }
    if (module === 'demo-preview' && !['view', 'manage'].includes(level)) {
      throw apiError(400, 'INVALID_ARGUMENT', '蓝图预览权限仅支持查看或管理');
    }
    if (seenModules.has(module)) throw apiError(400, 'INVALID_ARGUMENT', '功能权限模块重复');
    seenModules.add(module);
    return { module, level };
  });
}

function validateBlueprintPermissionPayload(permissions) {
  if (!Array.isArray(permissions)) throw apiError(400, 'INVALID_ARGUMENT', 'blueprintPermissions 必须是数组');
  const seenTargets = new Set();
  return permissions.map((permission) => {
    const targetType = validateText(permission.targetType, 'targetType', { required: true, max: 20 });
    const targetId = validateText(permission.targetId, 'targetId', { required: true, max: 64 });
    if (!['group', 'demo'].includes(targetType)) {
      throw apiError(400, 'INVALID_ARGUMENT', '蓝图授权类型仅支持 group 或 demo');
    }
    if (targetType === 'group' && !groups.some((group) => group.id === targetId)) {
      throw apiError(400, 'INVALID_ARGUMENT', '授权分组不存在');
    }
    if (targetType === 'demo' && !blueprints.some((blueprint) => blueprint.id === targetId)) {
      throw apiError(400, 'INVALID_ARGUMENT', '授权蓝图不存在');
    }
    const key = `${targetType}:${targetId}`;
    if (seenTargets.has(key)) throw apiError(400, 'INVALID_ARGUMENT', '蓝图授权目标重复');
    seenTargets.add(key);
    return { targetType, targetId };
  });
}

function validateMcpTokenStatus(status) {
  const nextStatus = validateText(status, 'status', { required: true, max: 20 });
  if (!['enabled', 'disabled'].includes(nextStatus)) {
    throw apiError(400, 'INVALID_ARGUMENT', 'status 仅支持 enabled 或 disabled');
  }
  return nextStatus;
}

function adminSnapshot() {
  return {
    users,
    functionPermissions,
    blueprintPermissions,
    mcpTokens: mcpTokens.map(({ tokenHash, ...token }) => token)
  };
}

function setupStatus() {
  return {
    setupRequired: isSetupRequired(),
    userCount: users.length
  };
}

async function readArtifactContent(version, artifactType) {
  if (artifactType === 'markdown') return version.markdown;
  if (version.storageBasePath) return readFile(path.join(version.storageBasePath, 'index.html'), 'utf8');
  if (!version.artifactUrl) throw apiError(404, 'VERSION_NOT_FOUND', 'HTML 产物不存在');
  const localPath = path.join(rootDir, 'public', version.artifactUrl.replace(/^\/+/, ''));
  return readFile(localPath, 'utf8');
}

function listBlueprintGroups(ctx, params) {
  requireScope(ctx.token, 'read:blueprint');
  requireBlueprintRead(ctx.user);
  const keyword = validateText(params.keyword, 'keyword', { max: 50 });
  const includeEmpty = params.includeEmpty !== false;
  const accessible = accessibleGroups(ctx.user.id, includeEmpty)
    .filter((group) => !keyword || group.name.includes(keyword))
    .map((group) => ({
      ...group,
      blueprintCount: accessibleBlueprints(ctx.user.id).filter((blueprint) => blueprint.groupId === group.id).length
    }));
  return { items: accessible, total: accessible.length };
}

function listBlueprints(ctx, params) {
  requireScope(ctx.token, 'read:blueprint');
  requireBlueprintRead(ctx.user);
  const groupId = validateText(params.groupId, 'groupId', { max: 64 });
  const keyword = validateText(params.keyword, 'keyword', { max: 50 });
  const tag = validateText(params.tag, 'tag', { max: 24 });
  const status = validateText(params.status, 'status', { max: 20 }) ?? 'active';
  if (!['active', 'archived', 'all'].includes(status)) {
    throw apiError(400, 'INVALID_ARGUMENT', 'status 仅支持 active、archived 或 all');
  }
  if (status !== 'active' && !hasModulePermission(ctx.user.id, 'demo-preview', 'manage')) {
    throw apiError(403, 'FORBIDDEN', '仅蓝图管理者可查看归档蓝图');
  }
  const limit = Math.min(Math.max(Number(params.limit ?? 20), 1), 100);
  const offset = Math.max(Number(params.offset ?? 0), 0);
  const filtered = accessibleBlueprints(ctx.user.id).filter((blueprint) => {
    const blueprintStatus = blueprint.status ?? 'active';
    if (status !== 'all' && blueprintStatus !== status) return false;
    if (groupId && blueprint.groupId !== groupId) return false;
    if (tag && !blueprint.tags.includes(tag)) return false;
    if (keyword && !`${blueprint.name} ${blueprint.summary}`.includes(keyword)) return false;
    return true;
  });
  return {
    items: filtered.slice(offset, offset + limit).map(publicBlueprint),
    total: filtered.length
  };
}

function getBlueprint(ctx, params) {
  requireScope(ctx.token, 'read:blueprint');
  requireBlueprintRead(ctx.user);
  const blueprintId = validateText(params.blueprintId, 'blueprintId', { required: true, max: 64 });
  const blueprint = findBlueprintOrThrow(ctx.user, blueprintId);
  return {
    ...publicBlueprint(blueprint),
    versions: blueprint.versions.map(publicVersion)
  };
}

async function getBlueprintArtifact(ctx, params) {
  requireScope(ctx.token, 'read:blueprint');
  requireBlueprintRead(ctx.user);
  const blueprintId = validateText(params.blueprintId, 'blueprintId', { required: true, max: 64 });
  const versionName = validateText(params.version, 'version', { max: 40 });
  const artifactType = validateText(params.artifactType, 'artifactType', { required: true, max: 20 });
  if (!['html', 'markdown'].includes(artifactType)) {
    throw apiError(400, 'INVALID_ARGUMENT', 'artifactType 仅支持 html 或 markdown');
  }
  const blueprint = findBlueprintOrThrow(ctx.user, blueprintId);
  const version = findVersionOrThrow(blueprint, versionName);
  return {
    blueprintId: blueprint.id,
    version: version.version,
    artifactType,
    content: await readArtifactContent(version, artifactType),
    contentType: artifactType === 'html' ? 'text/html' : 'text/markdown',
    updatedAt: version.deployedAt
  };
}

async function publishBlueprint(ctx, params) {
  requireScope(ctx.token, 'publish:blueprint');
  requireBlueprintManage(ctx.user);

  const idempotencyKey = validateText(params.idempotencyKey, 'idempotencyKey', { max: 120 });
  if (idempotencyKey && publishResultsByKey.has(idempotencyKey)) return publishResultsByKey.get(idempotencyKey);

  const blueprintId = validateText(params.blueprintId, 'blueprintId', { max: 64 });
  const name = validateText(params.name, 'name', { required: true, max: 80 });
  const summary = validateText(params.summary, 'summary', { max: 200 }) ?? '';
  const tags = validateTags(params.tags);
  const groupId = validateText(params.groupId, 'groupId', { max: 64 }) ?? defaultGroupId;
  const versionName = validateText(params.version, 'version', { required: true, max: 40 });
  const publishNote = validateText(params.publishNote, 'publishNote', { max: 300 }) ?? '';
  const html = params.html;
  const markdown = params.markdown;
  validateArtifact(html, markdown);

  const group = groups.find((item) => item.id === groupId);
  if (!group) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在');
  if (!canAccessGroup(ctx.user.id, groupId) && !hasModulePermission(ctx.user.id, 'system-settings', 'manage')) {
    throw apiError(403, 'FORBIDDEN', '绑定用户无目标分组权限');
  }

  let blueprint = blueprintId ? blueprints.find((item) => item.id === blueprintId) : null;
  if (blueprintId && (!blueprint || !canAccessBlueprint(ctx.user.id, blueprint))) {
    throw apiError(404, 'BLUEPRINT_NOT_FOUND', '蓝图不存在或不可访问');
  }
  if (blueprint?.versions.some((version) => version.version === versionName)) {
    throw apiError(409, 'VERSION_CONFLICT', '版本号已存在');
  }

  const finalBlueprintId = blueprint?.id ?? `blueprint_${randomUUID().slice(0, 8)}`;
  const versionId = `version_${randomUUID().slice(0, 8)}`;
  const versionDir = path.join(artifactRoot, finalBlueprintId, versionName);
  const tmpDir = `${versionDir}.tmp-${randomUUID()}`;
  const htmlHash = `sha256:${sha256(html)}`;
  const markdownHash = `sha256:${sha256(markdown)}`;
  const htmlSize = byteSize(html);
  const markdownSize = byteSize(markdown);
  const publishedAt = nowIso();

  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'index.html'), html, 'utf8');
    await writeFile(path.join(tmpDir, 'blueprint.md'), markdown, 'utf8');
    await writeFile(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify(
        {
          blueprintId: finalBlueprintId,
          version: versionName,
          htmlHash,
          markdownHash,
          htmlSize,
          markdownSize,
          publishedAt
        },
        null,
        2
      ),
      'utf8'
    );
    await mkdir(path.dirname(versionDir), { recursive: true });
    await rename(tmpDir, versionDir);
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw apiError(500, 'PUBLISH_FAILED', '发布产物写入失败', error.message);
  }

  if (!blueprint) {
    blueprint = {
      id: finalBlueprintId,
      name,
      summary,
      tags,
      groupId,
      createdAt: publishedAt,
      updatedAt: publishedAt,
      versions: []
    };
    blueprints.push(blueprint);
    blueprintPermissions.push({ userId: ctx.user.id, targetType: 'demo', targetId: finalBlueprintId });
  } else {
    blueprint.name = name;
    blueprint.summary = summary;
    blueprint.tags = tags;
    blueprint.groupId = groupId;
    blueprint.updatedAt = publishedAt;
  }

  blueprint.versions.forEach((version) => {
    version.isLatest = false;
  });
  const previewUrl = `/blueprints/${finalBlueprintId}/preview?version=${encodeURIComponent(versionName)}`;
  const artifactUrl = `/api/artifacts/${finalBlueprintId}/${encodeURIComponent(versionName)}/index.html`;
  blueprint.versions.unshift({
    id: versionId,
    blueprintId: finalBlueprintId,
    version: versionName,
    isLatest: true,
    status: 'available',
    previewUrl,
    artifactUrl,
    storageBasePath: versionDir,
    markdown,
    publishSource: 'mcp',
    publishNote,
    deployedAt: publishedAt
  });

  const result = {
    blueprintId: finalBlueprintId,
    versionId,
    version: versionName,
    isLatest: true,
    previewUrl,
    artifacts: {
      html: true,
      markdown: true
    },
    htmlHash,
    markdownHash,
    htmlSize,
    markdownSize,
    publishedAt
  };
  if (idempotencyKey) publishResultsByKey.set(idempotencyKey, result);
  persistState();
  return result;
}

const mcpToolHandlers = {
  'youzhao.list_blueprint_groups': listBlueprintGroups,
  'youzhao.list_blueprints': listBlueprints,
  'youzhao.get_blueprint': getBlueprint,
  'youzhao.get_blueprint_artifact': getBlueprintArtifact,
  'youzhao.publish_blueprint': publishBlueprint
};

async function handleMcpTool(req, res, toolName) {
  const startedAt = Date.now();
  const requestId = req.headers['x-request-id'] ?? `req_${randomUUID()}`;
  const params = await parseJson(req);
  const ctx = { ...authenticateMcp(req), tool: toolName, requestId };
  const handler = mcpToolHandlers[toolName];
  if (!handler) throw apiError(404, 'TOOL_NOT_FOUND', 'MCP 工具不存在');

  try {
    const data = await handler(ctx, params);
    await auditMcp(req, ctx, params, startedAt, 'success', null, {
      targetType: params.blueprintId ? 'blueprint' : undefined,
      targetId: data.blueprintId ?? params.blueprintId,
      htmlHash: data.htmlHash,
      markdownHash: data.markdownHash,
      htmlSize: data.htmlSize,
      markdownSize: data.markdownSize
    });
    sendJson(res, 200, { requestId, data });
  } catch (error) {
    await auditMcp(req, ctx, params, startedAt, 'failed', error.code ?? 'INTERNAL_ERROR');
    throw error;
  }
}

async function serveArtifact(req, res, pathname) {
  const match = pathname.match(/^\/api\/artifacts\/([^/]+)\/([^/]+)\/index\.html$/);
  if (!match) throw apiError(404, 'NOT_FOUND', '产物不存在');
  const [, blueprintId, versionName] = match.map(decodeURIComponent);
  const filePath = path.join(artifactRoot, blueprintId, versionName, 'index.html');
  await stat(filePath);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  createReadStream(filePath).pipe(res);
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return sendNoContent(res);

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'youzhao-api',
      version: appVersion,
      dataDir,
      dbPath,
      time: nowIso()
    });
  }

  if (req.method === 'GET' && pathname === '/api/setup/status') {
    return sendJson(res, 200, setupStatus());
  }

  if (req.method === 'POST' && pathname === '/api/setup/admin') {
    if (!isSetupRequired()) throw apiError(409, 'SETUP_COMPLETED', '平台已完成初始化');
    const body = await parseJson(req);
    const payload = validateUserPayload({ ...body, status: 'enabled' });
    const username = payload.username;
    const password = validateText(body.password, 'password', { required: true, max: 120 });
    const user = {
      id: `user_${randomUUID().slice(0, 8)}`,
      username,
      displayName: payload.displayName,
      email: payload.email,
      phone: payload.phone,
      status: 'enabled',
      createdAt: nowIso()
    };
    users.push(user);
    credentials.set(user.username, password);
    functionPermissions.push({ userId: user.id, module: 'system-settings', level: 'manage' });
    functionPermissions.push({ userId: user.id, module: 'demo-preview', level: 'manage' });
    groups.forEach((group) => {
      blueprintPermissions.push({ userId: user.id, targetType: 'group', targetId: group.id });
    });
    persistState();
    return sendJson(res, 201, { user, setup: setupStatus() });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (isSetupRequired()) throw apiError(409, 'SETUP_REQUIRED', '请先完成管理员帐号初始化');
    const body = await parseJson(req);
    const username = validateText(body.username, 'username', { required: true, max: 60 });
    const password = validateText(body.password, 'password', { required: true, max: 120 });
    if (credentials.get(username) !== password) throw apiError(401, 'UNAUTHENTICATED', '用户名或密码错误');
    const user = users.find((item) => item.username === username && item.status === 'enabled');
    if (!user) throw apiError(401, 'UNAUTHENTICATED', '用户不可用');
    const token = `yz_session_${randomBytes(24).toString('hex')}`;
    sessions.set(token, { userId: user.id, createdAt: nowIso() });
    return sendJson(res, 200, { token, user });
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    return sendJson(res, 200, {
      user: session.user,
      functionPermissions: getUserPermissions(session.user.id),
      blueprintPermissions: blueprintPermissions.filter((permission) => permission.userId === session.user.id)
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/users') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireSystemManage(session.user);
    return sendJson(res, 200, adminSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/admin/users') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireSystemManage(session.user);
    const body = await parseJson(req);
    const payload = validateUserPayload(body);
    const username = payload.username;
    if (users.some((user) => user.username === username)) throw apiError(409, 'USER_CONFLICT', '用户名已存在');
    const password = validateText(body.password, 'password', { max: 120 }) || '123456';
    const user = {
      id: `user_${randomUUID().slice(0, 8)}`,
      username,
      displayName: payload.displayName,
      email: payload.email,
      phone: payload.phone,
      status: payload.status,
      createdAt: nowIso()
    };
    users.push(user);
    credentials.set(user.username, password);
    functionPermissions.push({ userId: user.id, module: 'demo-preview', level: 'view' });
    blueprintPermissions.push({ userId: user.id, targetType: 'group', targetId: defaultGroupId });
    persistState();
    return sendJson(res, 201, { user, admin: adminSnapshot() });
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PATCH') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireSystemManage(session.user);
    const userId = decodeURIComponent(userMatch[1]);
    const user = users.find((item) => item.id === userId);
    if (!user) throw apiError(404, 'USER_NOT_FOUND', '用户不存在');
    const body = await parseJson(req);
    const payload = validateUserPayload(body, { partial: true });
    if (payload.displayName !== undefined) user.displayName = payload.displayName;
    if (payload.email !== undefined) user.email = payload.email;
    if (payload.phone !== undefined) user.phone = payload.phone;
    if (payload.status !== undefined) user.status = payload.status;
    persistState();
    return sendJson(res, 200, { user, admin: adminSnapshot() });
  }

  if (userMatch && req.method === 'DELETE') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireSystemManage(session.user);
    const userId = decodeURIComponent(userMatch[1]);
    if (users.length <= 1) throw apiError(400, 'INVALID_ARGUMENT', '至少保留一个用户');
    const index = users.findIndex((item) => item.id === userId);
    if (index < 0) throw apiError(404, 'USER_NOT_FOUND', '用户不存在');
    const [user] = users.splice(index, 1);
    credentials.delete(user.username);
    for (let i = functionPermissions.length - 1; i >= 0; i -= 1) {
      if (functionPermissions[i].userId === userId) functionPermissions.splice(i, 1);
    }
    for (let i = blueprintPermissions.length - 1; i >= 0; i -= 1) {
      if (blueprintPermissions[i].userId === userId) blueprintPermissions.splice(i, 1);
    }
    for (let i = mcpTokens.length - 1; i >= 0; i -= 1) {
      if (mcpTokens[i].boundUserId === userId) mcpTokens.splice(i, 1);
    }
    persistState();
    return sendJson(res, 200, { admin: adminSnapshot() });
  }

  const resetPasswordMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
  if (resetPasswordMatch && req.method === 'POST') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireSystemManage(session.user);
    const userId = decodeURIComponent(resetPasswordMatch[1]);
    const user = users.find((item) => item.id === userId);
    if (!user) throw apiError(404, 'USER_NOT_FOUND', '用户不存在');
    const body = await parseJson(req);
    const password = validateText(body.password, 'password', { required: true, max: 120 });
    credentials.set(user.username, password);
    persistState();
    return sendJson(res, 200, { user, admin: adminSnapshot() });
  }

  const userPermissionsMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/permissions$/);
  if (userPermissionsMatch && req.method === 'PUT') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireSystemManage(session.user);
    const userId = decodeURIComponent(userPermissionsMatch[1]);
    const user = users.find((item) => item.id === userId);
    if (!user) throw apiError(404, 'USER_NOT_FOUND', '用户不存在');
    const body = await parseJson(req);
    const nextFunctionPermissions = validateFunctionPermissionPayload(body.functionPermissions ?? []);
    const nextBlueprintPermissions = validateBlueprintPermissionPayload(body.blueprintPermissions ?? []);

    for (let i = functionPermissions.length - 1; i >= 0; i -= 1) {
      if (functionPermissions[i].userId === userId) functionPermissions.splice(i, 1);
    }
    functionPermissions.push(
      ...nextFunctionPermissions.map((permission) => ({
        userId,
        ...permission
      }))
    );

    for (let i = blueprintPermissions.length - 1; i >= 0; i -= 1) {
      if (blueprintPermissions[i].userId === userId) blueprintPermissions.splice(i, 1);
    }
    blueprintPermissions.push(
      ...nextBlueprintPermissions.map((permission) => ({
        userId,
        ...permission
      }))
    );

    persistState();
    return sendJson(res, 200, { admin: adminSnapshot() });
  }

  if (req.method === 'POST' && pathname === '/api/admin/mcp-tokens') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintManage(session.user);
    const body = await parseJson(req);
    const name = validateText(body.name, 'name', { required: true, max: 60 });
    const expiresAt = validateText(body.expiresAt, 'expiresAt', { max: 40 }) ?? '永不过期';
    if (expiresAt !== '永不过期' && Number.isNaN(Date.parse(expiresAt))) {
      throw apiError(400, 'INVALID_ARGUMENT', 'expiresAt 不是有效时间');
    }
    const rawToken = `yz_mcp_${randomBytes(18).toString('hex')}`;
    const token = {
      id: `mcp_token_${randomUUID().slice(0, 8)}`,
      name,
      boundUserId: session.user.id,
      status: 'enabled',
      scopes: hasModulePermission(session.user.id, 'demo-preview', 'manage')
        ? ['read:blueprint', 'publish:blueprint']
        : ['read:blueprint'],
      tokenHash: sha256(rawToken),
      tokenPreview: `${rawToken.slice(0, 7)}****${rawToken.slice(-4)}`,
      expiresAt,
      lastUsedAt: '未使用',
      createdAt: nowIso()
    };
    mcpTokens.unshift(token);
    const { tokenHash, ...publicToken } = token;
    persistState();
    return sendJson(res, 201, { token: rawToken, mcpToken: publicToken, admin: adminSnapshot() });
  }

  const mcpTokenMatch = pathname.match(/^\/api\/admin\/mcp-tokens\/([^/]+)$/);
  if (mcpTokenMatch && req.method === 'PATCH') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintManage(session.user);
    const tokenId = decodeURIComponent(mcpTokenMatch[1]);
    const token = mcpTokens.find((item) => item.id === tokenId);
    if (!token) throw apiError(404, 'TOKEN_NOT_FOUND', 'Token 不存在');
    if (token.boundUserId !== session.user.id && !hasModulePermission(session.user.id, 'system-settings', 'manage')) {
      throw apiError(403, 'FORBIDDEN', '不可管理其他用户 Token');
    }
    const body = await parseJson(req);
    token.status = validateMcpTokenStatus(body.status);
    const { tokenHash, ...publicToken } = token;
    persistState();
    return sendJson(res, 200, { mcpToken: publicToken, admin: adminSnapshot() });
  }

  if (mcpTokenMatch && req.method === 'DELETE') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintManage(session.user);
    const tokenId = decodeURIComponent(mcpTokenMatch[1]);
    const index = mcpTokens.findIndex((item) => item.id === tokenId);
    if (index < 0) throw apiError(404, 'TOKEN_NOT_FOUND', 'Token 不存在');
    const token = mcpTokens[index];
    if (token.boundUserId !== session.user.id && !hasModulePermission(session.user.id, 'system-settings', 'manage')) {
      throw apiError(403, 'FORBIDDEN', '不可删除其他用户 Token');
    }
    mcpTokens.splice(index, 1);
    persistState();
    return sendJson(res, 200, { admin: adminSnapshot() });
  }

  if (req.method === 'GET' && pathname === '/api/blueprint-groups') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintRead(session.user);
    const includeEmpty = url.searchParams.get('includeEmpty') !== 'false';
    return sendJson(res, 200, listBlueprintGroups({ token: { scopes: ['read:blueprint'] }, user: session.user }, {
      keyword: url.searchParams.get('keyword') ?? undefined,
      includeEmpty
    }));
  }

  if (req.method === 'POST' && pathname === '/api/blueprint-groups') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintManage(session.user);
    const body = await parseJson(req);
    const name = validateText(body.name, 'name', { required: true, max: 40 });
    if (groups.some((group) => group.name === name)) throw apiError(409, 'GROUP_CONFLICT', '分组名称已存在');
    const group = {
      id: `group_${randomUUID().slice(0, 8)}`,
      name,
      isDefault: false,
      order: Math.max(...groups.map((item) => item.order), 0) + 10,
      createdAt: nowIso()
    };
    groups.push(group);
    grantGroupToBlueprintManagers(group.id);
    persistState();
    return sendJson(res, 201, listBlueprintGroups({ token: { scopes: ['read:blueprint'] }, user: session.user }, {
      includeEmpty: true
    }));
  }

  if (req.method === 'PATCH' && pathname === '/api/blueprint-groups/reorder') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintManage(session.user);
    const body = await parseJson(req);
    if (!Array.isArray(body.groupIds)) throw apiError(400, 'INVALID_ARGUMENT', 'groupIds 必须是数组');
    const knownGroupIds = new Set(groups.map((group) => group.id));
    if (body.groupIds.some((groupId) => typeof groupId !== 'string' || !knownGroupIds.has(groupId))) {
      throw apiError(400, 'INVALID_ARGUMENT', 'groupIds 包含不存在的分组');
    }
    const orderedIds = [defaultGroupId, ...body.groupIds.filter((groupId) => groupId !== defaultGroupId)];
    groups.forEach((group) => {
      const index = orderedIds.indexOf(group.id);
      group.order = (index >= 0 ? index : orderedIds.length) * 10;
    });
    persistState();
    return sendJson(res, 200, listBlueprintGroups({ token: { scopes: ['read:blueprint'] }, user: session.user }, {
      includeEmpty: true
    }));
  }

  const groupMatch = pathname.match(/^\/api\/blueprint-groups\/([^/]+)$/);
  if (req.method === 'DELETE' && groupMatch) {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintManage(session.user);
    const groupId = decodeURIComponent(groupMatch[1]);
    const group = groups.find((item) => item.id === groupId);
    if (!group) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在');
    if (group.isDefault) throw apiError(400, 'INVALID_ARGUMENT', '默认分组不可删除');

    blueprints.forEach((blueprint) => {
      if (blueprint.groupId === groupId) {
        blueprint.groupId = defaultGroupId;
        blueprint.updatedAt = nowIso();
      }
    });
    for (let i = blueprintPermissions.length - 1; i >= 0; i -= 1) {
      if (blueprintPermissions[i].targetType === 'group' && blueprintPermissions[i].targetId === groupId) {
        blueprintPermissions.splice(i, 1);
      }
    }
    const groupIndex = groups.findIndex((item) => item.id === groupId);
    groups.splice(groupIndex, 1);

    persistState();
    return sendJson(res, 200, {
      groups: listBlueprintGroups({ token: { scopes: ['read:blueprint'] }, user: session.user }, { includeEmpty: true }),
      blueprints: listBlueprints({ token: { scopes: ['read:blueprint'] }, user: session.user }, { limit: 100, offset: 0 })
    });
  }

  if (req.method === 'GET' && pathname === '/api/blueprints') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintRead(session.user);
    return sendJson(res, 200, listBlueprints({ token: { scopes: ['read:blueprint'] }, user: session.user }, {
      groupId: url.searchParams.get('groupId') ?? undefined,
      keyword: url.searchParams.get('keyword') ?? undefined,
      tag: url.searchParams.get('tag') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined
    }));
  }

  const blueprintMatch = pathname.match(/^\/api\/blueprints\/([^/]+)$/);
  if (req.method === 'GET' && blueprintMatch) {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    return sendJson(res, 200, getBlueprint({ token: { scopes: ['read:blueprint'] }, user: session.user }, {
      blueprintId: decodeURIComponent(blueprintMatch[1])
    }));
  }

  if (req.method === 'PATCH' && blueprintMatch) {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintManage(session.user);
    const blueprintId = decodeURIComponent(blueprintMatch[1]);
    const blueprint = findBlueprintOrThrow(session.user, blueprintId);
    const patch = validateBlueprintPatch(await parseJson(req));

    if (patch.groupId !== undefined) {
      const group = groups.find((item) => item.id === patch.groupId);
      if (!group) throw apiError(404, 'GROUP_NOT_FOUND', '分组不存在');
      if (!canAccessGroup(session.user.id, patch.groupId) && !hasModulePermission(session.user.id, 'system-settings', 'manage')) {
        throw apiError(403, 'FORBIDDEN', '无目标分组权限');
      }
      blueprint.groupId = patch.groupId;
    }
    if (patch.name !== undefined) blueprint.name = patch.name;
    if (patch.summary !== undefined) blueprint.summary = patch.summary;
    if (patch.tags !== undefined) blueprint.tags = patch.tags;
    if (patch.status !== undefined) blueprint.status = patch.status;
    blueprint.updatedAt = nowIso();

    persistState();
    return sendJson(res, 200, {
      ...publicBlueprint(blueprint),
      versions: blueprint.versions.map(publicVersion)
    });
  }

  if (req.method === 'DELETE' && blueprintMatch) {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    requireBlueprintManage(session.user);
    const blueprintId = decodeURIComponent(blueprintMatch[1]);
    const blueprint = findBlueprintOrThrow(session.user, blueprintId);
    const index = blueprints.findIndex((item) => item.id === blueprint.id);
    if (index < 0) throw apiError(404, 'BLUEPRINT_NOT_FOUND', '蓝图不存在或不可访问');

    blueprints.splice(index, 1);
    for (let i = blueprintPermissions.length - 1; i >= 0; i -= 1) {
      if (blueprintPermissions[i].targetType === 'demo' && blueprintPermissions[i].targetId === blueprint.id) {
        blueprintPermissions.splice(i, 1);
      }
    }
    for (const [key, result] of publishResultsByKey.entries()) {
      if (result?.blueprintId === blueprint.id) publishResultsByKey.delete(key);
    }
    await rm(path.join(artifactRoot, blueprint.id), { recursive: true, force: true }).catch(() => undefined);

    persistState();
    return sendJson(res, 200, { id: blueprint.id });
  }

  const artifactMatch = pathname.match(/^\/api\/blueprints\/([^/]+)\/artifact$/);
  if (req.method === 'GET' && artifactMatch) {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    const data = await getBlueprintArtifact({ token: { scopes: ['read:blueprint'] }, user: session.user }, {
      blueprintId: decodeURIComponent(artifactMatch[1]),
      version: url.searchParams.get('version') ?? undefined,
      artifactType: url.searchParams.get('artifactType') ?? 'html'
    });
    return sendJson(res, 200, data);
  }

  if (pathname.startsWith('/api/artifacts/')) return serveArtifact(req, res, pathname);

  const mcpMatch = pathname.match(/^\/api\/mcp\/tools\/(.+)$/);
  if (req.method === 'POST' && mcpMatch) {
    return handleMcpTool(req, res, decodeURIComponent(mcpMatch[1]));
  }

  if (req.method === 'GET' && pathname === '/api/mcp/audit-logs') {
    const session = authenticateSession(req);
    if (!session) throw apiError(401, 'UNAUTHENTICATED', '未登录');
    if (!hasModulePermission(session.user.id, 'system-settings', 'manage')) {
      throw apiError(403, 'FORBIDDEN', '无系统设置管理权限');
    }
    return sendJson(res, 200, { items: auditLogs.slice(0, 100), total: auditLogs.length });
  }

  throw apiError(404, 'NOT_FOUND', '接口不存在');
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error?.code === 'ENOENT') return sendError(res, apiError(404, 'NOT_FOUND', '资源不存在'));
    sendError(res, error);
  }
});

loadPersistedState();
await mkdir(artifactRoot, { recursive: true });

server.listen(port, '0.0.0.0', () => {
  console.log(`YouZhao API listening on http://127.0.0.1:${port}`);
  console.log(`YouZhao SQLite storage: ${dbPath}`);
  console.log('Use system settings to create MCP tokens after administrator setup.');
});
