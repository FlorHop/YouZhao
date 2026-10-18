/**
 * 应用层 id 生成（docs/architecture-design.md §3.3 数据模型）。
 *
 * 为什么不用自增：id 是**不透明**字符串（`usr_…` / `grp_…`），业务含义只能靠前缀区分，
 * 客户端不能从 id 推断创建顺序或总量；跨环境迁移、导入导出、审计回溯都不会因为
 * 序列号冲突而失效。前缀同时让日志与审计一眼能看出目标类型。
 */
import { randomUUID } from 'node:crypto';

export type IdPrefix = 'usr' | 'grp' | 'grn' | 'cap' | 'ses' | 'aud' | 'bp' | 'ver' | 'tkt' | 'tok';

/** `${prefix}_${uuid}`：uuid 由 CSPRNG 生成，无需查库判重 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * 初始化即存在的默认分组（deployment-rules §15，0002_identity.sql 末尾 insert）。
 * 它是固定值而不是随机 id，因为迁移脚本里已经写死，代码必须与之一致。
 */
export const DEFAULT_GROUP_ID = 'group_default';
