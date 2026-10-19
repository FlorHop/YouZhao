/**
 * 旧模型 → 新模型 的**纯函数**映射与对照（M5 数据迁移的核心，可脱库单测）。
 *
 * 依据：`docs/architecture-design.md` §8「数据迁移要点」与 §3.5 授权引擎。
 *
 * 这里刻意不做任何 IO：输入是 `LegacyState`（`./model.ts`），输出是一份可审查的
 * `LegacyMigrationPlan`。落库与产物搬运在 `../migrate-legacy.ts`。
 *
 * 映射总表（与 §8 逐条对应）：
 *
 * | 旧 | 新 | 说明 |
 * | --- | --- | --- |
 * | `users` + `credentials` | `users`（+ scrypt 哈希） | 明文口令一次性转 scrypt，`must_change_password = true` |
 * | `functionPermissions: system-settings:manage` | `user_identity = user_admin` | **只有显式指定的那一个**成为 `owner`；绝不自动产生第二个 owner |
 * | `functionPermissions: system-settings:view` | 丢弃 | 新模型没有「系统设置只读」这一档，报告里逐条列出 |
 * | `functionPermissions: demo-preview:view` | 丢弃 | 新模型只看资源级 `view_grants`；该旧闸门是「函数级」的，取消后可见范围可能**变宽**，对照表逐人标出 |
 * | `functionPermissions: demo-preview:manage` | `capabilities(blueprint.manage)`（按其分组授权范围） | 发布能力**单独**确认：`publishDecisions` |
 * | `blueprintPermissions` | `view_grants` | `group` → `group`，`demo` → `blueprint` |
 * | 管理员自动获得新分组访问（旧 `grantGroupToBlueprintManagers`） | 补 `view_grants` | 不补会让管理员的可见范围凭空缩小 |
 * | `groups` / `blueprints` / `versions` | `blueprint_groups` / `blueprints` / `blueprint_versions` | 归档语义：`archived` → `status='archived'` + `archived_at`，**不物理删除** |
 * | `mcpTokens` | `mcp_tokens`（**停用占位**） | 明文不可回收、旧哈希对新格式无用 → 必须重建 |
 */

import { DEFAULT_GROUP_ID } from '../../domain/ids.js';
import type {
  LegacyBlueprint,
  LegacyState,
  LegacyUser,
  LegacyVersion,
} from './model.js';

/**
 * 旧数据里蓝图指向了已不存在的分组时，用它承载孤儿蓝图。
 * 不能塞进默认分组——那会让默认分组的查看者凭空多看到几张蓝图；占位分组没有任何授权，可见范围不变。
 */
const ORPHAN_GROUP_ID = 'group_legacy_orphan';
const ORPHAN_GROUP_NAME = '原分组已删除（迁移占位）';

/** 旧模型已知缺陷：迁移把它们**显式修掉**，报告里逐条列出（§8 要求「显式对照」）。 */
export const KNOWN_LEGACY_DEFECTS: readonly { id: string; title: string; fix: string }[] = [
  {
    id: 'L1',
    title: '`system-settings:manage` 等于全局管理员钥匙，同级管理员可互相撤销权限、重置口令，甚至移除最后一名管理员',
    fix: '新模型把「账号管理」与「业务能力」拆开：`owner` 唯一且受保护（`OWNER_PROTECTED`），同级管理员不能修改彼此（`PEER_MANAGE_DENIED`），不存在「最后一名管理员被移除」的空档',
  },
  {
    id: 'L2',
    title: '发布权限被并入 `demo-preview:manage`，凡是能维护内容的人都能发布',
    fix: '`blueprint.publish` 是独立能力且必须带资源范围，迁移时**不自动授予**，逐人进入 `publishDecisions` 待人工确认',
  },
  {
    id: 'L3',
    title: '删除分组会让其下蓝图回落到默认分组，从而改变「谁看得见」',
    fix: '分组删除改为归档；迁移按蓝图**迁移前的实际归属**写 `group_id`，归属不明的蓝图落到默认分组并在报告里逐条列出',
  },
  {
    id: 'L4',
    title: '产物接口匿名可读，归档/撤权后仍可访问，且路径可穿越',
    fix: '新模型产物只经 `POST /api/preview-tickets` 换一次性票据，取件时**每次重新校验可见性**；路径段白名单校验（M2 已有回归用例）',
  },
  {
    id: 'L5',
    title: '旧 Token 明文不可回收、绑定关系随意（创建者可指定任意绑定用户）',
    fix: '迁移只保留 Token 元数据并置为停用占位，必须在「MCP Token」页重建；新 Token 实际能力 = 绑定用户能力 ∩ scope',
  },
];

export interface LegacyMigrationOptions {
  /** 指定谁成为平台所有者（用户名）。缺省时若恰好只有一个 `system-settings:manage` 用户则取它。 */
  ownerUsername?: string;
  /** 部署时已存在的默认分组 id（默认 `group_default`，与迁移 0002 一致）。 */
  defaultGroupId?: string;
  /** 便于测试固定时间戳；缺省用真实时间。 */
  now?: () => Date;
}

export interface PlannedUser {
  legacyId: string;
  username: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  status: 'active' | 'disabled';
  identity: 'owner' | 'user_admin' | 'member';
  /** 明文口令我方只用于转哈希，绝不写入报告或日志 */
  plainPassword: string | null;
  mustResetPassword: boolean;
  createdAt: string | null;
  reason: string;
}

export interface PlannedGroup {
  id: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  archivedAt: string | null;
  /** 旧数据里没有该分组，是迁移时补出来承载「归属缺失」的蓝图 */
  synthesized: boolean;
}

export interface PlannedGrant {
  userId: string;
  targetType: 'group' | 'blueprint';
  targetId: string;
  reason: string;
}

export interface PlannedCapability {
  userId: string;
  capability: 'blueprint.manage' | 'blueprint.publish';
  targetType: 'group' | 'blueprint';
  targetId: string;
  reason: string;
}

export interface PlannedVersion {
  id: string;
  version: string;
  isLatest: boolean;
  status: 'available' | 'missing';
  publishSource: 'mcp' | 'web' | 'web-cover';
  publishNote: string;
  deployedAt: string | null;
  /** 旧磁盘目录是否应存在（存在性由 apply 阶段判断，缺失则改判 `missing`） */
  expectedArtifactDir: boolean;
  /** 旧行里内联的 README 正文：落盘时补成 `README.md` 条目 */
  inlineMarkdown: string | null;
}

export interface PlannedBlueprint {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  groupId: string;
  status: 'active' | 'archived';
  createdAt: string | null;
  updatedAt: string | null;
  versions: PlannedVersion[];
}

export interface PlannedToken {
  id: string;
  name: string;
  boundUserId: string;
  scopes: string[];
  /** 旧状态映射；迁移后一律 `disabled`（占位） */
  legacyStatus: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string | null;
  note: string;
}

export interface ComparisonRow {
  userId: string;
  username: string;
  identity: string;
  legacyVisible: string[];
  migratedVisible: string[];
  change: 'same' | 'widened' | 'narrowed';
  notes: string[];
}

export interface PublishDecision {
  userId: string;
  username: string;
  groups: string[];
  note: string;
}

export interface LegacyMigrationPlan {
  ownerUserId: string;
  groups: PlannedGroup[];
  users: PlannedUser[];
  grants: PlannedGrant[];
  capabilities: PlannedCapability[];
  blueprints: PlannedBlueprint[];
  tokens: PlannedToken[];
  comparison: ComparisonRow[];
  publishDecisions: PublishDecision[];
  warnings: string[];
  /** 旧库里存在但新模型没有对应位置的数据 */
  dropped: string[];
  counts: {
    users: number;
    userAdmins: number;
    members: number;
    groups: number;
    blueprints: number;
    versions: number;
    grants: number;
    capabilities: number;
    tokens: number;
  };
}

export class LegacyMigrationError extends Error {}

export function planLegacyMigration(
  state: LegacyState,
  options: LegacyMigrationOptions = {},
): LegacyMigrationPlan {
  const defaultGroupId = options.defaultGroupId ?? DEFAULT_GROUP_ID;
  const warnings: string[] = [];
  const dropped: string[] = [];

  const usersById = new Map(state.users.map((user) => [user.id, user]));

  // ── 谁成为 owner ─────────────────────────────────────────────────────────
  const systemManagers = state.functionPermissions.filter(
    (perm) => perm.module === 'system-settings' && perm.level === 'manage',
  );
  const managerIds = dedupe(systemManagers.map((perm) => perm.userId));
  let ownerUserId: string;
  if (options.ownerUsername) {
    const found = state.users.find((user) => user.username === options.ownerUsername);
    if (!found) {
      throw new LegacyMigrationError(`--owner ${options.ownerUsername} 在旧用户表里不存在`);
    }
    ownerUserId = found.id;
  } else if (managerIds.length === 1) {
    ownerUserId = managerIds[0] as string;
  } else {
    throw new LegacyMigrationError(
      managerIds.length === 0
        ? '旧数据里没有任何 `system-settings:manage` 用户，必须用 --owner <username> 指定平台所有者'
        : `旧数据里有 ${managerIds.length} 个 \`system-settings:manage\` 用户，必须用 --owner <username> 明确唯一所有者（旧模型允许存在多个全局管理员，这正是缺陷 L1）`,
    );
  }

  // ── 用户与身份 ───────────────────────────────────────────────────────────
  const users: PlannedUser[] = state.users.map((user) => {
    const isOwner = user.id === ownerUserId;
    const isSystemManager = managerIds.includes(user.id);
    const plainPassword = state.credentials[user.username] ?? null;
    const identity: PlannedUser['identity'] = isOwner ? 'owner' : isSystemManager ? 'user_admin' : 'member';
    if (!plainPassword) {
      warnings.push(
        `用户 ${user.username} 在旧凭据表里没有口令记录：迁移后需管理员重置一次口令，才可登录`,
      );
    }
    return {
      legacyId: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      email: user.email || null,
      phone: user.phone || null,
      status: user.status === 'disabled' ? 'disabled' : 'active',
      identity,
      plainPassword,
      mustResetPassword: true,
      createdAt: user.createdAt || null,
      reason: isOwner
        ? '由 --owner 指定（或无歧义时的唯一 system-settings:manage 用户）'
        : isSystemManager
          ? '旧 `system-settings:manage` → 用户管理员'
          : '其余用户 → 普通成员',
    };
  });

  for (const perm of state.functionPermissions) {
    if (perm.module === 'system-settings' && perm.level === 'view') {
      dropped.push(
        `functionPermission(${usernameOf(usersById, perm.userId)}) system-settings:view —— 新模型没有「系统设置只读」这一档`,
      );
    }
  }

  // ── 分组与蓝图 ───────────────────────────────────────────────────────────
  const groups = planGroups(state, defaultGroupId, warnings);
  const groupIds = new Set(groups.map((group) => group.id));
  const defaultGroupExists = state.groups.some((group) => group.isDefault);
  if (!defaultGroupExists) {
    warnings.push(
      `旧数据里没有标记为默认的分组；蓝图归属缺失时统一落到新库的默认分组 ${defaultGroupId}`,
    );
  }

  const blueprints: PlannedBlueprint[] = state.blueprints.map((blueprint) => {
    let groupId = blueprint.groupId;
    if (!groupId || !groupIds.has(groupId)) {
      // 不把孤儿蓝图塞进默认分组：那会让所有拥有默认分组查看权的人凭空多看到几张蓝图。
      // 改用一个没有任何授权的占位分组承载，可见范围与迁移前保持一致，由运营手动归位。
      if (!groupIds.has(ORPHAN_GROUP_ID)) {
        groups.push({
          id: ORPHAN_GROUP_ID,
          name: ORPHAN_GROUP_NAME,
          isDefault: false,
          sortOrder: 9999,
          archivedAt: null,
          synthesized: true,
        });
        groupIds.add(ORPHAN_GROUP_ID);
      }
      warnings.push(
        `蓝图 ${blueprint.name}(${blueprint.id}) 的所属分组 ${groupId || '(空)'} 在旧分组表里不存在，已移入占位分组「${ORPHAN_GROUP_NAME}」(${ORPHAN_GROUP_ID})——不改变任何人的可见范围，请手动归位（缺陷 L3）`,
      );
      groupId = ORPHAN_GROUP_ID;
    }
    return {
      id: blueprint.id,
      name: blueprint.name,
      summary: blueprint.summary,
      tags: blueprint.tags,
      groupId,
      status: blueprint.status === 'archived' ? 'archived' : 'active',
      createdAt: blueprint.createdAt || null,
      updatedAt: blueprint.updatedAt || null,
      versions: planVersions(blueprint, warnings),
    };
  });

  // ── 查看授权 ─────────────────────────────────────────────────────────────
  const grants: PlannedGrant[] = [];
  const grantKeys = new Set<string>();
  const addGrant = (grant: PlannedGrant): void => {
    const key = `${grant.userId}|${grant.targetType}|${grant.targetId}`;
    if (grantKeys.has(key)) return;
    grantKeys.add(key);
    grants.push(grant);
  };

  // 所有者的旧授权行不迁移：他在新模型里隐式可见全部蓝图与分组（见 §3.5 不变量），
  // 写行只会让「谁能看什么」的报表变脏。
  const ownerPermissionCount = state.blueprintPermissions.filter(
    (perm) => perm.userId === ownerUserId,
  ).length;
  if (ownerPermissionCount > 0) {
    dropped.push(
      `blueprintPermissions(${usernameOf(usersById, ownerUserId)}) 共 ${ownerPermissionCount} 条 —— 所有者在新模型里隐式可见全部蓝图与分组`,
    );
  }

  for (const perm of state.blueprintPermissions) {
    if (perm.userId === ownerUserId) continue;
    if (!usersById.has(perm.userId)) {
      warnings.push(`蓝图授权指向不存在的用户 ${perm.userId}，已跳过`);
      continue;
    }
    if (perm.targetType === 'group') {
      if (!groupIds.has(perm.targetId) && perm.targetId !== defaultGroupId) {
        warnings.push(
          `蓝图授权指向不存在的分组 ${perm.targetId}（用户 ${usernameOf(usersById, perm.userId)}），已跳过`,
        );
        continue;
      }
      addGrant({
        userId: perm.userId,
        targetType: 'group',
        targetId: perm.targetId,
        reason: '旧 blueprintPermissions(group)',
      });
      continue;
    }
    const exists = blueprints.some((blueprint) => blueprint.id === perm.targetId);
    if (!exists) {
      warnings.push(
        `蓝图授权指向不存在的蓝图 ${perm.targetId}（用户 ${usernameOf(usersById, perm.userId)}），已跳过`,
      );
      continue;
    }
    addGrant({
      userId: perm.userId,
      targetType: 'blueprint',
      targetId: perm.targetId,
      reason: '旧 blueprintPermissions(demo)',
    });
  }

  // 旧模型：管理员在「新建分组」时被自动写入组授权（server/index.mjs:275-285）。
  // 等价范围必须在迁移时补上，否则管理员的可见范围会凭空缩小。
  const previewManagers = dedupe(
    state.functionPermissions
      .filter((perm) => perm.module === 'demo-preview' && perm.level === 'manage')
      .map((perm) => perm.userId),
  ).filter((userId) => usersById.has(userId));

  // 所有者在**新模型里隐式**拥有全部业务能力与全部可见范围（见 §3.5 不变量）：
  // 为他补授权行/能力行没有意义，只会让「谁能看什么」的报表变脏，也不需要他确认发布能力。
  const contentManagers = previewManagers.filter((userId) => userId !== ownerUserId);
  if (contentManagers.length !== previewManagers.length) {
    dropped.push(
      `functionPermission(${usernameOf(usersById, ownerUserId)}) demo-preview:manage —— 所有者在新模型里隐式拥有全部业务能力与可见范围`,
    );
  }
  for (const userId of contentManagers) {
    for (const group of state.groups) {
      const already = grants.some(
        (grant) => grant.userId === userId && grant.targetType === 'group' && grant.targetId === group.id,
      );
      if (already) continue;
      addGrant({
        userId,
        targetType: 'group',
        targetId: group.id,
        reason: '旧模型管理员自动获得该分组访问权（换个模型会缩小范围，故补齐）',
      });
    }
  }

  // ── 业务能力 ─────────────────────────────────────────────────────────────
  const capabilities: PlannedCapability[] = [];
  const capabilityKeys = new Set<string>();
  const addCapability = (capability: PlannedCapability): void => {
    const key = `${capability.userId}|${capability.capability}|${capability.targetType}|${capability.targetId}`;
    if (capabilityKeys.has(key)) return;
    capabilityKeys.add(key);
    capabilities.push(capability);
  };

  for (const userId of contentManagers) {
    const owned = grants.filter((grant) => grant.userId === userId);
    if (owned.length === 0) {
      warnings.push(
        `用户 ${usernameOf(usersById, userId)} 在旧模型有 demo-preview:manage 但没有任何分组/蓝图授权，迁移后其 manage 能力无处落地（新模型能力必须带范围），未授予任何能力`,
      );
      continue;
    }
    for (const grant of owned) {
      addCapability({
        userId,
        capability: 'blueprint.manage',
        targetType: grant.targetType,
        targetId: grant.targetId,
        reason: '旧 demo-preview:manage → blueprint.manage（同范围）',
      });
    }
  }

  const publishDecisions: PublishDecision[] = contentManagers.map((userId) => ({
    userId,
    username: usernameOf(usersById, userId),
    groups: grants
      .filter((grant) => grant.userId === userId && grant.targetType === 'group')
      .map((grant) => groupNameOf(state, grant.targetId)),
    note: '旧模型把发布并入 manage；新模型 blueprint.publish 必须单独授予（缺陷 L2）。请确认此人是否仍需发布权，以及发布到哪些分组。',
  }));
  if (publishDecisions.length > 0) {
    warnings.push(
      `${publishDecisions.length} 个用户需要人工确认发布能力（旧模型 manage 含发布）——迁移**不自动**授予 blueprint.publish`,
    );
  }

  // ── Token（停用占位） ────────────────────────────────────────────────────
  const tokens: PlannedToken[] = state.mcpTokens.map((token) => {
    if (!usersById.has(token.boundUserId)) {
      warnings.push(`Token ${token.name}(${token.id}) 绑定的用户不存在，迁移为禁用占位但需要删除`);
    }
    return {
      id: token.id,
      name: token.name || `旧 Token ${token.id}`,
      boundUserId: token.boundUserId,
      scopes: token.scopes,
      legacyStatus: token.status,
      tokenPrefix: token.tokenPreview || '（旧无前缀）',
      expiresAt: parseLegacyDate(token.expiresAt),
      createdAt: parseLegacyDate(token.createdAt),
      note: '旧 Token 明文不可回收，且旧哈希与新令牌格式（yz_mcp_<tokenId>_<secret>）不兼容：迁移后一律停用，需在「MCP Token」页重建',
    };
  });

  if (state.auditLogs.length > 0) {
    dropped.push(
      `auditLogs（${state.auditLogs.length} 条）——旧结构没有可用的时间戳字段，且不含新模型要求的 request_id/actor 语义，不迁移；审计从新栈启用日重新累计`,
    );
  }
  for (const key of state.ignoredKeys) {
    dropped.push(`app_state.${key} —— 新模型无对应结构`);
  }

  // ── 对照表（迁移前生效可见 vs 迁移后生效可见） ───────────────────────────
  const comparison = users.map((user) => {
    const legacyVisible = state.blueprints
      .filter((blueprint) => legacyCanSee(state, blueprint, user.legacyId))
      .map((blueprint) => blueprint.id)
      .sort();
    const migratedVisible =
      user.identity === 'owner'
        ? blueprints.map((blueprint) => blueprint.id).sort()
        : blueprints
            .filter((blueprint) =>
              grants.some(
                (grant) =>
                  grant.userId === user.legacyId &&
                  (grant.targetType === 'group'
                    ? grant.targetId === blueprint.groupId
                    : grant.targetId === blueprint.id),
              ),
            )
            .map((blueprint) => blueprint.id)
            .sort();
    const change = diffChange(legacyVisible, migratedVisible);
    const notes: string[] = [];
    if (user.identity === 'owner') {
      notes.push('所有者在新模型里隐式拥有全部业务能力，可见范围恒为全部（设计如此）');
    }
    if (change === 'widened') {
      notes.push(
        '变宽：旧模型要求「函数级 demo-preview:view」与「资源级授权」同时满足，新模型只看资源级授权',
      );
    }
    if (change === 'narrowed') {
      notes.push('变窄：需人工复核，可能来自旧模型按函数权限放行的路径');
    }
    return {
      userId: user.legacyId,
      username: user.username,
      identity: user.identity,
      legacyVisible,
      migratedVisible,
      change,
      notes,
    };
  });

  const narrowed = comparison.filter((row) => row.change === 'narrowed');
  if (narrowed.length > 0) {
    warnings.push(
      `${narrowed.length} 个用户的可见范围在迁移后**变窄**，必须逐人复核：${narrowed
        .map((row) => row.username)
        .join('、')}`,
    );
  }

  return {
    ownerUserId,
    groups,
    users,
    grants,
    capabilities,
    blueprints,
    tokens,
    comparison,
    publishDecisions,
    warnings,
    dropped,
    counts: {
      users: users.length,
      userAdmins: users.filter((user) => user.identity === 'user_admin').length,
      members: users.filter((user) => user.identity === 'member').length,
      groups: groups.length,
      blueprints: blueprints.length,
      versions: blueprints.reduce((sum, blueprint) => sum + blueprint.versions.length, 0),
      grants: grants.length,
      capabilities: capabilities.length,
      tokens: tokens.length,
    },
  };
}

// ── 旧模型可见性（必须与 server/index.mjs:266-298 一致，用于对照） ───────────

function legacyCanSee(state: LegacyState, blueprint: LegacyBlueprint, userId: string): boolean {
  const hasManage = state.functionPermissions.some(
    (perm) => perm.userId === userId && perm.module === 'demo-preview' && perm.level === 'manage',
  );
  if ((blueprint.status || 'active') !== 'active' && !hasManage) return false;
  const hasView = state.functionPermissions.some(
    (perm) =>
      perm.userId === userId &&
      perm.module === 'demo-preview' &&
      (perm.level === 'view' || perm.level === 'manage'),
  );
  if (!hasView) return false;
  return state.blueprintPermissions.some(
    (perm) =>
      perm.userId === userId &&
      (perm.targetType === 'group' ? perm.targetId === blueprint.groupId : perm.targetId === blueprint.id),
  );
}

function planGroups(
  state: LegacyState,
  defaultGroupId: string,
  warnings: string[],
): PlannedGroup[] {
  const groups: PlannedGroup[] = state.groups.map((group) => ({
    id: group.id,
    name: group.name,
    isDefault: group.id === defaultGroupId || group.isDefault,
    sortOrder: Number.isFinite(group.order) ? group.order : 0,
    // 旧模型没有分组归档态：新模型里分组归档是新增能力，迁移时一律视为未归档。
    archivedAt: null,
    synthesized: false,
  }));

  const defaults = groups.filter((group) => group.isDefault);
  if (defaults.length > 1) {
    // 新库有 `blueprint_groups_single_default` 唯一索引：只能留一个。
    const keep = defaults.find((group) => group.id === defaultGroupId) ?? defaults[0];
    for (const group of defaults) {
      if (group !== keep) group.isDefault = false;
    }
    warnings.push(
      `旧数据里有 ${defaults.length} 个默认分组，已保留 ${keep?.id}，其余取消默认标记（新库有唯一索引约束）`,
    );
  }

  if (!groups.some((group) => group.isDefault)) {
    const existing = groups.find((group) => group.id === defaultGroupId);
    if (existing) {
      existing.isDefault = true;
    } else {
      groups.unshift({
        id: defaultGroupId,
        name: '默认分组',
        isDefault: true,
        sortOrder: 0,
        archivedAt: null,
        synthesized: true,
      });
      warnings.push(`旧数据里没有默认分组，已按新库约定补出 ${defaultGroupId}（默认分组）`);
    }
  }

  const seen = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id)) {
      warnings.push(`旧数据里有重复的分组 id ${group.id}，只保留第一个`);
    }
    seen.add(group.id);
  }
  return groups.filter((group, index) => groups.findIndex((item) => item.id === group.id) === index);
}

function planVersions(blueprint: LegacyBlueprint, warnings: string[]): PlannedVersion[] {
  const raw = blueprint.versions.filter((version) => version.version);
  if (raw.length === 0) {
    warnings.push(`蓝图 ${blueprint.name}(${blueprint.id}) 没有任何版本，迁移后仍可维护但打不开预览`);
    return [];
  }
  const latest = raw.filter((version) => version.isLatest);
  let latestVersion = latest[0]?.version ?? '';
  if (latest.length > 1) {
    latestVersion = [...latest].sort((a, b) => compareDeployedAt(b, a))[0]?.version ?? '';
    warnings.push(
      `蓝图 ${blueprint.name}(${blueprint.id}) 在旧数据里有 ${latest.length} 个 isLatest 版本，已保留最新的 ${latestVersion}，其余取消最新标记（新库有唯一索引约束）`,
    );
  }
  if (!latestVersion) {
    latestVersion = [...raw].sort((a, b) => compareDeployedAt(b, a))[0]?.version ?? '';
    warnings.push(
      `蓝图 ${blueprint.name}(${blueprint.id}) 没有任何版本被标记为最新，已按发布时间取 ${latestVersion}`,
    );
  }
  return raw.map((version) => ({
    id: version.id,
    version: version.version,
    isLatest: version.version === latestVersion,
    status: version.status === 'unavailable' ? 'missing' : 'available',
    publishSource: 'web',
    publishNote: '',
    deployedAt: parseLegacyDate(version.deployedAt),
    expectedArtifactDir: true,
    inlineMarkdown: version.markdown ? version.markdown : null,
  }));
}

function compareDeployedAt(a: LegacyVersion, b: LegacyVersion): number {
  return (parseLegacyDate(a.deployedAt) ?? '').localeCompare(parseLegacyDate(b.deployedAt) ?? '');
}

/**
 * 旧时间格式五花八门：`2026-12-31 23:59`、`未使用`、空串、ISO。
 * 迁移不编造时间：无法解析时给 null，由列默认值/报告承担。
 */
export function parseLegacyDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text || text === '未使用' || text === '-' || text === 'null') return null;
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized;
  const parsed = new Date(`${withSeconds}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(withSeconds) ? '' : '+08:00'}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function diffChange(before: string[], after: string[]): ComparisonRow['change'] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((id) => !beforeSet.has(id));
  const removed = before.filter((id) => !afterSet.has(id));
  if (added.length === 0 && removed.length === 0) return 'same';
  if (added.length > 0 && removed.length === 0) return 'widened';
  if (removed.length > 0 && added.length === 0) return 'narrowed';
  return 'narrowed';
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function usernameOf(users: Map<string, LegacyUser>, userId: string): string {
  return users.get(userId)?.username ?? userId;
}

function groupNameOf(state: LegacyState, groupId: string): string {
  return state.groups.find((group) => group.id === groupId)?.name ?? groupId;
}
