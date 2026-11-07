import { randomUUID } from 'node:crypto'
import type { RequestPerformance } from '../../shared/request-performance.js'
import type { JsonRpcMessage } from './json-rpc-process.js'
import { isRecord, textValue } from './rpc-driver-utils.js'

/** Measure Pi's observed assistant stream before the async turn consumer can block. */
export class PiPerformanceTracker {
  private readonly epoch = randomUUID()
  private sequence = 0
  private turnStartedAt: number | undefined
  private active: {
    readonly id: string
    readonly startedAt: number
    firstTokenAt?: number
    outputTokens?: number
  } | undefined

  constructor(private readonly now: () => number = Date.now) {}

  observe(message: JsonRpcMessage, receivedAt = this.now()): RequestPerformance | undefined {
    const params = isRecord(message.params) ? message.params : message
    const type = textValue(params.type ?? params.event)?.toLowerCase() ?? ''

    if (type === 'turn_start') {
      this.turnStartedAt = receivedAt
      this.active = undefined
      return undefined
    }

    if (type === 'message_start') {
      const assistant = isRecord(params.message) && params.message.role === 'assistant' ? params.message : undefined
      if (assistant !== undefined) {
        this.active = {
          id: textValue(assistant.id) ?? `message-${++this.sequence}`,
          startedAt: receivedAt,
        }
        this.updateOutput(this.active, assistant.usage)
      }
      return undefined
    }

    if (type === 'message_update') {
      const active = this.active ?? this.beginFallback(receivedAt)
      this.updateOutput(active, params.usage)
      const event = isRecord(params.assistantMessageEvent) ? params.assistantMessageEvent : undefined
      if (event !== undefined && isAssistantContent(event)) active.firstTokenAt ??= receivedAt
      return undefined
    }

    if (type !== 'message_end') {
      if (type === 'turn_end' || type === 'agent_end' || type === 'agent_settled') this.active = undefined
      return undefined
    }

    const assistant = isRecord(params.message) && params.message.role === 'assistant' ? params.message : undefined
    if (assistant === undefined) return undefined
    const active = this.active ?? this.beginFallback(receivedAt)
    this.updateOutput(active, assistant.usage ?? params.usage)
    const sample = active.firstTokenAt === undefined || active.outputTokens === undefined
      || active.outputTokens <= 0 || active.startedAt > active.firstTokenAt || receivedAt <= active.firstTokenAt
      ? undefined
      : {
          id: `${this.epoch}:${active.id}`,
          startedAt: active.startedAt,
          firstTokenAt: active.firstTokenAt,
          completedAt: receivedAt,
          outputTokens: active.outputTokens,
        }
    this.active = undefined
    this.turnStartedAt = receivedAt
    return sample
  }

  private beginFallback(receivedAt: number): {
    readonly id: string
    readonly startedAt: number
    firstTokenAt?: number
    outputTokens?: number
  } {
    const active = {
      id: `message-${++this.sequence}`,
      startedAt: this.turnStartedAt ?? receivedAt,
    }
    this.active = active
    return active
  }

  private updateOutput(active: { outputTokens?: number }, value: unknown): void {
    const usage = isRecord(value) ? value : undefined
    const output = usage === undefined ? undefined : numberValue(usage.output ?? usage.outputTokens)
    if (output !== undefined) active.outputTokens = Math.max(active.outputTokens ?? 0, output)
  }
}

function isAssistantContent(event: Record<string, unknown>): boolean {
  const type = textValue(event.type)?.toLowerCase() ?? ''
  if (type === 'text_delta' || type === 'thinking_delta' || type === 'toolcall_delta') {
    const delta = textValue(event.delta)
    return delta !== null && delta !== ''
  }
  if (type === 'text_end' || type === 'thinking_end') {
    const content = textValue(event.content)
    return content !== null && content !== ''
  }
  return type === 'toolcall_start' || type === 'toolcall_end'
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
