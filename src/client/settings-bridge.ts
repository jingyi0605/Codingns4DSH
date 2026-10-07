import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsSettings } from '../shared/contracts/config.js'
import { debugInfo, debugWarn } from '../shared/debug.js'
import type { CodingNsRpcClient } from './features/types.js'
import {
  sameSettingsSnapshot,
  type CodingNsSettingsSnapshot,
  type CodingNsSettingsStore,
  type CodingNsSettingsOperation,
} from '../dsh-capabilities/settings-store.js'

/** DSH 0.1 SettingsScope 与 0.2 Client 设置镜像的共同最小结构。 */
export interface DshClientSettingsScope<T> {
  getSnapshot(): LocalScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(operations: readonly CodingNsSettingsOperation[], expectedRevision?: number): Promise<void | boolean>
  set(field: string, value: unknown): Promise<void | boolean>
  unset(field: string): Promise<void | boolean>
}

type SettingsMutation = readonly CodingNsSettingsOperation[]
type SnapshotListener = () => void

interface RemoteSettingsResponse {
  readonly value: CodingNsSettings
  readonly revision: number
}

/**
 * DSH 未提供设置镜像（memory 模式、命名空间未下发或版本缺少 ConfigForm）时的占位快照。
 *
 * 它必须是稳定引用：设置页通过 `useSyncExternalStore` 读取快照，每次返回新对象
 * 会让 React 在每次渲染后都判定快照失效并强制再次渲染，最终以 React #185 崩溃整
 * 个设置分区。
 */
const UNAVAILABLE_LOCAL_SNAPSHOT = Object.freeze({
  status: 'unavailable' as const,
  value: undefined,
  revision: undefined,
  writable: false,
})

/**
 * 把 DSH 本地设置和远程 Host 设置 RPC 统一成一个设置作用域。
 *
 * 没有本地镜像时（`local` 为 undefined）完全使用 Host RPC：DSH 只向回环页面或
 * 声明了 Host 所有权的页面下发持久设置，非回环页面会降级为 memory 模式，此时
 * 插件设置必须走自己的 Host 写入边界才能保持可读写。
 */
export class CodingNsSettingsBridge implements CodingNsSettingsStore<CodingNsSettings> {
  private snapshot: CodingNsSettingsSnapshot<CodingNsSettings>
  private readonly listeners = new Set<SnapshotListener>()
  private readonly localUnsubscribe: () => void
  private remoteLoad: Promise<void> | undefined
  private remoteLoaded = false

  constructor(
    private readonly local: DshClientSettingsScope<CodingNsSettings> | undefined,
    private readonly rpc: CodingNsRpcClient,
  ) {
    this.snapshot = toStoreSnapshot(local?.getSnapshot() ?? UNAVAILABLE_LOCAL_SNAPSHOT)
    this.localUnsubscribe = local?.subscribe(() => {
      if (this.isRemote()) {
        void this.load().catch(() => undefined)
        return
      }
      this.remoteLoaded = false
      this.publish(toStoreSnapshot(this.localSnapshot()))
    }) ?? (() => undefined)
  }

  getSnapshot(): CodingNsSettingsSnapshot<CodingNsSettings> { return this.snapshot }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async load(): Promise<void> {
    if (!this.isRemote()) return
    if (this.remoteLoaded) return
    if (this.remoteLoad !== undefined) return this.remoteLoad
    debugInfo('codingns4dsh: client settings load begin')
    this.remoteLoad = this.call<RemoteSettingsResponse>('settings/get', {}).then((response) => {
      this.remoteLoaded = true
      this.publish({
        status: 'ready',
        value: response.value,
        revision: response.revision,
        writable: true,
      })
      debugInfo('codingns4dsh: client settings load success', { revision: response.revision })
    }).finally(() => {
      this.remoteLoad = undefined
    })
    return this.remoteLoad
  }

  async reload(): Promise<void> {
    // 先等初次读取结束，再发出新读取，避免迟到的初始快照覆盖业务 RPC 的更新。
    await this.remoteLoad?.catch(() => undefined)
    const response = await this.call<RemoteSettingsResponse>('settings/get', {})
    this.remoteLoaded = this.isRemote()
    this.publish({ status: 'ready', value: response.value, revision: response.revision, writable: true })
  }

  async set(field: string, value: unknown): Promise<boolean> {
    const local = this.local
    if (local !== undefined && !this.isRemote()) {
      await local.set(field, value)
      return true
    }
    return this.mutate([{ op: 'set', path: [field], value: toJsonValue(value) }])
  }

  async unset(field: string): Promise<boolean> {
    const local = this.local
    if (local !== undefined && !this.isRemote()) {
      await local.unset(field)
      return true
    }
    return this.mutate([{ op: 'unset', path: [field] }])
  }

  async mutate(ops: SettingsMutation, expectedRevision?: number): Promise<boolean> {
    const local = this.local
    if (local !== undefined && !this.isRemote()) {
      await local.mutate(ops, expectedRevision)
      return true
    }
    const payload = expectedRevision === undefined ? { ops } : { ops, expectedRevision }
    const response = await this.call<RemoteSettingsResponse>('settings/set', payload)
    this.remoteLoaded = true
    this.publish({
      ...this.snapshot,
      status: 'ready',
      value: response.value,
      revision: response.revision,
      writable: true,
    })
    return true
  }

  dispose(): void { this.localUnsubscribe() }

  private async call<T>(endpoint: string, payload: unknown): Promise<T> {
    return callCodingNsRpc<T>(this.rpc, endpoint, payload)
  }

  private localSnapshot(): LocalScopeSnapshot {
    return this.local?.getSnapshot() ?? UNAVAILABLE_LOCAL_SNAPSHOT
  }

  /**
   * 内容未变化时不替换快照引用、不唤醒订阅者。
   *
   * DSH 的本地设置镜像会在后台索引（例如 cliSessions 心跳）更新时反复通知；
   * 每次都发布新对象会让设置页持续重渲染，并使按快照身份触发的 effect 反复执行。
   */
  private publish(next: CodingNsSettingsSnapshot<CodingNsSettings>): void {
    if (sameSettingsSnapshot(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private isRemote(): boolean {
    if (this.local === undefined) return true
    const snapshot = this.local.getSnapshot()
    // 远程 DSH Web iframe 内的 settingsScope 属于被访问的 DSH Web Host；
    // CodingNS 插件设置仍归外层 CodingNS Host 所有，不能误写入 DSH Web 的本地缓存。
    return isRemoteWebContext() || snapshot.mode === 'memory' || snapshot.status === 'unavailable'
      // 某些 DSH 版本只向 Client 暴露只读设置镜像，但当前 Host 仍提供
      // Codingns4DSH 自有 settings/set RPC。此时必须切换到 Host 写入边界，
      // 否则设置页会永久把所有模块开关显示为不可操作。
      || snapshot.writable === false
  }
}

function isRemoteWebContext(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __CODINGNS4DSH_REMOTE_WEB_CONTEXT__?: unknown
    location?: { readonly protocol?: string }
  }
  // 中转 iframe 有显式标记；局域网代理直接打开 DSH Web 时没有 iframe，
  // 但同样属于浏览器 Host，插件设置仍应通过 CodingNS Host RPC 读取。
  return runtime.__CODINGNS4DSH_REMOTE_WEB_CONTEXT__ === true
    || runtime.location?.protocol === 'http:'
    || runtime.location?.protocol === 'https:'
}

/** 调用 Codingns4DSH Host RPC，并兼容 DSH 原生连接与普通 Web API 回退。 */
export async function callCodingNsRpc<T>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> {
  let result
  try {
    debugInfo('codingns4dsh: client rpc request', { channel: CODINGNS_RPC_CHANNEL, endpoint })
    result = await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload)
  } catch (error) {
    // DSH 原生连接通常把自定义 RPC 映射到 /api；保留逻辑通道兼容
    // Codingns4DSH Transport，同时在普通 Web Host 上回退到实际 Fetch 路由。
    const message = error instanceof Error ? error.message : String(error)
    if (!/HTTP (?:404|405)\b/u.test(message)) throw error
    debugWarn('codingns4dsh: client rpc fallback', { endpoint, error: message })
    try {
      result = await rpc.call('/api', `codingns/${endpoint}`, payload)
    } catch (fallbackError) {
      console.error('codingns4dsh: client rpc fallback failed', { endpoint, error: fallbackError })
      throw fallbackError
    }
  }
  if (!result.ok) {
    console.error('codingns4dsh: client rpc response error', { endpoint, error: result.error })
    // 保留 Host 的稳定错误码，让业务层区分版本冲突和真正的权限/网络失败。
    throw Object.assign(new Error(result.error.message), { code: result.error.code })
  }
  debugInfo('codingns4dsh: client rpc response success', { endpoint })
  return result.value as T
}

type JsonValue = null | string | boolean | number | JsonValue[] | { readonly [key: string]: JsonValue }

/** 设置 RPC 只能传 JSON；在浏览器边界尽早拒绝函数、循环引用等无效值。 */
function toJsonValue(value: unknown, visiting = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (visiting.has(value)) throw new TypeError('设置值不能包含循环引用')
    visiting.add(value)
    try { return value.map((entry) => toJsonValue(entry, visiting)) } finally { visiting.delete(value) }
  }
  if (typeof value !== 'object' || value === undefined) throw new TypeError('设置值必须是可序列化的 JSON')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('设置值只能包含 JSON 对象、数组和标量')
  if (visiting.has(value)) throw new TypeError('设置值不能包含循环引用')
  visiting.add(value)
  const result: Record<string, JsonValue> = {}
  try {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      result[key] = toJsonValue(entry, visiting)
    }
    return result
  } finally { visiting.delete(value) }
}

export function createCodingNsSettingsBridge(
  local: DshClientSettingsScope<CodingNsSettings> | undefined,
  rpc: CodingNsRpcClient,
): CodingNsSettingsBridge {
  return new CodingNsSettingsBridge(local, rpc)
}

/** 本地镜像或占位快照中的通用字段；DSH 各版本另有 base/user/mode 等附加字段。 */
export type LocalScopeSnapshot<T = CodingNsSettings> = {
  readonly value: T | undefined
  readonly revision: number | undefined
  readonly writable: boolean
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly mode?: string
}

function toStoreSnapshot(snapshot: LocalScopeSnapshot): CodingNsSettingsSnapshot<CodingNsSettings> {
  return { value: snapshot.value, revision: snapshot.revision, writable: snapshot.writable, status: snapshot.status }
}
