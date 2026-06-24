import { computed, reactive, ref } from 'vue';
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
    return state.demos.filter((demo) => demoIds.has(demo.id));
  });

  const visibleGroups = computed(() => {
    if (!currentUser.value) return [];
    if (hasFunctionPermission('demo-preview', 'manage')) {
      return [...state.groups].sort((a, b) => {
        if (a.isDefault) return -1;
        if (b.isDefault) return 1;
        return a.createdAt.localeCompare(b.createdAt);
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
        return a.createdAt.localeCompare(b.createdAt);
      });
  });

  function createGroup(name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('分组名称不能为空');
    if (state.groups.some((group) => group.name === trimmed)) throw new Error('分组名称已存在');

    state.groups.push({
      id: `group_${Date.now()}`,
      name: trimmed,
      isDefault: false,
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
    });
  }

  function deleteGroup(groupId: string) {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) throw new Error('分组不存在');
    if (group.isDefault) throw new Error('默认分组不可删除');

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

  function updateDemo(demoId: string, patch: Partial<Pick<Demo, 'name' | 'summary' | 'tags' | 'groupId'>>) {
    const demo = state.demos.find((item) => item.id === demoId);
    if (!demo) throw new Error('蓝图不存在');
    Object.assign(demo, patch, {
      updatedAt: new Date().toLocaleString('zh-CN', { hour12: false })
    });
  }

  function createUser(payload: Omit<User, 'id' | 'createdAt'>, password = '123456') {
    const username = payload.username.trim();
    if (!username) throw new Error('用户名不能为空');
    if (state.users.some((user) => user.username === username)) throw new Error('用户名已存在');
    if (!password.trim()) throw new Error('密码不能为空');

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
  }

  function updateUser(userId: string, payload: Omit<User, 'id' | 'createdAt'>) {
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error('用户不存在');
    const previousUsername = user.username;
    Object.assign(user, payload);
    if (previousUsername !== user.username && state.credentials[previousUsername]) {
      state.credentials[user.username] = state.credentials[previousUsername];
      delete state.credentials[previousUsername];
    }
  }

  function deleteUser(userId: string) {
    if (state.users.length === 1) throw new Error('至少保留一个用户');
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

  function resetUserPassword(userId: string, password: string) {
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error('用户不存在');
    if (!password.trim()) throw new Error('密码不能为空');
    state.credentials[user.username] = password.trim();
  }

  function login(username: string, password: string) {
    const user = state.users.find((item) => item.username === username.trim());
    if (!user) throw new Error('用户名或密码错误');
    if (user.status !== 'enabled') throw new Error('该用户已停用');
    if (state.credentials[user.username] !== password) throw new Error('用户名或密码错误');

    currentUserId.value = user.id;
    localStorage.setItem(authStorageKey, user.id);
  }

  function logout() {
    currentUserId.value = null;
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

  function getFunctionLevel(userId: string, module: ModuleKey) {
    return state.functionPermissions.find((item) => item.userId === userId && item.module === module)?.level ?? null;
  }

  function getDemoPermissions(userId: string) {
    return state.demoPermissions.filter((item) => item.userId === userId);
  }

  function createMcpToken(payload: Pick<McpToken, 'name' | 'boundUserId' | 'expiresAt'>) {
    const name = payload.name.trim();
    if (!name) throw new Error('Token 名称不能为空');
    if (!currentUser.value || currentUser.value.id !== payload.boundUserId) throw new Error('Token 只能绑定当前用户');
    if (!hasFunctionPermission('demo-preview', 'manage')) throw new Error('仅蓝图管理者可以创建 Token');
    if (!state.users.some((user) => user.id === payload.boundUserId)) throw new Error('绑定用户不存在');

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

  function setMcpTokenStatus(tokenId: string, status: McpToken['status']) {
    const token = state.mcpTokens.find((item) => item.id === tokenId);
    if (!token) throw new Error('Token 不存在');
    token.status = status;
  }

  function deleteMcpToken(tokenId: string) {
    state.mcpTokens = state.mcpTokens.filter((item) => item.id !== tokenId);
  }

  return {
    state,
    currentUser,
    currentUserId,
    isAuthenticated,
    visibleDemos,
    visibleGroups,
    hasFunctionPermission,
    getUserVisibleDemoIds,
    createGroup,
    deleteGroup,
    updateDemo,
    createUser,
    updateUser,
    deleteUser,
    resetUserPassword,
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
