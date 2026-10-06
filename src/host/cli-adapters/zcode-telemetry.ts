import type { CodingNsAgentEvent, CodingNsAgentToolEvent } from '../../shared/contracts/cli-adapter.js'
import type { JsonRpcMessage } from './json-rpc-process.js'
import { isRecord, usageChunk } from './rpc-driver-utils.js'

type UsageEvent = Extract<CodingNsAgentEvent, { type: 'usage' }>

/** 每轮独立持有统计；累计账单和当前请求上下文是两种数据，不能互相覆盖。 */
export class ZcodeTurnTelemetry {
  private readonly seen = new Set<string>()
  private readonly samples: UsageEvent[] = []
  private readonly tools = new Map<string, { name: string; input?: string }>()
  private context: Pick<UsageEvent, 'contextWindow' | 'contextTokens'> = {}

  constructor(private readonly sessionId: string) {}

  observe(message: JsonRpcMessage): CodingNsAgentToolEvent | null {
    if (message.method !== 'session/event') return null
    const params = isRecord(message.params) ? message.params : {}
    if (typeof params.sessionId === 'string' && params.sessionId !== this.sessionId) return null
    const key = typeof params.eventId === 'string' ? params.eventId
      : typeof params.seq === 'number' ? `seq:${params.seq}` : undefined
    if (key !== undefined && this.seen.has(key)) return null
    if (key !== undefined) this.seen.add(key)
    const payload = isRecord(params.payload) ? params.payload : {}
    // model_request_completed 网络通知也有 usage，但同一次请求稍后还会收到
    // ModelComplete。只结算带 stopReason 的模型完成事件，避免双倍计费。
    if (params.type === 'session.updated' && typeof payload.stopReason === 'string') {
      const sample = usageChunk(payload.usage)
      if (sample?.type === 'usage') {
        this.samples.push(sample)
        if (payload.querySource === 'main_turn' || payload.querySource === undefined) {
          this.context = { contextTokens: sample.totalTokens ?? sample.inputTokens + sample.outputTokens,
            ...(positive(payload.contextWindow) === undefined ? {} : { contextWindow: payload.contextWindow }) }
        }
      }
    }
    const callId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined
    if (callId === undefined) return null
    const tool = this.tools.get(callId) ?? { name: zcodeToolName(payload.toolName) }
    if (typeof payload.toolName === 'string') tool.name = zcodeToolName(payload.toolName)
    this.tools.set(callId, tool)
    if (params.type === 'model.streaming') {
      if (payload.kind === 'tool_input_start') tool.input = ''
      if (payload.kind === 'tool_input_delta' && typeof payload.delta === 'string') {
        tool.input = `${tool.input ?? ''}${payload.delta}`.slice(0, 64 * 1024)
      }
      return payload.kind === 'tool_input_end'
        ? { type: 'tool-event', callId, toolName: tool.name, status: 'started', ...(tool.input === undefined ? {} : { input: tool.input }) } : null
    }
    if (params.type !== 'tool.updated') return null
    if (payload.input !== undefined) tool.input = serialize(payload.input)
    const base = { type: 'tool-event' as const, callId, toolName: tool.name,
      ...(tool.input === undefined ? {} : { input: tool.input }) }
    if (payload.kind === 'scheduled' || payload.kind === 'started') return { ...base, status: 'started' }
    if (payload.kind === 'progress') {
      return { ...base, status: 'running', ...(typeof payload.outputPreview === 'string'
        ? { output: payload.outputPreview, outputMode: 'snapshot' as const } : {}) }
    }
    if (payload.kind === 'result') {
      const result = isRecord(payload.result) ? payload.result : {}
      const output = serialize(result.content ?? result.error ?? '')
      return { ...base, status: result.success === false ? 'failed' : 'completed', output, outputMode: 'snapshot',
        ...(result.success === false ? { error: firstText(result.error, output) ?? 'ZCode 工具执行失败' } : {}) }
    }
    if (payload.kind === 'error') {
      const error = firstText(payload.error?.message, payload.error, payload.message) ?? serialize(payload.error ?? payload)
      return { ...base, status: 'failed', error, output: error, outputMode: 'snapshot' }
    }
    return null
  }

  /** 原生模型完成事件没有窗口时才读取快照；窗口以实际请求报告为准。 */
  get needsContextSnapshot(): boolean { return this.context.contextWindow === undefined }

  readContextSnapshot(value: unknown): void {
    const root = isRecord(value) && isRecord(value.snapshot) ? value.snapshot : value
    const projection = isRecord(root) && isRecord(root.projection) ? root.projection : {}
    const window = positive(projection.contextWindow)
    const tokens = nonnegative(projection.contextUsed)
    if (window !== undefined && this.context.contextWindow === undefined) this.context = { ...this.context, contextWindow: window }
    if (this.context.contextTokens === undefined && tokens !== undefined) this.context = { ...this.context, contextTokens: tokens }
  }

  finish(legacyUsage: unknown, baseline: unknown): CodingNsAgentEvent | null {
    let usage: UsageEvent | null = null
    if (this.samples.length > 0) {
      const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'totalTokens'): number =>
        this.samples.reduce((total, sample) => total + (sample[key] ?? 0), 0)
      usage = usageChunk({ inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
        cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
        totalTokens: this.samples.reduce((total, sample) => total + (sample.totalTokens ?? sample.inputTokens + sample.outputTokens), 0) }) as UsageEvent
    } else if (isRecord(legacyUsage) && !isRecord(legacyUsage.inputBaselineBySource)) {
      // 旧 CLI 没有模型用量事件；只对原始累计桶求差。新 CLI 的基线去重口径
      // 不是请求消耗，不能拿它冒充账单或推导缓存命中率。
      const current = usageChunk(legacyUsage)
      const previous = usageChunk(baseline)
      if (current?.type === 'usage') {
        const values: Record<string, number> = {}
        const reset = previous?.type === 'usage' && current.inputTokens < previous.inputTokens
        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const) {
          if (current[key] !== undefined) values[key] = Math.max(0, current[key]! - (!reset && previous?.type === 'usage' ? previous[key] ?? 0 : 0))
        }
        usage = usageChunk(values) as UsageEvent | null
      }
    }
    if (usage === null) return usageChunk({ inputTokens: 0, outputTokens: 0, ...this.context })
    const { contextWindow, contextTokens } = this.context
    return { ...usage, ...this.context, ...(contextWindow !== undefined && contextTokens !== undefined
      ? { contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)) } : {}) }
  }
}

function positive(value: unknown): number | undefined { const number = nonnegative(value); return number !== undefined && number > 0 ? number : undefined }
function nonnegative(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined }
function serialize(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? '' }
function firstText(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === 'string' && value.trim() !== '') }
function zcodeToolName(value: unknown): string { return value === 'AskUserQuestion' ? 'question' : typeof value === 'string' ? value : 'tool' }
