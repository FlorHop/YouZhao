/**
 * 口令哈希与口令策略（docs/architecture-design.md §3.4 规则 6）。
 *
 * 存储格式：`scrypt$N$r$p$<saltBase64>$<hashBase64>`。
 * **参数写在哈希串里**：将来提高 N/r/p（或换算法）时，新口令用新参数，旧口令仍按串里
 * 记录的参数校验，不需要停机重置所有人密码 —— verifyPassword 只读串、不读常量。
 * 所以这里的 SCRYPT_* 常量只影响**新写入**的哈希。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

/** 新建哈希使用的参数（OWASP 对 scrypt 的下限建议：N=2^14, r=8, p=1） */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const ALGORITHM = 'scrypt';

/** 解析出的存储参数；keylen 由哈希串长度决定，不单独存 */
interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function deriveKey(plain: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      plain,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(plain, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: KEY_LENGTH,
  });
  return [
    ALGORITHM,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/** 解析存储串；任何不符合格式的输入返回 null（不抛异常） */
function parseStored(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (algorithm !== ALGORITHM) return null;
  if (nRaw === undefined || rRaw === undefined || pRaw === undefined) return null;
  if (saltRaw === undefined || hashRaw === undefined) return null;
  if (!/^\d+$/.test(nRaw) || !/^\d+$/.test(rRaw) || !/^\d+$/.test(pRaw)) return null;

  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (N <= 1 || r <= 0 || p <= 0) return null;

  const salt = Buffer.from(saltRaw, 'base64');
  const hash = Buffer.from(hashRaw, 'base64');
  if (salt.length === 0 || hash.length === 0) return null;

  return { params: { N, r, p, keylen: hash.length }, salt, hash };
}

/**
 * 校验口令。格式非法、参数不可用（例如被篡改成超大 N 触发 maxmem 限制）一律返回 false，
 * 不抛异常、不泄露失败原因；比较前先比长度再用 timingSafeEqual（它要求等长）。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (parsed === null) return false;
  try {
    const key = await deriveKey(plain, parsed.salt, parsed.params);
    if (key.length !== parsed.hash.length) return false;
    return timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

export const MIN_PASSWORD_LENGTH = 8;

/** 禁用口令（小写比较，命中即拒）。含初始化路径上最容易出现的弱口令 */
export const FORBIDDEN_PASSWORDS: readonly string[] = [
  '123456',
  '12345678',
  'password',
  'admin',
  'admin123',
  'youzhao',
  'youzhao123',
];

/**
 * 口令策略闸门：长度不足或命中禁用列表 → INVALID_ARGUMENT + reason=WEAK_PASSWORD。
 * 比较前 trim 一次，避免 " 123456 " 绕过精确匹配（配置读取本身也会 trim 环境变量）。
 */
export function assertAcceptablePassword(plain: string): void {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('INVALID_ARGUMENT', undefined, {
      reason: 'WEAK_PASSWORD',
      minLength: MIN_PASSWORD_LENGTH,
    });
  }
  if (FORBIDDEN_PASSWORDS.includes(plain.trim().toLowerCase())) {
    throw new AppError('INVALID_ARGUMENT', undefined, { reason: 'WEAK_PASSWORD' });
  }
}
