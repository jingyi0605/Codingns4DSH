import type { CodingNsCliModelCatalog } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'
import { parseVirtualSessionId } from '../shared/contracts/peer-host.js'

/**
 * Client 侧模型目录缓存。
 *
 * Agent 选择器、模型选择器和委派弹层共享同一份 RPC 结果。缓存只属于当前
 * RPC 客户端实例与会话所属 Host，同一 Host 的会话共享目录，跨 Host 不复用。
 */
const modelCatalogCaches = new WeakMap<object, Map<string, CodingNsCliModelCatalog>>()
const modelCatalogLoads = new WeakMap<object, Map<string, Promise<CodingNsCliModelCatalog>>>()
/** PeerHost 复用页面 RPC 实例，用稳定的 Host 身份隔离目录、请求与复检节流。 */
const modelCatalogHostKeys = new WeakMap<object, Map<string, object>>()

function modelCatalogKey(rpc: CodingNsRpcClient, sessionId?: string): object {
  const hostId = sessionId === undefined ? undefined : parseVirtualSessionId(sessionId)?.hostId
  if (hostId === undefined) return rpc as object
  let hosts = modelCatalogHostKeys.get(rpc as object)
  if (hosts === undefined) {
    hosts = new Map()
    modelCatalogHostKeys.set(rpc as object, hosts)
  }
  let key = hosts.get(hostId)
  if (key === undefined) { key = {}; hosts.set(hostId, key) }
  return key
}

/**
 * Client 缓存有效期。
 *
 * 目录里既有模型清单，也有账号级事实（例如 Codex 的 `officialSubscription`
 * 与 `defaultServiceTier`）。后者会随用户在外部工具里切换供应商或登录状态而
 * 变化，而页面不会因此重新挂载。若 Client 永久持有第一次的结果，依赖这些事实
 * 的控件（Codex 官方订阅的 Fast 档位开关）就会在整场会话里一直缺失。
 *
 * 因此这里给出一个短 TTL：命中即用（不阻塞渲染），过期后重新请求。Host 侧还会
 * 比对 Provider 配置指纹，配置真正变化时立即失效，不依赖这个 TTL。
 */
export const MODEL_CATALOG_CACHE_TTL_MS = 60_000

interface CachedCatalog {
  readonly value: CodingNsCliModelCatalog
  readonly storedAt: number
}

const modelCatalogCacheTimes = new WeakMap<object, Map<string, CachedCatalog>>()

function cacheEntry(rpc: CodingNsRpcClient, adapterId: string, sessionId?: string): CachedCatalog | undefined {
  return cacheTimesFor(rpc, sessionId).get(adapterId)
}

function cacheTimesFor(rpc: CodingNsRpcClient, sessionId?: string): Map<string, CachedCatalog> {
  const key = modelCatalogKey(rpc, sessionId)
  let times = modelCatalogCacheTimes.get(key)
  if (times === undefined) {
    times = new Map()
    modelCatalogCacheTimes.set(key, times)
  }
  return times
}

function storeCatalog(rpc: CodingNsRpcClient, adapterId: string, value: CodingNsCliModelCatalog, sessionId?: string): void {
  getModelCatalogCache(rpc, sessionId).set(adapterId, value)
  cacheTimesFor(rpc, sessionId).set(adapterId, { value, storedAt: Date.now() })
}

/** 指定会话时只作废其 Host；旧调用不传会话时仍清理整个 RPC 的指定目录。 */
export function invalidateModelCatalogCache(rpc: CodingNsRpcClient, adapterId?: string, sessionId?: string): void {
  const keys = sessionId === undefined
    ? [rpc as object, ...(modelCatalogHostKeys.get(rpc as object)?.values() ?? [])]
    : [modelCatalogKey(rpc, sessionId)]
  for (const key of keys) {
    const cache = modelCatalogCaches.get(key)
    const times = modelCatalogCacheTimes.get(key)
    if (adapterId === undefined) { cache?.clear(); times?.clear() }
    else { cache?.delete(adapterId); times?.delete(adapterId) }
  }
}

/**
 * 「判定可能过期」时的复检节流。
 *
 * 目录声明了服务档位却未确认官方订阅时，值得再探测一次；但真实第三方接入会
 * 长期停在这个状态，不能每次挂载都发一次请求。这里按适配器记录最近一次复检
 * 时间，只有超过间隔才允许再次作废缓存。
 */
export const MODEL_CATALOG_REVALIDATE_INTERVAL_MS = 60_000

const modelCatalogRevalidations = new WeakMap<object, Map<string, number>>()

export function shouldRevalidateModelCatalog(
  rpc: CodingNsRpcClient,
  adapterId: string,
  needsRevalidation: boolean,
  sessionId?: string,
): boolean {
  if (!needsRevalidation) return false
  const key = modelCatalogKey(rpc, sessionId)
  let times = modelCatalogRevalidations.get(key)
  if (times === undefined) {
    times = new Map()
    modelCatalogRevalidations.set(key, times)
  }
  const last = times.get(adapterId)
  const now = Date.now()
  if (last !== undefined && now - last < MODEL_CATALOG_REVALIDATE_INTERVAL_MS) return false
  times.set(adapterId, now)
  return true
}

export function getModelCatalogCache(rpc: CodingNsRpcClient, sessionId?: string): Map<string, CodingNsCliModelCatalog> {
  const key = modelCatalogKey(rpc, sessionId)
  let cache = modelCatalogCaches.get(key)
  if (cache === undefined) {
    cache = new Map()
    modelCatalogCaches.set(key, cache)
  }
  return cache
}

export function loadModelCatalog(rpc: CodingNsRpcClient, adapterId: string, sessionId?: string): Promise<CodingNsCliModelCatalog> {
  const cached = getModelCatalogCache(rpc, sessionId).get(adapterId)
  // 回退目录只用于当前渲染，不能在 Client 侧永久占住真实目录。Host 会在
  // 短周期内重试产品快照读取；下一次请求必须有机会拿到恢复后的目录。
  if (cached !== undefined && cached.fallback !== true && isFreshCacheEntry(rpc, adapterId, cached, sessionId)) {
    return Promise.resolve(cached)
  }
  if (cached !== undefined) invalidateModelCatalogCache(rpc, adapterId, sessionId)
  const loads = getModelCatalogLoadCache(rpc, sessionId)
  const running = loads.get(adapterId)
  if (running !== undefined) return running
  const request = callCliRpc<CodingNsCliModelCatalog>(rpc, 'models', {
    adapterId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }).then((value) => {
    if (value.fallback === true) invalidateModelCatalogCache(rpc, adapterId, sessionId)
    else storeCatalog(rpc, adapterId, value, sessionId)
    return value
  }).finally(() => {
    if (loads.get(adapterId) === request) loads.delete(adapterId)
  })
  loads.set(adapterId, request)
  return request
}

/** 缓存条目是否仍在有效期内；没有时间戳的旧条目按过期处理并触发一次重新读取。 */
function isFreshCacheEntry(rpc: CodingNsRpcClient, adapterId: string, cached: CodingNsCliModelCatalog, sessionId?: string): boolean {
  const entry = cacheEntry(rpc, adapterId, sessionId)
  if (entry === undefined || entry.value !== cached) return false
  return Date.now() - entry.storedAt < MODEL_CATALOG_CACHE_TTL_MS
}

function getModelCatalogLoadCache(rpc: CodingNsRpcClient, sessionId?: string): Map<string, Promise<CodingNsCliModelCatalog>> {
  const key = modelCatalogKey(rpc, sessionId)
  let cache = modelCatalogLoads.get(key)
  if (cache === undefined) {
    cache = new Map()
    modelCatalogLoads.set(key, cache)
  }
  return cache
}
