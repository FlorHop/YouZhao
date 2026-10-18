/**
 * 旧应用（`main` @ ff69340）的数据形状与读取器 —— **仅供 M5 数据迁移使用**。
 *
 * 依据：`docs/architecture-design.md` §8「数据迁移要点」。
 *
 * 旧应用把**全部业务数据**塞在 SQLite 单表 `app_state(key, value)` 的 JSON 里
 * （`server/index.mjs:209-224` 建表、`:236-247` 反序列化），产物则按
 * `previews/<blueprintId>/<version>/index.html` 落盘（`:785`、`:920`）。
 * 因此迁移的输入是「一个 JSON + 一个产物目录」，不需要旧应用在跑。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ── 旧形状（camelCase；对 snake_case 也兼容，见 pick） ──────────────────────

export interface LegacyUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  phone: string;
  /** `enabled` | `disabled` */
  status: string;
  createdAt: string;
}

export interface LegacyGroup {
  id: string;
  name: string;
  isDefault: boolean;
  /** 旧字段名可能是 order / sortOrder */
  order: number;
  createdAt: string;
}

export interface LegacyVersion {
  id: string;
  /** 旧字段名可能是 demoId / blueprintId */
  demoId: string;
  version: string;
  isLatest: boolean;
  previewUrl: string;
  artifactUrl: string;
  /** 旧模型把 README 正文直接存在版本行里 */
  markdown: string;
  /** `available` | `unavailable` */
  status: string;
  deployedAt: string;
}

export interface LegacyBlueprint {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  groupId: string;
  /** `active` | `archived` */
  status: string;
  versions: LegacyVersion[];
  createdAt: string;
  updatedAt: string;
}

/** 旧功能权限：`module` = demo-preview | system-settings，`level` = view | manage。 */
export interface LegacyFunctionPermission {
  userId: string;
  module: string;
  level: string;
}

/** 旧蓝图权限：`targetType` = group | demo。 */
export interface LegacyBlueprintPermission {
  userId: string;
  targetType: string;
  targetId: string;
}

export interface LegacyMcpToken {
  id: string;
  name: string;
  boundUserId: string;
  status: string;
  scopes: string[];
  /** 旧应用存 sha256(raw)，但明文不可回收 */
  tokenHash: string;
  tokenPreview: string;
  expiresAt: string;
  lastUsedAt: string;
  createdAt: string;
}

export interface LegacyState {
  users: LegacyUser[];
  /** username → 明文口令（旧应用就是明文存的，`:1027`/`:1042`） */
  credentials: Record<string, string>;
  groups: LegacyGroup[];
  blueprints: LegacyBlueprint[];
  functionPermissions: LegacyFunctionPermission[];
  blueprintPermissions: LegacyBlueprintPermission[];
  mcpTokens: LegacyMcpToken[];
  auditLogs: unknown[];
  /** 旧库里没有对应迁移目标的数据，逐项列出以便报告里说明 */
  ignoredKeys: string[];
}

export interface LegacyStateSource {
  /** 人类可读的来源描述（文件路径或 SQLite 路径 + 表） */
  source: string;
  state: LegacyState;
}

const MIGRATED_KEYS = [
  'users',
  'credentials',
  'groups',
  'blueprints',
  'functionPermissions',
  'blueprintPermissions',
  'mcpTokens',
  'auditLogs',
] as const;

/** 宽容读取：缺字段给默认值，不因为旧数据的小瑕疵让整次迁移失败。 */
export function normalizeLegacyState(raw: unknown): LegacyState {
  const root = isRecord(raw) ? raw : {};
  const record = isRecord(root.state) ? root.state : root;
  const ignoredKeys = Object.keys(record).filter(
    (key) => !(MIGRATED_KEYS as readonly string[]).includes(key),
  );
  return {
    users: arrayOf(record.users).map(normalizeUser).filter((user) => user.id && user.username),
    credentials: normalizeCredentials(record.credentials),
    groups: arrayOf(record.groups).map(normalizeGroup).filter((group) => group.id && group.name),
    blueprints: arrayOf(record.blueprints).map(normalizeBlueprint).filter((bp) => bp.id && bp.name),
    functionPermissions: arrayOf(record.functionPermissions)
      .map(normalizeFunctionPermission)
      .filter((perm) => perm.userId && perm.module),
    blueprintPermissions: arrayOf(record.blueprintPermissions)
      .map(normalizeBlueprintPermission)
      .filter((perm) => perm.userId && perm.targetId),
    mcpTokens: arrayOf(record.mcpTokens).map(normalizeToken).filter((token) => token.id),
    auditLogs: arrayOf(record.auditLogs),
    ignoredKeys,
  };
}

export async function readLegacyStateFile(file: string): Promise<LegacyStateSource> {
  const text = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`旧数据不是合法 JSON（${file}）：${(error as Error).message}`);
  }
  return { source: `json:${file}`, state: normalizeLegacyState(parsed) };
}

/** 直接读旧 SQLite 的 `app_state` 表（默认 key = `main`）。 */
export async function readLegacyStateFromDataDir(
  dataDir: string,
  options: { dbFileName?: string; stateKey?: string } = {},
): Promise<LegacyStateSource> {
  const dbPath = path.join(dataDir, options.dbFileName ?? 'youzhao.sqlite');
  const stateKey = options.stateKey ?? 'main';
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(stateKey) as
      | { value?: string }
      | undefined;
    if (!row?.value) {
      throw new Error(`旧库里没有 app_state.${stateKey}（${dbPath}）`);
    }
    return {
      source: `sqlite:${dbPath}#app_state.${stateKey}`,
      state: normalizeLegacyState(JSON.parse(row.value)),
    };
  } finally {
    db.close();
  }
}

/** 产物目录（旧结构：`<dataDir>/previews/<blueprintId>/<version>/`）。 */
export function legacyPreviewRoot(dataDir: string): string {
  return path.join(dataDir, 'previews');
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(str(value, ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUser(raw: unknown): LegacyUser {
  const record = isRecord(raw) ? raw : {};
  return {
    id: str(pick(record, 'id')),
    username: str(pick(record, 'username', 'user_name')),
    displayName: str(pick(record, 'displayName', 'display_name')),
    email: str(pick(record, 'email')),
    phone: str(pick(record, 'phone')),
    status: str(pick(record, 'status'), 'enabled'),
    createdAt: str(pick(record, 'createdAt', 'created_at')),
  };
}

function normalizeGroup(raw: unknown): LegacyGroup {
  const record = isRecord(raw) ? raw : {};
  return {
    id: str(pick(record, 'id')),
    name: str(pick(record, 'name')),
    isDefault: bool(pick(record, 'isDefault', 'is_default')),
    order: num(pick(record, 'order', 'sortOrder', 'sort_order')),
    createdAt: str(pick(record, 'createdAt', 'created_at')),
  };
}

function normalizeVersion(raw: unknown, blueprintId: string): LegacyVersion {
  const record = isRecord(raw) ? raw : {};
  return {
    id: str(pick(record, 'id')),
    demoId: str(pick(record, 'demoId', 'blueprintId', 'demo_id'), blueprintId),
    version: str(pick(record, 'version')),
    isLatest: bool(pick(record, 'isLatest', 'is_latest')),
    previewUrl: str(pick(record, 'previewUrl', 'preview_url')),
    artifactUrl: str(pick(record, 'artifactUrl', 'artifact_url')),
    markdown: str(pick(record, 'markdown')),
    status: str(pick(record, 'status'), 'available'),
    deployedAt: str(pick(record, 'deployedAt', 'deployed_at')),
  };
}

function normalizeBlueprint(raw: unknown): LegacyBlueprint {
  const record = isRecord(raw) ? raw : {};
  const id = str(pick(record, 'id'));
  return {
    id,
    name: str(pick(record, 'name')),
    summary: str(pick(record, 'summary')),
    tags: arrayOf(pick(record, 'tags')).map((tag) => str(tag)).filter(Boolean),
    groupId: str(pick(record, 'groupId', 'group_id')),
    status: str(pick(record, 'status'), 'active'),
    versions: arrayOf(pick(record, 'versions')).map((version) => normalizeVersion(version, id)),
    createdAt: str(pick(record, 'createdAt', 'created_at')),
    updatedAt: str(pick(record, 'updatedAt', 'updated_at')),
  };
}

function normalizeFunctionPermission(raw: unknown): LegacyFunctionPermission {
  const record = isRecord(raw) ? raw : {};
  return {
    userId: str(pick(record, 'userId', 'user_id')),
    module: str(pick(record, 'module')),
    level: str(pick(record, 'level'), 'view'),
  };
}

function normalizeBlueprintPermission(raw: unknown): LegacyBlueprintPermission {
  const record = isRecord(raw) ? raw : {};
  return {
    userId: str(pick(record, 'userId', 'user_id')),
    targetType: str(pick(record, 'targetType', 'target_type'), 'demo'),
    targetId: str(pick(record, 'targetId', 'target_id')),
  };
}

function normalizeToken(raw: unknown): LegacyMcpToken {
  const record = isRecord(raw) ? raw : {};
  return {
    id: str(pick(record, 'id')),
    name: str(pick(record, 'name')),
    boundUserId: str(pick(record, 'boundUserId', 'bound_user_id')),
    status: str(pick(record, 'status'), 'enabled'),
    scopes: arrayOf(pick(record, 'scopes')).map((scope) => str(scope)).filter(Boolean),
    tokenHash: str(pick(record, 'tokenHash', 'token_hash')),
    tokenPreview: str(pick(record, 'tokenPreview', 'token_prefix', 'token_preview')),
    expiresAt: str(pick(record, 'expiresAt', 'expires_at')),
    lastUsedAt: str(pick(record, 'lastUsedAt', 'last_used_at')),
    createdAt: str(pick(record, 'createdAt', 'created_at')),
  };
}

function normalizeCredentials(raw: unknown): Record<string, string> {
  // 旧形状是 [ [username, password], … ]（`entriesToMap`），也接受对象形式。
  const result: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (Array.isArray(entry) && entry.length >= 2) {
        result[str(entry[0])] = str(entry[1]);
      }
    }
    return result;
  }
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) result[key] = str(value);
  }
  return result;
}
