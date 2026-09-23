import type { CodingNsSessionAdapterBinding } from '../shared/contracts/cli-adapter.js'
import { callCliRpc } from './cli-catalog.js'
import type { CodingNsRpcClient } from './features/types.js'

type CacheListener = () => void

const adaptersBySession = new Map<string, string>()
const listeners = new Set<CacheListener>()

/** 返回一个会话当前绑定的适配器；查询成本为 O(1)。 */
export function sessionAdapterId(sessionId: string): string | undefined {
  return adaptersBySession.get(sessionId)
}

/** 同一浏览器内 Agent 选择变化时增量更新缓存。 */
export function publishSessionAdapter(sessionId: string, adapterId: string): void {
  const normalizedSessionId = sessionId.trim()
  const normalizedAdapterId = adapterId.trim()
  if (normalizedSessionId === '' || normalizedAdapterId === '') return
  if (adaptersBySession.get(normalizedSessionId) === normalizedAdapterId) return
  adaptersBySession.set(normalizedSessionId, normalizedAdapterId)
  notify()
}

/** 用 Host 的一次脱敏快照替换缓存，不保留已经消失的旧绑定。 */
export function replaceSessionAdapters(bindings: readonly CodingNsSessionAdapterBinding[]): void {
  const next = new Map<string, string>()
  for (const binding of bindings) {
    const sessionId = binding.sessionId.trim()
    const adapterId = binding.adapterId.trim()
    if (sessionId !== '' && adapterId !== '') next.set(sessionId, adapterId)
  }
  if (sameBindings(next)) return
  adaptersBySession.clear()
  for (const [sessionId, adapterId] of next) adaptersBySession.set(sessionId, adapterId)
  notify()
}

/** 一次 RPC 读取全部脱敏绑定；不会按 DOM 行逐条请求。 */
export async function fetchSessionAdapters(rpc: CodingNsRpcClient): Promise<readonly CodingNsSessionAdapterBinding[]> {
  const value = await callCliRpc<unknown>(rpc, 'session/adapter-map', {})
  if (!Array.isArray(value)) return []
  return value
    .filter(isSessionAdapterBinding)
    .map((binding) => ({
      sessionId: binding.sessionId.trim(),
      adapterId: binding.adapterId.trim(),
    }))
}

export function subscribeSessionAdapters(listener: CacheListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 模块停用时清空内存关系，避免跨 generation 使用旧绑定。 */
export function clearSessionAdapters(): void {
  if (adaptersBySession.size === 0) return
  adaptersBySession.clear()
  notify()
}

/** 只供测试和诊断读取的脱敏快照。 */
export function sessionAdapterSnapshot(): Readonly<Record<string, string>> {
  return Object.fromEntries(adaptersBySession)
}

function sameBindings(next: ReadonlyMap<string, string>): boolean {
  if (next.size !== adaptersBySession.size) return false
  for (const [sessionId, adapterId] of next) {
    if (adaptersBySession.get(sessionId) !== adapterId) return false
  }
  return true
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function isSessionAdapterBinding(value: unknown): value is CodingNsSessionAdapterBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.sessionId === 'string'
    && record.sessionId.trim() !== ''
    && typeof record.adapterId === 'string'
    && record.adapterId.trim() !== ''
}
