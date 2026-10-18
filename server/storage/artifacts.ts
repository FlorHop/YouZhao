/**
 * 产物落盘与路径安全（docs/architecture-design.md §3.6）。
 *
 * 这里是整条链路上最危险的一段：`blueprintId` / `version` / 包内相对路径三者都可能
 * 来自请求。旧实现的漏洞（`version=../audit-outside` 写出产物根之外、匿名可读产物）
 * 都由本文件的「段名校验 + 前缀断言 + 先临时目录后原子改名」三重约束挡住。
 *
 * 目录约定（与 deployment-rules §11 一致）：
 *   {root}/{blueprintId}/{version}/index.html
 *   {root}/{blueprintId}/{version}/assets/…
 *   {root}/{blueprintId}/{version}/manifest.json
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../domain/errors.js';
import { normalizeEntryPath, type ZipEntry } from './zip.js';

/** 产物包解压后的总大小上限（与 ZIP 默认限制一致，写盘前再守一道）。 */
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

const BLUEPRINT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 版本号：字母数字开头，允许 `.`/`_`/`-`，不允许以点开头（挡住 `..`）。 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 校验一个会进入文件系统的路径段。
 * 只接受白名单字符，因此 `..`、`/`、NUL、绝对路径都无法通过。
 */
export function assertSafeSegment(value: string, kind: 'blueprintId' | 'version'): string {
  const re = kind === 'blueprintId' ? BLUEPRINT_ID_RE : VERSION_RE;
  if (!re.test(value)) {
    throw new AppError('ARTIFACT_INVALID', `非法的${kind === 'blueprintId' ? '蓝图 id' : '版本号'}：${value}`);
  }
  return value;
}

/**
 * 解析产物内文件的实际路径。
 *
 * `relPath` 必须是**已经解码过一次**的路径：调用方在处理 URL 时只做一次
 * `decodeURIComponent`，此后不再解码，避免 `%252e%252e` 这类双重编码绕过。
 */
export function resolveArtifactPath(input: {
  readonly root: string;
  readonly blueprintId: string;
  readonly version: string;
  readonly relPath: string;
}): string {
  const blueprintId = assertSafeSegment(input.blueprintId, 'blueprintId');
  const version = assertSafeSegment(input.version, 'version');
  if (input.relPath.includes('\0')) {
    throw new AppError('ARTIFACT_INVALID', '产物路径含非法字符');
  }
  const base = path.resolve(input.root, blueprintId, version);
  // 复用 zip 的规范化规则：拒绝绝对路径与 `..` 穿越；空段、`.` 段与反斜杠会被规范化（不报错），
  // 规范化之后再断言结果落在版本目录内，双保险。
  const normalized = normalizeEntryPath(input.relPath);
  const resolved = path.resolve(base, normalized);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new AppError('ARTIFACT_INVALID', '产物路径越出该版本目录');
  }
  return resolved;
}

/** 对规范化后的全部条目计算整体 sha256（排序保证与写入顺序无关）。 */
export function computeArtifactHash(files: readonly ZipEntry[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface PublishedArtifact {
  readonly artifactPath: string;
  readonly manifestPath: string;
  readonly hash: string;
  readonly bytes: number;
  /** 覆盖发布时保留的旧目录，供人工回滚 */
  readonly backupPath: string | null;
}

export interface WriteArtifactInput {
  readonly root: string;
  readonly blueprintId: string;
  readonly version: string;
  readonly files: readonly ZipEntry[];
  /** true = 覆盖已存在的同版本产物（走 `.bak` + 原子改名）；false = 已存在即 VERSION_CONFLICT */
  readonly replace: boolean;
  /** 便于测试注入固定时间 */
  readonly now?: () => Date;
}

/**
 * 写入一个版本产物。
 *
 * 写入顺序：临时目录 → 全部文件 + manifest → 原子 `rename` 到位。
 * 任何一步失败都清理临时目录；覆盖时若改名失败会把 `.bak` 改回来，
 * 保证"要么旧版本完好、要么新版本完整"，不留半成品（M2 验收项）。
 */
export async function writeArtifactPackage(input: WriteArtifactInput): Promise<PublishedArtifact> {
  const blueprintId = assertSafeSegment(input.blueprintId, 'blueprintId');
  const version = assertSafeSegment(input.version, 'version');
  const now = input.now ?? (() => new Date());

  const totalBytes = input.files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (totalBytes > MAX_ARTIFACT_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', `产物包解压后体积超限（${totalBytes} 字节）`);
  }

  const root = path.resolve(input.root);
  const targetDir = path.join(root, blueprintId, version);
  const tempDir = path.join(root, `.tmp-${randomUUID()}`);
  const backupPath = `${targetDir}.bak-${now().getTime()}`;

  // 先做完全部条目校验再落盘：任何非法路径都在创建目录之前被拒绝，
  // 失败时磁盘上不会留下 `bp_1/` 这类空目录（M2 验收：不留半成品）。
  const validated = input.files.map((file) => {
    const normalized = normalizeEntryPath(file.path);
    const destination = path.resolve(tempDir, normalized);
    if (!destination.startsWith(`${tempDir}${path.sep}`)) {
      throw new AppError('ARTIFACT_INVALID', `产物条目越出临时目录：${file.path}`);
    }
    return { normalized, bytes: file.bytes, destination };
  });

  await mkdir(path.dirname(targetDir), { recursive: true });
  await mkdir(tempDir, { recursive: false });

  let movedBackup = false;
  try {
    for (const file of validated) {
      await mkdir(path.dirname(file.destination), { recursive: true });
      await writeFile(file.destination, file.bytes);
    }

    const hash = computeArtifactHash(input.files);
    const manifest = {
      blueprintId,
      version,
      entry: 'index.html',
      files: [...input.files]
        .map((file) => ({ path: normalizeEntryPath(file.path), bytes: file.bytes.length }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
      sha256: hash,
      createdAt: now().toISOString(),
    };
    await writeFile(path.join(tempDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    if (await pathExists(targetDir)) {
      if (!input.replace) {
        throw new AppError('VERSION_CONFLICT', `版本 ${version} 已存在；覆盖请显式调用覆盖接口`);
      }
      await rename(targetDir, backupPath);
      movedBackup = true;
    }

    await rename(tempDir, targetDir);
    return {
      artifactPath: targetDir,
      manifestPath: path.join(targetDir, 'manifest.json'),
      hash,
      bytes: totalBytes,
      backupPath: movedBackup ? backupPath : null,
    };
  } catch (error) {
    // 回滚：把旧目录改回来，并清掉临时目录（可能已被 rename 走，故忽略失败）。
    if (movedBackup) {
      try {
        if (!(await pathExists(targetDir))) {
          await rename(backupPath, targetDir);
        }
      } catch {
        // 回滚失败时保留 `.bak` 目录，运维仍可人工恢复
      }
    }
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await (await import('node:fs/promises')).stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 版本产物目录（不校验存在性）。 */
export function artifactDirFor(root: string, blueprintId: string, version: string): string {
  return path.join(
    path.resolve(root),
    assertSafeSegment(blueprintId, 'blueprintId'),
    assertSafeSegment(version, 'version'),
  );
}
