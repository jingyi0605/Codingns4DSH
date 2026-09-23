interface ReactFiberLike {
  readonly memoizedProps?: unknown
  readonly pendingProps?: unknown
  readonly return?: unknown
}

/** 从一个 DSH 0.1.6 treeitem 对应的 React Fiber 向上查找会话身份。 */
export function resolveDshSessionId(row: object): string | undefined {
  const carrier = row as Record<string, unknown>
  const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith('__reactFiber$'))
  if (fiberKey === undefined) return undefined

  let current: unknown = carrier[fiberKey]
  for (let depth = 0; depth < 32 && isRecord(current); depth += 1) {
    const fiber = current as ReactFiberLike
    const sessionId = sessionIdFromProps(fiber.memoizedProps) ?? sessionIdFromProps(fiber.pendingProps)
    if (sessionId !== undefined) return sessionId
    current = fiber.return
  }
  return undefined
}

function sessionIdFromProps(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of ['node', 'result'] as const) {
    const candidate = value[key]
    if (!isRecord(candidate) || typeof candidate.id !== 'string') continue
    const sessionId = candidate.id.trim()
    if (sessionId !== '') return sessionId
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
