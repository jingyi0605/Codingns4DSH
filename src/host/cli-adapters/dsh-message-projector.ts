import type {
  CodingNsAgentEvent,
  CodingNsAgentQuestionResponse,
  CodingNsAgentPermissionResponse,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsNativeSessionBridge, CodingNsNativeUsageSample } from '../native-session-bridge.js'
import { CodingNsDshToolHistoryProjector } from './dsh-tool-history.js'
import {
  CodingNsAgentEventNormalizer,
  type CodingNsNormalizedAgentEvent,
} from './stream-normalizer.js'
import type { CodingNsDshExternalToolMarker } from './dsh-tool-history.js'

export interface CodingNsDshMessageProjectorOptions {
  readonly adapterId: string
  readonly sessionId: string
  readonly modelId?: string
  readonly nativeSessions?: CodingNsNativeSessionBridge
  readonly signal?: AbortSignal
  readonly respondPermission?: (response: CodingNsAgentPermissionResponse) => Promise<void> | void
  readonly respondQuestion?: (response: CodingNsAgentQuestionResponse) => Promise<void> | void
}

/** DSH `llm/stream` 接受的最小结构；具体协议只允许在本文件构造。 */
export type CodingNsDshStreamChunk = Readonly<Record<string, unknown>>

/**
 * 把驱动的 Provider 口径 usage 映射成 DSH `TokenUsage` 的互斥桶口径。
 *
 * DSH 约定 `inputTokens` 只含未缓存输入，计费输入 = inputTokens + 缓存读写，而
 * 驱动层已经用 `usageChunk` 按各 Provider 的字段语义折算出 `uncachedInputTokens`
 * （Codex、Command Code 的 inputTokens 含缓存命中，Anthropic 风格的 input 不含）。
 * 这里必须以该字段为准；直接把驱动事件里的 `inputTokens` 当成未缓存输入写进 DSH，
 * 会让 token-meter 把缓存读取重复计入分母：缓存命中率被腰斩，上下文占用翻倍。
 */
function toDshTokenUsage(event: Extract<CodingNsAgentEvent, { type: 'usage' }>, useContextFallback = false): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalTokens?: number
} {
  // 没有缓存分桶时 `inputTokens` 本身就是全部输入，也就是未缓存输入。
  const providerInputTokens = event.uncachedInputTokens ?? event.inputTokens
  // Qoder 当前把 input/output token 桶返回为 0，但同时提供真实的上下文占用。
  // DSH token-meter 只读取标准 inputTokens 桶，因此仅在非 surface 样本中用
  // contextTokens 建立占用分子；正式 assistant usage 仍保留 Provider 原值。
  const inputTokens = useContextFallback
    && providerInputTokens === 0
    && event.outputTokens === 0
    && event.cacheReadTokens === undefined
    && event.cacheWriteTokens === undefined
    && event.contextTokens !== undefined
    ? event.contextTokens
    : providerInputTokens
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: event.outputTokens,
    ...(event.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.cacheReadTokens }),
    ...(event.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: event.cacheWriteTokens }),
    ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
  }
}

/**
 * 所有外部 Agent 共用的 DSH 消息投影器。
 *
 * 驱动只产生 CodingNsAgentEvent。本类统一完成快照去重、通道索引、工具历史、
 * 原生权限/问题交互、usage 和终态映射，调用方不再按 Provider 或消息类型分支。
 */
export class CodingNsDshMessageProjector {
  private readonly normalizer = new CodingNsAgentEventNormalizer()
  private readonly toolHistory: CodingNsDshToolHistoryProjector
  private reasoningIndex: number | undefined = 0
  private textIndex: number | undefined = 1
  private nextBlockIndex = 2
  private reasoningText = ''
  private textText = ''
  private finished = false
  /** 只要收到正文、工具、usage 或交互事件，就说明 Provider 确实产出了结果。 */
  private receivedProviderEvent = false

  constructor(private readonly options: CodingNsDshMessageProjectorOptions) {
    this.toolHistory = new CodingNsDshToolHistoryProjector(options.nativeSessions, options.sessionId, options.adapterId)
  }

  get isFinished(): boolean {
    return this.finished
  }

  async push(event: CodingNsAgentEvent): Promise<readonly CodingNsDshStreamChunk[]> {
    if (this.finished) return []
    if (event.type !== 'session-binding' && event.type !== 'finish') {
      this.receivedProviderEvent = true
    }
    if (event.type === 'usage') this.recordUsageSample(event)
    const projected: CodingNsDshStreamChunk[] = []
    for (const normalized of this.normalizer.push(event)) {
      projected.push(...await this.project(normalized))
      if (this.finished) break
    }
    return projected
  }

  /** Provider 未发送 finish 时补齐 usage 和正常终态。 */
  async complete(reason: 'stop' | 'cancel' = 'stop'): Promise<readonly CodingNsDshStreamChunk[]> {
    if (this.finished) return []
    if (reason === 'stop' && !this.receivedProviderEvent) {
      return this.fail('CODINGNS_PROVIDER_EMPTY_RESPONSE: Provider 未返回任何有效事件。')
    }
    const projected = await this.flushUsage()
    projected.push(...await this.project({ type: 'finish', reason }))
    return projected
  }

  /** 把执行异常也交给同一投影层，确保错误正文和终态结构一致。 */
  async fail(message: string, cancelled = false): Promise<readonly CodingNsDshStreamChunk[]> {
    if (this.finished) return []
    const projected = await this.flushUsage()
    const reason = cancelled ? 'cancel' : 'error'
    if (!cancelled) {
      projected.push(...await this.project({ type: 'text-delta', text: formatExecutionFailure(this.options.adapterId, message) }))
    }
    projected.push(...await this.project({ type: 'finish', reason }, message))
    return projected
  }

  private async flushUsage(): Promise<CodingNsDshStreamChunk[]> {
    const projected: CodingNsDshStreamChunk[] = []
    for (const event of this.normalizer.flush()) projected.push(...await this.project(event))
    return projected
  }

  /** Provider 的 usage 到达时立即给 token-meter 一个非 surface 采样点。
   *
   * DSH 规范要求正式 usage 仍随 assistant/message 在 finish 前结算，因此这里不
   * 提前向 LLM 流发送第二个 usage，只写入 assistant/attempt 供上下文计量投影使用。
   */
  private recordUsageSample(event: Extract<CodingNsAgentEvent, { type: 'usage' }>): void {
    // assistant/attempt 同样是 DSH 会话记录，usage 必须按 DSH 的互斥桶口径落盘。
    const usage: CodingNsNativeUsageSample = {
      ...toDshTokenUsage(event, this.options.adapterId === 'qoder' || this.options.adapterId === 'qoder-cn'),
      ...(event.cacheHitRate === undefined ? {} : { cacheHitRate: event.cacheHitRate }),
      ...(event.providerCredits === undefined ? {} : { providerCredits: event.providerCredits }),
      ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
      ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
      ...(event.contextUsageRatio === undefined ? {} : { contextUsageRatio: event.contextUsageRatio }),
    }
    if (event.contextWindow !== undefined) {
      this.options.nativeSessions?.appendRequestContext?.(this.options.sessionId, {
        provider: this.options.adapterId,
        model: this.options.modelId ?? this.options.adapterId,
        contextWindow: event.contextWindow,
        confirmed: true,
      })
    }
    this.options.nativeSessions?.appendUsageSample?.(this.options.sessionId, usage)
  }

  private async project(
    event: CodingNsNormalizedAgentEvent,
    failureMessage?: string,
  ): Promise<readonly CodingNsDshStreamChunk[]> {
    switch (event.type) {
      case 'reasoning-delta':
        if (event.text === '') return []
        return this.appendDelta('reasoning', event.text)
      case 'text-delta':
        if (event.text === '') return []
        return this.appendDelta('text', event.text)
      case 'message-boundary':
        return this.closeMessageBlock(event.channel)
      case 'step-boundary':
        // step 边界由 DSH 原生 turn/step 事件表达，不再伪造 Markdown 文本。
        // 伪造的空文本会被 Chat 渲染成额外的空白块，导致相邻 step 间距异常。
        return []
      case 'tool-event':
        return this.externalToolChunk(this.toolHistory.observe(event))
      case 'permission-request':
        await this.requestPermission(event)
        return []
      case 'question-request':
        await this.requestQuestions(event)
        return []
      case 'usage':
        return [{ type: 'usage', usage: toDshTokenUsage(event) }]
      case 'session-binding':
        return []
      case 'context-compaction':
        this.options.nativeSessions?.appendCompactionEvent?.(this.options.sessionId, {
          ...event,
          provider: event.provider ?? this.options.adapterId,
          model: event.model ?? this.options.modelId ?? this.options.adapterId,
        })
        return []
      case 'finish':
        const closed = [
          ...this.closeMessageBlock('reasoning'),
          ...this.closeMessageBlock('text'),
        ]
        this.finished = true
        const actualFailure = failureMessage ?? event.failure?.message
        this.toolHistory.finalize(event.reason, actualFailure)
        closed.push({ type: 'finish', reason: toDshFinishReason(event.reason, actualFailure, event.failure?.code) })
        return closed
      default:
        return assertNeverNormalizedEvent(event)
    }
  }

  private appendDelta(channel: 'reasoning' | 'text', text: string): readonly CodingNsDshStreamChunk[] {
    const opened = channel === 'reasoning' ? this.reasoningText === '' : this.textText === ''
    const index = this.openBlock(channel)
    if (channel === 'reasoning') this.reasoningText += text
    else this.textText += text
    const delta = { type: `${channel}-delta`, index, text }
    return opened ? [{ type: 'block-start', index, blockType: channel }, delta] : [delta]
  }

  private openBlock(channel: 'reasoning' | 'text'): number {
    const current = channel === 'reasoning' ? this.reasoningIndex : this.textIndex
    if (current !== undefined) return current
    const index = this.nextBlockIndex
    this.nextBlockIndex += 1
    if (channel === 'reasoning') this.reasoningIndex = index
    else this.textIndex = index
    return index
  }

  private closeMessageBlock(channel: 'reasoning' | 'text'): readonly CodingNsDshStreamChunk[] {
    if (channel === 'reasoning') {
      if (this.reasoningText === '') return []
      const index = this.reasoningIndex
      if (index === undefined) return []
      const chunk = { type: 'block-end', index, block: { type: 'reasoning', text: this.reasoningText } }
      this.reasoningText = ''
      this.reasoningIndex = undefined
      return [chunk]
    }
    if (this.textText === '') return []
    const index = this.textIndex
    if (index === undefined) return []
    const chunk = { type: 'block-end', index, block: { type: 'text', text: this.textText } }
    this.textText = ''
    this.textIndex = undefined
    return [chunk]
  }

  private externalToolChunk(marker: CodingNsDshExternalToolMarker | null): readonly CodingNsDshStreamChunk[] {
    if (marker === null) return []
    const index = this.nextBlockIndex
    this.nextBlockIndex += 1
    return [
      { type: 'block-start', index, blockType: 'reasoning' },
      {
        type: 'reasoning-delta',
        index,
        // 空 delta 会被 DSH 的流式聚合器丢弃，空格能保留 live-chunk 但不会显示思考正文。
        text: ' ',
        codingnsExternalTool: marker,
      },
      { type: 'block-end', index, block: { type: 'reasoning', text: ' ' } },
    ]
  }

  private async requestPermission(event: Extract<CodingNsAgentEvent, { type: 'permission-request' }>): Promise<void> {
    const responder = this.options.respondPermission
    if (responder === undefined) throw new Error('外部 Agent 发送了权限请求，但适配器没有权限回复接口')
    const outcome = await this.options.nativeSessions?.requestApproval?.(this.options.sessionId, {
      requestId: event.requestId,
      toolName: event.toolName ?? (event.kind || 'external-agent'),
      ...(event.callId ? { callId: event.callId } : {}),
      ...(event.detail ? { reason: event.detail } : {}),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    }) ?? 'unavailable'
    const approved = outcome === 'allowed-once'
    const reason = approvalReason(outcome)
    await responder({ requestId: event.requestId, approved, ...(reason === undefined ? {} : { reason }) })
  }

  private async requestQuestions(event: Extract<CodingNsAgentEvent, { type: 'question-request' }>): Promise<void> {
    const responder = this.options.respondQuestion
    if (responder === undefined) throw new Error('外部 Agent 发送了问题请求，但适配器没有问题回复接口')
    const response = await this.options.nativeSessions?.askQuestions?.(this.options.sessionId, {
      requestId: event.requestId,
      questions: event.questions,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    }) ?? null
    if (response === null) throw new Error('DSH 原生问题组件不可用或问题已取消')
    await responder(response)
  }
}

function assertNeverNormalizedEvent(value: never): never {
  throw new Error(`未支持的 DSH 事件类型: ${String((value as { readonly type?: unknown }).type ?? 'unknown')}`)
}

function toDshFinishReason(reason: 'stop' | 'cancel' | 'error', failureMessage?: string, failureCode?: string): Record<string, unknown> {
  if (reason === 'cancel') {
    return { kind: 'aborted', failure: { message: failureMessage ?? '外部 Agent 执行已取消', code: 'ABORTED' } }
  }
  if (reason === 'error') {
    return { kind: 'error', failure: { message: failureMessage ?? '外部 Agent 执行失败', code: failureCode ?? 'PROVIDER_ERROR' } }
  }
  return { kind: 'stop' }
}

function approvalReason(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'): string | undefined {
  if (outcome === 'rejected') return '用户拒绝了权限请求'
  if (outcome === 'cancelled') return '权限请求已取消'
  if (outcome === 'unavailable') return 'DSH 原生权限组件不可用'
  return undefined
}

function formatExecutionFailure(adapterId: string, message: string): string {
  const content = `[${adapterId}] ${message}`
  const fence = '~'.repeat(Math.max(3, longestCharacterRun(content, '~') + 1))
  return `\n\n**外部 Agent 执行失败**\n\n${fence}text\n${content}\n${fence}\n`
}

function longestCharacterRun(value: string, character: string): number {
  let longest = 0
  let current = 0
  for (const item of value) {
    current = item === character ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return longest
}
