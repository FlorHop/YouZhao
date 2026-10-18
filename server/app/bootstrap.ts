/**
 * 初始所有者初始化（docs/architecture-design.md §3.4 规则 4、permission-design §4 不变量 1/2）。
 *
 * 两条必须守住的设计：
 * 1. **不再有"用户表为空即开放"的 setup 接口**。所有者只能在部署时由环境变量
 *    （`ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_DISPLAY_NAME`）注入，且首次登录强制改密；
 * 2. **幂等**：本函数在每次进程启动时调用，多实例并发启动也安全 —— `user_identity` 上的
 *    `user_identity_single_owner` 部分唯一索引兜底，冲突时回滚并重新查询，返回既有所有者，
 *    绝不静默提升某个已有用户。
 */
import { sql } from 'kysely';
import type { Db } from '../db/types.js';
import { writeAudit } from '../audit/audit.js';
import { AppError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { hashPassword } from '../domain/password.js';

export interface BootstrapOwnerInput {
  username: string;
  password: string;
  displayName: string;
}

export interface BootstrapOwnerResult {
  created: boolean;
  ownerId: string;
}

/** PostgreSQL 唯一约束冲突 */
const UNIQUE_VIOLATION = '23505';

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isUniqueViolation(error: unknown): boolean {
  return hasErrorCode(error) && error.code === UNIQUE_VIOLATION;
}

async function findOwnerId(db: Db): Promise<string | null> {
  const row = await db
    .selectFrom('user_identity')
    .select('user_id')
    .where('identity', '=', 'owner')
    .executeTakeFirst();
  return row === undefined ? null : row.user_id;
}

/**
 * 确保库里恰有一位所有者。返回 `created=false` 时表示已存在（本次什么都没写）。
 *
 * 冲突与异常数据的处理：
 * - 库里有用户但没有 owner 记录（异常数据）→ `INTERNAL_ERROR`，拒绝自动初始化；
 * - 该情况下若配置的用户名已被别的账号占用 → `USERNAME_CONFLICT`（更可操作，
 *   提示换 ADMIN_USERNAME 或人工核查），绝不覆盖既有账号；
 * - 并发启动撞唯一索引 → 回滚后重查，返回先到者的 ownerId。
 */
export async function ensureInitialOwner(
  db: Db,
  input: BootstrapOwnerInput,
): Promise<BootstrapOwnerResult> {
  let result: BootstrapOwnerResult;
  try {
    result = await db.transaction().execute(async (trx) => {
      const countRow = await trx
        .selectFrom('users')
        .select(sql<number>`count(*)`.as('count'))
        .executeTakeFirst();
      const userCount = Number(countRow?.count ?? 0);

      if (userCount === 0) {
        const ownerId = newId('usr');
        const passwordHash = await hashPassword(input.password);
        await trx
          .insertInto('users')
          .values({
            id: ownerId,
            username: input.username,
            display_name: input.displayName,
            status: 'active',
            password_hash: passwordHash,
            must_change_password: true,
          })
          .execute();
        await trx
          .insertInto('user_identity')
          .values({ user_id: ownerId, identity: 'owner', granted_by: null })
          .execute();
        return { created: true, ownerId };
      }

      const ownerId = await findOwnerId(trx);
      if (ownerId !== null) return { created: false, ownerId };

      // 有用户却没有 owner：异常数据，不猜测、不提升
      const taken = await trx
        .selectFrom('users')
        .select('id')
        .where('username', '=', input.username)
        .executeTakeFirst();
      if (taken !== undefined) {
        throw new AppError(
          'USERNAME_CONFLICT',
          '配置的 ADMIN_USERNAME 已被非所有者账号占用，且库中不存在所有者：请更换用户名或人工核查 user_identity 表',
        );
      }
      throw new AppError(
        'INTERNAL_ERROR',
        '库中已存在用户但 user_identity 缺少 owner 记录（异常数据）：拒绝自动初始化，请人工核查用户与身份表',
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await findOwnerId(db);
      if (existing !== null) return { created: false, ownerId: existing };
    }
    throw error;
  }

  // 审计在事务外写：审计写入自身不抛错，且失败不会污染已提交的事务
  if (result.created) {
    await writeAudit(db, {
      actorType: 'system',
      action: 'user.bootstrapOwner',
      targetType: 'user',
      targetId: result.ownerId,
      result: 'allow',
      detail: { username: input.username, mustChangePassword: true },
    });
  }
  return result;
}
