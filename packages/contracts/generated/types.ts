// ⚠️ 本文件由 packages/contracts/scripts/generate.mjs 生成，请勿手工修改。
// 契约的唯一事实来源是 packages/contracts/schemas/**/*.json。
// 修改契约后运行：pnpm -C packages/contracts gen

import type { FromSchema } from 'json-schema-to-ts';

import {
  authLoginSchema,
  authSessionSchema,
  blueprintGroupsCreateSchema,
  blueprintGroupsListSchema,
  blueprintGroupsMutationSchema,
  blueprintGroupsReorderSchema,
  blueprintsCreateSchema,
  blueprintsDetailSchema,
  blueprintsListSchema,
  blueprintsMutationSchema,
  blueprintsPublishVersionSchema,
  blueprintsUpdateSchema,
  commonErrorSchema,
  embedTicketSchema,
  mcpConnectionInfoSchema,
  mcpCoverBlueprintVersionOutputSchema,
  mcpCoverBlueprintVersionSchema,
  mcpCreateBlueprintGroupOutputSchema,
  mcpCreateBlueprintGroupSchema,
  mcpDeleteBlueprintVersionOutputSchema,
  mcpDeleteBlueprintVersionSchema,
  mcpGetBlueprintArtifactOutputSchema,
  mcpGetBlueprintArtifactSchema,
  mcpGetBlueprintOutputSchema,
  mcpGetBlueprintSchema,
  mcpListBlueprintGroupsOutputSchema,
  mcpListBlueprintGroupsSchema,
  mcpListBlueprintsOutputSchema,
  mcpListBlueprintsSchema,
  mcpPublishBlueprintOutputSchema,
  mcpPublishBlueprintSchema,
  mePasswordSchema,
  meUpdateSchema,
  previewTicketResponseSchema,
  previewTicketSchema,
  systemHealthSchema,
  tokensCreateResponseSchema,
  tokensCreateSchema,
  tokensListSchema,
  tokensMutationSchema,
  tokensUpdateSchema,
  tokensVerifyResponseSchema,
  tokensVerifySchema,
  usersCapabilitiesSchema,
  usersCreateSchema,
  usersGrantsChangeSchema,
  usersGrantsSchema,
  usersIdentitySchema,
  usersListSchema,
  usersManagedBySchema,
  usersPasswordSchema,
  usersUpdateSchema,
} from './schemas.js';

export type LoginRequest = FromSchema<typeof authLoginSchema>;
export type SessionResponse = FromSchema<typeof authSessionSchema>;
export type CreateBlueprintGroupRequest = FromSchema<typeof blueprintGroupsCreateSchema>;
export type BlueprintGroupsListResponse = FromSchema<typeof blueprintGroupsListSchema>;
export type BlueprintGroupMutationResponse = FromSchema<typeof blueprintGroupsMutationSchema>;
export type ReorderBlueprintGroupsRequest = FromSchema<typeof blueprintGroupsReorderSchema>;
export type CreateBlueprintRequest = FromSchema<typeof blueprintsCreateSchema>;
export type BlueprintDetailResponse = FromSchema<typeof blueprintsDetailSchema>;
export type BlueprintsListResponse = FromSchema<typeof blueprintsListSchema>;
export type BlueprintMutationResponse = FromSchema<typeof blueprintsMutationSchema>;
export type PublishBlueprintVersionRequest = FromSchema<typeof blueprintsPublishVersionSchema>;
export type UpdateBlueprintRequest = FromSchema<typeof blueprintsUpdateSchema>;
export type ErrorResponse = FromSchema<typeof commonErrorSchema>;
export type EmbedTicketRequest = FromSchema<typeof embedTicketSchema>;
export type McpConnectionInfoResponse = FromSchema<typeof mcpConnectionInfoSchema>;
export type McpCoverBlueprintVersionOutput = FromSchema<typeof mcpCoverBlueprintVersionOutputSchema>;
export type McpCoverBlueprintVersionInput = FromSchema<typeof mcpCoverBlueprintVersionSchema>;
export type McpCreateBlueprintGroupOutput = FromSchema<typeof mcpCreateBlueprintGroupOutputSchema>;
export type McpCreateBlueprintGroupInput = FromSchema<typeof mcpCreateBlueprintGroupSchema>;
export type McpDeleteBlueprintVersionOutput = FromSchema<typeof mcpDeleteBlueprintVersionOutputSchema>;
export type McpDeleteBlueprintVersionInput = FromSchema<typeof mcpDeleteBlueprintVersionSchema>;
export type McpGetBlueprintArtifactOutput = FromSchema<typeof mcpGetBlueprintArtifactOutputSchema>;
export type McpGetBlueprintArtifactInput = FromSchema<typeof mcpGetBlueprintArtifactSchema>;
export type McpGetBlueprintOutput = FromSchema<typeof mcpGetBlueprintOutputSchema>;
export type McpGetBlueprintInput = FromSchema<typeof mcpGetBlueprintSchema>;
export type McpListBlueprintGroupsOutput = FromSchema<typeof mcpListBlueprintGroupsOutputSchema>;
export type McpListBlueprintGroupsInput = FromSchema<typeof mcpListBlueprintGroupsSchema>;
export type McpListBlueprintsOutput = FromSchema<typeof mcpListBlueprintsOutputSchema>;
export type McpListBlueprintsInput = FromSchema<typeof mcpListBlueprintsSchema>;
export type McpPublishBlueprintOutput = FromSchema<typeof mcpPublishBlueprintOutputSchema>;
export type McpPublishBlueprintInput = FromSchema<typeof mcpPublishBlueprintSchema>;
export type ChangeOwnPasswordRequest = FromSchema<typeof mePasswordSchema>;
export type UpdateMeRequest = FromSchema<typeof meUpdateSchema>;
export type PreviewTicketResponse = FromSchema<typeof previewTicketResponseSchema>;
export type PreviewTicketRequest = FromSchema<typeof previewTicketSchema>;
export type HealthResponse = FromSchema<typeof systemHealthSchema>;
export type CreateMcpTokenResponse = FromSchema<typeof tokensCreateResponseSchema>;
export type CreateMcpTokenRequest = FromSchema<typeof tokensCreateSchema>;
export type TokensListResponse = FromSchema<typeof tokensListSchema>;
export type McpTokenMutationResponse = FromSchema<typeof tokensMutationSchema>;
export type UpdateMcpTokenRequest = FromSchema<typeof tokensUpdateSchema>;
export type VerifyMcpTokenResponse = FromSchema<typeof tokensVerifyResponseSchema>;
export type VerifyMcpTokenRequest = FromSchema<typeof tokensVerifySchema>;
export type SetUserCapabilitiesRequest = FromSchema<typeof usersCapabilitiesSchema>;
export type CreateUserRequest = FromSchema<typeof usersCreateSchema>;
export type UserGrantsChangeRequest = FromSchema<typeof usersGrantsChangeSchema>;
export type UserGrantsResponse = FromSchema<typeof usersGrantsSchema>;
export type SetUserIdentityRequest = FromSchema<typeof usersIdentitySchema>;
export type UsersListResponse = FromSchema<typeof usersListSchema>;
export type SetManagedByRequest = FromSchema<typeof usersManagedBySchema>;
export type ResetUserPasswordRequest = FromSchema<typeof usersPasswordSchema>;
export type UpdateUserRequest = FromSchema<typeof usersUpdateSchema>;
