import { randomUUID } from 'node:crypto'
import type { RequestPerformance } from '../../shared/request-performance.js'
import { isRecord } from './rpc-driver-utils.js'

/** Pair each main-agent message's output with its stream arrival times, before translation. */
export class ClaudePerformanceTracker {
  private readonly epoch = randomUUID()
  private readonly completed = new Set<string>()
  private startedAt: number
  private active: {
    id: string
    startedAt: number
    firstTokenAt?: number
    outputTokens?: number
  } | undefined

  constructor(startedAt: number) { this.startedAt = startedAt }

  observe(value: Record<string, unknown>, time: number): RequestPerformance | undefined {
    if (value.parent_tool_use_id != null) return undefined
    if (value.type === 'system' && value.subtype === 'api_retry') {
      this.active = undefined
      this.startedAt = time
      return undefined
    }
    const message = isRecord(value.message) ? value.message : undefined
    if (value.type === 'user' && Array.isArray(message?.content)
      && message.content.some(part => isRecord(part) && part.type === 'tool_result')) this.startedAt = time
    if (value.type === 'result') {
      // Result usage sums the whole tool loop; it cannot be paired with the last message.
      this.active = undefined
      return undefined
    }
    const event = value.type === 'stream_event' && isRecord(value.event) ? value.event : undefined
    if (event?.type === 'message_start' && isRecord(event.message)) {
      const id = event.message.id
      if (typeof id === 'string' && !this.completed.has(id) && this.active?.id !== id) {
        this.active = { id, startedAt: this.startedAt }
      }
    }
    const active = this.active
    if (active === undefined) return undefined
    // Assistant snapshots may precede message_stop, but never define a timing boundary.
    const snapshot = value.type === 'assistant' && message?.id === active.id ? message : undefined
    const rawUsage = event?.type === 'message_delta' ? event.usage : snapshot?.usage
    if (isRecord(rawUsage)) {
      const output = rawUsage.output_tokens
      if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
        active.outputTokens = Math.max(active.outputTokens ?? 0, output)
      }
    }
    const delta = isRecord(event?.delta) ? event.delta : undefined
    const block = isRecord(event?.content_block) ? event.content_block : undefined
    if (event?.type === 'content_block_delta' && [delta?.text, delta?.thinking, delta?.partial_json]
      .some(text => typeof text === 'string' && text !== '')
      || event?.type === 'content_block_start' && (block?.type === 'tool_use'
        || [block?.text, block?.thinking].some(text => typeof text === 'string' && text !== ''))) {
      active.firstTokenAt ??= time
    }
    if (event?.type !== 'message_stop') return undefined
    this.active = undefined
    this.completed.add(active.id)
    this.startedAt = time
    const { startedAt, firstTokenAt, outputTokens } = active
    if (firstTokenAt === undefined || outputTokens === undefined || outputTokens <= 0
      || startedAt > firstTokenAt || time <= firstTokenAt) return undefined
    return { id: `${this.epoch}:${active.id}`, startedAt, firstTokenAt, completedAt: time, outputTokens }
  }
}
