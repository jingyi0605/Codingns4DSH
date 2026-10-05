import type { CodingNsCliModelCatalog } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'

/**
 * Client 侧模型目录缓存。
 *
 * Agent 选择器、模型选择器和委派弹层共享同一份 RPC 结果。缓存只属于当前
 * RPC 客户端实例，避免切换远端 Host 后误用旧 Host 的目录。
 */
const modelCatalogCaches = new WeakMap<object, Map<string, CodingNsCliModelCatalog>>()
const modelCatalogLoads = new WeakMap<object, Map<string, Promise<CodingNsCliModelCatalog>>>()

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

function cacheEntry(rpc: CodingNsRpcClient, adapterId: string): CachedCatalog | undefined {
  return cacheTimesFor(rpc).get(adapterId)
}

function cacheTimesFor(rpc: CodingNsRpcClient): Map<string, CachedCatalog> {
  const key = rpc as object
  let times = modelCatalogCacheTimes.get(key)
  if (times === undefined) {
    times = new Map()
    modelCatalogCacheTimes.set(key, times)
  }
  return times
}

function storeCatalog(rpc: CodingNsRpcClient, adapterId: string, value: CodingNsCliModelCatalog): void {
  getModelCatalogCache(rpc).set(adapterId, value)
  cacheTimesFor(rpc).set(adapterId, { value, storedAt: Date.now() })
}

/** 作废某个适配器（或全部适配器）的 Client 目录缓存。 */
export function invalidateModelCatalogCache(rpc: CodingNsRpcClient, adapterId?: string): void {
  const cache = getModelCatalogCache(rpc)
  const times = cacheTimesFor(rpc)
  if (adapterId === undefined) {
    cache.clear()
    times.clear()
    return
  }
  cache.delete(adapterId)
  times.delete(adapterId)
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
): boolean {
  if (!needsRevalidation) return false
  const key = rpc as object
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

export function getModelCatalogCache(rpc: CodingNsRpcClient): Map<string, CodingNsCliModelCatalog> {
  const key = rpc as object
  let cache = modelCatalogCaches.get(key)
  if (cache === undefined) {
    cache = new Map()
    modelCatalogCaches.set(key, cache)
  }
  return cache
}

export function loadModelCatalog(rpc: CodingNsRpcClient, adapterId: string, sessionId?: string): Promise<CodingNsCliModelCatalog> {
  const cached = getModelCatalogCache(rpc).get(adapterId)
  // 回退目录只用于当前渲染，不能在 Client 侧永久占住真实目录。Host 会在
  // 短周期内重试产品快照读取；下一次请求必须有机会拿到恢复后的目录。
  if (cached !== undefined && cached.fallback !== true && isFreshCacheEntry(rpc, adapterId, cached)) {
    return Promise.resolve(cached)
  }
  if (cached !== undefined) invalidateModelCatalogCache(rpc, adapterId)
  const loads = getModelCatalogLoadCache(rpc)
  const running = loads.get(adapterId)
  if (running !== undefined) return running
  const request = callCliRpc<CodingNsCliModelCatalog>(rpc, 'models', {
    adapterId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }).then((value) => {
    if (value.fallback === true) invalidateModelCatalogCache(rpc, adapterId)
    else storeCatalog(rpc, adapterId, value)
    return value
  }).finally(() => {
    if (loads.get(adapterId) === request) loads.delete(adapterId)
  })
  loads.set(adapterId, request)
  return request
}

/** 缓存条目是否仍在有效期内；没有时间戳的旧条目按过期处理并触发一次重新读取。 */
function isFreshCacheEntry(rpc: CodingNsRpcClient, adapterId: string, cached: CodingNsCliModelCatalog): boolean {
  const entry = cacheEntry(rpc, adapterId)
  if (entry === undefined || entry.value !== cached) return false
  return Date.now() - entry.storedAt < MODEL_CATALOG_CACHE_TTL_MS
}

function getModelCatalogLoadCache(rpc: CodingNsRpcClient): Map<string, Promise<CodingNsCliModelCatalog>> {
  const key = rpc as object
  let cache = modelCatalogLoads.get(key)
  if (cache === undefined) {
    cache = new Map()
    modelCatalogLoads.set(key, cache)
  }
  return cache
}
