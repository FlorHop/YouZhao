/**
 * 端点绑定层：把服务端契约映射成有名字的函数。
 *
 * 页面只调用这里，不直接拼路径（`docs/frontend-design.md` §11：
 * 权限裁剪一律在服务端，前端不做安全过滤）。
 * 类型全部取自 `@youzhao/contracts/types`（契约是唯一事实来源）。
 */

import type {
  BlueprintDetailResponse,
  BlueprintGroupsListResponse,
  BlueprintMutationResponse,
  BlueprintsListResponse,
  CreateBlueprintGroupRequest,
  CreateBlueprintRequest,
  CreateMcpTokenRequest,
  CreateMcpTokenResponse,
  CreateUserRequest,
  McpTokenMutationResponse,
  PublishBlueprintVersionRequest,
  ReorderBlueprintGroupsRequest,
  SessionResponse,
  TokensListResponse,
  UpdateBlueprintRequest,
  UpdateMcpTokenRequest,
  UpdateMeRequest,
  ChangeOwnPasswordRequest,
  UsersListResponse,
} from '@youzhao/contracts/types';

import { apiData, apiList, apiRequest } from './api';
import type { Envelope, ListEnvelope } from './api';

// ── 行类型（从契约响应里取，避免另写一份形状） ─────────────────────────────

export type SessionData = SessionResponse['data'];
export type CurrentUser = SessionData['user'];
export type ViewGrant = SessionData['viewGrants'][number];
export type ScopeRef = SessionData['delegableScopes'][number];
export type CapabilityRef = SessionData['capabilities'][number];
export type UserRow = UsersListResponse['data']['items'][number];
export type GrantRow = ViewGrant;
export type TokenRow = TokensListResponse['data']['items'][number];
export type BlueprintGroup = BlueprintGroupsListResponse['data']['items'][number];
export type BlueprintCard = BlueprintsListResponse['data']['items'][number];
export type BlueprintDetail = BlueprintDetailResponse['data']['blueprint'];
export type BlueprintVersion = BlueprintDetailResponse['data']['versions'][number];
export type BlueprintCapabilities = BlueprintDetailResponse['data']['capabilities'];
export type BlueprintMutation = BlueprintMutationResponse['data'];

export type Identity = CurrentUser['identity'];
export type UserStatus = CurrentUser['status'];
export type CapabilityName = CapabilityRef['capability'];
export type TargetType = ViewGrant['targetType'];
export type TokenScope = TokenRow['scopes'][number];

// ── 会话与本人 ─────────────────────────────────────────────────────────────

export function fetchSession(): Promise<SessionData> {
  return apiData<SessionData>('/api/me');
}

export function login(username: string, password: string): Promise<SessionData> {
  return apiData<SessionData>('/api/auth/login', { method: 'POST', json: { username, password } });
}

export async function logout(): Promise<void> {
  await apiRequest<null>('/api/auth/logout', { method: 'POST' });
}

export function updateMe(input: UpdateMeRequest): Promise<SessionData> {
  return apiData<SessionData>('/api/me', { method: 'PATCH', json: input });
}

export async function changeMyPassword(input: ChangeOwnPasswordRequest): Promise<void> {
  await apiRequest<null>('/api/me/password', { method: 'POST', json: input });
}

// ── 用户（O / A） ─────────────────────────────────────────────────────────

export type ListUsersQuery = {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: UserStatus;
  identity?: Identity;
};

export function listUsers(query: ListUsersQuery = {}): Promise<ListEnvelope<UserRow>> {
  return apiList<UserRow>('/api/users', { query });
}

export function createUser(input: CreateUserRequest): Promise<Envelope<UserRow>> {
  return apiRequest<Envelope<UserRow>>('/api/users', { method: 'POST', json: input });
}

export function updateUser(
  userId: string,
  input: { displayName?: string; email?: string | null; phone?: string | null },
): Promise<Envelope<UserRow>> {
  return apiRequest<Envelope<UserRow>>(`/api/users/${userId}`, { method: 'PATCH', json: input });
}

export async function resetUserPassword(userId: string, password: string): Promise<void> {
  await apiRequest<null>(`/api/users/${userId}/password`, { method: 'POST', json: { password } });
}

export async function deleteUser(userId: string): Promise<void> {
  await apiRequest<null>(`/api/users/${userId}`, { method: 'DELETE' });
}

export async function setManagedBy(userId: string, managerIds: string[]): Promise<void> {
  await apiRequest<null>(`/api/users/${userId}/managed-by`, {
    method: 'PUT',
    json: { managerIds },
  });
}

/** 身份变更：O 任命/撤销用户管理员（`identity` 只能在 `user_admin` 与 `member` 之间）。 */
export function setUserIdentity(userId: string, identity: 'user_admin' | 'member'): Promise<Envelope<UserRow>> {
  return apiRequest<Envelope<UserRow>>(`/api/users/${userId}/identity`, {
    method: 'PUT',
    json: { identity },
  });
}

export function listUserGrants(userId: string): Promise<ListEnvelope<ViewGrant>> {
  return apiList<ViewGrant>(`/api/users/${userId}/grants`, { query: { pageSize: 100 } });
}

/** 增量语义：`add` / `remove` 只带本次变更项（设计 §8.2）。 */
export function changeUserGrants(
  userId: string,
  change: { add?: ScopeRef[]; remove?: ScopeRef[] },
): Promise<Envelope<{ items: ViewGrant[] }>> {
  return apiRequest<Envelope<{ items: ViewGrant[] }>>(`/api/users/${userId}/grants`, {
    method: 'POST',
    json: change,
  });
}

/** 整体替换该用户的业务能力（`PUT` 语义，需显式范围）。 */
export function setUserCapabilities(
  userId: string,
  capabilities: CapabilityRef[],
): Promise<Envelope<{ capabilities: CapabilityRef[] }>> {
  return apiRequest<Envelope<{ capabilities: CapabilityRef[] }>>(`/api/users/${userId}/capabilities`, {
    method: 'PUT',
    json: { capabilities },
  });
}

// ── MCP Token ─────────────────────────────────────────────────────────────

export function listTokens(params: { boundUserId?: string } = {}): Promise<ListEnvelope<TokenRow>> {
  return apiList<TokenRow>('/api/mcp-tokens', { query: params });
}

export function createToken(input: CreateMcpTokenRequest): Promise<Envelope<CreateMcpTokenResponse['data']>> {
  return apiRequest<Envelope<CreateMcpTokenResponse['data']>>('/api/mcp-tokens', {
    method: 'POST',
    json: input,
  });
}

export function updateToken(
  tokenId: string,
  input: UpdateMcpTokenRequest,
): Promise<Envelope<McpTokenMutationResponse['data']>> {
  return apiRequest<Envelope<McpTokenMutationResponse['data']>>(`/api/mcp-tokens/${tokenId}`, {
    method: 'PATCH',
    json: input,
  });
}

export function deleteToken(tokenId: string): Promise<Envelope<McpTokenMutationResponse['data']>> {
  return apiRequest<Envelope<McpTokenMutationResponse['data']>>(`/api/mcp-tokens/${tokenId}`, {
    method: 'DELETE',
  });
}

// ── 蓝图分组 ──────────────────────────────────────────────────────────────

export function listBlueprintGroups(): Promise<ListEnvelope<BlueprintGroup>> {
  return apiList<BlueprintGroup>('/api/blueprint-groups');
}

export function createBlueprintGroup(input: CreateBlueprintGroupRequest): Promise<Envelope<{ group: BlueprintGroup }>> {
  return apiRequest<Envelope<{ group: BlueprintGroup }>>('/api/blueprint-groups', {
    method: 'POST',
    json: input,
  });
}

export function reorderBlueprintGroups(input: ReorderBlueprintGroupsRequest): Promise<Envelope<unknown>> {
  return apiRequest<Envelope<unknown>>('/api/blueprint-groups/reorder', { method: 'PATCH', json: input });
}

/** 归档分组：其下蓝图回落默认分组、该分组授权同时移除，产物保留可恢复。 */
export function archiveBlueprintGroup(groupId: string): Promise<Envelope<unknown>> {
  return apiRequest<Envelope<unknown>>(`/api/blueprint-groups/${groupId}`, { method: 'DELETE' });
}

export function restoreBlueprintGroup(groupId: string): Promise<Envelope<unknown>> {
  return apiRequest<Envelope<unknown>>(`/api/blueprint-groups/${groupId}/restore`, { method: 'POST' });
}

// ── 蓝图 ──────────────────────────────────────────────────────────────────

export type ListBlueprintsQuery = {
  page?: number;
  pageSize?: number;
  keyword?: string;
  groupId?: string;
  status?: 'active' | 'archived';
};

export function listBlueprints(query: ListBlueprintsQuery = {}): Promise<ListEnvelope<BlueprintCard>> {
  return apiList<BlueprintCard>('/api/blueprints', { query });
}

/** 列表接口同时返回可见分组（含每组卡片数），P2 因此不需要逐条请求详情。 */
export function listBlueprintsWithGroups(query: ListBlueprintsQuery = {}): Promise<{
  items: BlueprintCard[];
  groups: BlueprintGroupsListResponse['data']['items'];
  meta: ListEnvelope<BlueprintCard>['meta'];
}> {
  return apiList<BlueprintCard>('/api/blueprints', { query }).then((envelope) => ({
    items: envelope.data.items,
    groups: (envelope.data as { groups?: BlueprintGroupsListResponse['data']['items'] }).groups ?? [],
    meta: envelope.meta,
  }));
}

export function getBlueprint(blueprintId: string): Promise<BlueprintDetailResponse['data']> {
  return apiData<BlueprintDetailResponse['data']>(`/api/blueprints/${blueprintId}`);
}

/** 产物以压缩包上传：包内必须含入口 `index.html`（先校验后落盘）。 */
export function createBlueprintWithArtifact(
  input: CreateBlueprintRequest,
  artifact: File,
): Promise<Envelope<BlueprintMutation>> {
  const form = new FormData();
  form.set('name', input.name);
  if (input.summary !== undefined) form.set('summary', input.summary);
  if (input.tags !== undefined) form.set('tags', JSON.stringify(input.tags));
  if (input.groupId !== undefined) form.set('groupId', input.groupId);
  form.set('version', input.version);
  if (input.publishNote !== undefined) form.set('publishNote', input.publishNote);
  if (input.idempotencyKey !== undefined) form.set('idempotencyKey', input.idempotencyKey);
  form.set('artifact', artifact);
  return apiRequest<Envelope<BlueprintMutation>>('/api/blueprints', { method: 'POST', form });
}

export function publishBlueprintVersion(
  blueprintId: string,
  input: PublishBlueprintVersionRequest,
  artifact: File,
): Promise<Envelope<BlueprintMutation>> {
  const form = new FormData();
  form.set('version', input.version);
  if (input.publishNote !== undefined) form.set('publishNote', input.publishNote);
  if (input.makeLatest !== undefined) form.set('makeLatest', String(input.makeLatest));
  form.set('artifact', artifact);
  return apiRequest<Envelope<BlueprintMutation>>(`/api/blueprints/${blueprintId}/versions`, {
    method: 'POST',
    form,
  });
}

/** 覆盖已有版本：版本号不变、不新增版本；不可逆（确认框必须写明）。 */
export function coverBlueprintVersion(
  blueprintId: string,
  version: string,
  artifact: File,
  publishNote?: string,
): Promise<Envelope<BlueprintMutation>> {
  const form = new FormData();
  if (publishNote !== undefined) form.set('publishNote', publishNote);
  form.set('artifact', artifact);
  return apiRequest<Envelope<BlueprintMutation>>(`/api/blueprints/${blueprintId}/versions/${version}`, {
    method: 'PUT',
    form,
  });
}

export function updateBlueprint(
  blueprintId: string,
  input: UpdateBlueprintRequest,
): Promise<Envelope<BlueprintMutation>> {
  return apiRequest<Envelope<BlueprintMutation>>(`/api/blueprints/${blueprintId}`, {
    method: 'PATCH',
    json: input,
  });
}

/** 归档蓝图（连同全部版本；产物不物理删除，可恢复）。 */
export function archiveBlueprint(blueprintId: string): Promise<Envelope<BlueprintMutation>> {
  return apiRequest<Envelope<BlueprintMutation>>(`/api/blueprints/${blueprintId}`, { method: 'DELETE' });
}

export function restoreBlueprint(blueprintId: string): Promise<Envelope<BlueprintMutation>> {
  return apiRequest<Envelope<BlueprintMutation>>(`/api/blueprints/${blueprintId}/restore`, { method: 'POST' });
}

export function archiveBlueprintVersion(
  blueprintId: string,
  version: string,
): Promise<Envelope<BlueprintMutation>> {
  return apiRequest<Envelope<BlueprintMutation>>(`/api/blueprints/${blueprintId}/versions/${version}`, {
    method: 'DELETE',
  });
}

export function restoreBlueprintVersion(
  blueprintId: string,
  version: string,
): Promise<Envelope<BlueprintMutation>> {
  return apiRequest<Envelope<BlueprintMutation>>(
    `/api/blueprints/${blueprintId}/versions/${version}/restore`,
    { method: 'POST' },
  );
}

// ── 预览票据（P3 由票据换取短时受限 Cookie，产物因此不匿名可读） ───────────

export interface PreviewTicket {
  ticket: string;
  expiresAt: string;
  url: string;
  blueprintId: string;
  version: string;
  purpose: 'preview' | 'embed';
}

export function issuePreviewTicket(
  blueprintId: string,
  version: string,
): Promise<PreviewTicket> {
  return apiData<PreviewTicket>('/api/preview-tickets', {
    method: 'POST',
    json: { blueprintId, version, purpose: 'preview' },
  });
}
