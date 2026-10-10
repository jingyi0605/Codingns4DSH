import type { CodingNsCliSessionConfig } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'

/** 会话配置在一次导航期间由多个 Slot 共同读取；共享短期快照即可消除重复 RPC。 */
const SESSION_CONFIG_CACHE_TTL_MS = 5000

interface CacheEntry {
  readonly value: CodingNsCliSessionConfig
  readonly loadedAt: number
}

type Pending = Promise<CodingNsCliSessionConfig>

const caches = new WeakMap<CodingNsRpcClient, Map<string, CacheEntry | Pending>>()

/**
 * 读取会话当前 Agent/模型配置。
 *
 * 同一 RPC 客户端和会话在短时间内只允许一个在途请求；完成后保留 5 秒，
 * 覆盖会话切换时同时挂载的 Agent、订阅和技能组件。写入方可调用 remember
 * 立即替换快照，避免短期缓存覆盖用户刚选择的模型。
 */
export function loadCliSessionConfig(rpc: CodingNsRpcClient, sessionId: string): Promise<CodingNsCliSessionConfig> {
  const normalized = sessionId.trim()
  if (normalized === '') return Promise.resolve({ adapterId: 'dsh' })
  const cache = cacheFor(rpc)
  const existing = cache.get(normalized)
  if (existing instanceof Promise) return existing
  if (existing !== undefined && Date.now() - existing.loadedAt < SESSION_CONFIG_CACHE_TTL_MS) {
    return Promise.resolve(existing.value)
  }
  const request = callCliRpc<CodingNsCliSessionConfig>(rpc, 'session/get', { sessionId: normalized })
    .then((value) => {
      cache.set(normalized, { value, loadedAt: Date.now() })
      return value
    })
    .finally(() => {
      if (cache.get(normalized) === request) {
        const current = cache.get(normalized)
        if (current instanceof Promise) cache.delete(normalized)
      }
    })
  cache.set(normalized, request)
  return request
}

/** 用户刚写入 Agent/模型后立即更新共享快照。 */
export function rememberCliSessionConfig(rpc: CodingNsRpcClient, sessionId: string, value: CodingNsCliSessionConfig): void {
  const normalized = sessionId.trim()
  if (normalized === '') return
  cacheFor(rpc).set(normalized, { value, loadedAt: Date.now() })
}

function cacheFor(rpc: CodingNsRpcClient): Map<string, CacheEntry | Pending> {
  let cache = caches.get(rpc)
  if (cache === undefined) {
    cache = new Map()
    caches.set(rpc, cache)
  }
  return cache
}
