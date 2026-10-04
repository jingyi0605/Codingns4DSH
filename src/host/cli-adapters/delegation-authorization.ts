export interface DelegationAuthorizationTarget {
  readonly adapterId: string
  readonly modelId?: string
}

const allowedTargets = new Map<string, ReadonlyMap<string, string | undefined>>()

/** 记录一次父会话提交中由 carrier 明确授权的目标 Agent。 */
export function setDelegationAuthorization(
  sessionId: string,
  targets: readonly (string | DelegationAuthorizationTarget)[],
): void {
  const id = sessionId.trim()
  if (id === '') return
  const normalized = new Map<string, string | undefined>()
  for (const target of targets) {
    const adapterId = typeof target === 'string' ? target.trim() : target.adapterId.trim()
    if (adapterId === '') continue
    const modelId = typeof target === 'string' ? undefined : target.modelId?.trim() || undefined
    if (!normalized.has(adapterId)) normalized.set(adapterId, modelId)
  }
  if (normalized.size === 0) allowedTargets.delete(id)
  else allowedTargets.set(id, normalized)
}

export function clearDelegationAuthorization(sessionId: string): void {
  allowedTargets.delete(sessionId.trim())
}

export function isDelegationTargetAllowed(sessionId: string, adapterId: string): boolean {
  const targets = allowedTargets.get(sessionId.trim())
  return targets === undefined || targets.has(adapterId.trim())
}

/** 读取 carrier 明确授权的模型；旧 v1 或未授权模型时返回 undefined。 */
export function getDelegationModel(sessionId: string, adapterId: string): string | undefined {
  return allowedTargets.get(sessionId.trim())?.get(adapterId.trim())
}

/**
 * 当本轮只授权了一个委派目标时返回默认目标。
 *
 * Command Code 的内建 `agent` 工具不会携带 CodingNS 的 `agent` 字段；此时如果
 * 直接回退到父会话适配器，就会把“选择 Claude Code”的任务错误地再次创建成
 * Command Code。多个目标时不猜测，仍要求模型显式传入目标。
 */
export function getSingleDelegationTarget(sessionId: string): DelegationAuthorizationTarget | undefined {
  const targets = allowedTargets.get(sessionId.trim())
  if (targets === undefined || targets.size !== 1) return undefined
  const entry = targets.entries().next().value as [string, string | undefined] | undefined
  if (entry === undefined) return undefined
  const [adapterId, modelId] = entry
  return modelId === undefined ? { adapterId } : { adapterId, modelId }
}
