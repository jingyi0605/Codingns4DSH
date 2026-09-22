import type { Context } from '@deepseek-ai/cordis'

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
