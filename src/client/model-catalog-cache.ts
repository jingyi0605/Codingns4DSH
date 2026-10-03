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
  if (cached !== undefined && cached.fallback !== true) return Promise.resolve(cached)
  if (cached?.fallback === true) getModelCatalogCache(rpc).delete(adapterId)
  const loads = getModelCatalogLoadCache(rpc)
  const running = loads.get(adapterId)
  if (running !== undefined) return running
  const request = callCliRpc<CodingNsCliModelCatalog>(rpc, 'models', {
    adapterId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }).then((value) => {
    if (value.fallback === true) {
      getModelCatalogCache(rpc).delete(adapterId)
    } else {
      getModelCatalogCache(rpc).set(adapterId, value)
    }
    return value
  }).finally(() => {
    if (loads.get(adapterId) === request) loads.delete(adapterId)
  })
  loads.set(adapterId, request)
  return request
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
