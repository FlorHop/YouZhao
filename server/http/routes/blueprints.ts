/**
 * 蓝图路由（docs/permission-design.md §6.4）。
 *
 * - 判权全部在用例层（`server/app/blueprints.ts`），路由只负责：解析入参、取会话上下文、
 *   组织响应信封 `{ data, meta: { requestId } }`。
 * - 这里是**有意的自研** `multipart/form-data` content-type parser：设计文档的选型是
 *   `@fastify/multipart`（`docs/architecture-design.md` §3.1 技术选型），本期暂以自研实现替代，
 *   已在 §3.1.1「M0 落地注记（临时决定与退出点）」记为临时决定，退出点是 M6 前评估替换。
 *   它只负责拆分字段与文件，真正的安全校验仍在 `server/storage/zip.ts`（拒绝 `..`、绝对路径、
 *   符号链接、超限、危险扩展名）；文本字段交给 `request.body`，由路由级契约 schema 用 Fastify
 *   自带 Ajv 校验，文件字节放进请求级 WeakMap，避免污染 body（契约 schema 全是
 *   `additionalProperties: false`）。§3.1.1 要求「损坏分段 → 400、拒绝内容伪造分隔符」，
 *   由 `server/test/blueprint-routes.test.ts` 的 multipart 边界用例守门。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  blueprintsCreateSchema,
  blueprintsDetailSchema,
  blueprintsListSchema,
  blueprintsMutationSchema,
  blueprintsPublishVersionSchema,
  blueprintsUpdateSchema,
} from '@youzhao/contracts/schemas';
import type {
  CreateBlueprintRequest,
  PublishBlueprintVersionRequest,
  UpdateBlueprintRequest,
} from '@youzhao/contracts/types';
import { AppError } from '../../domain/errors.js';
import type { Db } from '../../db/types.js';
import type { AppConfig } from '../../config.js';
import { requireContext, requestIp } from '../plugins/request-context.js';
import {
  archiveBlueprint,
  archiveBlueprintVersion,
  coverBlueprintVersion,
  createBlueprint,
  getBlueprintDetail,
  listBlueprints,
  publishBlueprintVersion,
  restoreBlueprint,
  restoreBlueprintVersion,
  updateBlueprint,
  type ArtifactCall,
  type CallerFacts,
} from '../../app/blueprints.js';

export interface BlueprintDependencies {
  readonly config: AppConfig;
  readonly db: Db;
}

// ── multipart/form-data ──────────────────────────────────────────────────────

interface MultipartUpload {
  readonly filename: string;
  readonly bytes: Buffer;
}

/** 请求级文件暂存：同一个请求内 parser 写入、handler 读取。 */
const uploads = new WeakMap<FastifyRequest, MultipartUpload[]>();

function readBoundary(contentType: string): string | null {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (match === null) return null;
  return match[1] ?? match[2] ?? null;
}

/** 从 `Content-Disposition` 里取 `name` / `filename`。 */
function readDisposition(header: string): { name: string | null; filename: string | null } {
  const name = /;\s*name="([^"]*)"/i.exec(header);
  const filename = /;\s*filename="([^"]*)"/i.exec(header);
  return { name: name?.[1] ?? null, filename: filename?.[1] ?? null };
}

/**
 * 极简 multipart 解析：只处理文本字段与文件字段，够蓝图上传用。
 * 结构损坏 → `INVALID_ARGUMENT`（产物包本身的问题才归 `ARTIFACT_INVALID`）。
 *
 * 边界规则按 RFC 2046：整体必须以 `--<boundary>` 开头，分段之间只认**行首**的
 * `\r\n--<boundary>`。若像早期实现那样直接 `indexOf('--<boundary>')`，文件字节里
 * 恰好出现 `--<boundary>` 就会被当成新分段，把产物包截断（见路由级测试的场景 13b）。
 */
function parseMultipart(
  body: Buffer,
  boundary: string,
): { fields: Record<string, unknown>; files: MultipartUpload[] } {
  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  const fields: Record<string, unknown> = {};
  const files: MultipartUpload[] = [];
  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    throw new AppError('INVALID_ARGUMENT', '无法解析 multipart 请求体');
  }
  let cursor = delimiter.length;

  while (cursor < body.length) {
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break; // 结束标记 `--`
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2;
    else if (body[cursor] === 0x0a) cursor += 1;

    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) throw new AppError('INVALID_ARGUMENT', '无法解析 multipart 请求体');
    const headerText = body.subarray(cursor, headerEnd).toString('utf8');
    const partStart = headerEnd + 4;

    // 只认行首边界：`separator` 自带前置 CRLF，因此分段内容天然不含尾部换行。
    const next = body.indexOf(separator, partStart);
    if (next < 0) throw new AppError('INVALID_ARGUMENT', '无法解析 multipart 请求体');
    const content = body.subarray(partStart, next);

    const { name, filename } = readDisposition(headerText);
    if (filename !== null && filename.length > 0) {
      files.push({ filename, bytes: Buffer.from(content) });
    } else if (name !== null) {
      const text = content.toString('utf8');
      // tags 在 multipart 里是 JSON 数组字符串；契约 schema 要求真正的数组。
      // 非法 JSON 是入参问题，必须回 400 INVALID_ARGUMENT，不能让它冒泡成 500。
      if (name === 'tags') {
        fields[name] = parseTagsField(text);
      } else {
        fields[name] = text;
      }
    }

    cursor = next + separator.length;
  }

  return { fields, files };
}

/** `tags` 字段：空 → `[]`，否则按 JSON 解析；非法 JSON → 400 `INVALID_ARGUMENT`。 */
function parseTagsField(text: string): unknown {
  if (text.trim().length === 0) return [];
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('INVALID_ARGUMENT', '字段 tags 不是合法的 JSON 数组');
  }
}

function registerMultipartParser(app: FastifyInstance, deps: BlueprintDependencies): void {
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: deps.config.http.jsonBodyLimitBytes },
    (request, body, done) => {
      try {
        const boundary = readBoundary(String(request.headers['content-type'] ?? ''));
        if (boundary === null) {
          done(new AppError('INVALID_ARGUMENT', '缺少 multipart boundary'));
          return;
        }
        const parsed = parseMultipart(body as Buffer, boundary);
        uploads.set(request, parsed.files);
        done(null, parsed.fields);
      } catch (error) {
        done(error instanceof Error ? error : new AppError('INVALID_ARGUMENT', '无法解析请求体'));
      }
    },
  );
}

function uploadedArtifact(request: FastifyRequest): Buffer | null {
  const files = uploads.get(request) ?? [];
  return files[0]?.bytes ?? null;
}

// ── 路由内联 schema ──────────────────────────────────────────────────────────

const blueprintParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const versionParamsSchema = {
  type: 'object',
  required: ['id', 'version'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    version: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

/** 契约里没有覆盖版本的请求体 schema，这里内联一个（与 `publishNote` 同规）。 */
const coverBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { publishNote: { type: 'string', maxLength: 500 } },
} as const;

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100 },
    keyword: { type: 'string', maxLength: 120 },
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    status: { type: 'string', enum: ['active', 'archived'] },
  },
} as const;

interface ListQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly keyword?: string;
  readonly groupId?: string;
  readonly status?: 'active' | 'archived';
}

export function registerBlueprintRoutes(app: FastifyInstance, deps: BlueprintDependencies): void {
  registerMultipartParser(app, deps);

  /** 请求事实 + 产物根目录，交给用例层。 */
  const artifactCall = async (request: FastifyRequest): Promise<ArtifactCall> => ({
    ip: requestIp(request),
    requestId: String(request.id),
    storageRoot: deps.config.preview.storagePath,
  });
  const callerFacts = (request: FastifyRequest): CallerFacts => ({
    ip: requestIp(request),
    requestId: String(request.id),
  });

  app.get(
    '/api/blueprints',
    { schema: { querystring: listQuerySchema, response: { 200: blueprintsListSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const query = request.query as ListQuery;
      const data = await listBlueprints(deps.db, context, {
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
        keyword: query.keyword,
        groupId: query.groupId,
        status: query.status,
      });
      return {
        data,
        meta: {
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          requestId: String(request.id),
        },
      };
    },
  );

  app.get(
    '/api/blueprints/:id',
    { schema: { params: blueprintParamsSchema, response: { 200: blueprintsDetailSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id } = request.params as { id: string };
      const data = await getBlueprintDetail(deps.db, context, id);
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.post(
    '/api/blueprints',
    {
      schema: {
        body: blueprintsCreateSchema,
        response: { 200: blueprintsMutationSchema },
      },
    },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const data = await createBlueprint(
        deps.db,
        context,
        request.body as CreateBlueprintRequest,
        uploadedArtifact(request),
        await artifactCall(request),
      );
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.post(
    '/api/blueprints/:id/versions',
    {
      schema: {
        params: blueprintParamsSchema,
        body: blueprintsPublishVersionSchema,
        response: { 200: blueprintsMutationSchema },
      },
    },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id } = request.params as { id: string };
      const data = await publishBlueprintVersion(
        deps.db,
        context,
        id,
        request.body as PublishBlueprintVersionRequest,
        uploadedArtifact(request),
        await artifactCall(request),
      );
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.put(
    '/api/blueprints/:id/versions/:version',
    {
      schema: {
        params: versionParamsSchema,
        body: coverBodySchema,
        response: { 200: blueprintsMutationSchema },
      },
    },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id, version } = request.params as { id: string; version: string };
      const body = request.body as { publishNote?: string };
      const data = await coverBlueprintVersion(
        deps.db,
        context,
        id,
        version,
        body,
        uploadedArtifact(request),
        await artifactCall(request),
      );
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.delete(
    '/api/blueprints/:id/versions/:version',
    { schema: { params: versionParamsSchema, response: { 200: blueprintsMutationSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id, version } = request.params as { id: string; version: string };
      const data = await archiveBlueprintVersion(
        deps.db,
        context,
        id,
        version,
        callerFacts(request),
      );
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.post(
    '/api/blueprints/:id/versions/:version/restore',
    { schema: { params: versionParamsSchema, response: { 200: blueprintsMutationSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id, version } = request.params as { id: string; version: string };
      const data = await restoreBlueprintVersion(
        deps.db,
        context,
        id,
        version,
        callerFacts(request),
      );
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.patch(
    '/api/blueprints/:id',
    {
      schema: {
        params: blueprintParamsSchema,
        body: blueprintsUpdateSchema,
        response: { 200: blueprintsMutationSchema },
      },
    },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id } = request.params as { id: string };
      const data = await updateBlueprint(
        deps.db,
        context,
        id,
        request.body as UpdateBlueprintRequest,
        callerFacts(request),
      );
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.delete(
    '/api/blueprints/:id',
    { schema: { params: blueprintParamsSchema, response: { 200: blueprintsMutationSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id } = request.params as { id: string };
      const data = await archiveBlueprint(deps.db, context, id, callerFacts(request));
      return { data, meta: { requestId: String(request.id) } };
    },
  );

  app.post(
    '/api/blueprints/:id/restore',
    { schema: { params: blueprintParamsSchema, response: { 200: blueprintsMutationSchema } } },
    async (request) => {
      const context = await requireContext(request, { db: deps.db });
      const { id } = request.params as { id: string };
      const data = await restoreBlueprint(deps.db, context, id, callerFacts(request));
      return { data, meta: { requestId: String(request.id) } };
    },
  );
}
