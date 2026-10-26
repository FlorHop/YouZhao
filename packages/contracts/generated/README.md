# @youzhao/contracts

契约的唯一事实来源是 `packages/contracts/schemas/**/*.json`（本文件由生成器维护）。

## 当前契约

| 文件 | 生成的类型 | 生成的运行时 schema |
| --- | --- | --- |
| `schemas/auth/login.json` | `LoginRequest` | `authLoginSchema` |
| `schemas/auth/session.json` | `SessionResponse` | `authSessionSchema` |
| `schemas/blueprint-groups/create.json` | `CreateBlueprintGroupRequest` | `blueprintGroupsCreateSchema` |
| `schemas/blueprint-groups/list.json` | `BlueprintGroupsListResponse` | `blueprintGroupsListSchema` |
| `schemas/blueprint-groups/mutation.json` | `BlueprintGroupMutationResponse` | `blueprintGroupsMutationSchema` |
| `schemas/blueprint-groups/reorder.json` | `ReorderBlueprintGroupsRequest` | `blueprintGroupsReorderSchema` |
| `schemas/blueprints/create.json` | `CreateBlueprintRequest` | `blueprintsCreateSchema` |
| `schemas/blueprints/detail.json` | `BlueprintDetailResponse` | `blueprintsDetailSchema` |
| `schemas/blueprints/list.json` | `BlueprintsListResponse` | `blueprintsListSchema` |
| `schemas/blueprints/mutation.json` | `BlueprintMutationResponse` | `blueprintsMutationSchema` |
| `schemas/blueprints/publish-version.json` | `PublishBlueprintVersionRequest` | `blueprintsPublishVersionSchema` |
| `schemas/blueprints/update.json` | `UpdateBlueprintRequest` | `blueprintsUpdateSchema` |
| `schemas/common/error.json` | `ErrorResponse` | `commonErrorSchema` |
| `schemas/embed/ticket.json` | `EmbedTicketRequest` | `embedTicketSchema` |
| `schemas/mcp/connection-info.json` | `McpConnectionInfoResponse` | `mcpConnectionInfoSchema` |
| `schemas/mcp/cover-blueprint-version-output.json` | `McpCoverBlueprintVersionOutput` | `mcpCoverBlueprintVersionOutputSchema` |
| `schemas/mcp/cover-blueprint-version.json` | `McpCoverBlueprintVersionInput` | `mcpCoverBlueprintVersionSchema` |
| `schemas/mcp/create-blueprint-group-output.json` | `McpCreateBlueprintGroupOutput` | `mcpCreateBlueprintGroupOutputSchema` |
| `schemas/mcp/create-blueprint-group.json` | `McpCreateBlueprintGroupInput` | `mcpCreateBlueprintGroupSchema` |
| `schemas/mcp/delete-blueprint-version-output.json` | `McpDeleteBlueprintVersionOutput` | `mcpDeleteBlueprintVersionOutputSchema` |
| `schemas/mcp/delete-blueprint-version.json` | `McpDeleteBlueprintVersionInput` | `mcpDeleteBlueprintVersionSchema` |
| `schemas/mcp/get-blueprint-artifact-output.json` | `McpGetBlueprintArtifactOutput` | `mcpGetBlueprintArtifactOutputSchema` |
| `schemas/mcp/get-blueprint-artifact.json` | `McpGetBlueprintArtifactInput` | `mcpGetBlueprintArtifactSchema` |
| `schemas/mcp/get-blueprint-output.json` | `McpGetBlueprintOutput` | `mcpGetBlueprintOutputSchema` |
| `schemas/mcp/get-blueprint.json` | `McpGetBlueprintInput` | `mcpGetBlueprintSchema` |
| `schemas/mcp/list-blueprint-groups-output.json` | `McpListBlueprintGroupsOutput` | `mcpListBlueprintGroupsOutputSchema` |
| `schemas/mcp/list-blueprint-groups.json` | `McpListBlueprintGroupsInput` | `mcpListBlueprintGroupsSchema` |
| `schemas/mcp/list-blueprints-output.json` | `McpListBlueprintsOutput` | `mcpListBlueprintsOutputSchema` |
| `schemas/mcp/list-blueprints.json` | `McpListBlueprintsInput` | `mcpListBlueprintsSchema` |
| `schemas/mcp/publish-blueprint-output.json` | `McpPublishBlueprintOutput` | `mcpPublishBlueprintOutputSchema` |
| `schemas/mcp/publish-blueprint.json` | `McpPublishBlueprintInput` | `mcpPublishBlueprintSchema` |
| `schemas/me/password.json` | `ChangeOwnPasswordRequest` | `mePasswordSchema` |
| `schemas/me/update.json` | `UpdateMeRequest` | `meUpdateSchema` |
| `schemas/preview/ticket-response.json` | `PreviewTicketResponse` | `previewTicketResponseSchema` |
| `schemas/preview/ticket.json` | `PreviewTicketRequest` | `previewTicketSchema` |
| `schemas/system/health.json` | `HealthResponse` | `systemHealthSchema` |
| `schemas/tokens/create-response.json` | `CreateMcpTokenResponse` | `tokensCreateResponseSchema` |
| `schemas/tokens/create.json` | `CreateMcpTokenRequest` | `tokensCreateSchema` |
| `schemas/tokens/list.json` | `TokensListResponse` | `tokensListSchema` |
| `schemas/tokens/mutation.json` | `McpTokenMutationResponse` | `tokensMutationSchema` |
| `schemas/tokens/update.json` | `UpdateMcpTokenRequest` | `tokensUpdateSchema` |
| `schemas/tokens/verify-response.json` | `VerifyMcpTokenResponse` | `tokensVerifyResponseSchema` |
| `schemas/tokens/verify.json` | `VerifyMcpTokenRequest` | `tokensVerifySchema` |
| `schemas/users/access.json` | `UserAccessResponse` | `usersAccessSchema` |
| `schemas/users/capabilities.json` | `SetUserCapabilitiesRequest` | `usersCapabilitiesSchema` |
| `schemas/users/create.json` | `CreateUserRequest` | `usersCreateSchema` |
| `schemas/users/grants-change.json` | `UserGrantsChangeRequest` | `usersGrantsChangeSchema` |
| `schemas/users/grants.json` | `UserGrantsResponse` | `usersGrantsSchema` |
| `schemas/users/identity.json` | `SetUserIdentityRequest` | `usersIdentitySchema` |
| `schemas/users/jurisdiction-set.json` | `SetUserJurisdictionRequest` | `usersJurisdictionSetSchema` |
| `schemas/users/jurisdiction.json` | `UserJurisdictionResponse` | `usersJurisdictionSchema` |
| `schemas/users/list.json` | `UsersListResponse` | `usersListSchema` |
| `schemas/users/managed-by.json` | `SetManagedByRequest` | `usersManagedBySchema` |
| `schemas/users/password.json` | `ResetUserPasswordRequest` | `usersPasswordSchema` |
| `schemas/users/update.json` | `UpdateUserRequest` | `usersUpdateSchema` |

## 命令

```bash
pnpm -C packages/contracts gen      # 重新生成 generated/
pnpm -C packages/contracts check    # 校验生成物是否同步（CI 用）
```

## 新增一个动作的顺序（docs/architecture-design.md §6.1）

1. 加 schema（入参 + 出参各一份，`$id` = 文件相对路径）
2. 加权限矩阵行（docs/permission-design.md）
3. 写用例
4. 最后加界面

## 约束

- `$id` 必须等于文件相对路径；顶层必须有 `title`（唯一）与 `additionalProperties: false`。
- 支持顶层 `$defs` 与同文件 `$ref`（只接受 `#/$defs/<name>`，名字须是合法标识符且已声明）；跨文件引用不支持。
- `generated/` 提交进仓库；CI 会在生成物过期时失败。
