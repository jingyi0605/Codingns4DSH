const allowedTargets = new Map<string, ReadonlySet<string>>()

/** 记录一次父会话提交中由 carrier 明确授权的目标 Agent。 */
export function setDelegationAuthorization(sessionId: string, adapterIds: readonly string[]): void {
  const id = sessionId.trim()
  if (id === '') return
  const targets = new Set(adapterIds.map((value) => value.trim()).filter((value) => value !== ''))
  if (targets.size === 0) allowedTargets.delete(id)
  else allowedTargets.set(id, targets)
}

export function clearDelegationAuthorization(sessionId: string): void {
  allowedTargets.delete(sessionId.trim())
}

export function isDelegationTargetAllowed(sessionId: string, adapterId: string): boolean {
  const targets = allowedTargets.get(sessionId.trim())
  return targets === undefined || targets.has(adapterId.trim())
}
