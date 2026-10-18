/**
 * MCP 工具集（docs/architecture-design.md §4.5、§4.6）。
 *
 * 三条纪律，和 HTTP 层完全对称：
 * 1. **不重复实现领域逻辑**：范围解析、能力判定、产物校验与落盘、审计全部复用
 *    `app/blueprints.ts` 的用例——HTTP 与 MCP 是同一套用例的两个入口；
 * 2. **入参 schema 来自契约包**（`packages/contracts/schemas/mcp/*.json` → 生成物），
 *    不在这里手写第二份；SDK 用 `fromJsonSchema` 把 JSON Schema 转成它的校验器；
 * 3. **Token 的 scope 只是闸门**：真正的能力仍由绑定用户的身份/能力决定（S3 裁决：
 *    Token 能力 = 绑定用户能力 ∩ Token scope）。
 *
 * 已知未覆盖（记录在案，勿当作已支持）：
 * - `outputSchema` 未提供：MCP 工具的响应形状与 HTTP 信封不同，契约包只有入参 schema，
 *   因此响应不做 schema 校验（structuredContent 为宽松对象）。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { CONTRACT_VERSION } from '@youzhao/contracts/version';
import {
  mcpCoverBlueprintVersionOutputSchema,
  mcpCoverBlueprintVersionSchema,
  mcpCreateBlueprintGroupOutputSchema,
  mcpDeleteBlueprintVersionOutputSchema,
  mcpGetBlueprintArtifactOutputSchema,
  mcpGetBlueprintOutputSchema,
  mcpListBlueprintGroupsOutputSchema,
  mcpListBlueprintsOutputSchema,
  mcpPublishBlueprintOutputSchema,
  mcpCreateBlueprintGroupSchema,
  mcpDeleteBlueprintVersionSchema,
  mcpGetBlueprintArtifactSchema,
  mcpGetBlueprintSchema,
  mcpListBlueprintGroupsSchema,
  mcpListBlueprintsSchema,
  mcpPublishBlueprintSchema,
} from '@youzhao/contracts/schemas';
import type {
  CreateBlueprintGroupRequest,
  CreateBlueprintRequest,
  McpCoverBlueprintVersionInput,
  McpCreateBlueprintGroupInput,
  McpDeleteBlueprintVersionInput,
  McpGetBlueprintArtifactInput,
  McpGetBlueprintInput,
  McpListBlueprintsInput,
  McpPublishBlueprintInput,
  PublishBlueprintVersionRequest,
} from '@youzhao/contracts/types';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/types.js';
import { writeAudit } from '../audit/audit.js';
import type { RequestContext, TokenScope } from '../domain/entities.js';
import { AppError, isAppError } from '../domain/errors.js';
import { assertToolScope } from '../domain/policy.js';
import {
  archiveBlueprintVersion,
  coverBlueprintVersion,
  createBlueprint,
  createBlueprintGroup,
  getBlueprintDetail,
  listBlueprintGroups,
  listBlueprints,
  publishBlueprintVersion,
  type CallerFacts,
} from '../app/blueprints.js';
import { issuePreviewTicket } from '../app/preview.js';
import { artifactDirFor } from '../storage/artifacts.js';
import { buildZip } from '../storage/zip.js';
import { withIdempotency } from './idempotency.js';

/** 文本产物内联返回的上限（超过则只回清单 + 票据）。 */
const TEXT_INLINE_LIMIT = 512 * 1024;
const TEXT_PATH_RE = /\.(?:html?|md|markdown|txt|json|css|js|svg)$/i;

export const MCP_TOOL_NAMES = [
  'youzhao.list_blueprint_groups',
  'youzhao.list_blueprints',
  'youzhao.get_blueprint',
  'youzhao.get_blueprint_artifact',
  'youzhao.publish_blueprint',
  'youzhao.cover_blueprint_version',
  'youzhao.delete_blueprint_version',
  'youzhao.create_blueprint_group',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * 每个 MCP 工具所需的 Token scope（§4.4/§4.5）。**同一份事实来源**同时被两处使用：
 * - `mcp/http.ts` 在**协议层**先拦一次（这样 scope 不足回的是 403 + `insufficient_scope`，
 *   而不是 JSON-RPC 里的 `isError: true`——规范要求前者）；
 * - 工具实现内再 `assertToolScope` 兜一次（防将来新增调用路径绕过 HTTP 层）。
 */
export const MCP_TOOL_SCOPES: Record<McpToolName, TokenScope> = {
  'youzhao.list_blueprint_groups': 'read:blueprint',
  'youzhao.list_blueprints': 'read:blueprint',
  'youzhao.get_blueprint': 'read:blueprint',
  'youzhao.get_blueprint_artifact': 'read:blueprint',
  'youzhao.publish_blueprint': 'publish:blueprint',
  'youzhao.cover_blueprint_version': 'publish:blueprint',
  'youzhao.delete_blueprint_version': 'publish:blueprint',
  'youzhao.create_blueprint_group': 'publish:blueprint',
};

/** 工具名 → 所需 scope；不是已知工具时返回 undefined（交给 SDK 报参数错误）。 */
export function requiredScopeForTool(name: string): TokenScope | undefined {
  return (MCP_TOOL_SCOPES as Record<string, TokenScope>)[name];
}

export interface McpDeps {
  readonly db: Db;
  readonly config: AppConfig;
  /** Token 的绑定用户上下文（`actorType: 'token'`）。 */
  readonly context: RequestContext;
  readonly tokenId: string;
  /** Token 自身的 scope：`tools/list` 按此裁剪工具集（§4.5）。 */
  readonly scopes: readonly TokenScope[];
  readonly call: CallerFacts;
}

/** JSON Schema → SDK 校验器；契约包的 `JsonSchema` 类型比 SDK 的窄，这里显式放宽。 */
function inputSchema<T>(schema: unknown) {
  return fromJsonSchema<T>(schema as never);
}

/** 出参 schema：同一份契约 JSON Schema，声明的是工具返回结构（§4.5）。 */
function outputSchemaOf(schema: unknown) {
  return fromJsonSchema<unknown>(schema as never);
}

function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

interface ArtifactManifest {
  readonly entry?: string;
  readonly files?: readonly { readonly path: string; readonly bytes: number }[];
}

async function readManifest(dir: string): Promise<ArtifactManifest> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as ArtifactManifest;
  } catch {
    return {};
  }
}

async function listArtifactFiles(dir: string): Promise<{ path: string; bytes: number }[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: { path: string; bytes: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'manifest.json') continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dir, absolute).split(path.sep).join('/');
    const stat = await readFile(absolute);
    files.push({ path: relative, bytes: stat.byteLength });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function buildYouzhaoMcpServer(deps: McpDeps): McpServer {
  const { db, config, context, tokenId, call } = deps;
  // 平台目前只有一个对外版本号（契约版本）；MCP 的 serverInfo.version 与之一致，
  // 避免出现「应用版本 / 契约版本」两套互相对不上的字符串。
  const server = new McpServer({ name: 'youzhao', version: CONTRACT_VERSION });
  const storageRoot = config.preview.storagePath;

  /**
   * 按 Token scope 裁剪工具集（§4.5「按 Token scope 过滤工具集」）：scope 不够的工具**根本不注册**，
   * 于是 `tools/list` 天然只列出调用方拿得到的工具。注意这只是「少列」而非闸门——真正的拦截在
   * `mcp/http.ts` 的协议层预检（403 + insufficient_scope）与工具内的 `assertToolScope`。
   */
  const tokenScopes = new Set<TokenScope>(deps.scopes);
  const enabled = (name: McpToolName): boolean => tokenScopes.has(MCP_TOOL_SCOPES[name]);

  /**
   * 统一出口：领域错误转成工具级失败（协议级 401/403 由 HTTP 层先行返回，不到这里），
   * 并为**每一次工具调用**写一条审计（§4.6：调用时间 / token_id / 绑定用户 / Tool 名 /
   * 结果 / 错误码 / IP / 耗时）。审计只经共享的 `audit/audit.ts`，这里不拼 SQL。
   */
  async function guard(toolName: McpToolName, run: () => Promise<unknown>): Promise<CallToolResult> {
    const startedAt = Date.now();
    try {
      const value = await run();
      await writeAudit(db, {
        actorType: 'token',
        actorId: context.userId,
        tokenId,
        requestId: call.requestId,
        action: `mcp.${toolName}`,
        result: 'allow',
        ip: call.ip,
        durationMs: Date.now() - startedAt,
        detail: { tool: toolName },
      });
      return ok(value);
    } catch (error) {
      const appError = isAppError(error) ? error : undefined;
      await writeAudit(db, {
        actorType: 'token',
        actorId: context.userId,
        tokenId,
        requestId: call.requestId,
        action: `mcp.${toolName}`,
        result: appError === undefined ? 'error' : 'deny',
        errorCode: appError?.code ?? 'INTERNAL_ERROR',
        ip: call.ip,
        durationMs: Date.now() - startedAt,
        detail: { tool: toolName },
      });
      if (appError === undefined) throw error;
      const body = { error: { code: appError.code, message: appError.message, details: appError.details } };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        structuredContent: body,
      };
    }
  }

  if (enabled('youzhao.list_blueprint_groups'))
  server.registerTool(
    'youzhao.list_blueprint_groups',
    {
      title: '列出蓝图分组',
      description: '列出当前 Token 绑定用户可见的蓝图分组（含可见蓝图数）。无需参数。',
      inputSchema: inputSchema<Record<string, never>>(mcpListBlueprintGroupsSchema),
      outputSchema: outputSchemaOf(mcpListBlueprintGroupsOutputSchema),
      annotations: { readOnlyHint: true },
    },
    () =>
      guard('youzhao.list_blueprint_groups', async () => {
        assertToolScope(context, 'read:blueprint');
        return { groups: await listBlueprintGroups(db, context) };
      }),
  );

  if (enabled('youzhao.list_blueprints'))
  server.registerTool(
    'youzhao.list_blueprints',
    {
      title: '列出蓝图',
      description: '分页列出可见蓝图；可按分组、关键词、状态过滤。服务端按查看范围过滤。',
      inputSchema: inputSchema<McpListBlueprintsInput>(mcpListBlueprintsSchema),
      outputSchema: outputSchemaOf(mcpListBlueprintsOutputSchema),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard('youzhao.list_blueprints', async () => {
        assertToolScope(context, 'read:blueprint');
        return listBlueprints(db, context, {
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 20,
          ...(args.keyword === undefined ? {} : { keyword: args.keyword }),
          ...(args.groupId === undefined ? {} : { groupId: args.groupId }),
          ...(args.status === undefined ? {} : { status: args.status }),
        });
      }),
  );

  if (enabled('youzhao.get_blueprint'))
  server.registerTool(
    'youzhao.get_blueprint',
    {
      title: '读取蓝图元数据',
      description: '读取一份蓝图的元数据与版本列表；可用 version 指定单个版本。',
      inputSchema: inputSchema<McpGetBlueprintInput>(mcpGetBlueprintSchema),
      outputSchema: outputSchemaOf(mcpGetBlueprintOutputSchema),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard('youzhao.get_blueprint', async () => {
        assertToolScope(context, 'read:blueprint');
        const detail = await getBlueprintDetail(db, context, args.blueprintId);
        if (args.version === undefined) return detail;
        const versions = detail.versions.filter((item) => item.version === args.version);
        if (versions.length === 0) throw new AppError('VERSION_NOT_FOUND');
        return { ...detail, versions };
      }),
  );

  if (enabled('youzhao.get_blueprint_artifact'))
  server.registerTool(
    'youzhao.get_blueprint_artifact',
    {
      title: '读取蓝图产物',
      description:
        '读取某个版本的产物：单文件文本产物（Markdown/HTML）直接内联返回 text；多文件产物返回 files[] 清单与入口票据 URL（一次性，60 秒内有效）。',
      inputSchema: inputSchema<McpGetBlueprintArtifactInput>(mcpGetBlueprintArtifactSchema),
      outputSchema: outputSchemaOf(mcpGetBlueprintArtifactOutputSchema),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard('youzhao.get_blueprint_artifact', async () => {
        assertToolScope(context, 'read:blueprint');
        const detail = await getBlueprintDetail(db, context, args.blueprintId);
        const chosen =
          args.version === undefined
            ? (detail.versions.find((item) => item.isLatest) ?? detail.versions[0])
            : detail.versions.find((item) => item.version === args.version);
        if (chosen === undefined) throw new AppError('VERSION_NOT_FOUND');

        const dir = artifactDirFor(storageRoot, args.blueprintId, chosen.version);
        const manifest = await readManifest(dir);
        const files = manifest.files ?? (await listArtifactFiles(dir));
        const entry = manifest.entry ?? 'index.html';

        let text: string | undefined;
        const only = files.length === 1 ? files[0] : undefined;
        if (only !== undefined && only.bytes <= TEXT_INLINE_LIMIT && TEXT_PATH_RE.test(only.path)) {
          text = await readFile(path.join(dir, ...only.path.split('/')), 'utf8');
        }

        // 非内联情形（HTML 或多文件）：给一次性票据入口，不返回裸路径
        const needsTicket = text === undefined;
        const ticket = needsTicket
          ? await issuePreviewTicket(
              db,
              config,
              { blueprintId: args.blueprintId, version: chosen.version, purpose: 'preview' },
              context,
            )
          : null;

        return {
          blueprintId: args.blueprintId,
          version: chosen.version,
          entry,
          files,
          ...(text === undefined ? {} : { text }),
          // 出参要过 outputSchema：`expiresAt` 在领域层是 Date（HTTP 由 fast-json-stringify 转 ISO），
          // 而 MCP 的 structuredContent 是原样交给校验器的，必须自己序列化。
          ...(ticket === null ? {} : { url: ticket.url, expiresAt: ticket.expiresAt.toISOString() }),
        };
      }),
  );

  if (enabled('youzhao.publish_blueprint'))
  server.registerTool(
    'youzhao.publish_blueprint',
    {
      title: '发布蓝图',
      description:
        '不带 blueprintId = 新建蓝图并发布首个版本；带 blueprintId = 在该蓝图上发布新版本。需要 Token 具备 publish:blueprint，且绑定用户对目标分组/蓝图有发布能力。',
      inputSchema: inputSchema<McpPublishBlueprintInput>(mcpPublishBlueprintSchema),
      outputSchema: outputSchemaOf(mcpPublishBlueprintOutputSchema),
      annotations: { destructiveHint: true },
    },
    (args) =>
      guard('youzhao.publish_blueprint', () =>
        withIdempotency({
          db,
          tokenId,
          key: args.idempotencyKey,
          payload: args,
          execute: async () => {
            const files = [
              { path: 'index.html', content: args.html },
              ...(args.markdown === undefined ? [] : [{ path: 'README.md', content: args.markdown }]),
            ];
            const artifact = buildZip(files);
            if (args.blueprintId === undefined) {
              const request: CreateBlueprintRequest = {
                name: args.name,
                groupId: args.groupId,
                version: args.version,
                ...(args.summary === undefined ? {} : { summary: args.summary }),
                ...(args.tags === undefined ? {} : { tags: args.tags }),
                ...(args.publishNote === undefined ? {} : { publishNote: args.publishNote }),
              };
              return createBlueprint(db, context, request, artifact, { ...call, storageRoot });
            }
            const request: PublishBlueprintVersionRequest = {
              version: args.version,
              makeLatest: true,
              ...(args.publishNote === undefined ? {} : { publishNote: args.publishNote }),
            };
            return publishBlueprintVersion(db, context, args.blueprintId, request, artifact, {
              ...call,
              storageRoot,
            });
          },
        }),
      ),
  );

  if (enabled('youzhao.cover_blueprint_version'))
  server.registerTool(
    'youzhao.cover_blueprint_version',
    {
      title: '覆盖蓝图版本',
      description: '用新产物覆盖某个已存在版本（版本号与发布记录不变）。需要绑定用户对该蓝图有维护能力。',
      inputSchema: inputSchema<McpCoverBlueprintVersionInput>(mcpCoverBlueprintVersionSchema),
      outputSchema: outputSchemaOf(mcpCoverBlueprintVersionOutputSchema),
      annotations: { destructiveHint: true },
    },
    (args) =>
      guard('youzhao.cover_blueprint_version', () =>
        withIdempotency({
          db,
          tokenId,
          key: args.idempotencyKey,
          payload: args,
          execute: async () => {
            const files = [
              { path: 'index.html', content: args.html },
              ...(args.markdown === undefined ? [] : [{ path: 'README.md', content: args.markdown }]),
            ];
            return coverBlueprintVersion(
              db,
              context,
              args.blueprintId,
              args.version,
              args.publishNote === undefined ? {} : { publishNote: args.publishNote },
              buildZip(files),
              { ...call, storageRoot },
            );
          },
        }),
      ),
  );

  if (enabled('youzhao.delete_blueprint_version'))
  server.registerTool(
    'youzhao.delete_blueprint_version',
    {
      title: '删除蓝图版本',
      description: '归档删除某个版本（不可删除最后一个版本）。需要绑定用户对该蓝图有维护能力。',
      inputSchema: inputSchema<McpDeleteBlueprintVersionInput>(mcpDeleteBlueprintVersionSchema),
      outputSchema: outputSchemaOf(mcpDeleteBlueprintVersionOutputSchema),
      annotations: { destructiveHint: true },
    },
    (args) =>
      guard('youzhao.delete_blueprint_version', () =>
        withIdempotency({
          db,
          tokenId,
          key: args.idempotencyKey,
          payload: args,
          execute: () =>
            archiveBlueprintVersion(db, context, args.blueprintId, args.version, call),
        }),
      ),
  );

  if (enabled('youzhao.create_blueprint_group'))
  server.registerTool(
    'youzhao.create_blueprint_group',
    {
      title: '新建蓝图分组',
      description: '新建一个蓝图分组。需要绑定用户至少对一个分组/蓝图有维护能力。不支持分组排序。',
      inputSchema: inputSchema<McpCreateBlueprintGroupInput>(mcpCreateBlueprintGroupSchema),
      outputSchema: outputSchemaOf(mcpCreateBlueprintGroupOutputSchema),
      annotations: {},
    },
    (args) =>
      guard('youzhao.create_blueprint_group', () =>
        withIdempotency({
          db,
          tokenId,
          key: args.idempotencyKey,
          payload: args,
          execute: () => {
            const request: CreateBlueprintGroupRequest = { name: args.name };
            return createBlueprintGroup(db, context, request, call);
          },
        }),
      ),
  );

  return server;
}
