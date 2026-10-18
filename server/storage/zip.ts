/**
 * 最小 ZIP 读取器（docs/architecture-design.md §3.6 上传解包校验）。
 *
 * 为什么不引三方包：产物包是**不可信输入**，这里需要的是"拒绝一切可疑形态"的确定性行为，
 * 而不是格式覆盖面。自建可精确控制条目数、解压后体积、压缩比、符号链接与路径形态，
 * 并让每个拒绝都带明确错误码（`ARTIFACT_INVALID`）。
 *
 * 支持：store(0) / deflate(8)；不支持 zip64 与加密（命中即拒绝，产物包体积远低于 zip64 门槛）。
 */
import { inflateRawSync } from 'node:zlib';
import { AppError } from '../domain/errors.js';

/** 一个已通过校验的包内条目。 */
export interface ZipEntry {
  /** 包内相对路径，已规范化为 `/` 分隔、无前导 `/`、无 `..` */
  readonly path: string;
  readonly bytes: Buffer;
}

export interface ZipLimits {
  /** 条目数上限（含目录项） */
  readonly maxEntries: number;
  /** 单文件解压后上限 */
  readonly maxFileBytes: number;
  /** 全部文件解压后总上限 */
  readonly maxTotalBytes: number;
  /** 压缩比上限（防 zip bomb）；压缩后为 0 的条目跳过该检查 */
  readonly maxRatio: number;
  /** 路径长度上限 */
  readonly maxPathLength: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 512,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxRatio: 200,
  maxPathLength: 180,
};

/** 产物包内禁止出现的文件类型：服务端脚本、密钥与环境文件。 */
const FORBIDDEN_EXTENSIONS = [
  '.mjs',
  '.cjs',
  '.env',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.sqlite',
  '.db',
];

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;
/** 符号链接的 unix mode 位（external attributes 高 16 位） */
const S_IFLNK = 0xa000;

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('ARTIFACT_INVALID', message, details);
}

/** 找到 End of Central Directory：从尾部向前找签名（注释最长 64KiB）。 */
function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw invalid('压缩包结构无效：找不到中央目录');
}

/**
 * 规范化并校验包内路径。
 * 拒绝：绝对路径、盘符、`..`、空段、反斜杠（统一转 `/` 后再判定）、NUL、超长路径。
 */
export function normalizeEntryPath(rawName: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): string {
  if (rawName.includes('\0')) {
    throw invalid('压缩包内含非法路径：出现 NUL 字符');
  }
  const name = rawName.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw invalid(`压缩包内含绝对路径：${rawName}`);
  }
  const segments = name.split('/');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw invalid(`压缩包内含路径穿越：${rawName}`);
    }
    cleaned.push(segment);
  }
  if (cleaned.length === 0) {
    throw invalid(`压缩包内含空路径：${rawName}`);
  }
  const normalized = cleaned.join('/');
  if (normalized.length > limits.maxPathLength) {
    throw invalid(`压缩包内路径过长：${rawName}`);
  }
  return normalized;
}

function assertAllowedExtension(path: string): void {
  const lower = path.toLowerCase();
  const hit = FORBIDDEN_EXTENSIONS.find((ext) => lower.endsWith(ext));
  if (hit !== undefined) {
    throw invalid(`产物包不允许包含 ${hit} 文件`, { path });
  }
}

/**
 * 解包 ZIP，返回通过全部校验的**文件**条目（目录项被丢弃）。
 *
 * 校验顺序刻意做成"先总量、后逐条"：条目数/体积上限先看中央目录声明值，
 * 再看本地头实际解压结果，两边都不放过。
 */
export function readZip(
  buffer: Buffer,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): readonly ZipEntry[] {
  const eocd = findEocd(buffer);
  const entryCountTotal = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    entryCountTotal === ZIP64_MARKER_16 ||
    centralSize === ZIP64_MARKER_32 ||
    centralOffset === ZIP64_MARKER_32
  ) {
    throw invalid('暂不支持 zip64 格式的压缩包');
  }
  if (entryCountTotal > limits.maxEntries) {
    throw invalid(`压缩包条目过多（${entryCountTotal} > ${limits.maxEntries}）`);
  }
  if (centralOffset + centralSize > buffer.length) {
    throw invalid('压缩包结构无效：中央目录越界');
  }

  const files: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let cursor = centralOffset;

  for (let i = 0; i < entryCountTotal; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw invalid('压缩包结构无效：中央目录条目损坏');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if ((flags & 0x0001) !== 0) {
      throw invalid(`压缩包内含加密条目：${name}`);
    }
    if (uncompressedSize === ZIP64_MARKER_32 || compressedSize === ZIP64_MARKER_32) {
      throw invalid('暂不支持 zip64 格式的压缩包条目');
    }
    const isDirectory = name.endsWith('/');
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === S_IFLNK) {
      throw invalid(`压缩包内含符号链接：${name}`);
    }

    const normalized = normalizeEntryPath(name, limits);
    if (isDirectory) {
      cursor += 46 + nameLength + extraLength + commentLength;
      continue;
    }
    if (seen.has(normalized)) {
      throw invalid(`压缩包内含重复条目：${normalized}`);
    }
    seen.add(normalized);
    assertAllowedExtension(normalized);

    if (uncompressedSize > limits.maxFileBytes) {
      throw invalid(`产物包内单个文件过大：${normalized}`, {
        excerpt: normalized,
        limit: limits.maxFileBytes,
      });
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxRatio) {
      throw invalid(`产物包内压缩比异常：${normalized}`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) {
      throw invalid(`产物包解压后体积超限（> ${limits.maxTotalBytes} 字节）`);
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw invalid(`压缩包结构无效：本地头损坏（${normalized}）`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw invalid(`压缩包结构无效：条目数据越界（${normalized}）`);
    }
    const raw = buffer.subarray(dataStart, dataEnd);

    let bytes: Buffer;
    if (method === 0) {
      bytes = Buffer.from(raw);
    } else if (method === 8) {
      try {
        bytes = inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes });
      } catch {
        throw invalid(`产物包条目解压失败：${normalized}`);
      }
    } else {
      throw invalid(`产物包使用了不支持的压缩方式（${method}）：${normalized}`);
    }
    if (bytes.length !== uncompressedSize) {
      throw invalid(`产物包条目大小与声明不符：${normalized}`);
    }

    files.push({ path: normalized, bytes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (files.length === 0) {
    throw invalid('压缩包内没有任何文件');
  }
  return files;
}

/**
 * 从解包结果中取出包内入口。
 *
 * 入口必须是**根级** `index.html`（`docs/architecture-design.md` §3.6 目录约定）：
 * 只含 `sub/index.html` 的包一律拒绝，避免线上拿到一个没有入口的版本目录。
 */
export function requireEntryHtml(files: readonly ZipEntry[]): ZipEntry {
  const entry = files.find((file) => file.path === 'index.html');
  if (entry === undefined) {
    throw invalid('产物包缺少根级入口 index.html');
  }
  return entry;
}

/** ZIP 写入器的输入条目：文本按 UTF-8 编码，路径按 `normalizeEntryPath` 规范化。 */
export interface ZipWriteEntry {
  readonly path: string;
  readonly content: string | Buffer;
}

/** 固定时间戳（1980-01-01 00:00:00，DOS 纪元起点）：产物包内容可复现，便于哈希比对。 */
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = 33; // 1980-01-01

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 最小 ZIP 写入器（**store 方法，不压缩**）。
 *
 * 存在的理由：MCP 发布只有内联文本（HTML/Markdown），没有上传的压缩包；把它在这里打成
 * 标准 ZIP，就能让 HTTP 上传与 MCP 发布**汇合到同一个** `writeArtifactPackage` 校验/落盘入口
 * （docs/architecture-design.md §4.3「共用领域层」）。不压缩是刻意的：产物包远低于 zip64 门槛，
 * 且读侧同样支持 store。
 *
 * 写出的包必须能被本文件的 `readZip` 原样读回（测试会做一次往返断言）。
 */
export function buildZip(entries: readonly ZipWriteEntry[]): Buffer {
  if (entries.length === 0) {
    throw invalid('产物包至少要有一个文件');
  }
  const seen = new Set<string>();
  const normalized: { readonly path: string; readonly bytes: Buffer }[] = [];
  for (const entry of entries) {
    const path = normalizeEntryPath(entry.path);
    if (seen.has(path)) {
      throw invalid(`产物包内路径重复：${path}`);
    }
    seen.add(path);
    normalized.push({ path, bytes: Buffer.from(entry.content) });
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of normalized) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(DOS_EPOCH_TIME, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); // store
    central.writeUInt16LE(DOS_EPOCH_TIME, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    // 注意：JS 位运算是 32 位有符号，`0o100644 << 16` 会溢出成负数（Node 抛 ERR_OUT_OF_RANGE）。
    // 这里用乘法保持无符号语义。
    central.writeUInt32LE(0o100644 * 0x10000, 38); // external attrs：普通文件 0644
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + entry.bytes.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(normalized.length, 8);
  eocd.writeUInt16LE(normalized.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
