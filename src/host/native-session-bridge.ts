import type { Context } from '@deepseek-ai/cordis'
import type {
  CodingNsAgentQuestion,
  CodingNsAgentQuestionResponse,
} from '../shared/contracts/cli-adapter.js'

/**
 * DSH Host 原生会话服务的最小运行时面。
 *
 * 这里故意不直接依赖 dsh-session 或 dsh-api-session-controller：插件的
 * package.json 只锁定 DSH 兼容版本，某些精简 Host 可能没有装载完整会话服务。
 * 运行时探测可以让这类 Host 继续使用 CodingNS，而完整 DSH 则优先走原生 API。
 */
export interface CodingNsNativeSessionStore {
  get(sessionId: string): unknown
  list(): readonly unknown[]
  flush?(session: unknown): Promise<boolean> | Promise<void> | boolean | void
}

/** 公共 CLI 投影层写入 DSH 的工具调用，不包含任何 Provider 私有字段。 */
export interface CodingNsNativeToolCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

/** 一次工具调用在 DSH Session 中的稳定位置。 */
export interface CodingNsNativeToolCallHandle {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly callSeq: number
}

/** 公共 CLI 投影层写入 DSH 的工具结果。 */
export interface CodingNsNativeToolResult {
  readonly output: string
  readonly isError: boolean
  readonly error?: string
  readonly meta?: unknown
}

/** 外部 Agent 工具在 DSH Session 中的只读时间线标记。 */
export interface CodingNsNativeExternalToolEvent {
  readonly phase: 'start' | 'update'
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly output?: string
  readonly error?: string
}

export type CodingNsNativeApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 公共消息投影层交给 DSH 原生权限服务的请求。 */
export interface CodingNsNativeApprovalRequest {
  readonly requestId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** 公共消息投影层交给 DSH 原生问题服务的请求。 */
export interface CodingNsNativeQuestionRequest {
  readonly requestId: string
  readonly questions: readonly CodingNsAgentQuestion[]
  readonly signal?: AbortSignal
}

export interface CodingNsNativeSessionController {
  create?(request: { readonly sessionId?: string; readonly cwd?: string }): Promise<{ readonly sessionId: string }>
  list?(request?: unknown, signal?: AbortSignal): Promise<{ readonly items: readonly unknown[] }>
}

/** DSH 工作区控制器负责改变原生侧栏中的会话可见性。 */
export interface CodingNsNativeWorkspaceController {
  archiveSession?(request: { readonly sessionId: string }): Promise<unknown> | unknown
  unarchiveSession?(request: { readonly sessionId: string }): Promise<unknown> | unknown
}

export interface CodingNsNativeSessionBridge {
  readonly available: boolean
  /** 当前 Host 是否提供可接收 Session 事件的事件总线。 */
  readonly supportsEvents: boolean
  readonly store: CodingNsNativeSessionStore | undefined
  readonly controller: CodingNsNativeSessionController | undefined
  readonly workspaceController?: CodingNsNativeWorkspaceController
  /** 获取已经进入 DSH 原生 SessionStore 的会话。 */
  get(sessionId: string): unknown | undefined
  /** 获取当前 Host 已装载的原生会话；失败时返回空数组。 */
  list(): readonly unknown[]
  /** 调用 DSH 原生 session/list；无 Controller 时回退到本地 SessionStore。 */
  listRemote(signal?: AbortSignal): Promise<readonly unknown[]>
  /** 创建或采用一个 DSH 原生会话。 */
  ensure(sessionId: string, cwd?: string): Promise<string | null>
  /** 等待 DSH 原生持久化监听器完成当前会话的检查点。 */
  flush(sessionId: string): Promise<void>
  /**
   * 只追加已由外部 Agent 执行的工具历史，不经过 DSH Agent Loop。
   * 返回 null 表示会话或活动 step 不可用，调用方应安静降级。
   */
  appendToolCall?(sessionId: string, call: CodingNsNativeToolCall): CodingNsNativeToolCallHandle | null
  /** 追加与 appendToolCall 配对的只读结果；不会再次执行工具。 */
  appendToolResult?(handle: CodingNsNativeToolCallHandle, result: CodingNsNativeToolResult): boolean
  /** 追加不进入模型消息面的外部工具时间线标记。 */
  appendExternalToolEvent?(sessionId: string, event: CodingNsNativeExternalToolEvent): boolean
  /** 使用 DSH 原生 approval 组件请求一次权限决定；服务不可用时拒绝。 */
  requestApproval?(sessionId: string, request: CodingNsNativeApprovalRequest): Promise<CodingNsNativeApprovalOutcome>
  /** 使用 DSH 原生 userQuestions 组件提问；服务不可用或取消时返回 null。 */
  askQuestions?(sessionId: string, request: CodingNsNativeQuestionRequest): Promise<CodingNsAgentQuestionResponse | null>
  /** 从 DSH 原生侧栏归档会话；控制器不可用时返回 false。 */
  archive?(sessionId: string): Promise<boolean>
  /** 恢复 DSH 原生侧栏中的归档会话；控制器不可用时返回 false。 */
  unarchive?(sessionId: string): Promise<boolean>
  /** 订阅 DSH 的原生事件流；返回值用于在功能停用时移除监听器。 */
  subscribe(handlers: {
    readonly onEvent?: (session: unknown, event: unknown) => void
    readonly onFlush?: (session: unknown) => void | Promise<void>
  }): () => void
}

export function createCodingNsNativeSessionBridge(ctx: Context): CodingNsNativeSessionBridge {
  // Cordis Context 是运行时代理，直接读取未在 inject 中声明的可选服务会抛错。
  // get() 专门用于无强制依赖的服务探测，精简 Host 缺少服务时会返回 undefined。
  const storeValue: unknown = ctx.get('sessions')
  const controllerValue: unknown = ctx.get('sessionController')
  const workspaceControllerValue: unknown = ctx.get('workspaceController')
  const store = isSessionStore(storeValue) ? storeValue : undefined
  const controller = isSessionController(controllerValue) ? controllerValue : undefined
  const workspaceController = isWorkspaceController(workspaceControllerValue) ? workspaceControllerValue : undefined
  const currentWorkspaceController = (): CodingNsNativeWorkspaceController | undefined => {
    const value: unknown = ctx.get('workspaceController')
    return isWorkspaceController(value) ? value : undefined
  }
  const on = typeof (ctx as unknown as { on?: unknown }).on === 'function'
    ? (ctx as unknown as { on(name: string, listener: (...args: unknown[]) => unknown): () => unknown }).on.bind(ctx)
    : undefined

  return {
    get available() {
      return store !== undefined || controller !== undefined || currentWorkspaceController() !== undefined
    },
    supportsEvents: on !== undefined,
    store,
    controller,
    ...(workspaceController === undefined ? {} : { workspaceController }),
    get(sessionId) {
      return store?.get(sessionId)
    },
    list() {
      try { return store?.list() ?? [] } catch { return [] }
    },
    async listRemote(signal) {
      if (controller?.list !== undefined) {
        try { return (await controller.list({}, signal)).items } catch { return [] }
      }
      return this.list()
    },
    async ensure(sessionId, cwd) {
      if (sessionId.trim() === '') return null
      if (store?.get(sessionId) !== undefined) return sessionId
      if (controller?.create !== undefined) {
        const created = await controller.create({ sessionId, ...(cwd ? { cwd } : {}) })
        return typeof created.sessionId === 'string' && created.sessionId.trim() ? created.sessionId : sessionId
      }
      // 不调用裸 SessionStore.create()：它把会话绑定到插件 Fiber，停用插件
      // 时会被移除，无法满足长期会话和原生侧栏持久化要求。
      return null
    },
    async flush(sessionId) {
      const session = store?.get(sessionId)
      if (session === undefined || store?.flush === undefined) return
      await store.flush(session)
    },
    appendToolCall(sessionId, call) {
      const session = appendableSession(store?.get(sessionId))
      const position = session === null ? null : activeStep(session)
      if (session === null || position === null) return null
      const event = session.append('tool/call', {
        turn: position.turn,
        step: position.step,
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      })
      const callSeq = eventSeq(event)
      if (callSeq === null) return null
      return { sessionId, ...position, callId: call.callId, callSeq }
    },
    appendToolResult(handle, result) {
      const session = appendableSession(store?.get(handle.sessionId))
      if (session === null) return false
      const error = result.error?.trim()
      session.append('tool/result', {
        turn: handle.turn,
        step: handle.step,
        message: {
          id: `${handle.callId}-result-${handle.turn}-${handle.step}`,
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: handle.callId,
            content: [{ type: 'text', text: result.output }],
            ...(result.isError ? { isError: true } : {}),
          }],
          source: { kind: 'tool', callId: handle.callId },
        },
        ...(result.isError
          ? { error: { name: 'ExternalToolError', code: 'EXTERNAL_TOOL_FAILED', ...(error ? { reason: error } : {}) } }
          : {}),
        ...(result.meta === undefined ? {} : { meta: result.meta }),
      }, {
        surfaceOp: 'append',
        sourceEventSeqs: [handle.callSeq],
      })
      return true
    },
    appendExternalToolEvent(sessionId, externalTool) {
      const session = appendableSession(store?.get(sessionId))
      const position = session === null ? null : activeStep(session)
      if (session === null || position === null) return false
      try {
        // assistant/attempt 是 DSH 已定义的非消息事件，不会进入模型上下文或原生工具执行器。
        // 额外字段由 Session 原样持久化，客户端 Definition 只把它当作 CodingNS 展示标记。
        session.append('assistant/attempt', {
          ...position,
          stream: [],
          codingnsExternalTool: {
            source: 'codingns-external-tool',
            ...externalTool,
          },
        })
        return true
      } catch {
        return false
      }
    },
    async requestApproval(sessionId, request) {
      const agent = nativeAgent(ctx, sessionId)
      const approval = nativeApproval(ctx)
      if (agent === null || approval === null) return 'unavailable'
      try {
        const outcome = await approval.request({
          agent,
          toolName: request.toolName,
          ...(request.callId ? { callId: request.callId } : {}),
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        return isApprovalOutcome(outcome) ? outcome : 'unavailable'
      } catch {
        return request.signal?.aborted ? 'cancelled' : 'unavailable'
      }
    },
    async askQuestions(sessionId, request) {
      const agent = nativeAgent(ctx, sessionId)
      const userQuestions = nativeUserQuestions(ctx)
      if (agent === null || userQuestions === null) return null
      try {
        const answer = await userQuestions.ask({
          agent,
          questions: request.questions,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        if (!isQuestionAnswer(answer)) return null
        return { requestId: request.requestId, answers: answer.answers }
      } catch {
        return null
      }
    },
    async archive(sessionId) {
      const current = currentWorkspaceController()
      if (sessionId.trim() === '' || current?.archiveSession === undefined) return false
      await current.archiveSession({ sessionId })
      return true
    },
    async unarchive(sessionId) {
      const current = currentWorkspaceController()
      if (sessionId.trim() === '' || current?.unarchiveSession === undefined) return false
      await current.unarchiveSession({ sessionId })
      return true
    },
    subscribe(handlers) {
      const disposers: Array<() => unknown> = []
      if (on !== undefined && handlers.onEvent !== undefined) {
        disposers.push(on('session/event', (session: unknown, event: unknown) => handlers.onEvent?.(session, event)))
      }
      if (on !== undefined && handlers.onFlush !== undefined) {
        disposers.push(on('session/flush', (session: unknown) => handlers.onFlush?.(session)))
      }
      return () => { for (const dispose of disposers) dispose() }
    },
  }
}

interface AppendableSession {
  snapshotEvents(): readonly unknown[]
  append(type: string, data: unknown, options?: unknown): unknown
}

interface NativeAgentRegistry {
  get(sessionId: string): unknown
}

interface NativeApprovalService {
  request(request: Record<string, unknown>): Promise<unknown>
}

interface NativeUserQuestionService {
  ask(request: Record<string, unknown>): Promise<unknown>
}

function appendableSession(value: unknown): AppendableSession | null {
  if (!isRecord(value)) return null
  if (typeof value.snapshotEvents !== 'function' || typeof value.append !== 'function') return null
  return value as unknown as AppendableSession
}

function activeStep(session: AppendableSession): { turn: number; step: number } | null {
  let events: readonly unknown[]
  try { events = session.snapshotEvents() } catch { return null }
  const closed = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]
    const event: Record<string, unknown> | null = isRecord(candidate) ? candidate : null
    const data = isRecord(event?.data) ? event.data : null
    const turn = finiteInteger(data?.turn)
    const step = finiteInteger(data?.step)
    if (turn === null || step === null) continue
    const key = `${turn}:${step}`
    if (event?.type === 'step/end') closed.add(key)
    if (event?.type === 'step/start' && !closed.has(key)) return { turn, step }
  }
  return null
}

function eventSeq(value: unknown): number | null {
  return isRecord(value) ? finiteInteger(value.seq) : null
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isSessionStore(value: unknown): value is CodingNsNativeSessionStore {
  return isRecord(value) && typeof value.get === 'function' && typeof value.list === 'function'
}

function isSessionController(value: unknown): value is CodingNsNativeSessionController {
  return isRecord(value) && (typeof value.create === 'function' || typeof value.list === 'function')
}

function isWorkspaceController(value: unknown): value is CodingNsNativeWorkspaceController {
  return isRecord(value) && (typeof value.archiveSession === 'function' || typeof value.unarchiveSession === 'function')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nativeAgent(ctx: Context, sessionId: string): unknown | null {
  const value: unknown = ctx.get('agents')
  if (!isRecord(value) || typeof value.get !== 'function') return null
  try { return (value as unknown as NativeAgentRegistry).get(sessionId) ?? null } catch { return null }
}

function nativeApproval(ctx: Context): NativeApprovalService | null {
  const value: unknown = ctx.get('approval')
  return isRecord(value) && typeof value.request === 'function' ? value as unknown as NativeApprovalService : null
}

function nativeUserQuestions(ctx: Context): NativeUserQuestionService | null {
  const value: unknown = ctx.get('userQuestions')
  return isRecord(value) && typeof value.ask === 'function' ? value as unknown as NativeUserQuestionService : null
}

function isApprovalOutcome(value: unknown): value is CodingNsNativeApprovalOutcome {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}

function isQuestionAnswer(value: unknown): value is Omit<CodingNsAgentQuestionResponse, 'requestId'> {
  if (!isRecord(value) || !Array.isArray(value.answers)) return false
  return value.answers.every((answer) => isRecord(answer)
    && typeof answer.id === 'string'
    && Array.isArray(answer.selected)
    && answer.selected.every((item) => typeof item === 'string')
    && (answer.custom === undefined || typeof answer.custom === 'string'))
}
