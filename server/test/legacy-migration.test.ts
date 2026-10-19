/**
 * M5 旧数据迁移回归（§8）。
 *
 * 分两层：
 *  1. **计划器（纯函数）**：身份映射、授权映射、默认分组收敛、可见范围对照、
 *     不自动授予发布能力、已知缺陷逐条出现。
 *  2. **执行层（PGlite + 临时目录）**：真写库、真搬产物、目标库保护、`--replace`、
 *     产物缺失只标 `missing` 不整批失败。
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createTestContext, type TestContext } from './http-helpers.js';
import {
  normalizeLegacyState,
  readLegacyStateFile,
  readLegacyStateFromDataDir,
  legacyPreviewRoot,
  type LegacyState,
} from '../db/legacy/model.js';
import {
  KNOWN_LEGACY_DEFECTS,
  LegacyMigrationError,
  planLegacyMigration,
  parseLegacyDate,
} from '../db/legacy/plan.js';
import {
  applyLegacyMigration,
  LegacyApplyError,
} from '../db/legacy/apply.js';

// ── 合成旧快照 ──────────────────────────────────────────────────────────────
// 刻意包含：两个 system-settings:manage（旧模型的 L1 缺陷）、一个 demo-preview:manage、
// 一个没有凭据的用户、一个指向不存在分组的蓝图、一个没有任何 isLatest 的蓝图。

function syntheticState(): LegacyState {
  return normalizeLegacyState({
    users: [
      { id: 'u1', username: 'admin', displayName: '系统管理员', status: 'active', createdAt: '2026-01-02 09:00' },
      { id: 'u2', username: 'zhou', displayName: '周予安', status: 'active', createdAt: '2026-02-11 10:30' },
      { id: 'u3', username: 'chen', displayName: '陈以宁', status: 'active', createdAt: '2026-03-05 14:20' },
      { id: 'u4', username: 'ghost', displayName: '无凭据用户', status: 'disabled', createdAt: '' },
    ],
    credentials: { admin: 'admin-pass-1234', zhou: 'zhou-pass-1234', chen: 'chen-pass-1234' },
    groups: [
      { id: 'group_default', name: '默认分组', isDefault: true, order: 0 },
      { id: 'group_city', name: '城市治理', isDefault: false, order: 10 },
      { id: 'group_invest', name: '招商引资', isDefault: true, order: 20 },
    ],
    blueprints: [
      {
        id: 'bp_city_001',
        name: '城市治理驾驶舱',
        summary: '城市治理总览',
        tags: ['治理'],
        groupId: 'group_city',
        status: 'active',
        createdAt: '2026-04-01 09:00',
        updatedAt: '2026-04-02 09:00',
        versions: [
          { id: 'ver_1', version: '1.0.0', isLatest: true, status: 'available', deployedAt: '2026-04-02 10:00', markdown: '# 城市治理\n\n指标口径说明。' },
          { id: 'ver_2', version: '0.9.0', isLatest: false, status: 'available', deployedAt: '2026-04-01 10:00' },
        ],
      },
      {
        id: 'bp_invest_001',
        name: '招商驾驶舱',
        summary: '招商引资总览',
        tags: ['招商', '驾驶舱'],
        groupId: 'group_invest',
        status: 'active',
        createdAt: '2026-04-03 09:00',
        updatedAt: '2026-04-03 09:00',
        // 两个 isLatest：新库有唯一索引，必须收敛
        versions: [
          { id: 'ver_3', version: '2.0.0', isLatest: true, status: 'available', deployedAt: '2026-04-05 10:00' },
          { id: 'ver_4', version: '1.5.0', isLatest: true, status: 'available', deployedAt: '2026-04-04 10:00' },
        ],
      },
      {
        id: 'bp_lost_001',
        name: '归属丢失的蓝图',
        summary: '',
        tags: [],
        groupId: 'group_removed',
        status: 'archived',
        createdAt: '2026-04-06 09:00',
        updatedAt: '2026-04-06 09:00',
        versions: [{ id: 'ver_5', version: '1.0.0', isLatest: false, status: 'unavailable', deployedAt: '未使用' }],
      },
    ],
    functionPermissions: [
      { userId: 'u1', module: 'system-settings', level: 'manage' },
      { userId: 'u2', module: 'system-settings', level: 'manage' },
      { userId: 'u2', module: 'demo-preview', level: 'manage' },
      { userId: 'u3', module: 'demo-preview', level: 'view' },
      { userId: 'u4', module: 'system-settings', level: 'view' },
    ],
    blueprintPermissions: [
      { userId: 'u2', targetType: 'group', targetId: 'group_city' },
      { userId: 'u3', targetType: 'blueprint', targetId: 'bp_city_001' },
      { userId: 'u4', targetType: 'group', targetId: 'group_removed' },
    ],
    mcpTokens: [
      {
        id: 'tok_legacy_1',
        name: '旧 Agent Token',
        boundUserId: 'u2',
        status: 'active',
        scopes: ['read:blueprint'],
        tokenHash: 'deadbeef',
        tokenPreview: 'yz_mcp_tok',
        expiresAt: '未使用',
        createdAt: '2026-05-01 09:00',
      },
    ],
    auditLogs: [{ id: 'aud_1' }],
  });
}

// ── 计划器 ─────────────────────────────────────────────────────────────────

test('迁移计划：--owner 明确唯一所有者，其余 system-settings:manage 降为用户管理员', () => {
  const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
  const byName = new Map(plan.users.map((user) => [user.username, user]));

  assert.equal(byName.get('admin')?.identity, 'owner');
  assert.equal(byName.get('zhou')?.identity, 'user_admin');
  assert.equal(byName.get('chen')?.identity, 'member');
  assert.equal(byName.get('ghost')?.identity, 'member');
  assert.equal(plan.counts.users, 4);
  assert.equal(plan.counts.userAdmins, 1);
  assert.equal(plan.counts.members, 2);
  assert.match(byName.get('zhou')?.reason ?? '', /system-settings:manage/);
});

test('迁移计划：不指定 --owner 且有多个全局管理员时拒绝迁移', () => {
  assert.throws(
    () => planLegacyMigration(syntheticState()),
    (error: unknown) =>
      error instanceof LegacyMigrationError && /必须用 --owner/.test((error as Error).message),
  );
});

test('迁移计划：恰好一个全局管理员时可省略 --owner', () => {
  const state = syntheticState();
  state.functionPermissions = state.functionPermissions.filter(
    (perm) => !(perm.userId === 'u2' && perm.module === 'system-settings'),
  );
  const plan = planLegacyMigration(state);
  assert.equal(plan.users.find((user) => user.legacyId === plan.ownerUserId)?.username, 'admin');
});

test('迁移计划：授权按 group→group、demo→blueprint 映射，并补齐管理员的自动组授权', () => {
  const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
  const keys = plan.grants.map((grant) => `${grant.userId}|${grant.targetType}|${grant.targetId}`);

  assert.ok(keys.includes('u2|group|group_city'), '旧 blueprintPermissions(group) 应原样迁移');
  assert.ok(keys.includes('u3|blueprint|bp_city_001'), '旧 blueprintPermissions(demo) → blueprint');
  // u2 是 demo-preview:manage：旧模型在新建分组时会自动写组授权，迁移必须补齐，否则可见范围凭空缩小
  assert.ok(keys.includes('u2|group|group_invest'), '管理员的自动组授权必须补齐');
  assert.ok(keys.includes('u2|group|group_default'));
  // 指向不存在分组的授权被丢弃并留痕
  assert.ok(!keys.includes('u4|group|group_removed'));
  assert.ok(plan.warnings.some((warning) => /不存在的分组 group_removed/.test(warning)));
});

test('迁移计划：所有者的旧蓝图授权不生成 view_grants 行（隐式全可见）', () => {
  const state = syntheticState();
  state.blueprintPermissions.push({ userId: 'u1', targetType: 'group', targetId: 'group_city' });
  state.blueprintPermissions.push({ userId: 'u1', targetType: 'blueprint', targetId: 'bp_city_001' });

  const plan = planLegacyMigration(state, { ownerUsername: 'admin' });

  assert.equal(
    plan.grants.filter((grant) => grant.userId === plan.ownerUserId).length,
    0,
    '所有者不写授权行',
  );
  assert.ok(
    plan.dropped.some((note) => /blueprintPermissions\(admin\) 共 2 条/.test(note)),
    '丢弃项里应记录所有者的旧授权行',
  );
});

test('迁移计划：demo-preview:manage → blueprint.manage，且绝不自动授予发布能力', () => {
  const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
  const manage = plan.capabilities.filter((capability) => capability.userId === 'u2');

  assert.ok(manage.length > 0, 'u2 的 manage 应按其授权范围展开');
  assert.ok(manage.every((capability) => capability.capability === 'blueprint.manage'));
  assert.equal(plan.capabilities.filter((capability) => capability.capability === 'blueprint.publish').length, 0);
  assert.equal(plan.publishDecisions.length, 1);
  assert.equal(plan.publishDecisions[0]?.username, 'zhou');
  assert.ok(plan.warnings.some((warning) => /人工确认发布能力/.test(warning)));
});

test('迁移计划：多个默认分组收敛为一个，归属丢失的蓝图移入无授权的占位分组', () => {
  const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
  assert.equal(plan.groups.filter((group) => group.isDefault).length, 1);
  assert.equal(plan.groups.find((group) => group.isDefault)?.id, 'group_default');
  assert.ok(plan.warnings.some((warning) => /个默认分组/.test(warning)));

  const lost = plan.blueprints.find((blueprint) => blueprint.id === 'bp_lost_001');
  assert.equal(lost?.groupId, 'group_legacy_orphan');
  assert.equal(lost?.status, 'archived');
  // 占位分组没有任何授权 → 孤儿蓝图不会因为「回落到默认分组」被默认分组的查看者看到
  assert.ok(plan.grants.every((grant) => grant.targetId !== 'group_legacy_orphan'));
  assert.ok(plan.warnings.some((warning) => /所属分组 group_removed/.test(warning)));
  assert.ok(plan.warnings.some((warning) => /占位分组/.test(warning)));
});

test('迁移计划：多个 isLatest 收敛为一个，时间格式五花八门也不编造时间', () => {
  const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
  const invest = plan.blueprints.find((blueprint) => blueprint.id === 'bp_invest_001');
  const latest = invest?.versions.filter((version) => version.isLatest) ?? [];

  assert.equal(latest.length, 1);
  assert.equal(latest[0]?.version, '2.0.0');
  assert.equal(invest?.versions.find((version) => version.version === '1.5.0')?.isLatest, false);
  assert.ok(plan.warnings.some((warning) => /个 isLatest 版本/.test(warning)));

  assert.equal(parseLegacyDate('未使用'), null);
  assert.equal(parseLegacyDate(''), null);
  assert.equal(parseLegacyDate('2026-04-02 10:00'), '2026-04-02T02:00:00.000Z');
  assert.equal(parseLegacyDate('2026-04-02T10:00:00.000Z'), '2026-04-02T10:00:00.000Z');
  // `status: unavailable` → `missing`，且 `deployedAt` 为「未使用」时退回当前时间由执行层兜底
  assert.equal(
    plan.blueprints.find((blueprint) => blueprint.id === 'bp_lost_001')?.versions[0]?.status,
    'missing',
  );
});

test('迁移计划：可见范围对照逐人给出，旧函数级 view 闸门取消后的「变宽」被显式标出', () => {
  const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
  const zhou = plan.comparison.find((row) => row.username === 'zhou');
  const chen = plan.comparison.find((row) => row.username === 'chen');
  const admin = plan.comparison.find((row) => row.username === 'admin');

  assert.ok(zhou, '应有周予安的对照行');
  // 快照里 group_invest 没有给 manage 用户组授权，但旧运行时「新建分组」会自动补一条
  // （grantGroupToBlueprintManagers）。迁移按旧语义补齐，所以相对快照是**变宽**，必须在报告里标出。
  assert.deepEqual(zhou.legacyVisible, ['bp_city_001']);
  assert.deepEqual(zhou.migratedVisible, ['bp_city_001', 'bp_invest_001']);
  assert.equal(zhou.change, 'widened');
  assert.ok(zhou.notes.some((note) => /变宽/.test(note)));

  assert.ok(chen);
  assert.equal(chen.change, 'same');

  assert.equal(admin?.identity, 'owner');
  assert.equal(admin?.migratedVisible.length, 3);
  assert.ok(admin?.notes.some((note) => /隐式拥有全部业务能力/.test(note)));
});

test('迁移计划：Token 只保留元数据并标注必须重建，审计与未知键进「不迁移」清单', () => {
  const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
  assert.equal(plan.tokens.length, 1);
  assert.equal(plan.tokens[0]?.legacyStatus, 'active');
  assert.match(plan.tokens[0]?.note ?? '', /需在「MCP Token」页重建/);
  assert.ok(plan.dropped.some((item) => /auditLogs/.test(item)));
  assert.equal(plan.warnings.filter((warning) => /没有口令记录/.test(warning)).length, 1);
});

test('迁移计划：已知旧缺陷逐条出现在报告里（§8 要求显式对照）', () => {
  const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
  assert.ok(KNOWN_LEGACY_DEFECTS.length >= 5);
  assert.deepEqual(
    KNOWN_LEGACY_DEFECTS.map((defect) => defect.id),
    ['L1', 'L2', 'L3', 'L4', 'L5'],
  );
  assert.ok(KNOWN_LEGACY_DEFECTS.every((defect) => defect.fix.length > 10));
  assert.ok(plan.counts.versions === 5);
});

// ── 读取旧数据 ─────────────────────────────────────────────────────────────

test('读取旧数据：能从 JSON 文件与旧 SQLite 的 app_state 两种来源读出同一形态', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'youzhao-legacy-'));
  try {
    const raw = {
      state: {
        users: [{ id: 'u1', username: 'admin', displayName: '管理员' }],
        credentials: { admin: 'pass-1234' },
        groups: [{ id: 'group_default', name: '默认分组', isDefault: true, sortOrder: 0 }],
        blueprints: [],
        functionPermissions: [{ userId: 'u1', module: 'system-settings', level: 'manage' }],
        blueprintPermissions: [],
        mcpTokens: [],
        futureField: 'ignored',
      },
    };
    const jsonFile = path.join(dir, 'snapshot.json');
    await writeFile(jsonFile, JSON.stringify(raw), 'utf8');
    const fromJson = await readLegacyStateFile(jsonFile);
    assert.equal(fromJson.state.users.length, 1);
    assert.ok(fromJson.state.ignoredKeys.includes('futureField'));
    assert.equal(fromJson.state.credentials.admin, 'pass-1234');

    const dbFile = path.join(dir, 'youzhao.sqlite');
    const db = new DatabaseSync(dbFile);
    db.exec('create table app_state (key text primary key, value text not null)');
    db.prepare('insert into app_state (key, value) values (?, ?)').run('main', JSON.stringify(raw));
    db.close();

    const fromSqlite = await readLegacyStateFromDataDir(dir);
    assert.equal(fromSqlite.state.users[0]?.username, 'admin');
    assert.match(fromSqlite.source, /app_state\.main/);
    assert.equal(legacyPreviewRoot(dir), path.join(dir, 'previews'));

    await assert.rejects(
      () => readLegacyStateFromDataDir(dir, { stateKey: 'missing' }),
      /没有 app_state\.missing/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 执行层（真写库 + 真搬产物） ─────────────────────────────────────────────

async function withContext(
  body: (context: TestContext) => Promise<void>,
): Promise<void> {
  const context = await createTestContext();
  try {
    await body(context);
  } finally {
    await context.close();
  }
}

test('执行迁移：写入用户/身份/分组/蓝图/版本/授权/能力，并把旧产物搬进新根目录', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'youzhao-legacy-artifacts-'));
  const sourceRoot = path.join(dir, 'previews');
  const targetRoot = path.join(dir, 'target');
  try {
    await mkdir(path.join(sourceRoot, 'bp_city_001', '1.0.0', 'assets'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'bp_city_001', '1.0.0', 'index.html'), '<html>city</html>', 'utf8');
    await writeFile(path.join(sourceRoot, 'bp_city_001', '1.0.0', 'assets', 'app.js'), 'console.log(1)', 'utf8');
    await writeFile(path.join(sourceRoot, 'bp_city_001', '1.0.0', 'manifest.json'), '{"legacy":true}', 'utf8');
    // 旧产物里的 blueprint.md 是同一份正文的旧文件名，且可能已过期（行内 markdown 才是旧库当前值）
    await writeFile(path.join(sourceRoot, 'bp_city_001', '1.0.0', 'blueprint.md'), '# 过期正文', 'utf8');
    await mkdir(path.join(sourceRoot, 'bp_city_001', '0.9.0'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'bp_city_001', '0.9.0', 'index.html'), '<html>old</html>', 'utf8');
    // 该版本旧库没有行内 markdown：文件里的正文必须被保留为 README.md，不能丢
    await writeFile(path.join(sourceRoot, 'bp_city_001', '0.9.0', 'blueprint.md'), '# 只有文件里有正文', 'utf8');
    // bp_invest_001 故意没有产物 → 必须标 missing 而不是让整批失败
    await mkdir(path.join(sourceRoot, 'bp_lost_001', '1.0.0'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'bp_lost_001', '1.0.0', 'app.js'), 'no index', 'utf8');

    const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });

    await withContext(async ({ db }) => {
      const result = await applyLegacyMigration({
        db,
        plan,
        artifactSourceRoot: sourceRoot,
        artifactTargetRoot: targetRoot,
        replace: false,
      });

      assert.deepEqual(result.inserted, {
        groups: 4,
        users: 4,
        identities: 4,
        grants: 4,
        capabilities: 3,
        blueprints: 3,
        versions: 5,
        tokens: 1,
      });
      assert.equal(result.artifacts.copied.length, 2);
      assert.equal(result.artifacts.missing.length, 3);
      assert.equal(result.artifacts.failed.length, 0);

      // 用户与身份
      const owner = await db
        .selectFrom('user_identity')
        .select(['user_id', 'identity'])
        .where('identity', '=', 'owner')
        .executeTakeFirstOrThrow();
      assert.equal(owner.user_id, 'u1');
      const identities = await db.selectFrom('user_identity').select('identity').execute();
      assert.equal(identities.filter((row) => row.identity === 'user_admin').length, 1);
      const users = await db.selectFrom('users').select(['id', 'password_hash', 'must_change_password']).execute();
      assert.equal(users.length, 4);
      assert.ok(users.every((user) => user.password_hash.startsWith('scrypt$')));
      assert.ok(users.every((user) => user.must_change_password));
      assert.ok(users.every((user) => !user.password_hash.includes('pass-1234')), '口令不得以明文入库');

      // 分组：默认唯一
      const defaults = await db
        .selectFrom('blueprint_groups')
        .select('id')
        .where('is_default', '=', true)
        .execute();
      assert.deepEqual(defaults.map((row) => row.id), ['group_default']);

      // 蓝图与版本
      const blueprints = await db.selectFrom('blueprints').select(['id', 'group_id', 'status']).execute();
      assert.equal(blueprints.length, 3);
      assert.equal(blueprints.find((row) => row.id === 'bp_lost_001')?.group_id, 'group_legacy_orphan');
      assert.equal(blueprints.find((row) => row.id === 'bp_lost_001')?.status, 'archived');

      const latest = await db
        .selectFrom('blueprint_versions')
        .select(['blueprint_id', 'version', 'status', 'artifact_hash', 'artifact_bytes'])
        .where('is_latest', '=', true)
        .execute();
      assert.deepEqual(
        latest.map((row) => `${row.blueprint_id}@${row.version}`).sort(),
        // bp_lost_001 只有一个版本且旧数据没标 isLatest：计划器会把它补成最新（并给出警告），
        // 即使产物缺失也是「最新版本」，新模型允许 latest 与 missing 同时成立。
        ['bp_city_001@1.0.0', 'bp_invest_001@2.0.0', 'bp_lost_001@1.0.0'],
      );
      const copied = latest.find((row) => row.blueprint_id === 'bp_city_001');
      assert.equal(copied?.status, 'available');
      assert.ok((copied?.artifact_bytes ?? 0) > 0);
      assert.ok(copied?.artifact_hash);

      const missing = await db
        .selectFrom('blueprint_versions')
        .select(['blueprint_id', 'version', 'status'])
        .where('status', '=', 'missing')
        .execute();
      assert.deepEqual(
        missing.map((row) => `${row.blueprint_id}@${row.version}`).sort(),
        ['bp_invest_001@1.5.0', 'bp_invest_001@2.0.0', 'bp_lost_001@1.0.0'],
      );

      // 新产物根：manifest 由新模型重算，旧 manifest 被忽略
      const manifest = JSON.parse(
        await (await import('node:fs/promises')).readFile(
          path.join(targetRoot, 'bp_city_001', '1.0.0', 'manifest.json'),
          'utf8',
        ),
      ) as { files: { path: string }[]; sha256: string };
      assert.deepEqual(
        manifest.files.map((file) => file.path).sort(),
        ['README.md', 'assets/app.js', 'index.html'],
      );
      assert.ok(manifest.sha256);
      // 行内 markdown 优先：旧文件里的「过期正文」不得出现在新产物里
      assert.equal(
        await readFile(path.join(targetRoot, 'bp_city_001', '1.0.0', 'README.md'), 'utf8'),
        '# 城市治理\n\n指标口径说明。',
      );
      // 没有行内 markdown 时，旧文件里的正文必须改名为 README.md 后保留
      assert.equal(
        await readFile(path.join(targetRoot, 'bp_city_001', '0.9.0', 'README.md'), 'utf8'),
        '# 只有文件里有正文',
      );

      // 授权与能力：全部记为所有者授予
      const grants = await db.selectFrom('view_grants').select(['user_id', 'target_type', 'target_id', 'granted_by']).execute();
      assert.equal(grants.length, 4);
      assert.ok(grants.every((grant) => grant.granted_by === 'u1'));

      // Token 一律停用且哈希不可用
      const tokens = await db.selectFrom('mcp_tokens').select(['id', 'status', 'token_prefix', 'scopes']).execute();
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0]?.status, 'disabled');
      assert.match(tokens[0]?.token_prefix ?? '', /^legacy:/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('执行迁移：目标库已有用户时拒绝，--replace 只清业务表且不动 schema_migrations', async () => {
  await withContext(async ({ db }) => {
    const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });

    // 先由 bootstrap 建一个所有者，模拟「api 先起过一次」
    const { ensureInitialOwner } = await import('../app/bootstrap.js');
    await ensureInitialOwner(db, {
      username: 'admin',
      password: 'local-dev-owner-password',
      displayName: '系统管理员',
    });

    await assert.rejects(
      () =>
        applyLegacyMigration({
          db,
          plan,
          artifactSourceRoot: null,
          artifactTargetRoot: '/tmp/youzhao-legacy-target-unused',
          replace: false,
        }),
      (error: unknown) => error instanceof LegacyApplyError && /--replace/.test((error as Error).message),
    );

    const result = await applyLegacyMigration({
      db,
      plan,
      artifactSourceRoot: null,
      artifactTargetRoot: '/tmp/youzhao-legacy-target-unused',
      replace: true,
    });
    assert.equal(result.wiped, true);

    const migrations = await db.selectFrom('schema_migrations').select('version').execute();
    assert.ok(migrations.length >= 5, 'schema_migrations 必须保留');

    const users = await db.selectFrom('users').select('id').execute();
    assert.equal(users.length, plan.users.length);
    assert.ok(users.some((user) => user.id === 'u1'));
    assert.ok(!users.some((user) => user.id.startsWith('usr_')), '被清空的 bootstrap 所有者不应残留');
  });
});

test('执行迁移：不搬产物时所有版本标 missing，并给出可读的下一步', async () => {
  await withContext(async ({ db }) => {
    const plan = planLegacyMigration(syntheticState(), { ownerUsername: 'admin' });
    const result = await applyLegacyMigration({
      db,
      plan,
      artifactSourceRoot: null,
      artifactTargetRoot: '/tmp/youzhao-legacy-target-unused',
      replace: false,
    });

    assert.equal(result.artifacts.copied.length, 0);
    assert.ok(result.warnings.some((warning) => /全部标记为 missing/.test(warning)));
    const available = await db
      .selectFrom('blueprint_versions')
      .select('id')
      .where('status', '=', 'available')
      .execute();
    assert.equal(available.length, 0);
    assert.equal(result.inserted.versions, 5);
  });
});
