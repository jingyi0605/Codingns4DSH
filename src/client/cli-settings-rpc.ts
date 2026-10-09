import type { CodingNsRpcClient, CodingNsRpcResult } from './features/types.js'
import { createPeerHostScopedClient } from './peer-host-scoped-client.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { resolveCodingNsTranslator, type CodingNsLocale } from './locale.js'

const CATALOG_ENDPOINTS = new Set(['cli/catalog', 'cli/catalog/refresh', 'cli/models'])
const clients = new WeakMap<CodingNsRpcClient, Map<string | null, { readonly client: CodingNsRpcClient; readonly locale: CodingNsLocale | undefined }>>()
let requestSequence = 0

/** 设置页明确绑定 Host；远端目录不依赖前台会话或已添加的工作区。 */
export function createCliSettingsRpc(rpc: CodingNsRpcClient, peerHostId: string | null, locale?: CodingNsLocale): CodingNsRpcClient {
  let hosts = clients.get(rpc)
  if (hosts === undefined) { hosts = new Map(); clients.set(rpc, hosts) }
  const cached = hosts.get(peerHostId)
  if (cached !== undefined && cached.locale === locale) return cached.client
  const peer = createPeerHostScopedClient(rpc)
  const client: CodingNsRpcClient = {
    async call(channel, endpoint, payload, signal) {
      const method = channel === CODINGNS_RPC_CHANNEL ? endpoint : channel === '/api' ? endpoint.replace(/^codingns\//u, '') : ''
      if (peerHostId === null) {
        // 聚合 Transport 识别此字段，设置页的本机目录不会跟随远端前台导航。
        const input = CATALOG_ENDPOINTS.has(method) ? { ...asRecord(payload), catalogHostId: 'local' } : payload
        return rpc.call(channel, endpoint, input, signal)
      }
      // 远端设置页仅支持目录查询与检测刷新，禁止把本机启用开关转发出去。
      if (!CATALOG_ENDPOINTS.has(method)) throw new Error(resolveCodingNsTranslator(locale)('cli.peerHostRpcReadOnly'))
      const response = await peer.request({
        hostId: peerHostId, targetHostId: peerHostId, workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0,
      }, `/api/codingns/${method}`, {
        method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: `codingns-agent-catalog-${Date.now()}-${++requestSequence}`, method, payload }),
        ...(signal === undefined ? {} : { signal }),
      })
      let envelope: Record<string, unknown> | null = null
      try { envelope = asRecord(JSON.parse(response.body)) } catch { /* 非 JSON 响应由统一错误返回。 */ }
      if (response.status < 200 || response.status >= 300) {
        const error = asRecord(envelope?.error)
        return failure(typeof error?.code === 'string' ? error.code : 'PEER_HOST_PROXY_UNREACHABLE',
          typeof error?.message === 'string' ? error.message : resolveCodingNsTranslator(locale)('cli.peerHostRpcFailed', { status: response.status }))
      }
      const result = asRecord(envelope?.result)
      if (result?.ok === true && Object.hasOwn(result, 'value')) return { ok: true, value: result.value }
      const error = asRecord(result?.error)
      if (result?.ok === false && typeof error?.code === 'string' && typeof error.message === 'string') return failure(error.code, error.message)
      return failure('PEER_HOST_RESPONSE_INVALID', resolveCodingNsTranslator(locale)('cli.peerHostRpcInvalid'))
    },
  }
  hosts.set(peerHostId, { client, locale })
  return client
}

function failure(code: string, message: string): CodingNsRpcResult { return { ok: false, error: { code, message } } }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
