export type ModuleKey = 'demo-preview' | 'system-settings';
export type PermissionLevel = 'view' | 'manage';
export type DemoPermissionTarget = 'group' | 'demo';
export type UserStatus = 'enabled' | 'disabled';
export type VersionStatus = 'available' | 'unavailable';
export type McpTokenStatus = 'enabled' | 'disabled';

export interface DemoVersion {
  id: string;
  demoId: string;
  version: string;
  isLatest: boolean;
  previewUrl: string;
  artifactUrl: string;
  markdown: string;
  status: VersionStatus;
  deployedAt: string;
}

export interface DemoGroup {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
}

export interface Demo {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  groupId: string;
  versions: DemoVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface FunctionPermission {
  userId: string;
  module: ModuleKey;
  level: PermissionLevel;
}

export interface DemoPermission {
  userId: string;
  targetType: DemoPermissionTarget;
  targetId: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  phone: string;
  status: UserStatus;
  createdAt: string;
}

export interface McpToken {
  id: string;
  name: string;
  boundUserId: string;
  status: McpTokenStatus;
  tokenPreview: string;
  expiresAt: string;
  lastUsedAt: string;
  createdAt: string;
}
