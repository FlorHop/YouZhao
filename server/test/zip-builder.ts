/**
 * 测试用 ZIP 组装器：手工拼字节，覆盖 store(0)/deflate(8)、符号链接、zip64 标记等形态。
 *
 * 生产代码不允许依赖三方差件生成压缩包，测试也不引：这样"生成端"和"读取端"不会
 * 共享同一个库的隐含假设，校验断言的才是我们自己的规则。
 */
import { deflateRawSync } from 'node:zlib';

export interface TestZipEntry {
  /** 包内路径；目录项以 `/` 结尾 */
  readonly path: string;
  readonly data?: Buffer | string;
  /** 0 = store，8 = deflate；默认 8 */
  readonly method?: 0 | 8;
  /** 写成 unix 符号链接条目 */
  readonly symlink?: boolean;
  /** 显式覆盖 external attributes */
  readonly externalAttributes?: number;
  /** 显式覆盖中央目录里声明的解压后大小（用于制造"声明与实体不符"） */
  readonly declaredSize?: number;
  /** 显式覆盖中央目录里声明的压缩后大小 */
  readonly declaredCompressedSize?: number;
}

export interface TestZipOptions {
  /** 把 EOCD 的条目数写成 zip64 标记 0xffff */
  readonly zip64?: boolean;
  readonly comment?: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: readonly TestZipEntry[], options: TestZipOptions = {}): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const raw = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = entry.data === undefined ? Buffer.alloc(0) : method === 8 ? deflateRawSync(raw) : raw;
    const crc = entry.data === undefined ? 0 : crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const external =
      entry.externalAttributes ?? (entry.symlink === true ? (0o120777 << 16) | 0 : (0o100644 << 16) | 0);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.declaredCompressedSize ?? body.length, 20);
    central.writeUInt32LE(entry.declaredSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(external >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    localParts.push(local, body);
    centralParts.push(central);
    offset += local.length + body.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const commentBuffer = Buffer.from(options.comment ?? '', 'utf8');
  const eocd = Buffer.alloc(22 + commentBuffer.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(options.zip64 === true ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(options.zip64 === true ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuffer.length, 20);
  commentBuffer.copy(eocd, 22);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

/** 常用入口文件内容 */
export const SAMPLE_INDEX_HTML = '<!doctype html><html><body>演示蓝图</body></html>';
