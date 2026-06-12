import { computed, reactive, ref } from 'vue';
import {
  defaultGroupId,
  demoPermissionsSeed,
  demosSeed,
  functionPermissionsSeed,
  groupsSeed,
  usersSeed
} from './mockData';
import type {
  Demo,
  DemoGroup,
  DemoPermission,
  FunctionPermission,
  ModuleKey,
  PermissionLevel,
  User
} from './types';

const state = reactive({
  users: structuredClone(usersSeed) as User[],
  groups: structuredClone(groupsSeed) as DemoGroup[],
  demos: structuredClone(demosSeed) as Demo[],
  functionPermissions: structuredClone(functionPermissionsSeed) as FunctionPermission[],
  demoPermissions: structuredClone(demoPermissionsSeed) as DemoPermission[]
});

export const currentUserId = ref('user_admin');

export function useAppState() {
  const currentUser = computed(() => state.users.find((user) => user.id === currentUserId.value) ?? state.users[0]);

  function hasFunctionPermission(module: ModuleKey, required: PermissionLevel) {
    const permission = state.functionPermissions.find(
      (item) => item.userId === currentUser.value.id && item.module === module
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
    if (!hasFunctionPermission('demo-preview', 'view')) return [];
    const demoIds = getUserVisibleDemoIds(currentUser.value.id);
    return state.demos.filter((demo) => demoIds.has(demo.id));
  });

  const visibleGroups = computed(() => {
    const groupIds = new Set(visibleDemos.value.map((demo) => demo.groupId));
    groupIds.add(defaultGroupId);
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
    if (!demo) throw new Error('Demo 不存在');
    Object.assign(demo, patch, {
      updatedAt: new Date().toLocaleString('zh-CN', { hour12: false })
    });
  }

  function createUser(payload: Omit<User, 'id' | 'createdAt'>) {
    const username = payload.username.trim();
    if (!username) throw new Error('用户名不能为空');
    if (state.users.some((user) => user.username === username)) throw new Error('用户名已存在');

    const user: User = {
      ...payload,
      username,
      id: `user_${Date.now()}`,
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
    };

    state.users.push(user);
    state.functionPermissions.push({ userId: user.id, module: 'demo-preview', level: 'view' });
    state.demoPermissions.push({ userId: user.id, targetType: 'group', targetId: defaultGroupId });
  }

  function updateUser(userId: string, payload: Omit<User, 'id' | 'createdAt'>) {
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error('用户不存在');
    Object.assign(user, payload);
  }

  function deleteUser(userId: string) {
    if (state.users.length === 1) throw new Error('至少保留一个用户');
    state.users = state.users.filter((user) => user.id !== userId);
    state.functionPermissions = state.functionPermissions.filter((item) => item.userId !== userId);
    state.demoPermissions = state.demoPermissions.filter((item) => item.userId !== userId);
    if (currentUserId.value === userId) {
      currentUserId.value = state.users[0]?.id ?? '';
    }
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

  return {
    state,
    currentUser,
    currentUserId,
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
    setFunctionPermission,
    setDemoPermissions,
    getFunctionLevel,
    getDemoPermissions
  };
}
