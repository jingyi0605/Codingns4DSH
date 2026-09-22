import type { CodingNsAgentToolEvent } from '../../shared/contracts/cli-adapter.js'

export type ExternalToolStatus = NonNullable<CodingNsAgentToolEvent['status']>

/** 保留 Provider 的结构化参数和结果，不用隐式的 [object Object] 丢失信息。 */
export function serializeToolValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 工具状态的常见别名统一到 Host 契约，未知值使用调用方给出的协议阶段。 */
export function normalizeToolStatus(value: unknown, fallback: ExternalToolStatus): ExternalToolStatus {
  const status = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/gu, '_') : ''
  if (['queued', 'pending', 'starting', 'started'].includes(status)) return 'started'
  if (['running', 'in_progress', 'inprogress', 'streaming'].includes(status)) return 'running'
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)) return 'completed'
  if (['failed', 'failure', 'error', 'denied', 'rejected', 'cancelled', 'canceled'].includes(status)) return 'failed'
  return fallback
}

export function firstToolText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

export function isToolRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
