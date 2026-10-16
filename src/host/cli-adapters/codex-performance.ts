import { randomUUID } from 'node:crypto'
import type { CodexRequestPerformance } from '../../shared/codex-performance.js'
import { isRecord } from './rpc-driver-utils.js'
import type { JsonRpcMessage } from './json-rpc-process.js'

/** Observe the RPC reader, before generator queues, translation, and DSH step suspension. */
export class CodexPerformanceTracker {
  private readonly epoch = randomUUID()
  private sequence = 0
  private startedAt: number | undefined
  private firstTokenAt: number | undefined
  private totalOutputTokens: number | undefined
  private readonly tools = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  beginTurn(): void {
    this.startedAt = this.now()
    this.firstTokenAt = undefined
    this.tools.clear()
  }

  observe(message: JsonRpcMessage): CodexRequestPerformance | undefined {
    const params = isRecord(message.params) ? message.params : {}
    const item = isRecord(params.item) ? params.item : undefined
    const method = message.method ?? ''
    const time = this.now()
    if (method === 'turn/started') this.beginTurn()
    if (method === 'turn/completed') {
      this.startedAt = undefined
      this.firstTokenAt = undefined
      this.tools.clear()
      return undefined
    }
    const type = typeof item?.type === 'string' ? item.type.replace(/[_-]/gu, '').toLowerCase() : ''
    if (method === 'item/started' && (type === 'reasoning' || type === 'agentmessage')) {
      this.startedAt ??= time
      // Reasoning summaries arrive after hidden output tokens have already been generated.
      // Its item start is the available boundary that includes that hidden generation.
      if (type === 'reasoning') this.firstTokenAt ??= time
    }
    if ((method.includes('agentMessage') || method.includes('reasoning')) && typeof params.delta === 'string' && params.delta !== '') {
      this.startedAt ??= time
      this.firstTokenAt ??= time
    }
    if (item !== undefined && !['reasoning', 'agentmessage', 'contextcompaction', 'plan'].includes(type)) {
      const id = typeof item.id === 'string' ? item.id : undefined
      if (id !== undefined && method === 'item/started') this.tools.add(id)
      if (id !== undefined && method === 'item/completed') {
        this.tools.delete(id)
        if (this.tools.size === 0 && this.firstTokenAt === undefined) this.startedAt = time
      }
    }
    if (method !== 'thread/tokenUsage/updated') return undefined
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : params.token_usage
    if (!isRecord(usage)) return undefined
    const last = [usage.last, usage.lastUsage, usage.last_token_usage].find(isRecord)
    const total = isRecord(usage.total) ? token(usage.total.outputTokens ?? usage.total.output_tokens) : undefined
    const previousTotal = this.totalOutputTokens
    if (total !== undefined) this.totalOutputTokens = total
    const outputTokens = last === undefined
      ? total !== undefined && previousTotal !== undefined && total >= previousTotal ? total - previousTotal : undefined
      : token(last.outputTokens ?? last.output_tokens)
    const startedAt = this.startedAt
    const firstTokenAt = this.firstTokenAt
    this.startedAt = this.tools.size === 0 ? time : undefined
    this.firstTokenAt = undefined
    if ((total !== undefined && previousTotal === total) || outputTokens === undefined || outputTokens <= 0
      || startedAt === undefined || firstTokenAt === undefined || startedAt > firstTokenAt || time <= firstTokenAt) return undefined
    return { id: `${this.epoch}:${++this.sequence}`, startedAt, firstTokenAt, completedAt: time, outputTokens }
  }
}

function token(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
