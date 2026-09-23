import type {
  CodingNsAgentEvent,
  CodingNsAgentQuestionResponse,
  CodingNsAgentPermissionResponse,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { CodingNsDshToolHistoryProjector } from './dsh-tool-history.js'
import {
  CodingNsAgentEventNormalizer,
  type CodingNsNormalizedAgentEvent,
} from './stream-normalizer.js'
import type { CodingNsDshExternalToolMarker } from './dsh-tool-history.js'

export interface CodingNsDshMessageProjectorOptions {
  readonly adapterId: string
  readonly sessionId: string
  readonly nativeSessions?: CodingNsNativeSessionBridge
  readonly signal?: AbortSignal
  readonly respondPermission?: (response: CodingNsAgentPermissionResponse) => Promise<void> | void
  readonly respondQuestion?: (response: CodingNsAgentQuestionResponse) => Promise<void> | void
}

/** DSH `llm/stream` 接受的最小结构；具体协议只允许在本文件构造。 */
export type CodingNsDshStreamChunk = Readonly<Record<string, unknown>>

/**
 * 所有外部 Agent 共用的 DSH 消息投影器。
 *
 * 驱动只产生 CodingNsAgentEvent。本类统一完成快照去重、通道索引、工具历史、
 * 原生权限/问题交互、usage 和终态映射，调用方不再按 Provider 或消息类型分支。
 */
export class CodingNsDshMessageProjector {
  private readonly normalizer = new CodingNsAgentEventNormalizer()
  private readonly toolHistory: CodingNsDshToolHistoryProjector
  private finished = false

  constructor(private readonly options: CodingNsDshMessageProjectorOptions) {
    this.toolHistory = new CodingNsDshToolHistoryProjector(options.nativeSessions, options.sessionId)
  }

  get isFinished(): boolean {
    return this.finished
  }

  async push(event: CodingNsAgentEvent): Promise<readonly CodingNsDshStreamChunk[]> {
    if (this.finished) return []
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
      projected.push({ type: 'text-delta', index: 1, text: formatExecutionFailure(this.options.adapterId, message) })
    }
    projected.push(...await this.project({ type: 'finish', reason }, message))
    return projected
  }

  private async flushUsage(): Promise<CodingNsDshStreamChunk[]> {
    const projected: CodingNsDshStreamChunk[] = []
    for (const event of this.normalizer.flush()) projected.push(...await this.project(event))
    return projected
  }

  private async project(
    event: CodingNsNormalizedAgentEvent,
    failureMessage?: string,
  ): Promise<readonly CodingNsDshStreamChunk[]> {
    switch (event.type) {
      case 'reasoning-delta':
        return event.text === '' ? [] : [{ type: 'reasoning-delta', index: 0, text: event.text }]
      case 'text-delta':
        return event.text === '' ? [] : [{ type: 'text-delta', index: 1, text: event.text }]
      case 'tool-event':
        return externalToolChunk(this.toolHistory.observe(event))
      case 'permission-request':
        await this.requestPermission(event)
        return []
      case 'question-request':
        await this.requestQuestions(event)
        return []
      case 'usage':
        return [{
          type: 'usage',
          usage: {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.cacheReadTokens }),
            ...(event.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: event.cacheWriteTokens }),
            ...(event.uncachedInputTokens === undefined ? {} : { uncachedInputTokens: event.uncachedInputTokens }),
            ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
            ...(event.cacheHitRate === undefined ? {} : { cacheHitRate: event.cacheHitRate }),
          },
        }]
      case 'session-binding':
        return []
      case 'finish':
        this.finished = true
        this.toolHistory.finalize(event.reason, failureMessage)
        return [{ type: 'finish', reason: toDshFinishReason(event.reason, failureMessage) }]
    }
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

/**
 * 外部工具已经由 Provider 执行，不能转成 DSH tool-call block；使用空 reasoning
 * chunk 携带私有标记，只让 Client 的实时 Conversation 投影读取，不会进入模型
 * 消息，也不会被 Agent Loop 再次执行。
 */
function externalToolChunk(marker: CodingNsDshExternalToolMarker | null): readonly CodingNsDshStreamChunk[] {
  if (marker === null) return []
  return [{
    type: 'reasoning-delta',
    index: 0,
    text: '',
    codingnsExternalTool: marker,
  }]
}

function toDshFinishReason(reason: 'stop' | 'cancel' | 'error', failureMessage?: string): Record<string, unknown> {
  if (reason === 'cancel') {
    return { kind: 'aborted', failure: { message: failureMessage ?? '外部 Agent 执行已取消', code: 'ABORTED' } }
  }
  if (reason === 'error') {
    return { kind: 'error', failure: { message: failureMessage ?? '外部 Agent 执行失败', code: 'PROVIDER_ERROR' } }
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
