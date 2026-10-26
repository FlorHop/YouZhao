/**
 * 范围解析——**唯一实现**（docs/architecture-design.md §3.3「范围解析」）。
 *
 * 规则要点：
 * - 分组范围覆盖组内全部蓝图；蓝图范围只覆盖它自己。
 * - 查看范围与可委派范围是同一集合（S1）；可委派范围只对 `user_admin` 有意义。
 * - 业务能力同时带来看得见的资格（§3.3 的 `canView` 公式）。
 */
import type {
  CapabilityGrant,
  CapabilityName,
  Identity,
  JurisdictionScope,
  RequestContext,
  ScopeRef,
  TargetType,
} from './entities.js';

/** 被授权或被判定的资源（`groupId` 仅蓝图需要，用于判断分组范围是否覆盖它）。 */
export interface ResourceLike {
  readonly kind: 'group' | 'blueprint';
  readonly id: string;
  readonly groupId?: string;
}

export function scopeKey(ref: ScopeRef): string {
  return `${ref.targetType}:${ref.targetId}`;
}

export function dedupeScopes(refs: readonly ScopeRef[]): ScopeRef[] {
  const seen = new Set<string>();
  const out: ScopeRef[] = [];
  for (const ref of refs) {
    const key = scopeKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ targetType: ref.targetType, targetId: ref.targetId });
  }
  return out;
}

export function scopeEquals(left: ScopeRef, right: ScopeRef): boolean {
  return left.targetType === right.targetType && left.targetId === right.targetId;
}

/** 某个范围项是否覆盖给定资源。 */
export function scopeCovers(ref: ScopeRef, resource: ResourceLike): boolean {
  if (ref.targetType === 'group') {
    const groupOfResource = resource.kind === 'group' ? resource.id : resource.groupId;
    return groupOfResource !== undefined && ref.targetId === groupOfResource;
  }
  return resource.kind === 'blueprint' && ref.targetId === resource.id;
}

/**
 * 授权目标：范围项 + 可选的分组信息。
 * 蓝图目标必须带上 `groupId`，否则无法判断「它是否落在可委派的分组内」。
 */
export interface ScopedTarget extends ScopeRef {
  readonly groupId?: string;
}

/**
 * 目标是否在给定范围内（可委派范围的 ⊆ 判定）。
 * - 完全相同的一个范围项：在范围内。
 * - 蓝图目标且其分组在范围内：视为在范围内（原型允许按项勾选组内蓝图）。
 */
export function isScopedTargetWithin(
  target: ScopedTarget,
  haystack: readonly ScopeRef[],
): boolean {
  if (haystack.some((ref) => scopeEquals(ref, target))) return true;
  if (target.targetType === 'blueprint' && target.groupId !== undefined) {
    return haystack.some((ref) => ref.targetType === 'group' && ref.targetId === target.groupId);
  }
  return false;
}

/** 一组授权目标是否全部落在 `haystack` 内。 */
export function isScopeSubset(
  needles: readonly ScopedTarget[],
  haystack: readonly ScopeRef[],
): boolean {
  return needles.every((needle) => isScopedTargetWithin(needle, haystack));
}

/** 有效查看范围 = `view_grants` 去重（同一集合也即可委派范围，S1）。 */
export function effectiveViewScope(grants: readonly ScopeRef[]): ScopeRef[] {
  return dedupeScopes(grants);
}

/** 可委派范围：只有用户管理员有；S1 裁决为「等于本人查看范围」。 */
export function delegableScope(identity: Identity, viewScope: readonly ScopeRef[]): ScopeRef[] {
  return identity === 'user_admin' ? dedupeScopes(viewScope) : [];
}

export function capabilityKey(cap: CapabilityGrant): string {
  return `${cap.capability}:${cap.targetType}:${cap.targetId}`;
}

export function dedupeCapabilities(caps: readonly CapabilityGrant[]): CapabilityGrant[] {
  const seen = new Set<string>();
  const out: CapabilityGrant[] = [];
  for (const cap of caps) {
    const key = capabilityKey(cap);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      capability: cap.capability,
      targetType: cap.targetType,
      targetId: cap.targetId,
    });
  }
  return out;
}

/**
 * 管辖派生的业务能力（docs/permission-design.md §2.3）：
 * - 分组管辖 ⇒ 该分组上的 `blueprint.publish` + `blueprint.manage`（组范围覆盖组内全部蓝图）。
 * - 单个蓝图的管辖 ⇒ 该蓝图上的 `blueprint.manage`。**不**派生「在该组内新建蓝图」——
 *   新建的目标资源是分组本身，不是某个已有蓝图，否则单点管辖会变成整组发版权。
 */
export function deriveJurisdictionCapabilities(
  jurisdiction: JurisdictionScope,
): CapabilityGrant[] {
  const out: CapabilityGrant[] = [];
  for (const groupId of jurisdiction.groupIds) {
    out.push({ capability: 'blueprint.publish', targetType: 'group', targetId: groupId });
    out.push({ capability: 'blueprint.manage', targetType: 'group', targetId: groupId });
  }
  for (const blueprintId of jurisdiction.blueprintIds) {
    out.push({ capability: 'blueprint.manage', targetType: 'blueprint', targetId: blueprintId });
  }
  return out;
}

/**
 * 有效能力 = 管辖派生 ∪ `capabilities` 行（并集裁决，docs/permission-design.md §2.3）。
 *
 * 并集而不是「能力表说了算」，是为了避免出现「他管辖着这个组、却因为表里没有 publish 行
 * 而发不了版」的矛盾状态：管辖**不被**能力表削减，能力表只做加法（例外授权）。
 */
export function effectiveCapabilities(
  granted: readonly CapabilityGrant[],
  jurisdiction: JurisdictionScope | undefined,
): CapabilityGrant[] {
  if (jurisdiction === undefined) return dedupeCapabilities(granted);
  return dedupeCapabilities([...granted, ...deriveJurisdictionCapabilities(jurisdiction)]);
}

export function capabilityTargets(
  caps: readonly CapabilityGrant[],
  capability?: CapabilityName,
): ScopeRef[] {
  return dedupeScopes(
    caps
      .filter((cap) => capability === undefined || cap.capability === capability)
      .map((cap) => ({ targetType: cap.targetType, targetId: cap.targetId })),
  );
}

export function hasAnyCapability(
  caps: readonly CapabilityGrant[],
  capability: CapabilityName,
): boolean {
  return caps.some((cap) => cap.capability === capability);
}

/** 指定能力是否覆盖该资源（分组能力覆盖组内蓝图，蓝图能力只覆盖自己）。 */
export function isCapabilityCovered(
  caps: readonly CapabilityGrant[],
  capability: CapabilityName,
  resource: ResourceLike,
): boolean {
  return caps.some(
    (cap) =>
      cap.capability === capability &&
      scopeCovers({ targetType: cap.targetType, targetId: cap.targetId }, resource),
  );
}

/** `canView`：查看范围覆盖，或任一业务能力的资源覆盖（§3.3 公式）。 */
export function isResourceVisible(
  viewScope: readonly ScopeRef[],
  caps: readonly CapabilityGrant[],
  resource: ResourceLike,
): boolean {
  if (viewScope.some((ref) => scopeCovers(ref, resource))) return true;
  return caps.some((cap) =>
    scopeCovers({ targetType: cap.targetType, targetId: cap.targetId }, resource),
  );
}

/**
 * 上下文级的可见性判定：**用例层唯一入口**。
 *
 * 与 `isResourceVisible` 只差一条，但很关键：身份 `owner` 隐式拥有全部业务能力
 * （`docs/architecture-design.md` §3.5 落地约定），而能力覆盖资源即意味着可见——
 * 因此所有者天然看得见全部蓝图与分组，无需（也不应）给他写 `view_grants`。
 * 用例层请一律用这个函数，不要自己组合 `ctx.viewScope` / `ctx.capabilities`。
 */
export function visibleToContext(
  ctx: Pick<RequestContext, 'identity' | 'viewScope' | 'capabilities'>,
  resource: ResourceLike,
): boolean {
  if (ctx.identity === 'owner') return true;
  return isResourceVisible(ctx.viewScope, ctx.capabilities, resource);
}

/** 便捷：从范围项反查能看到的资源键集合（供列表过滤使用）。 */
export function scopeKeysOfType(refs: readonly ScopeRef[], targetType: TargetType): string[] {
  return refs.filter((ref) => ref.targetType === targetType).map((ref) => ref.targetId);
}
