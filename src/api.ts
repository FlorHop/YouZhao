import type { Demo, DemoGroup, DemoPermission, DemoVersion, FunctionPermission, McpToken, User } from './types';

const apiBase = import.meta.env.VITE_API_BASE_URL ?? '';
const tokenStorageKey = 'youzhao.auth.token';

interface ApiResponse<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

interface LoginResponse {
  token: string;
  user: User;
}

interface EmbedExchangeResponse {
  token: string;
  user: User;
  redirect: string;
  groupIds: string[];
}

export interface SetupStatus {
  setupRequired: boolean;
  userCount: number;
}

interface MeResponse {
  user: User;
  functionPermissions: FunctionPermission[];
  blueprintPermissions: DemoPermission[];
}

interface BlueprintGroupResponse {
  items: Array<DemoGroup & { blueprintCount: number }>;
  total: number;
}

interface BlueprintListItem {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  groupId: string;
  status: Demo['status'];
  latestVersion: string | null;
  updatedAt: string;
}

interface BlueprintDetail extends BlueprintListItem {
  versions: Array<{
    id: string;
    version: string;
    isLatest: boolean;
    status: string;
    previewUrl: string;
    artifactUrl: string;
    publishedAt: string;
  }>;
}

interface ArtifactResponse {
  content: string;
}

export interface AdminSnapshot {
  users: User[];
  functionPermissions: FunctionPermission[];
  blueprintPermissions: DemoPermission[];
  mcpTokens: McpToken[];
}

export function getAuthToken() {
  return localStorage.getItem(tokenStorageKey);
}

export function setAuthToken(token: string) {
  localStorage.setItem(tokenStorageKey, token);
}

export function clearAuthToken() {
  localStorage.removeItem(tokenStorageKey);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers
  });
  const payload = (await response.json().catch(() => ({}))) as ApiResponse<T> & T;

  if (!response.ok) {
    const message = 'error' in payload && payload.error ? payload.error.message : '服务请求失败';
    throw new Error(message);
  }

  return 'data' in payload && payload.data !== undefined ? payload.data : (payload as T);
}

export async function loginApi(username: string, password: string) {
  return request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

export async function exchangeEmbedTicketApi(ticket: string) {
  return request<EmbedExchangeResponse>('/api/embed/exchange', {
    method: 'POST',
    body: JSON.stringify({ ticket })
  });
}

export async function getSetupStatusApi() {
  return request<SetupStatus>('/api/setup/status');
}

export async function setupAdminApi(payload: Pick<User, 'username' | 'displayName' | 'email' | 'phone'> & { password: string }) {
  return request<{ user: User; setup: SetupStatus }>('/api/setup/admin', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function getMeApi() {
  return request<MeResponse>('/api/me');
}

export async function getBlueprintGroupsApi() {
  return request<BlueprintGroupResponse>('/api/blueprint-groups?includeEmpty=true');
}

export async function createBlueprintGroupApi(name: string) {
  return request<BlueprintGroupResponse>('/api/blueprint-groups', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
}

export async function deleteBlueprintGroupApi(groupId: string) {
  return request<{ groups: BlueprintGroupResponse; blueprints: { items: BlueprintListItem[]; total: number } }>(
    `/api/blueprint-groups/${encodeURIComponent(groupId)}`,
    { method: 'DELETE' }
  );
}

export async function reorderBlueprintGroupsApi(groupIds: string[]) {
  return request<BlueprintGroupResponse>('/api/blueprint-groups/reorder', {
    method: 'PATCH',
    body: JSON.stringify({ groupIds })
  });
}

export async function getBlueprintsApi(status: 'active' | 'archived' | 'all' = 'active') {
  const params = new URLSearchParams({ limit: '100', status });
  return request<{ items: BlueprintListItem[]; total: number }>(`/api/blueprints?${params.toString()}`);
}

export async function getBlueprintDetailApi(blueprintId: string) {
  return request<BlueprintDetail>(`/api/blueprints/${encodeURIComponent(blueprintId)}`);
}

export async function updateBlueprintApi(
  blueprintId: string,
  payload: Partial<Pick<Demo, 'name' | 'summary' | 'tags' | 'groupId' | 'status'>>
) {
  return request<BlueprintDetail>(`/api/blueprints/${encodeURIComponent(blueprintId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

export async function deleteBlueprintApi(blueprintId: string) {
  return request<{ id: string }>(`/api/blueprints/${encodeURIComponent(blueprintId)}`, {
    method: 'DELETE'
  });
}

export async function getBlueprintArtifactApi(blueprintId: string, version: string, artifactType: 'html' | 'markdown') {
  const params = new URLSearchParams({ version, artifactType });
  return request<ArtifactResponse>(`/api/blueprints/${encodeURIComponent(blueprintId)}/artifact?${params.toString()}`);
}

export async function getAdminUsersApi() {
  return request<AdminSnapshot>('/api/admin/users');
}

export async function createUserApi(payload: Omit<User, 'id' | 'createdAt'> & { password?: string }) {
  return request<{ user: User; admin: AdminSnapshot }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function updateUserApi(userId: string, payload: Omit<User, 'id' | 'createdAt' | 'username'>) {
  return request<{ user: User; admin: AdminSnapshot }>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

export async function deleteUserApi(userId: string) {
  return request<{ admin: AdminSnapshot }>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE'
  });
}

export async function resetUserPasswordApi(userId: string, password: string) {
  return request<{ user: User; admin: AdminSnapshot }>(`/api/admin/users/${encodeURIComponent(userId)}/password`, {
    method: 'POST',
    body: JSON.stringify({ password })
  });
}

export async function updateUserPermissionsApi(
  userId: string,
  payload: {
    functionPermissions: Array<Omit<FunctionPermission, 'userId'>>;
    blueprintPermissions: Array<Omit<DemoPermission, 'userId'>>;
  }
) {
  return request<{ admin: AdminSnapshot }>(`/api/admin/users/${encodeURIComponent(userId)}/permissions`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export async function createMcpTokenApi(payload: Pick<McpToken, 'name' | 'expiresAt'>) {
  return request<{ token: string; mcpToken: McpToken; admin: AdminSnapshot }>('/api/admin/mcp-tokens', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function updateMcpTokenApi(tokenId: string, payload: Pick<McpToken, 'status'>) {
  return request<{ mcpToken: McpToken; admin: AdminSnapshot }>(`/api/admin/mcp-tokens/${encodeURIComponent(tokenId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

export async function deleteMcpTokenApi(tokenId: string) {
  return request<{ admin: AdminSnapshot }>(`/api/admin/mcp-tokens/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE'
  });
}

export function toDemoVersion(blueprintId: string, version: BlueprintDetail['versions'][number]): DemoVersion {
  return {
    id: version.id,
    demoId: blueprintId,
    version: version.version,
    isLatest: version.isLatest,
    previewUrl: version.previewUrl,
    artifactUrl: version.artifactUrl,
    markdown: '',
    status: version.status === 'available' ? 'available' : 'unavailable',
    deployedAt: version.publishedAt
  };
}

export function toDemo(detail: BlueprintDetail): Demo {
  return {
    id: detail.id,
    name: detail.name,
    summary: detail.summary,
    tags: detail.tags,
    groupId: detail.groupId,
    status: detail.status ?? 'active',
    versions: detail.versions.map((version) => toDemoVersion(detail.id, version)),
    createdAt: detail.updatedAt,
    updatedAt: detail.updatedAt
  };
}
