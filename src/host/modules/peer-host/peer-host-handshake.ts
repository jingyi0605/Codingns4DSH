import type { PeerHostErrorCode, PeerHostRecord, PeerHostRoute } from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'
import {
  PeerHostStore,
  type PeerHostHandshakeUpdate,
} from './peer-host-store.js'

export const PEER_HOST_HANDSHAKE_PATH = '/api/public/host-handshake'

export interface PeerHostHandshakePayload {
  readonly productId: string
  readonly pluginId: string | null
  readonly pluginVersion: string | null
  readonly dshVersion: string
  readonly hostname?: string | null
  readonly configProfile?: string | null
  readonly apiCompatibility: string
  readonly fingerprint: string | null
  readonly capabilities: readonly string[]
}

export interface PeerHostHandshakeOptions {
  readonly productId: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly apiCompatibility: string
  readonly isDshVersionSupported: (version: string) => boolean
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** 目标 Host 握手协调器；只把脱敏结果写回 PeerHostRecord。 */
export class PeerHostHandshakeService {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(private readonly store: PeerHostStore, private readonly credentials: { clear(peerHostId: string): Promise<void> }, private readonly options: PeerHostHandshakeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.now = options.now ?? Date.now
  }

  async check(peerHostId: string): Promise<PeerHostRecord> {
    const current = await this.requireRecord(peerHostId)
    await this.store.updateHandshake(peerHostId, this.emptyUpdate('checking'))
    try {
      const payload = await this.fetchHandshake(current.route)
      const update = this.resolve(current, payload)
      if (update.status === 'identity_changed') await this.credentials.clear(peerHostId)
      return await this.store.updateHandshake(peerHostId, update)
    } catch (error) {
      const code = errorCode(error, PEER_HOST_ERROR_CODES.UNREACHABLE)
      return this.store.updateHandshake(peerHostId, {
        ...this.emptyUpdate('unreachable'),
        lastErrorCode: code,
      })
    }
  }

  private async fetchHandshake(route: PeerHostRoute): Promise<PeerHostHandshakePayload> {
    if (route.kind !== 'lan') throw new HandshakeError(PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE, '中转 PeerHost 暂不可用')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(new URL(PEER_HOST_HANDSHAKE_PATH, route.normalizedOrigin), { method: 'GET', signal: controller.signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new HandshakeError(PEER_HOST_ERROR_CODES.UNREACHABLE, `握手请求失败: ${response.status}`)
      let value: unknown
      try { value = await response.json() } catch { throw new HandshakeError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, '握手响应不是 JSON') }
      if (!isHandshakePayload(value)) throw new HandshakeError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, '握手响应字段无效')
      return value
    } catch (error) {
      if (error instanceof HandshakeError) throw error
      throw new HandshakeError(PEER_HOST_ERROR_CODES.UNREACHABLE, '目标 Host 不可达')
    } finally {
      clearTimeout(timer)
    }
  }

  private resolve(current: PeerHostRecord, payload: PeerHostHandshakePayload): PeerHostHandshakeUpdate {
    const common = {
      pluginId: payload.pluginId,
      pluginVersion: payload.pluginVersion,
      dshVersion: payload.dshVersion,
      hostname: payload.hostname ?? null,
      configProfile: payload.configProfile ?? null,
      apiCompatibility: payload.apiCompatibility,
      fingerprint: payload.fingerprint,
      lastCheckedAt: this.now(),
      lastErrorCode: null,
    } as const
    if (payload.productId !== this.options.productId || payload.pluginId !== this.options.pluginId) {
      return { ...common, status: 'plugin_missing', lastErrorCode: PEER_HOST_ERROR_CODES.PLUGIN_MISSING }
    }
    if (payload.pluginVersion !== this.options.pluginVersion || !this.options.isDshVersionSupported(payload.dshVersion) || payload.apiCompatibility !== this.options.apiCompatibility) {
      return { ...common, status: 'version_mismatch', lastErrorCode: PEER_HOST_ERROR_CODES.VERSION_MISMATCH }
    }
    if (current.fingerprint !== null && payload.fingerprint !== current.fingerprint) {
      return { ...common, status: 'identity_changed', lastErrorCode: PEER_HOST_ERROR_CODES.IDENTITY_CHANGED }
    }
    return { ...common, status: 'ready' }
  }

  private emptyUpdate(status: PeerHostRecord['status']): PeerHostHandshakeUpdate {
    return {
      status,
      pluginId: null,
      pluginVersion: null,
      dshVersion: null,
      hostname: null,
      configProfile: null,
      apiCompatibility: null,
      fingerprint: null,
      lastCheckedAt: this.now(),
      lastErrorCode: null,
    }
  }

  private async requireRecord(peerHostId: string): Promise<PeerHostRecord> {
    const record = await this.store.get(peerHostId)
    if (record === null) throw new HandshakeError(PEER_HOST_ERROR_CODES.NOT_FOUND, 'PeerHost 不存在')
    return record
  }
}

export class HandshakeError extends Error {
  constructor(readonly code: PeerHostErrorCode, message: string) {
    super(message)
    this.name = 'HandshakeError'
  }
}

function isHandshakePayload(value: unknown): value is PeerHostHandshakePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return typeof input.productId === 'string'
    && (typeof input.pluginId === 'string' || input.pluginId === null)
    && (typeof input.pluginVersion === 'string' || input.pluginVersion === null)
    && typeof input.dshVersion === 'string'
    && (input.hostname === undefined || input.hostname === null || typeof input.hostname === 'string')
    && (input.configProfile === undefined || input.configProfile === null || typeof input.configProfile === 'string')
    && typeof input.apiCompatibility === 'string'
    && (typeof input.fingerprint === 'string' || input.fingerprint === null)
    && Array.isArray(input.capabilities)
    && input.capabilities.every((item) => typeof item === 'string')
}

function errorCode(error: unknown, fallback: PeerHostErrorCode): PeerHostErrorCode {
  if (error instanceof HandshakeError) return error.code
  return fallback
}
