import type { CodingNsAgentEvent } from '../../shared/contracts/cli-adapter.js'
import type { RequestPerformance } from '../../shared/request-performance.js'
import type { JsonRpcMessage } from './json-rpc-process.js'
import { isRecord, usageChunk } from './rpc-driver-utils.js'

type Usage = Extract<CodingNsAgentEvent, { type: 'usage' }>
type Observation = Extract<CodingNsAgentEvent, { type: 'usage-observation' }>

/** Model capacity belongs to the provider session, not to a billed request total. */
export class GrokContextUsage {
  modelId: string | undefined
  private readonly windows = new Map<string, number>()

  observe(value: unknown): void {
    if (!isRecord(value)) return
    const params = isRecord(value.params) ? value.params : value
    const meta = isRecord(params._meta) ? params._meta : {}
    if (meta.isReplay === true) return
    const models = [params.models, meta.modelState, params].find(item => isRecord(item) && Array.isArray(item.availableModels))
    if (isRecord(models)) {
      for (const model of models.availableModels) {
        if (!isRecord(model)) continue
        const id = model.modelId ?? model.id
        const window = token(model._meta?.totalContextTokens)
        if (typeof id === 'string' && window !== undefined && window > 0) this.windows.set(id, window)
      }
      if (typeof models.currentModelId === 'string') this.modelId = models.currentModelId
    }
    if (typeof meta.modelId === 'string') this.modelId = meta.modelId
  }

  get contextWindow(): number | undefined {
    return this.modelId === undefined ? undefined : this.windows.get(this.modelId)
  }

  setWindow(window: number): void {
    if (this.modelId !== undefined && window > 0) this.windows.set(this.modelId, window)
  }
}

/** Observe the RPC reader while DSH consumers and translation may be suspended. */
export class GrokPromptUsage {
  private aggregate: Usage | undefined
  private responseUsage: Usage | undefined
  private readonly requests: Usage[] = []
  private readonly samples: RequestPerformance[] = []
  private readonly completedStreams = new Set<number>()
  private readonly signatures = new Set<string>()
  private active: { startedAt: number; firstTokenAt: number } | undefined
  private startedAt: number
  private contextTokens: number | undefined
  private responseContextTokens: number | undefined
  private contextWindow: number | undefined
  private observedSamples = 0
  private lastContext: Pick<Observation, 'contextWindow' | 'contextTokens' | 'contextModelId'> | undefined

  constructor(private readonly id: string, private readonly context: GrokContextUsage, private readonly now: () => number = Date.now) {
    this.startedAt = now()
  }

  observe(message: JsonRpcMessage): void {
    const params = isRecord(message.params) ? message.params : message
    const update = isRecord(params.update) ? params.update : params
    const meta = isRecord(params._meta) ? params._meta : {}
    if (meta.isReplay === true) return
    this.context.observe(message)
    const time = this.now()
    const streamStart = token(meta.streamStartMs)
    if (streamStart !== undefined && !this.completedStreams.has(streamStart)
      && this.active?.firstTokenAt !== streamStart) {
      // Native stream start includes hidden reasoning that precedes visible text.
      const start = this.samples.length === 0 ? token(meta.turnStartMs) ?? this.startedAt : this.startedAt
      this.active = { startedAt: Math.min(start, streamStart), firstTokenAt: streamStart }
    }
    this.contextTokens = token(meta.totalTokens) ?? this.contextTokens
    const type = String(update.sessionUpdate ?? update.type ?? '').toLowerCase()
    if (type === 'usage_update' || type === 'usage-update') {
      this.aggregate = readUsage(update) ?? this.aggregate
      this.contextTokens = token(update.used ?? update.contextTokens) ?? this.contextTokens
      const size = token(update.size ?? update.contextWindow)
      if (size !== undefined && size > 0) {
        this.contextWindow = size
        this.context.setWindow(size)
      }
      return
    }
    if (type === 'response_completed') {
      const signature = typeof update.signature === 'string' ? update.signature : undefined
      if (signature !== undefined && this.signatures.has(signature)) return
      if (signature !== undefined) this.signatures.add(signature)
      const usage = readUsage(update)
      if (usage !== undefined) {
        this.requests.push(usage)
        this.completeRequest(usage.outputTokens, time)
      }
      return
    }
    if (type === 'tool_call_update' && ['completed', 'failed'].includes(String(update.status).toLowerCase())) this.startedAt = time
    if (['turn_completed', 'turn_complete', 'prompt_complete', 'completed', 'done'].includes(type)) {
      this.aggregate = readUsage(update) ?? this.aggregate
      // A turn total may span many calls; it cannot be paired with the last stream.
      if (update.usage?.modelCalls === 1 && this.requests.length === 0 && this.aggregate !== undefined) {
        this.completeRequest(this.aggregate.outputTokens, time)
      }
    }
  }

  observeResponse(value: unknown): void {
    if (!isRecord(value) || !isRecord(value._meta)) return
    this.context.observe(value)
    const meta = value._meta
    this.responseUsage = readUsage({ usage: meta.usage })
    this.responseContextTokens = token(meta.totalTokens)
    // Some versions omit response_completed but retain the last call's usage here.
    const lastOutput = token(meta.outputTokens)
    if (lastOutput !== undefined) this.completeRequest(lastOutput, this.now())
  }

  finish(): Usage | undefined {
    const usage = this.responseUsage ?? this.aggregate ?? sumRequests(this.requests)
    const context = this.contextFields()
    const { contextTokens } = context
    if (usage === undefined && contextTokens === undefined) return undefined
    return {
      type: 'usage', inputTokens: 0, outputTokens: 0, ...usage,
      ...context,
      ...(this.samples.length === 0 ? {} : { requestPerformance: { id: this.id, samples: [...this.samples] } }),
    }
  }

  /** Drain each measurement once into the notification queue, before a consumer can block it. */
  takeObservation(): Observation | undefined {
    const context = this.contextFields()
    const samples = this.samples.slice(this.observedSamples)
    if (samples.length === 0 && context.contextTokens === this.lastContext?.contextTokens
      && context.contextWindow === this.lastContext?.contextWindow && context.contextModelId === this.lastContext?.contextModelId) return undefined
    if (samples.length === 0 && context.contextTokens === undefined && context.contextWindow === undefined) return undefined
    this.observedSamples = this.samples.length
    this.lastContext = context
    return {
      type: 'usage-observation', ...context,
      ...(samples.length === 0 ? {} : { requestPerformance: { id: samples.at(-1)!.id, samples } }),
    }
  }

  private contextFields(): Pick<Observation, 'contextTokens' | 'contextWindow' | 'contextModelId' | 'contextUsageRatio'> {
    const contextTokens = this.responseContextTokens ?? this.contextTokens
    const contextWindow = this.contextWindow ?? this.context.contextWindow
    return {
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextTokens === undefined || contextWindow === undefined ? {} : {
        contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)),
      }),
      ...(this.context.modelId === undefined ? {} : { contextModelId: this.context.modelId }),
    }
  }

  private completeRequest(outputTokens: number, time: number): void {
    const active = this.active
    this.active = undefined
    this.startedAt = time
    if (active === undefined) return
    this.completedStreams.add(active.firstTokenAt)
    if (outputTokens <= 0 || time <= active.firstTokenAt) return
    this.samples.push({ id: `${this.id}:${active.firstTokenAt}`, ...active, completedAt: time, outputTokens })
  }
}

function readUsage(value: unknown): Usage | undefined {
  const event = usageChunk(value)
  return event?.type === 'usage' ? event : undefined
}

function sumRequests(requests: readonly Usage[]): Usage | undefined {
  if (requests.length === 0) return undefined
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
  let cached = false
  for (const usage of requests) {
    const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    inputTokens += usage.uncachedInputTokens === undefined ? usage.inputTokens : usage.uncachedInputTokens + cache
    outputTokens += usage.outputTokens
    cacheReadTokens += usage.cacheReadTokens ?? 0
    cacheWriteTokens += usage.cacheWriteTokens ?? 0
    cached ||= usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined
  }
  return readUsage({ inputTokens, outputTokens, ...(cached ? { cacheReadTokens, cacheWriteTokens } : {}) })
}

function token(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
