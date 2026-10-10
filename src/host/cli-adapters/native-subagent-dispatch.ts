import { DEFAULT_SUBAGENT_BRIDGE_SETTINGS } from '../../shared/contracts/config.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { externalTeamProvider, startNativeSubagent, withTeamSubagentSelection, type NativeSubagentService } from './native-team-subagent.js'

/** 同步子代理首轮的最长等待时间；后台任务不会把这个预算绑定到调用方。 */
export const NATIVE_SUBAGENT_TIMEOUT_MS = 15 * 60_000
/** 后台子代理的执行保护上限；工具调用已经立即返回，长任务只通过生命周期查询观察。 */
export const BACKGROUND_NATIVE_SUBAGENT_TIMEOUT_MS = 60 * 60_000
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
 * DSH 会把启动请求收到的 signal 原样转发给 Provider 的 prepareContinuable，
 * 缺省时不会补一个可用的 signal。桥接路径没有调用方 signal，必须兜底，
 * 否则 Provider 侧的 `request.signal.throwIfAborted()` 会直接抛 TypeError。
 */
const fallbackSignal = new AbortController().signal

/** DSH Agent 的最小结构：原生子代理启动会读 options 与 session.header。 */
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
  /**
   * 子会话起始目录。缺省时子会话继承父级当前目录；旧版本 DSH 会忽略该字段。
   * 相对路径由 DSH 相对父级当前目录解析，这里不做本地拼接。
   */
  readonly cwd?: string | undefined
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
  /** 创建成功后先进入 running；首轮终态再进入 completed/failed/interrupted。 */
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted'
  readonly background: boolean
  readonly text: string
  readonly toolCalls: number
  readonly error?: string | undefined
}

export interface NativeSubagentMessageRequest {
  readonly parentAgent: NativeParentAgent
  readonly parentId: string
  readonly childSessionId: string
  readonly message: string
  readonly signal?: AbortSignal | undefined
}

export interface NativeSubagentMessageResult {
  readonly ok: boolean
  readonly childSessionId: string
  readonly messageId?: string | undefined
  readonly error?: string | undefined
}

/** 向已创建的直接子代理发送后续消息，使用 DSH 原生 sendMessage 的父身份校验。 */
export async function sendNativeSubagentMessage(
  service: NativeSubagentService,
  request: NativeSubagentMessageRequest,
): Promise<NativeSubagentMessageResult> {
  const childSessionId = request.childSessionId.trim()
  const message = request.message.trim()
  if (childSessionId === '' || message === '') {
    return { ok: false, childSessionId, error: '子会话 ID 和消息内容不能为空。' }
  }
  if (typeof service.sendMessage !== 'function') {
    return { ok: false, childSessionId, error: '当前 DSH 未提供可续子会话 sendMessage 能力。' }
  }
  try {
    const result = await service.sendMessage(
      request.parentAgent,
      childSessionId,
      [{ type: 'text', text: message }],
      { signal: request.signal ?? fallbackSignal },
    )
    return {
      ok: true,
      childSessionId,
      ...(typeof result === 'string' && result.trim() !== '' ? { messageId: result } : {}),
    }
  } catch (error) {
    return {
      ok: false,
      childSessionId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 读取子会话当前事件游标；后续 follow-up 只消费游标之后的新一轮。 */
export function nativeSubagentEventCursor(sessions: CodingNsNativeSessionBridge, childSessionId: string): number {
  const session = sessions.get(childSessionId.trim()) as { snapshotEvents?: () => readonly unknown[] } | undefined
  let cursor = 0
  for (const event of session?.snapshotEvents?.() ?? []) {
    const row = asRecord(event)
    const seq = row?.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) cursor = Math.max(cursor, seq)
  }
  return cursor
}

/** 后续消息被 DSH 接受后，重新打开该子会话的生命周期观察窗口。 */
export function trackNativeSubagentFollowup(
  sessions: CodingNsNativeSessionBridge,
  childSessionId: string,
  afterSeq: number,
): void {
  const id = childSessionId.trim()
  const current = lifecycleStates.get(id)
  if (current === undefined || lifecycleWaiters.has(id)) return
  const lifecycle: NativeSubagentLifecycle = {
    childSessionId: current.childSessionId,
    parentSessionId: current.parentSessionId,
    adapterId: current.adapterId,
    status: 'running',
    completed: false,
    ...(current.toolCalls === undefined ? {} : { toolCalls: current.toolCalls }),
  }
  saveLifecycle(lifecycle)
  const completion = waitForChildFirstTurn(
    sessions,
    id,
    undefined,
    BACKGROUND_NATIVE_SUBAGENT_TIMEOUT_MS,
    afterSeq,
  ).then((result) => {
    saveLifecycle(lifecycleFromResult(lifecycle, result))
    return result
  })
  lifecycleWaiters.set(id, completion)
  void completion.finally(() => { lifecycleWaiters.delete(id) })
}

interface ParentTaskState {
  active: number
  targets: Set<string>
}

const parentTaskStates = new Map<string, ParentTaskState>()

export interface NativeSubagentLifecycle {
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly adapterId: string
  readonly status: 'creating' | 'running' | 'completed' | 'failed' | 'interrupted'
  readonly completed: boolean
  readonly text?: string
  readonly error?: string
  readonly toolCalls?: number
  /** failed 子代理是否已经被父 Agent 读取并复核。 */
  readonly failureReviewed?: boolean
}

const lifecycleStates = new Map<string, NativeSubagentLifecycle>()
const lifecycleWaiters = new Map<string, Promise<ChildResult>>()
const MAX_LIFECYCLE_STATES = 2048
/** 已经拦截过父会话当前轮次的结束事件，避免重复注入相同提醒。 */
const guardedParentTurns = new Set<string>()

function saveLifecycle(value: NativeSubagentLifecycle): void {
  lifecycleStates.set(value.childSessionId, value)
  while (lifecycleStates.size > MAX_LIFECYCLE_STATES) {
    const oldest = lifecycleStates.keys().next().value as string | undefined
    if (oldest === undefined) break
    lifecycleStates.delete(oldest)
  }
}

function lifecycleFromResult(
  base: NativeSubagentLifecycle,
  result: ChildResult,
): NativeSubagentLifecycle {
  return {
    ...base,
    status: result.status,
    completed: result.completed && result.status === 'completed',
    text: result.text,
    ...(result.error === undefined ? {} : { error: result.error }),
    toolCalls: result.toolCalls,
    ...(result.status === 'failed' ? { failureReviewed: false } : {}),
  }
}

export function readNativeSubagentLifecycle(childSessionId: string): NativeSubagentLifecycle | undefined {
  return lifecycleStates.get(childSessionId.trim())
}

/**
 * 标记一次 failed 子代理已经被父 Agent 查看。
 *
 * 查看本身不替父 Agent 做决定；调用方仍必须根据错误和已有报告选择重新创建、
 * 通过 send 接管，或明确结束当前任务。这里单独记录查看事实，避免父会话在没有
 * 读取失败状态时直接收尾。
 */
export function reviewNativeSubagentFailure(childSessionId: string): NativeSubagentLifecycle | undefined {
  const id = childSessionId.trim()
  const current = lifecycleStates.get(id)
  if (current === undefined || current.status !== 'failed' || current.failureReviewed === true) return current
  const reviewed: NativeSubagentLifecycle = { ...current, failureReviewed: true }
  saveLifecycle(reviewed)
  return reviewed
}

/** failed 且尚未查看的子代理必须阻塞父会话收尾。 */
export function nativeSubagentFailureNeedsReview(lifecycle: NativeSubagentLifecycle): boolean {
  return lifecycle.status === 'failed' && lifecycle.failureReviewed !== true
}

/** 给模型的失败复核提示；正常运行和成功终态不增加额外字段。 */
export function nativeSubagentFailureReviewFields(lifecycle: NativeSubagentLifecycle): Record<string, unknown> {
  if (lifecycle.status !== 'failed') return {}
  return {
    failureReviewed: lifecycle.failureReviewed === true,
    failureReviewRequired: lifecycle.failureReviewed !== true,
    failureGuidance: '请评估是否需要 action=start 重新创建子代理，或用 action=send 接管并继续；确认无需继续后才能结束主任务。',
  }
}

export interface NativeSubagentParentBarrier {
  readonly parentSessionId: string
  readonly blocked: boolean
  readonly pending: readonly NativeSubagentLifecycle[]
  readonly activeCount: number
  readonly injected: boolean
}

/** 读取父会话下仍未完成或尚未复核失败的子代理。 */
export function readNativeSubagentParentPending(parentSessionId: string): readonly NativeSubagentLifecycle[] {
  const id = parentSessionId.trim()
  if (id === '') return []
  return [...lifecycleStates.values()]
    .filter((state) => state.parentSessionId === id && (state.status === 'creating' || state.status === 'running' || nativeSubagentFailureNeedsReview(state)))
}

/**
 * 父会话 turn/end 前的收尾屏障。
 *
 * DSH 没有可取消的原生 turn/end 事件，最安全的做法是在检测到仍有后台子代理
 * 时注入下一步用户上下文，让父 Agent 继续等待并汇总。注入成功后同一父轮次不
 * 再重复注入；下一次 turn/start 会由 `markNativeSubagentParentTurnStarted` 解锁。
 */
export function guardNativeSubagentParentTurn(
  sessions: CodingNsNativeSessionBridge,
  parentSessionId: string,
): NativeSubagentParentBarrier {
  const id = parentSessionId.trim()
  const pending = readNativeSubagentParentPending(id)
  const activeCount = Math.max(parentTaskStates.get(id)?.active ?? 0, pending.length)
  if (id === '' || activeCount === 0) {
    guardedParentTurns.delete(id)
    return { parentSessionId: id, blocked: false, pending, activeCount: 0, injected: false }
  }
  if (guardedParentTurns.has(id)) {
    return { parentSessionId: id, blocked: true, pending, activeCount, injected: false }
  }
  const childIds = pending.map((state) => `${state.childSessionId}(${state.status})`).join(', ')
  const hasFailed = pending.some((state) => nativeSubagentFailureNeedsReview(state))
  const summary = hasFailed
    ? `存在 failed 子代理，主任务暂不能收尾。请先使用 agent_subagent 的 action=read/wait 查看失败原因和已有报告，再评估是否需要 action=start 重新创建，或 action=send 接管继续；确认无需继续后才能汇总报告：${childIds}。`
    : `子代理尚未结束，主任务暂不能收尾。请先使用 agent_subagent 的 action=wait/read 检查：${childIds || `${String(activeCount)} 个子代理正在创建`}。所有子代理进入终态后再汇总报告。`
  const injected = sessions.injectNextStep?.(id, summary) === true
  if (injected) guardedParentTurns.add(id)
  return { parentSessionId: id, blocked: true, pending, activeCount, injected }
}

/** 父会话真正开始下一轮后清除上一轮的收尾屏障。 */
export function markNativeSubagentParentTurnStarted(parentSessionId: string): void {
  const id = parentSessionId.trim()
  if (id !== '') guardedParentTurns.delete(id)
}

/** 等待后台子会话进入终态；进程重启后只能返回已持有的最后状态。 */
export async function waitNativeSubagentLifecycle(
  childSessionId: string,
  timeoutMs = NATIVE_SUBAGENT_TIMEOUT_MS,
): Promise<NativeSubagentLifecycle | undefined> {
  const id = childSessionId.trim()
  if (id === '') return undefined
  const current = lifecycleStates.get(id)
  if (current === undefined) return undefined
  if (current.status !== 'running' && current.status !== 'creating') return current
  const pending = lifecycleWaiters.get(id)
  if (pending === undefined) return current
  const bounded = Math.max(1, Math.min(Math.floor(timeoutMs), NATIVE_SUBAGENT_TIMEOUT_MS))
  await Promise.race([
    pending,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, bounded)
      timer.unref?.()
    }),
  ])
  return lifecycleStates.get(id) ?? current
}

/**
 * 派发一个目标适配器子代理：`startNativeSubagent` 创建原生子会话，
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
    const agentOptions = request.adapterId === 'dsh' && request.modelId !== undefined && request.modelId !== 'provider-default'
      ? { model: request.modelId }
      : undefined
    const started = await select(() => startNativeSubagent(service, {
      provider: externalTeamProvider(request.adapterId),
      label: request.prompt.replace(/\s+/gu, ' ').slice(0, 120),
      request: {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: request.parentAgent,
        // 目标目录只在调用方显式给出时下发；旧版本 DSH 会忽略该字段。
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        // DSH 内置 spawn Provider 支持 agentOptions；外部 CLI Provider 不支持，
        // 所以只有 dsh 目标才把二级选择器的模型下发到原生子 Agent。
        ...(agentOptions === undefined ? {} : { agentOptions }),
      },
      signal: request.signal ?? fallbackSignal,
    }))
    startedChildId = started.childId
    const lifecycle: NativeSubagentLifecycle = {
      childSessionId: started.childId,
      parentSessionId: request.parentId,
      adapterId: request.adapterId,
      status: 'running',
      completed: false,
    }
    saveLifecycle(lifecycle)
    const completion = waitForChildFirstTurn(
      sessions,
      started.childId,
      request.background ? undefined : request.signal,
      request.background ? BACKGROUND_NATIVE_SUBAGENT_TIMEOUT_MS : NATIVE_SUBAGENT_TIMEOUT_MS,
    ).then((result) => {
      saveLifecycle(lifecycleFromResult(lifecycle, result))
      return result
    })
    lifecycleWaiters.set(started.childId, completion)
    if (request.background) {
      // 后台派发只提前返回“已启动”，额度仍占用到首个 turn/end，防止父会话不断重复派发。
      void completion.finally(() => {
        lifecycleWaiters.delete(started.childId!)
        release()
      })
      return {
        adapterId: request.adapterId,
        childSessionId: started.childId,
        ok: true,
        completed: false,
        status: 'running',
        background: true,
        text: '子代理已启动，等待首轮 turn/end。',
        toolCalls: 0,
      }
    }
    const result = await completion
    lifecycleWaiters.delete(started.childId)
    release()
    return {
      adapterId: request.adapterId,
      childSessionId: started.childId,
      ok: result.ok,
      completed: result.completed,
      status: result.status,
      background: false,
      text: result.text,
      toolCalls: result.toolCalls,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  } catch (error) {
    release()
    const message = error instanceof Error ? error.message : String(error)
    if (startedChildId !== undefined) {
      const current = lifecycleStates.get(startedChildId)
      if (current !== undefined) saveLifecycle({ ...current, status: 'failed', completed: false, error: message, failureReviewed: false })
    }
    throw new Error(startedChildId === undefined ? message : `子代理 ${startedChildId} 派发失败：${message}`)
  }
}

interface ChildResult {
  readonly ok: boolean
  readonly completed: boolean
  readonly status: 'completed' | 'failed' | 'interrupted'
  readonly text: string
  readonly toolCalls: number
  readonly error?: string | undefined
}

function waitForChildFirstTurn(
  sessions: CodingNsNativeSessionBridge,
  childId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  afterSeq = 0,
): Promise<ChildResult> {
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
      const status = signal?.aborted || error === '子代理请求已取消。' ? 'interrupted' : ok && completed ? 'completed' : 'failed'
      resolve({ ok, completed, status, text: output, toolCalls, ...(readableError === undefined ? {} : { error: readableError }) })
    }
    const onAbort = (): void => finish(false, false, '子代理请求已取消。')
    const processEvent = (event: unknown): void => {
      const row = asRecord(event)
      if (row === undefined) return
      if (typeof row.seq === 'number' && row.seq <= afterSeq) return
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
    timeout = setTimeout(() => finish(false, false, `子代理首轮在 ${String(Math.round(timeoutMs / 60_000))} 分钟内未收到 turn/end。`), timeoutMs)
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
  const files = [...prompt.matchAll(/[^\s"'`，。！？；：、:（）()<>《》「」【】]+?\.(?:md|markdown|txt|json|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|css|html|vue|svelte|csv|xlsx?)(?=$|[\s"'`，。！？；：、:（）()<>《》「」【】])/giu)]
    .map((match) => normalizeTargetFile(match[0]!))
    // AGENTS.md/README.md 是任务上下文，不是目标文件。多个并行任务都会引用
    // 它们；把这些公共说明文件拿来去重会把完全不同的任务误判成重复。
    .filter((file) => !['agents.md', 'readme.md', 'readme.en.md'].includes(file.toLocaleLowerCase()))
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
