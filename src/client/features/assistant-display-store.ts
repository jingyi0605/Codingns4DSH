import type { AssistantChatRun, AssistantDebugSnapshot, AssistantLifecycleSnapshot } from '../../shared/contracts/assistant.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './types.js'

export interface AssistantStatusSnapshot {
  readonly revision: number
  readonly capturedAt: number | null
  readonly indexState: AssistantDebugSnapshot['indexState']
  readonly indexedAt: number | null
  readonly workspaces: AssistantDebugSnapshot['workspaces']
}
interface DisplaySnapshot<T> { readonly value?: T; readonly error?: unknown }
interface RefreshOptions { readonly force?: boolean; readonly afterPending?: boolean; readonly maxAgeMs?: number }

/** 展示专用快照：按完成时间串行调度，隐藏暂停；绝不承载通话心跳或后台租约。 */
export class AssistantDisplayResource<T> {
  private snapshot: DisplaySnapshot<T> = {}
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<T | undefined> | undefined
  private queued: Promise<T | undefined> | undefined
  private controller: AbortController | undefined
  private failures = 0
  private updatedAt = 0
  private forceNext = false
  private generation = 0
  private readonly dom: Document | undefined

  constructor(private readonly read: (signal: AbortSignal, force: boolean) => Promise<T>,
    private readonly interval: (value: T | undefined) => number,
    dom?: Document) { this.dom = dom ?? (typeof document === 'undefined' ? undefined : document) }

  readonly getSnapshot = (): DisplaySnapshot<T> => this.snapshot
  get observed(): boolean { return this.listeners.size > 0 }
  get active(): boolean { return this.observed || this.pending !== undefined }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) { this.dom?.addEventListener('visibilitychange', this.visible); this.visible() }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size !== 0) return
      this.generation++; this.forceNext = false
      clearTimeout(this.timer); this.controller?.abort()
      this.dom?.removeEventListener('visibilitychange', this.visible)
    }
  }
  private readonly visible = (): void => {
    clearTimeout(this.timer)
    if (this.dom?.visibilityState === 'hidden') { this.controller?.abort(); return }
    void this.refresh({ afterPending: this.controller?.signal.aborted === true })
  }
  refresh(options: RefreshOptions = {}): Promise<T | undefined> {
    this.forceNext ||= options.force === true
    if (this.dom?.visibilityState === 'hidden') return Promise.resolve(this.snapshot.value)
    if (this.pending) {
      if (options.afterPending || options.force) {
        const generation = this.generation
        this.queued ??= this.pending.then(() => { this.queued = undefined; return generation === this.generation ? this.refresh() : this.snapshot.value })
        return this.queued
      }
      return this.pending
    }
    if (!this.forceNext && options.maxAgeMs && this.snapshot.error === undefined && this.snapshot.value !== undefined && Date.now() - this.updatedAt < options.maxAgeMs) return Promise.resolve(this.snapshot.value)
    clearTimeout(this.timer)
    const controller = new AbortController(); this.controller = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
    const force = this.forceNext; this.forceNext = false
    // 即便旧 Host 忽略 signal，也不让迟到快照写回已经隐藏或解绑的界面。
    this.pending = abortable(() => this.read(signal, force), signal).then((value) => {
      signal.throwIfAborted()
      this.failures = 0; this.updatedAt = Date.now(); this.snapshot = { value }; this.emit()
      return value
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) { this.failures++; this.snapshot = { ...this.snapshot, error }; this.emit() }
      return undefined
    }).finally(() => {
      this.pending = undefined
      if (!this.listeners.size || this.dom?.visibilityState === 'hidden') return
      const delay = Math.min(this.interval(this.snapshot.value) * 2 ** Math.min(this.failures, 4), 60_000)
      this.timer = setTimeout(() => { void this.refresh() }, delay)
    })
    return this.pending
  }
  private emit(): void { for (const listener of this.listeners) listener() }
}

/** 取消时结束等待；底层 Promise 仍由处理器接住，避免迟到拒绝成为未处理异常。 */
function abortable<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason)
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    void Promise.resolve().then(() => { signal.throwIfAborted(); return read() }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted))
  })
}

const stores = new WeakMap<CodingNsRpcClient, Map<string, AssistantDisplayStore>>()
const legacyStatus = new WeakSet<CodingNsRpcClient>()
export function assistantDisplayScope(ids: readonly string[]): string { return JSON.stringify([...new Set(ids)].sort()) }
export function getAssistantDisplayStore(rpc: CodingNsRpcClient, scope: string): AssistantDisplayStore {
  let scopes = stores.get(rpc)
  if (!scopes) { scopes = new Map(); stores.set(rpc, scopes) }
  let store = scopes.get(scope)
  if (!store) { store = new AssistantDisplayStore(rpc); scopes.set(scope, store) }
  // 反复改管理范围不能永久保留所有完整调试快照。保留最近八个范围，
  // 被界面订阅或仍在读取的实例不回收，避免拆成两个并行请求所有者。
  scopes.delete(scope); scopes.set(scope, store)
  for (const [key, cached] of scopes) {
    if (scopes.size <= 8) break
    if (key !== scope && !cached.active) scopes.delete(key)
  }
  return store
}

export class AssistantDisplayStore {
  private readonly chats = new Map<string, AssistantDisplayResource<AssistantChatRun>>()
  readonly status: AssistantDisplayResource<AssistantStatusSnapshot>
  readonly debug: AssistantDisplayResource<AssistantDebugSnapshot>
  readonly lifecycle: AssistantDisplayResource<AssistantLifecycleSnapshot>
  get active(): boolean { return this.status.active || this.debug.active || this.lifecycle.active || [...this.chats.values()].some((resource) => resource.active) }
  constructor(private readonly rpc: CodingNsRpcClient, dom?: Document) {
    this.debug = new AssistantDisplayResource((signal, force) => this.call('assistant/debug', force ? { refresh: true } : {}, signal),
      () => legacyStatus.has(rpc) ? 30_000 : 3_000, dom)
    this.status = new AssistantDisplayResource(async (signal, force) => {
      if (!legacyStatus.has(rpc)) {
        try { return await this.call<AssistantStatusSnapshot>('assistant/status', {}, signal) }
        catch (error) { if (!unknownStatus(error)) throw error; legacyStatus.add(rpc) }
      }
      // 旧 Host 只探测一次未知接口；所有降级读取共用 debug 的缓存与在途请求。
      const value = await this.debug.refresh({ maxAgeMs: 30_000, ...(force ? { force: true } : {}) })
      if (!value) throw this.debug.getSnapshot().error ?? new Error('Assistant debug snapshot unavailable')
      return { revision: value.index?.generation ?? 0, capturedAt: value.capturedAt, indexState: value.indexState, indexedAt: value.indexedAt, workspaces: value.workspaces }
    }, () => legacyStatus.has(rpc) ? 30_000 : 3_000, dom)
    this.lifecycle = new AssistantDisplayResource((signal) => this.call('assistant/lifecycle/read', {}, signal),
      (value) => value?.conversation.active?.state === 'running' || value?.conversation.voiceSessions?.some((session) => session.endedAt === null) ? 600 : 1500, dom)
  }
  chat(requestId: string): AssistantDisplayResource<AssistantChatRun> {
    for (const [id, cached] of this.chats) if (id !== requestId && !cached.observed) this.chats.delete(id)
    let resource = this.chats.get(requestId)
    if (!resource) {
      resource = new AssistantDisplayResource((signal) => this.call('assistant/chat/read', { requestId }, signal), () => 600)
      this.chats.set(requestId, resource)
    }
    return resource
  }
  private async call<T>(endpoint: string, payload: unknown, signal: AbortSignal): Promise<T> {
    const result = await this.rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value as T
  }
}
function unknownStatus(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? ''
  const message = error instanceof Error ? error.message : String(error)
  return /UNKNOWN_(?:ACTION|ENDPOINT|METHOD)|METHOD_NOT_FOUND|RPC_NOT_FOUND|UNSUPPORTED_ACTION/iu.test(code)
    || /(?:unknown|unsupported|not found).*(?:status|action|endpoint)|(?:未知|不支持|未注册).*(?:status|操作|动作|接口)/iu.test(message)
}
