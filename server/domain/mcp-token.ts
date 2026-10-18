/**
 * MCP Token 的**材料生成与解析**（纯函数，不碰数据库）。
 *
 * 形态：`yz_mcp_<tokenId>_<secret>`
 * - `tokenId` 是 `mcp_tokens.id`（`newId('tok')` → `tok_<uuid>`，不含下划线之外的噪音）；
 * - `secret` 是 32 位十六进制随机串（不含下划线），因此**按最后一个下划线切分**永远无歧义；
 * - 明文只在创建响应里出现一次；库里只存 `sha256(明文)`（`token_hash`）与可识别前缀
 *   （`token_prefix`，形如 `yz_mcp_tok_1a2b…_9f3c`），库被读取也无法反推出可用凭证。
 *
 * 纪律：本文件不查库、不抛业务错误；鉴权链在 `mcp/auth.ts`。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MCP_TOKEN_ALPHABET = 'hex';

/** 明文令牌的固定前缀，用于快速识别「这看起来是不是有招 MCP Token」。 */
export const MCP_TOKEN_PREFIX = 'yz_mcp_';

/** 展示用前缀里保留的 secret 字符数：足够区分，不足以复用。 */
const PREFIX_SECRET_CHARS = 4;

export interface McpTokenMaterial {
  /** 明文令牌，仅在创建响应里返回一次。 */
  readonly token: string;
  /** 令牌主键，写入 `mcp_tokens.id`。 */
  readonly tokenId: string;
  /** 可展示前缀，写入 `mcp_tokens.token_prefix`。 */
  readonly tokenPrefix: string;
  /** 明文摘要，写入 `mcp_tokens.token_hash`。 */
  readonly tokenHash: string;
}

/** `sha256(明文)` 十六进制；与 `domain/session.ts` 的做法一致。 */
export function hashMcpToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** 用已有的令牌主键生成完整材料（创建流程：先 `newId('tok')` 再调用本函数）。 */
export function buildMcpTokenMaterial(tokenId: string): McpTokenMaterial {
  if (!/^[A-Za-z0-9_-]+$/.test(tokenId)) {
    throw new Error(`非法令牌主键：${tokenId}`);
  }
  const secret = randomBytes(16).toString('hex');
  const token = `${MCP_TOKEN_PREFIX}${tokenId}_${secret}`;
  return {
    token,
    tokenId,
    tokenPrefix: `${MCP_TOKEN_PREFIX}${tokenId}_${secret.slice(0, PREFIX_SECRET_CHARS)}`,
    tokenHash: hashMcpToken(token),
  };
}

/**
 * 从明文里取出令牌主键；不是本系统令牌形态时返回 `null`。
 * 只做形态解析，**不代表令牌有效**。
 */
export function parseMcpToken(raw: string): { readonly tokenId: string } | null {
  if (!raw.startsWith(MCP_TOKEN_PREFIX)) return null;
  const rest = raw.slice(MCP_TOKEN_PREFIX.length);
  const separator = rest.lastIndexOf('_');
  if (separator <= 0 || separator === rest.length - 1) return null;
  const tokenId = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(tokenId) || !/^[0-9a-f]{16,}$/.test(secret)) return null;
  return { tokenId };
}

/** 从 `Authorization` 头里取 Bearer 明文；缺失或格式不对返回 `null`。 */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : match[1] ?? null;
}

/** 常量时间比较两个摘要；长度不同直接判否（`timingSafeEqual` 要求等长）。 */
export function tokenHashMatches(expectedHash: string, presentedHash: string): boolean {
  const expected = Buffer.from(expectedHash, 'utf8');
  const presented = Buffer.from(presentedHash, 'utf8');
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}
