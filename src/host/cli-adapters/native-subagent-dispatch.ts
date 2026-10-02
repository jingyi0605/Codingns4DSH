import { DEFAULT_SUBAGENT_BRIDGE_SETTINGS } from '../../shared/contracts/config.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { externalTeamProvider, withTeamSubagentSelection, type NativeSubagentService } from './native-team-subagent.js'

/** 同步子代理首轮的最长等待时间；桥接与 agent_subagent 共用同一预算。 */
export const NATIVE_SUBAGENT_TIMEOUT_MS = 15 * 60_000
/**
 * 同一父会话可同时保留的子代理任务数缺省值。
 *
 * 外部 CLI（如 Command Code）会在一批里并发开出远超上限的子代理调用；这个上限
 * 过去硬编码为 5，超限调用直接失败并静默回退到 CLI 内建子代理，父会话与界面都
 * 看不出差异。现在由设置 `subagentBridge.maxConcurrentSubagents` 覆盖，缺省与
 * DSH 自身的 `maxActiveSubagents`（8）对齐。
 */
export const MAX_NATIVE_SUBAGENTS_PER_PARENT = DEFAULT_SUBAGENT_BRIDGE_SETTINGS.maxConcurrentSubagents
const TURN_END_SETTLE_MS = 50

let maxNativeSubagentsPerParent = MAX_NATIVE_SUBAGENTS_PER_PARENT

/**
 * 更新同一父会话的并发子代理上限。
 *
 * 设置值缺失、越界或非有限时回落到缺省值：把上限写成 0 或 NaN 会让派发彻底
 * 锁死，这比沿用缺省值危险得多。
 */
export function setMaxNativeSubagentsPerParent(value: number | undefined): void {
  maxNativeSubagentsPerParent = typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : MAX_NATIVE_SUBAGENTS_PER_PARENT
}

export function getMaxNativeSubagentsPerParent(): number {
  return maxNativeSubagentsPerParent
}

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
  /** 只有收到子会话 `turn/end` 才为 true。 */
  readonly completed: boolean
  readonly background: boolean
  readonly text: string
  readonly toolCalls: number
  readonly error?: string | undefined
}

interface ParentTaskState {
  active: number
  targets: Set<string>
}

const parentTaskStates = new Map<string, ParentTaskState>()

/**
 * 派发一个外部适配器子代理：startContinuable 创建原生可续子会话，
 * 非后台模式等待子会话首轮结束并回收文本与工具计数。
 */
export async function dispatchNativeSubagent(
  service: NativeSubagentService,
  sessions: CodingNsNativeSessionBridge,
  request: NativeSubagentDispatchRequest,
): Promise<NativeSubagentDispatchResult> {
  const taskKey = nativeSubagentTaskKey(request.prompt)
  reserveParentTask(request.parentId, taskKey)
  let startedChildId: string | undefined
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    releaseParentTask(request.parentId, taskKey)
  }
  const select = request.select ?? (<T>(action: () => Promise<T>): Promise<T> =>
    withTeamSubagentSelection(request.parentId, request.adapterId, request.modelId, action))
  try {
    const started = await select(() => service.startContinuable!({
      provider: externalTeamProvider(request.adapterId),
      label: request.prompt.replace(/\s+/gu, ' ').slice(0, 120),
      request: { prompt: [{ type: 'text', text: request.prompt }], parent: request.parentAgent },
      signal: request.signal ?? fallbackSignal,
    }))
    startedChildId = started.childId
    if (request.background) {
      // 后台派发只提前返回“已启动”，额度仍占用到首个 turn/end，防止父会话不断重复派发。
      void waitForChildFirstTurn(sessions, started.childId, undefined).finally(release)
      return {
        adapterId: request.adapterId,
        childSessionId: started.childId,
        ok: true,
        completed: false,
        background: true,
        text: '子代理已启动，等待首轮 turn/end。',
        toolCalls: 0,
      }
    }
    const result = await waitForChildFirstTurn(sessions, started.childId, request.signal)
    release()
    return {
      adapterId: request.adapterId,
      childSessionId: started.childId,
      ok: result.ok,
      completed: result.completed,
      background: false,
      text: result.text,
      toolCalls: result.toolCalls,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  } catch (error) {
    release()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(startedChildId === undefined ? message : `子代理 ${startedChildId} 派发失败：${message}`)
  }
}

interface ChildResult {
  readonly ok: boolean
  readonly completed: boolean
  readonly text: string
  readonly toolCalls: number
  readonly error?: string | undefined
}

function waitForChildFirstTurn(sessions: CodingNsNativeSessionBridge, childId: string, signal: AbortSignal | undefined): Promise<ChildResult> {
  return new Promise((resolve) => {
    let text = ''
    let toolCalls = 0
    let done = false
    const seen = new Set<string>()
    let finishTimer: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let detach: (() => void) | undefined
    const finish = (ok: boolean, completed: boolean, error?: string): void => {
      if (done) return
      done = true
      if (finishTimer !== undefined) clearTimeout(finishTimer)
      if (timeout !== undefined) clearTimeout(timeout)
      detach?.()
      signal?.removeEventListener('abort', onAbort)
      const readableError = error?.trim() || (ok ? undefined : '子代理未能完成首轮，且未提供错误原因。')
      const output = text.trim() !== '' ? text : (readableError ?? '子代理已完成，但没有文本输出。')
      resolve({ ok, completed, text: output, toolCalls, ...(readableError === undefined ? {} : { error: readableError }) })
    }
    const onAbort = (): void => finish(false, false, '子代理请求已取消。')
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
      else if (type === 'turn/end') {
        const outcome = readTurnOutcome(data)
        finishTimer = setTimeout(() => finish(!signal?.aborted && outcome.ok, true, signal?.aborted ? '子代理请求已取消。' : outcome.error), TURN_END_SETTLE_MS)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    detach = sessions.subscribe({ onEvent(session, event) {
      if (asRecord(asRecord(session)?.header)?.id === childId) processEvent(event)
    } })
    const snapshot = sessions.get(childId) as { snapshotEvents?: () => readonly unknown[] } | undefined
    for (const event of snapshot?.snapshotEvents?.() ?? []) processEvent(event)
    timeout = setTimeout(() => finish(false, false, `子代理首轮在 ${String(Math.round(NATIVE_SUBAGENT_TIMEOUT_MS / 60_000))} 分钟内未收到 turn/end。`), NATIVE_SUBAGENT_TIMEOUT_MS)
    timeout.unref?.()
  })
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function readTurnOutcome(value: Record<string, any>): { ok: boolean; error?: string } {
  const reason = asRecord(value.reason)
  const kind = typeof reason?.kind === 'string' ? reason.kind : undefined
  if (kind === undefined || kind === 'completed' || kind === 'stop') return { ok: true }
  const error = readErrorText(reason?.error) ?? readErrorText(reason?.failure) ?? readErrorText(reason?.message)
    ?? readErrorText(value.error) ?? readErrorText(value.failure) ?? readErrorText(value.message)
  return { ok: false, error: error ?? `子代理首轮以 ${kind} 结束。` }
}

function readErrorText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  const row = asRecord(value)
  if (row === undefined) return undefined
  for (const key of ['message', 'detail', 'reason', 'error']) {
    const text = readErrorText(row[key])
    if (text !== undefined) return text
  }
  return undefined
}

/** 从任务提示中提取目标文件；没有文件时用规范化提示词作为去重键。 */
export function nativeSubagentTaskKey(prompt: string): string {
  const files = [...prompt.matchAll(/[^\s"'`，。！？；：:（）()<>《》「」【】]+?\.(?:md|markdown|txt|json|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|css|html|vue|svelte|csv|xlsx?)(?=$|[\s"'`，。！？；：:（）()<>《》「」【】])/giu)]
    .map((match) => normalizeTargetFile(match[0]!))
    .filter((file) => file !== '')
  const uniqueFiles = [...new Set(files)].sort()
  if (uniqueFiles.length > 0) return `file:${uniqueFiles.join('|').toLocaleLowerCase()}`
  return `prompt:${prompt.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()}`
}

function normalizeTargetFile(value: string): string {
  let file = value.replace(/^[`"'「」【】(<]+|[`"'「」】)>，。！？；；:：]+$/gu, '')
  // 中文任务经常把“创建/写入/修改”等动词直接粘在文件名之前；去掉这些前缀，
  // 才能让“创建笑话02.md”和“请写入笑话02.md”命中同一个目标。
  file = file.replace(/^(?:请)?(?:创建|新建|写入|修改|编辑|更新|生成|处理|检查|读取|查看|目标文件|文件|关于)\s*/u, '')
  return file
}

function reserveParentTask(parentId: string, taskKey: string): void {
  const state = parentTaskStates.get(parentId) ?? { active: 0, targets: new Set<string>() }
  if (state.targets.has(taskKey)) throw new Error(`同一父会话已在处理相同目标：${taskKey.replace(/^file:/u, '')}`)
  const limit = getMaxNativeSubagentsPerParent()
  if (state.active >= limit) throw new Error(`同一父会话最多同时运行 ${String(limit)} 个子代理，请等待已有任务收到 turn/end，或在「外部 Agent 集成」里调高「并发子代理上限」。`)
  state.active += 1
  state.targets.add(taskKey)
  parentTaskStates.set(parentId, state)
}

function releaseParentTask(parentId: string, taskKey: string): void {
  const state = parentTaskStates.get(parentId)
  if (state === undefined) return
  state.active = Math.max(0, state.active - 1)
  state.targets.delete(taskKey)
  if (state.active === 0) parentTaskStates.delete(parentId)
}
