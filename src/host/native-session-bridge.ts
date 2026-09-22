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

export interface CodingNsNativeSessionController {
  create?(request: { readonly sessionId?: string; readonly cwd?: string }): Promise<{ readonly sessionId: string }>
  list?(request?: unknown, signal?: AbortSignal): Promise<{ readonly items: readonly unknown[] }>
}

export interface CodingNsNativeSessionBridge {
  readonly available: boolean
  readonly store: CodingNsNativeSessionStore | undefined
  readonly controller: CodingNsNativeSessionController | undefined
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
  const store = isSessionStore(storeValue) ? storeValue : undefined
  const controller = isSessionController(controllerValue) ? controllerValue : undefined
  const on = typeof (ctx as unknown as { on?: unknown }).on === 'function'
    ? (ctx as unknown as { on(name: string, listener: (...args: unknown[]) => unknown): () => unknown }).on.bind(ctx)
    : undefined

  return {
    available: store !== undefined || controller !== undefined,
    store,
    controller,
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

function isSessionStore(value: unknown): value is CodingNsNativeSessionStore {
  return isRecord(value) && typeof value.get === 'function' && typeof value.list === 'function'
}

function isSessionController(value: unknown): value is CodingNsNativeSessionController {
  return isRecord(value) && (typeof value.create === 'function' || typeof value.list === 'function')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
