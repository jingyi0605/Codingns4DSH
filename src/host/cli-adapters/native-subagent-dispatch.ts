import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { externalTeamProvider, withTeamSubagentSelection, type NativeSubagentService } from './native-team-subagent.js'

/** 同步子代理首轮的最长等待时间；桥接与 agent_subagent 共用同一预算。 */
export const NATIVE_SUBAGENT_TIMEOUT_MS = 15 * 60_000
const TURN_END_SETTLE_MS = 50
/**
 * DSH 会把 startContinuable 收到的 signal 原样转发给 Provider 的 prepareContinuable，
 * 缺省时不会补一个可用的 signal。桥接路径没有调用方 signal，必须兜底，
 * 否则 Provider 侧的 `request.signal.throwIfAborted()` 会直接抛 TypeError。
 */
const fallbackSignal = new AbortController().signal

/** DSH Agent 的最小结构：startContinuable 会读 options 与 session.header。 */
export interface NativeParentAgent {
  readonly id?: string
  readonly options?: { readonly subagentDepth?: number }
  readonly session?: { readonly header?: { readonly id?: string } }
}

export interface NativeSubagentDispatchRequest {
  readonly adapterId: string
  readonly prompt: string
  readonly parentAgent: NativeParentAgent
  readonly parentId: string
  readonly modelId?: string | undefined
  readonly background: boolean
  readonly signal?: AbortSignal | undefined
  /**
   * 创建阶段的并发策略。缺省沿用 Team 工具的单飞守卫；桥接传入排队版本，
   * 让同一个父会话的并行子代理按顺序创建而不是被直接拒绝。
   */
  readonly select?: (<T>(action: () => Promise<T>) => Promise<T>) | undefined
}

export interface NativeSubagentDispatchResult {
  readonly adapterId: string
  readonly childSessionId: string
  readonly ok: boolean
  readonly background: boolean
  readonly text: string
  readonly toolCalls: number
}

/**
 * 派发一个外部适配器子代理：startContinuable 创建原生可续子会话，
 * 非后台模式等待子会话首轮结束并回收文本与工具计数。
 */
export async function dispatchNativeSubagent(
  service: NativeSubagentService,
  sessions: CodingNsNativeSessionBridge,
  request: NativeSubagentDispatchRequest,
): Promise<NativeSubagentDispatchResult> {
  const select = request.select ?? (<T>(action: () => Promise<T>): Promise<T> =>
    withTeamSubagentSelection(request.parentId, request.adapterId, request.modelId, action))
  const started = await select(() => service.startContinuable!({
    provider: externalTeamProvider(request.adapterId),
    label: request.prompt.replace(/\s+/gu, ' ').slice(0, 120),
    request: { prompt: [{ type: 'text', text: request.prompt }], parent: request.parentAgent },
    signal: request.signal ?? fallbackSignal,
  }))
  if (request.background) {
    return {
      adapterId: request.adapterId,
      childSessionId: started.childId,
      ok: true,
      background: true,
      text: '子代理已在原生子智能体会话中启动。',
      toolCalls: 0,
    }
  }
  const result = await waitForChildFirstTurn(sessions, started.childId, request.signal)
  return {
    adapterId: request.adapterId,
    childSessionId: started.childId,
    ok: result.ok,
    background: false,
    text: result.text,
    toolCalls: result.toolCalls,
  }
}

interface ChildResult { readonly ok: boolean; readonly text: string; readonly toolCalls: number }

function waitForChildFirstTurn(sessions: CodingNsNativeSessionBridge, childId: string, signal: AbortSignal | undefined): Promise<ChildResult> {
  return new Promise((resolve) => {
    let text = ''
    let toolCalls = 0
    let done = false
    const seen = new Set<string>()
    let finishTimer: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let detach: (() => void) | undefined
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      if (finishTimer !== undefined) clearTimeout(finishTimer)
      if (timeout !== undefined) clearTimeout(timeout)
      detach?.()
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok, text, toolCalls })
    }
    const onAbort = (): void => finish(false)
    const processEvent = (event: unknown): void => {
      const row = asRecord(event)
      if (row === undefined) return
      const key = typeof row.seq === 'number' || typeof row.eventSeq === 'number' ? String(row.seq ?? row.eventSeq) : JSON.stringify(row)
      if (seen.has(key)) return
      seen.add(key)
      // DSH 的 SessionEvent 是 `{ type, seq, time, data }`：判别字段在顶层，data 只承载
      // 该类型自己的载荷。读 `data.type` 会永远匹配不到，同步等待只能等满超时。
      const type = typeof row.type === 'string' ? row.type : ''
      const data = asRecord(row.data) ?? row
      if (type === 'assistant/message') {
        const message = asRecord(data.message)
        const content = Array.isArray(message?.content) ? message.content : []
        for (const block of content) if (asRecord(block)?.type === 'text' && typeof asRecord(block)?.text === 'string') text = asRecord(block)!.text as string
      } else if (type === 'tool/result') toolCalls += 1
      else if (type === 'turn/end') finishTimer = setTimeout(() => finish(!signal?.aborted && readTurnOk(data)), TURN_END_SETTLE_MS)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    detach = sessions.subscribe({ onEvent(session, event) {
      if (asRecord(asRecord(session)?.header)?.id === childId) processEvent(event)
    } })
    const snapshot = sessions.get(childId) as { snapshotEvents?: () => readonly unknown[] } | undefined
    for (const event of snapshot?.snapshotEvents?.() ?? []) processEvent(event)
    timeout = setTimeout(() => finish(false), NATIVE_SUBAGENT_TIMEOUT_MS)
    timeout.unref?.()
  })
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function readTurnOk(value: Record<string, any>): boolean {
  const reason = asRecord(value.reason)
  return reason?.kind === undefined || reason.kind === 'completed' || reason.kind === 'stop'
}
