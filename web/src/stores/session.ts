/**
 * 会话与身份状态（Pinia）。
 *
 * 关键约定：
 *   - 身份只有三种：`owner`（唯一）/ `user_admin` / `member`；**没有 role 字段**。
 *   - 前端的主体性判断只用于「导航与操作入口是否渲染」，**不是安全边界**：
 *     服务端逐接口校验，越权一律以 403 返回（设计 §11）。
 *   - 会话凭证在 HttpOnly Cookie 里，前端只持有「我是谁 + 我有什么」的快照。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { ApiError } from '@/services/api';
import * as api from '@/services/endpoints';
import type { CapabilityName, CurrentUser, Identity, SessionData, TargetType } from '@/services/endpoints';

export type SessionStatus = 'unknown' | 'anonymous' | 'authenticated';

const IDENTITY_LABELS: Record<Identity, string> = {
  owner: '平台所有者',
  user_admin: '用户管理员',
  member: '普通用户',
};

const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  'blueprint.manage': '蓝图管理',
  'blueprint.publish': '蓝图发布',
};

export function identityLabel(identity: Identity): string {
  return IDENTITY_LABELS[identity];
}

export function capabilityLabel(capability: CapabilityName): string {
  return CAPABILITY_LABELS[capability];
}

export const useSessionStore = defineStore('session', () => {
  const status = ref<SessionStatus>('unknown');
  const me = ref<SessionData | null>(null);
  const loadError = ref<string | null>(null);

  const user = computed<CurrentUser | null>(() => me.value?.user ?? null);
  const identity = computed<Identity | null>(() => user.value?.identity ?? null);
  const isOwner = computed(() => identity.value === 'owner');
  const isUserAdmin = computed(() => identity.value === 'user_admin');
  /** 用户管理界面的准入身份（普通用户整体不可进入，见设计 §4）。 */
  const canEnterManagement = computed(() => isOwner.value || isUserAdmin.value);
  const displayName = computed(() => user.value?.displayName ?? '');
  const viewGrants = computed(() => me.value?.viewGrants ?? []);
  const delegableScopes = computed(() => me.value?.delegableScopes ?? []);
  const capabilities = computed(() => me.value?.capabilities ?? []);
  /** 我管辖的分组 / 单蓝图（仅用户管理员会有内容；管辖派生写权在 capabilities 里已生效）。 */
  const jurisdiction = computed(
    () => me.value?.jurisdiction ?? { groupIds: [] as string[], blueprintIds: [] as string[] },
  );

  function apply(data: SessionData): void {
    me.value = data;
    status.value = 'authenticated';
    loadError.value = null;
  }

  function clear(): void {
    me.value = null;
    status.value = 'anonymous';
  }

  /** 进入应用时拉取会话；401 视为未登录（不报错）。 */
  async function load(): Promise<void> {
    try {
      apply(await api.fetchSession());
    } catch (error) {
      if (error instanceof ApiError && error.isAuthError) {
        clear();
        return;
      }
      loadError.value = error instanceof Error ? error.message : '会话加载失败';
      status.value = 'anonymous';
    }
  }

  async function signIn(username: string, password: string): Promise<void> {
    apply(await api.login(username, password));
  }

  async function signOut(): Promise<void> {
    try {
      await api.logout();
    } finally {
      clear();
    }
  }

  /** 本人资料变更后同步刷新快照（会话不变）。 */
  async function refresh(): Promise<void> {
    apply(await api.fetchSession());
  }

  // ── 可见性/能力判定（仅用于渲染决策） ──────────────────────────────────

  /** 授权项是否覆盖目标：要么直接授到目标，要么授到目标所在分组。 */
  function isGranted(targetType: TargetType, targetId: string, groupId?: string | null): boolean {
    if (isOwner.value) return true;
    return viewGrants.value.some(
      (grant) =>
        (grant.targetType === targetType && grant.targetId === targetId) ||
        (grant.targetType === 'group' && groupId !== undefined && groupId !== null && grant.targetId === groupId),
    );
  }

  /** 是否持有某项业务能力（可限定目标）。 */
  function hasCapability(capability: CapabilityName, target?: { type: TargetType; id: string; groupId?: string | null }): boolean {
    if (isOwner.value) return true;
    return capabilities.value.some((item) => {
      if (item.capability !== capability) return false;
      if (target === undefined) return true;
      if (item.targetType === target.type && item.targetId === target.id) return true;
      return (
        item.targetType === 'group' &&
        target.groupId !== undefined &&
        target.groupId !== null &&
        item.targetId === target.groupId
      );
    });
  }

  /** 蓝图卡片操作区按能力装配（P2）：两者皆无时保持纯浏览态。 */
  function blueprintCapabilities(blueprint: { id: string; groupId: string }): {
    canManage: boolean;
    canPublish: boolean;
  } {
    return {
      canManage: hasCapability('blueprint.manage', {
        type: 'blueprint',
        id: blueprint.id,
        groupId: blueprint.groupId,
      }),
      canPublish: hasCapability('blueprint.publish', {
        type: 'group',
        id: blueprint.groupId,
        groupId: blueprint.groupId,
      }),
    };
  }

  /** 是否能创建蓝图（= 至少在一个分组上有发布权）。 */
  const canPublishAnywhere = computed(() => hasCapability('blueprint.publish'));

  return {
    status,
    me,
    loadError,
    user,
    identity,
    isOwner,
    isUserAdmin,
    canEnterManagement,
    displayName,
    viewGrants,
    delegableScopes,
    capabilities,
    jurisdiction,
    canPublishAnywhere,
    apply,
    clear,
    load,
    signIn,
    signOut,
    refresh,
    isGranted,
    hasCapability,
    blueprintCapabilities,
  };
});
