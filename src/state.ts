import { computed, reactive, ref } from 'vue';
import {
  type AdminSnapshot,
  clearAuthToken,
  createBlueprintGroupApi,
  createMcpTokenApi,
  deleteBlueprintApi,
  createUserApi,
  deleteBlueprintGroupApi,
  deleteMcpTokenApi,
  deleteUserApi,
  getAuthToken,
  getAdminUsersApi,
  getBlueprintArtifactApi,
  getBlueprintDetailApi,
  getBlueprintGroupsApi,
  getBlueprintsApi,
  getMeApi,
  loginApi,
  reorderBlueprintGroupsApi,
  resetUserPasswordApi,
  setAuthToken,
  toDemo,
  updateBlueprintApi,
  updateMcpTokenApi,
  updateUserPermissionsApi,
  updateUserApi
} from './api';
import {
  defaultGroupId,
  authCredentialsSeed,
  demoPermissionsSeed,
  demosSeed,
  functionPermissionsSeed,
  groupsSeed,
  mcpTokensSeed,
  usersSeed
} from './mockData';
import type {
  Demo,
  DemoGroup,
  DemoPermission,
  FunctionPermission,
  McpToken,
  ModuleKey,
  PermissionLevel,
  User
} from './types';

const state = reactive({
  users: structuredClone(usersSeed) as User[],
  groups: structuredClone(groupsSeed) as DemoGroup[],
  demos: structuredClone(demosSeed) as Demo[],
  functionPermissions: structuredClone(functionPermissionsSeed) as FunctionPermission[],
  demoPermissions: structuredClone(demoPermissionsSeed) as DemoPermission[],
  mcpTokens: structuredClone(mcpTokensSeed) as McpToken[],
  credentials: structuredClone(authCredentialsSeed) as Record<string, string>
});

const authStorageKey = 'youzhao.auth.userId';
export const currentUserId = ref<string | null>(localStorage.getItem(authStorageKey));
export const isAuthenticated = computed(() => Boolean(currentUserId.value));
const hasBackendToken = computed(() => Boolean(getAuthToken()));

let bootstrapPromise: Promise<void> | null = null;

function upsertById<T extends { id: string }>(collection: T[], item: T) {
  const index = collection.findIndex((current) => current.id === item.id);
  if (index >= 0) {
    collection[index] = item;
  } else {
    collection.push(item);
  }
}

function applyMe(payload: {
  user: User;
  functionPermissions: FunctionPermission[];
  blueprintPermissions: DemoPermission[];
}) {
  upsertById(state.users, payload.user);
  state.functionPermissions = [
    ...state.functionPermissions.filter((permission) => permission.userId !== payload.user.id),
    ...payload.functionPermissions
  ];
  state.demoPermissions = [
    ...state.demoPermissions.filter((permission) => permission.userId !== payload.user.id),
    ...payload.blueprintPermissions
  ];
  currentUserId.value = payload.user.id;
  localStorage.setItem(authStorageKey, payload.user.id);
}

function applyAdminSnapshot(payload: AdminSnapshot) {
  state.users = payload.users;
  state.functionPermissions = payload.functionPermissions;
  state.demoPermissions = payload.blueprintPermissions;
  state.mcpTokens = payload.mcpTokens;
}

export function useAppState() {
  const currentUser = computed(() => state.users.find((user) => user.id === currentUserId.value) ?? null);

  function hasFunctionPermission(module: ModuleKey, required: PermissionLevel) {
    const userId = currentUser.value?.id;
    if (!userId) return false;
    const permission = state.functionPermissions.find(
      (item) => item.userId === userId && item.module === module
    );

    if (!permission) return false;
    if (required === 'view') return permission.level === 'view' || permission.level === 'manage';
    return permission.level === 'manage';
  }

  function getUserVisibleDemoIds(userId: string) {
    const permissions = state.demoPermissions.filter((item) => item.userId === userId);
    const groupIds = new Set(
      permissions.filter((item) => item.targetType === 'group').map((item) => item.targetId)
    );
    const demoIds = new Set(
      permissions.filter((item) => item.targetType === 'demo').map((item) => item.targetId)
    );

    state.demos.forEach((demo) => {
      if (groupIds.has(demo.groupId)) {
        demoIds.add(demo.id);
      }
    });

    return demoIds;
  }

  const visibleDemos = computed(() => {
    if (!currentUser.value) return [];
    if (!hasFunctionPermission('demo-preview', 'view')) return [];
    const demoIds = getUserVisibleDemoIds(currentUser.value.id);
    const canManage = hasFunctionPermission('demo-preview', 'manage');
    return state.demos.filter((demo) => (canManage || demo.status !== 'archived') && demoIds.has(demo.id));
  });

  const visibleGroups = computed(() => {
    if (!currentUser.value) return [];
    if (hasFunctionPermission('demo-preview', 'manage')) {
      return [...state.groups].sort((a, b) => {
        if (a.isDefault) return -1;
        if (b.isDefault) return 1;
        return a.order - b.order || a.createdAt.localeCompare(b.createdAt);
      });
    }

    const groupIds = new Set(
      state.demoPermissions
        .filter((permission) => permission.userId === currentUser.value?.id && permission.targetType === 'group')
        .map((permission) => permission.targetId)
    );
    visibleDemos.value.forEach((demo) => groupIds.add(demo.groupId));

    return state.groups
      .filter((group) => groupIds.has(group.id))
      .sort((a, b) => {
        if (a.isDefault) return -1;
        if (b.isDefault) return 1;
        return a.order - b.order || a.createdAt.localeCompare(b.createdAt);
      });
  });

  async function bootstrapSession() {
    if (!getAuthToken()) return;
    if (!bootstrapPromise) {
      bootstrapPromise = getMeApi()
        .then(applyMe)
        .catch(() => {
          clearAuthToken();
          currentUserId.value = null;
          localStorage.removeItem(authStorageKey);
        })
        .finally(() => {
          bootstrapPromise = null;
        });
    }
    await bootstrapPromise;
  }

  async function refreshBlueprints() {
    await bootstrapSession();
    if (!getAuthToken() || !currentUser.value || !hasFunctionPermission('demo-preview', 'view')) return;

    const blueprintStatus = hasFunctionPermission('demo-preview', 'manage') ? 'all' : 'active';
    const [groupsResponse, blueprintsResponse] = await Promise.all([
      getBlueprintGroupsApi(),
      getBlueprintsApi(blueprintStatus)
    ]);
    state.groups = groupsResponse.items.map(({ blueprintCount, ...group }) => group);

    const details = await Promise.all(blueprintsResponse.items.map((blueprint) => getBlueprintDetailApi(blueprint.id)));
    state.demos = details.map(toDemo);
  }

  async function refreshAdminData() {
    await bootstrapSession();
    if (!getAuthToken() || !currentUser.value || !hasFunctionPermission('system-settings', 'manage')) return;
    applyAdminSnapshot(await getAdminUsersApi());
  }

  async function loadBlueprintDetail(blueprintId: string) {
    await bootstrapSession();
    if (!getAuthToken()) return state.demos.find((demo) => demo.id === blueprintId) ?? null;
    const detail = await getBlueprintDetailApi(blueprintId);
    const demo = toDemo(detail);
    upsertById(state.demos, demo);
    return demo;
  }

  async function loadBlueprintMarkdown(blueprintId: string, version: string) {
    const demo = state.demos.find((item) => item.id === blueprintId);
    const targetVersion = demo?.versions.find((item) => item.version === version);
    if (targetVersion?.markdown) return targetVersion.markdown;
    if (!getAuthToken()) return targetVersion?.markdown ?? '';

    const artifact = await getBlueprintArtifactApi(blueprintId, version, 'markdown');
    if (targetVersion) targetVersion.markdown = artifact.content;
    return artifact.content;
  }

  function applyGroupResponse(response: { items: Array<DemoGroup & { blueprintCount?: number }> }) {
    state.groups = response.items.map(({ blueprintCount, ...group }) => group);
  }

  async function createGroup(name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('分组名称不能为空');
    if (state.groups.some((group) => group.name === trimmed)) throw new Error('分组名称已存在');

    if (getAuthToken()) {
      applyGroupResponse(await createBlueprintGroupApi(trimmed));
      return;
    }

    const group = {
      id: `group_${Date.now()}`,
      name: trimmed,
      isDefault: false,
      order: Math.max(...state.groups.map((group) => group.order), 0) + 10,
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
    };
    state.groups.push(group);
    state.functionPermissions
      .filter((permission) => permission.module === 'demo-preview' && permission.level === 'manage')
      .forEach((permission) => {
        const exists = state.demoPermissions.some(
          (item) => item.userId === permission.userId && item.targetType === 'group' && item.targetId === group.id
        );
        if (!exists) {
          state.demoPermissions.push({ userId: permission.userId, targetType: 'group', targetId: group.id });
        }
      });
  }

  async function deleteGroup(groupId: string) {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) throw new Error('分组不存在');
    if (group.isDefault) throw new Error('默认分组不可删除');

    if (getAuthToken()) {
      const response = await deleteBlueprintGroupApi(groupId);
      applyGroupResponse(response.groups);
      await refreshBlueprints();
      return;
    }

    state.demos.forEach((demo) => {
      if (demo.groupId === groupId) {
        demo.groupId = defaultGroupId;
        demo.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      }
    });
    state.demoPermissions = state.demoPermissions.filter(
      (permission) => !(permission.targetType === 'group' && permission.targetId === groupId)
    );
    state.groups = state.groups.filter((item) => item.id !== groupId);
  }

  async function reorderGroups(groupIds: string[]) {
    if (getAuthToken()) {
      applyGroupResponse(await reorderBlueprintGroupsApi(groupIds));
      return;
    }
    groupIds.forEach((groupId, index) => {
      const group = state.groups.find((item) => item.id === groupId);
      if (group) group.order = index * 10;
    });
  }

  async function updateDemo(
    demoId: string,
    patch: Partial<Pick<Demo, 'name' | 'summary' | 'tags' | 'groupId' | 'status'>>
  ) {
    const demo = state.demos.find((item) => item.id === demoId);
    if (!demo) throw new Error('蓝图不存在');
    if (getAuthToken()) {
      const updated = toDemo(await updateBlueprintApi(demoId, patch));
      upsertById(state.demos, updated);
      return updated;
    }
    Object.assign(demo, patch, {
      updatedAt: new Date().toLocaleString('zh-CN', { hour12: false })
    });
    return demo;
  }

  async function archiveDemo(demoId: string) {
    return updateDemo(demoId, { status: 'archived' });
  }

  async function restoreDemo(demoId: string) {
    return updateDemo(demoId, { status: 'active' });
  }

  async function deleteDemo(demoId: string) {
    const demo = state.demos.find((item) => item.id === demoId);
    if (!demo) throw new Error('蓝图不存在');
    if (getAuthToken()) {
      await deleteBlueprintApi(demoId);
      state.demos = state.demos.filter((item) => item.id !== demoId);
      state.demoPermissions = state.demoPermissions.filter(
        (permission) => !(permission.targetType === 'demo' && permission.targetId === demoId)
      );
      return;
    }
    state.demos = state.demos.filter((item) => item.id !== demoId);
    state.demoPermissions = state.demoPermissions.filter(
      (permission) => !(permission.targetType === 'demo' && permission.targetId === demoId)
    );
  }

  async function createUser(payload: Omit<User, 'id' | 'createdAt'>, password = '123456') {
    const username = payload.username.trim();
    if (!username) throw new Error('用户名不能为空');
    if (state.users.some((user) => user.username === username)) throw new Error('用户名已存在');
    if (!password.trim()) throw new Error('密码不能为空');

    if (getAuthToken()) {
      const response = await createUserApi({ ...payload, username, password: password.trim() });
      applyAdminSnapshot(response.admin);
      return response.user;
    }

    const user: User = {
      ...payload,
      username,
      id: `user_${Date.now()}`,
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
    };

    state.users.push(user);
    state.credentials[user.username] = password.trim();
    state.functionPermissions.push({ userId: user.id, module: 'demo-preview', level: 'view' });
    state.demoPermissions.push({ userId: user.id, targetType: 'group', targetId: defaultGroupId });
    return user;
  }

  async function updateUser(userId: string, payload: Omit<User, 'id' | 'createdAt'>) {
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error('用户不存在');

    if (getAuthToken()) {
      const { username, ...serverPayload } = payload;
      const response = await updateUserApi(userId, serverPayload);
      applyAdminSnapshot(response.admin);
      return response.user;
    }

    const previousUsername = user.username;
    Object.assign(user, payload);
    if (previousUsername !== user.username && state.credentials[previousUsername]) {
      state.credentials[user.username] = state.credentials[previousUsername];
      delete state.credentials[previousUsername];
    }
    return user;
  }

  async function deleteUser(userId: string) {
    if (state.users.length === 1) throw new Error('至少保留一个用户');
    if (getAuthToken()) {
      const response = await deleteUserApi(userId);
      applyAdminSnapshot(response.admin);
      if (currentUserId.value === userId) {
        logout();
      }
      return;
    }

    const user = state.users.find((item) => item.id === userId);
    state.users = state.users.filter((user) => user.id !== userId);
    if (user) delete state.credentials[user.username];
    state.functionPermissions = state.functionPermissions.filter((item) => item.userId !== userId);
    state.demoPermissions = state.demoPermissions.filter((item) => item.userId !== userId);
    state.mcpTokens = state.mcpTokens.filter((item) => item.boundUserId !== userId);
    if (currentUserId.value === userId) {
      logout();
    }
  }

  async function resetUserPassword(userId: string, password: string) {
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error('用户不存在');
    if (!password.trim()) throw new Error('密码不能为空');
    if (getAuthToken()) {
      const response = await resetUserPasswordApi(userId, password.trim());
      applyAdminSnapshot(response.admin);
      return;
    }
    state.credentials[user.username] = password.trim();
  }

  async function login(username: string, password: string) {
    try {
      const payload = await loginApi(username, password);
      setAuthToken(payload.token);
      const me = await getMeApi();
      applyMe(me);
      return;
    } catch (backendError) {
      clearAuthToken();
      const canUseLocalFallback = !backendError || (backendError as Error).message === 'Failed to fetch';
      if (!canUseLocalFallback) throw backendError;
    }

    const user = state.users.find((item) => item.username === username.trim());
    if (!user) throw new Error('用户名或密码错误');
    if (user.status !== 'enabled') throw new Error('该用户已停用');
    if (state.credentials[user.username] !== password) throw new Error('用户名或密码错误');

    currentUserId.value = user.id;
    localStorage.setItem(authStorageKey, user.id);
  }

  function logout() {
    currentUserId.value = null;
    clearAuthToken();
    localStorage.removeItem(authStorageKey);
  }

  function setFunctionPermission(userId: string, module: ModuleKey, level: PermissionLevel | null) {
    state.functionPermissions = state.functionPermissions.filter(
      (item) => !(item.userId === userId && item.module === module)
    );
    if (level) {
      state.functionPermissions.push({ userId, module, level });
    }
  }

  function setDemoPermissions(userId: string, permissions: DemoPermission[]) {
    state.demoPermissions = state.demoPermissions.filter((item) => item.userId !== userId);
    state.demoPermissions.push(...permissions);
  }

  async function updateUserPermissions(
    userId: string,
    nextFunctionPermissions: Array<Omit<FunctionPermission, 'userId'>>,
    nextDemoPermissions: Array<Omit<DemoPermission, 'userId'>>
  ) {
    if (getAuthToken()) {
      const response = await updateUserPermissionsApi(userId, {
        functionPermissions: nextFunctionPermissions,
        blueprintPermissions: nextDemoPermissions
      });
      applyAdminSnapshot(response.admin);
      return;
    }

    state.functionPermissions = state.functionPermissions.filter((item) => item.userId !== userId);
    state.functionPermissions.push(
      ...nextFunctionPermissions.map((permission) => ({
        ...permission,
        userId
      }))
    );
    setDemoPermissions(
      userId,
      nextDemoPermissions.map((permission) => ({
        ...permission,
        userId
      }))
    );
  }

  function getFunctionLevel(userId: string, module: ModuleKey) {
    return state.functionPermissions.find((item) => item.userId === userId && item.module === module)?.level ?? null;
  }

  function getDemoPermissions(userId: string) {
    return state.demoPermissions.filter((item) => item.userId === userId);
  }

  async function createMcpToken(payload: Pick<McpToken, 'name' | 'boundUserId' | 'expiresAt'>) {
    const name = payload.name.trim();
    if (!name) throw new Error('Token 名称不能为空');
    if (!currentUser.value || currentUser.value.id !== payload.boundUserId) throw new Error('Token 只能绑定当前用户');
    if (!hasFunctionPermission('demo-preview', 'manage')) throw new Error('仅蓝图管理者可以创建 Token');
    if (!state.users.some((user) => user.id === payload.boundUserId)) throw new Error('绑定用户不存在');

    if (getAuthToken()) {
      const response = await createMcpTokenApi({ name, expiresAt: payload.expiresAt });
      applyAdminSnapshot(response.admin);
      return response.token;
    }

    const randomPart = Math.random().toString(36).slice(2, 10);
    const suffix = randomPart.slice(-4);
    state.mcpTokens.unshift({
      id: `mcp_token_${Date.now()}`,
      name,
      boundUserId: payload.boundUserId,
      status: 'enabled',
      tokenPreview: `yz_mcp_****_${suffix}`,
      expiresAt: payload.expiresAt || '永不过期',
      lastUsedAt: '未使用',
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
    });

    return `yz_mcp_${randomPart}_${Date.now()}`;
  }

  async function setMcpTokenStatus(tokenId: string, status: McpToken['status']) {
    if (getAuthToken()) {
      const response = await updateMcpTokenApi(tokenId, { status });
      applyAdminSnapshot(response.admin);
      return;
    }
    const token = state.mcpTokens.find((item) => item.id === tokenId);
    if (!token) throw new Error('Token 不存在');
    token.status = status;
  }

  async function deleteMcpToken(tokenId: string) {
    if (getAuthToken()) {
      const response = await deleteMcpTokenApi(tokenId);
      applyAdminSnapshot(response.admin);
      return;
    }
    state.mcpTokens = state.mcpTokens.filter((item) => item.id !== tokenId);
  }

  return {
    state,
    currentUser,
    currentUserId,
    isAuthenticated,
    hasBackendToken,
    visibleDemos,
    visibleGroups,
    hasFunctionPermission,
    bootstrapSession,
    refreshBlueprints,
    refreshAdminData,
    loadBlueprintDetail,
    loadBlueprintMarkdown,
    getUserVisibleDemoIds,
    createGroup,
    deleteGroup,
    reorderGroups,
    updateDemo,
    archiveDemo,
    restoreDemo,
    deleteDemo,
    createUser,
    updateUser,
    deleteUser,
    resetUserPassword,
    updateUserPermissions,
    setFunctionPermission,
    setDemoPermissions,
    getFunctionLevel,
    getDemoPermissions,
    createMcpToken,
    setMcpTokenStatus,
    deleteMcpToken,
    login,
    logout
  };
}
