import type { PeerHostErrorCode, PeerHostRecord, PeerHostStatus } from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'
import { PeerHostStore, type PeerHostCredentialStore, type PeerHostTokenRecord } from './peer-host-store.js'

export interface PeerHostLoginInput {
  readonly username: string
  readonly password: string
}

export interface PeerHostSessionView {
  readonly peerHostId: string
  readonly status: 'logged_in' | 'logged_out'
  readonly expiresAt: number | null
}

export interface PeerHostSessionOptions {
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly refreshSkewMs?: number
}

/**
 * 这些状态只表示上一次连接尝试的瞬时结果。
 *
 * 真实数据面（HTTP、原生 Remote 或 WebSocket）仍可能可用，不能因为握手
 * 的旧结果就阻止后续请求再次验证连接。配置错误、版本不兼容和身份变化
 * 则不在这里放行，避免绕过管理面的安全边界。
 */
export function isPeerHostTransientStatus(status: PeerHostStatus): boolean {
  return status === 'checking' || status === 'unreachable' || status === 'reconnecting'
}

/** PeerHost 目标登录态协调器；token 只在 Host 进程和敏感存储中流转。 */
export class PeerHostSessionService {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly refreshSkewMs: number
  /** 同一目标的并发请求共用一次续期，避免重复登录和票据覆盖。 */
  private readonly pendingRefresh = new Map<string, Promise<PeerHostSessionView>>()

  constructor(
    private readonly store: PeerHostStore,
    private readonly credentials: PeerHostCredentialStore,
    private readonly options: { readonly apiPath?: string } & PeerHostSessionOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.refreshSkewMs = options.refreshSkewMs ?? 30_000
  }

  async login(peerHostId: string, input: PeerHostLoginInput): Promise<PeerHostSessionView> {
    // 目标明确拒绝旧 token 后状态就是 session_required；此时重新登录必须直接可用，
    // 不能要求用户先手工重新握手。
    const record = await this.ensureReady(peerHostId, true)
    const username = requiredText(input.username, 'username')
    const password = requiredText(input.password, 'password')
    const response = await this.request(record, '/api/auth/login', { username, password })
    const payload = parseTokenResponse(response)
    const credential = toCredential(payload, this.now(), { username, password })
    await this.credentials.write(peerHostId, credential)
    if (record.status !== 'ready') await this.store.updateStatus(peerHostId, 'ready', null)
    return toView(peerHostId, credential)
  }

  async refresh(peerHostId: string, allowStaleStatus = false): Promise<PeerHostSessionView> {
    const pending = this.pendingRefresh.get(peerHostId)
    if (pending !== undefined) return pending
    const task = this.refreshSession(peerHostId, allowStaleStatus)
    this.pendingRefresh.set(peerHostId, task)
    try { return await task }
    finally { this.pendingRefresh.delete(peerHostId) }
  }

  private async refreshSession(peerHostId: string, allowStaleStatus: boolean): Promise<PeerHostSessionView> {
    const record = await this.ensureReady(peerHostId, true, allowStaleStatus)
    const previous = await this.credentials.read(peerHostId)
    if (previous === null) return this.sessionRequired(peerHostId)
    const refreshed = await this.tryRefresh(peerHostId, record, previous)
    if (refreshed !== null) return toView(peerHostId, refreshed)
    // refreshToken 失效但编辑时保存了账号密码时静默重登，用户无需再手工登录。
    const relogged = await this.trySavedLogin(peerHostId, record, previous)
    if (relogged !== null) return toView(peerHostId, relogged)
    return this.sessionRequired(peerHostId)
  }

  async getAccessToken(peerHostId: string, allowStaleStatus = false): Promise<string> {
    const record = await this.ensureReady(peerHostId, true, allowStaleStatus)
    const credential = await this.credentials.read(peerHostId)
    if (credential === null) return this.sessionRequired(peerHostId)
    if ((record.status === 'ready' || allowStaleStatus) && credential.expiresAt - this.now() > this.refreshSkewMs) return credential.accessToken
    await this.refresh(peerHostId, allowStaleStatus)
    return this.readAccessToken(peerHostId, allowStaleStatus)
  }

  /** 401 已确认为票据拒绝后恢复；迟到的旧请求直接复用其它请求已经更新的票据。 */
  async recoverAccessToken(peerHostId: string, rejectedToken: string, allowStaleStatus = false): Promise<string> {
    const record = await this.ensureReady(peerHostId, true, allowStaleStatus)
    const current = await this.credentials.read(peerHostId)
    if (record.status === 'ready' && current !== null && current.accessToken !== rejectedToken) return this.getAccessToken(peerHostId, allowStaleStatus)
    await this.refresh(peerHostId, allowStaleStatus)
    return this.readAccessToken(peerHostId, allowStaleStatus)
  }

  private async readAccessToken(peerHostId: string, allowStaleStatus = false): Promise<string> {
    await this.ensureReady(peerHostId, false, allowStaleStatus)
    const current = await this.credentials.read(peerHostId)
    return current === null ? this.sessionRequired(peerHostId) : current.accessToken
  }

  /**
   * 用 refreshToken 续期；只有票据被拒才返回 null，交给调用方静默重登。
   *
   * 这里刻意不清除凭据：网络抖动导致的失败不应该抹掉用户在编辑里保存的账号，
   * 否则"只保存一次"的语义会被一次断网破坏。
   */
  private async tryRefresh(peerHostId: string, record: PeerHostRecord, previous: PeerHostTokenRecord): Promise<PeerHostTokenRecord | null> {
    try {
      const response = await this.request(record, '/api/auth/refresh', { refreshToken: previous.refreshToken })
      const payload = parseTokenResponse(response, previous.refreshToken)
      const credential = toCredential(payload, this.now(), readSavedAccount(previous))
      await this.credentials.write(peerHostId, credential)
      if (record.status !== 'ready') await this.store.updateStatus(peerHostId, 'ready', null)
      return credential
    } catch (error) {
      if (error instanceof PeerHostSessionError && error.code === PEER_HOST_ERROR_CODES.SESSION_REQUIRED) return null
      throw error
    }
  }

  /**
   * 用编辑时保存的账号密码静默重登。
   *
   * 只有目标明确拒绝该账号（401 → SESSION_REQUIRED）时才清除凭据，避免用过期
   * 口令反复重试；网络类失败保留凭据，等待下一次请求再试。
   */
  private async trySavedLogin(peerHostId: string, record: PeerHostRecord, previous: PeerHostTokenRecord): Promise<PeerHostTokenRecord | null> {
    const account = readSavedAccount(previous)
    if (account === null) return null
    try {
      const response = await this.request(record, '/api/auth/login', account)
      const payload = parseTokenResponse(response)
      const credential = toCredential(payload, this.now(), account)
      await this.credentials.write(peerHostId, credential)
      if (record.status !== 'ready') await this.store.updateStatus(peerHostId, 'ready', null)
      return credential
    } catch (error) {
      if (error instanceof PeerHostSessionError && error.code === PEER_HOST_ERROR_CODES.SESSION_REQUIRED) {
        await this.credentials.clear(peerHostId)
        return null
      }
      throw error
    }
  }

  /**
   * 目标 Host 明确拒绝当前 token 时的恢复入口。
   *
   * 保存了账号密码时先尝试静默重登：目标是"编辑里保存一次，之后一直能连"，
   * 因此一次 401 不应该直接把用户打回手工登录。重登失败才清理登录态。
   */
  async invalidate(peerHostId: string): Promise<void> {
    const record = await this.store.get(peerHostId)
    if (record !== null && record.status === 'ready') {
      const credential = await this.credentials.read(peerHostId)
      if (credential !== null && readSavedAccount(credential) !== null) {
        const recovered = await this.trySavedLogin(peerHostId, record, credential)
        if (recovered !== null) return
      }
    }
    await this.credentials.clear(peerHostId)
    if (record !== null && record.status === 'ready') await this.store.updateStatus(peerHostId, 'session_required', PEER_HOST_ERROR_CODES.SESSION_REQUIRED)
  }

  async logout(peerHostId: string): Promise<PeerHostSessionView> {
    const record = await this.store.get(peerHostId)
    if (record === null) throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.NOT_FOUND, 'PeerHost 不存在')
    const credential = await this.credentials.read(peerHostId)
    if (credential !== null) {
      try {
        await this.request(record, '/api/auth/logout', undefined, credential.accessToken)
      } catch {
        // 远端退出失败不能阻止本地凭据清理，避免旧 token 继续被代理使用。
      }
    }
    await this.credentials.clear(peerHostId)
    if (record.status === 'ready') await this.store.updateStatus(peerHostId, 'ready', null)
    return { peerHostId, status: 'logged_out', expiresAt: null }
  }

  private async ensureReady(peerHostId: string, allowSessionRequired = false, allowStaleStatus = false): Promise<PeerHostRecord> {
    const record = await this.store.get(peerHostId)
    if (record === null) throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.NOT_FOUND, 'PeerHost 不存在')
    const requiresLogin = record.status === 'session_required'
    if (record.status === 'ready' || (allowSessionRequired && requiresLogin) || (allowStaleStatus && isPeerHostTransientStatus(record.status))) return record
    throw new PeerHostSessionError(
      requiresLogin ? PEER_HOST_ERROR_CODES.SESSION_REQUIRED : PEER_HOST_ERROR_CODES.NOT_READY,
      requiresLogin ? '目标 Host 需要登录' : 'PeerHost 尚未通过握手检查',
    )
  }

  private async request(record: PeerHostRecord, path: string, body?: unknown, accessToken?: string): Promise<unknown> {
    if (record.route.kind !== 'lan') throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE, '中转 PeerHost 暂不可用')
    const headers = new Headers({ accept: 'application/json' })
    if (body !== undefined) headers.set('content-type', 'application/json')
    if (accessToken !== undefined) headers.set('authorization', `Bearer ${accessToken}`)
    let response: Response
    try {
      response = await this.fetchImpl(new URL(path, record.route.normalizedOrigin), {
        method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE, `目标 Host 请求失败（POST ${path}，网络不可达）`)
    }
    let payload: unknown = null
    try { payload = await response.json() } catch { /* logout 允许空响应 */ }
    if (!response.ok) {
      if (response.status === 401) {
        // 登录端点的 401 只表示凭据被拒；不能用“登录态已失效”掩盖密码错误。
        const message = path === '/api/auth/login' ? '目标 Host 用户名或密码错误' : '目标 Host 登录态已失效'
        throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.SESSION_REQUIRED, message)
      }
      throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE, `目标 Host 请求失败（POST ${path}，HTTP ${response.status}）`)
    }
    return payload
  }

  private async sessionRequired(peerHostId: string): Promise<never> {
    await this.store.updateStatus(peerHostId, 'session_required', PEER_HOST_ERROR_CODES.SESSION_REQUIRED)
    throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.SESSION_REQUIRED, '目标 Host 需要登录')
  }
}

export class PeerHostSessionError extends Error {
  constructor(readonly code: PeerHostErrorCode, message: string) {
    super(message)
    this.name = 'PeerHostSessionError'
  }
}

function parseTokenResponse(value: unknown, fallbackRefreshToken?: string): { accessToken: string; refreshToken: string; expiresIn: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, '目标 Host 登录响应无效')
  const input = value as Record<string, unknown>
  const accessToken = typeof input.accessToken === 'string' ? input.accessToken : ''
  const refreshToken = typeof input.refreshToken === 'string' ? input.refreshToken : fallbackRefreshToken ?? ''
  const expiresIn = typeof input.expiresIn === 'number' && Number.isFinite(input.expiresIn) && input.expiresIn > 0 ? input.expiresIn : 0
  if (!accessToken || !refreshToken || expiresIn <= 0) throw new PeerHostSessionError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, '目标 Host token 响应无效')
  return { accessToken, refreshToken, expiresIn }
}

function toCredential(
  payload: { accessToken: string; refreshToken: string; expiresIn: number },
  now: number,
  account: PeerHostLoginInput | null = null,
): PeerHostTokenRecord {
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    expiresAt: now + payload.expiresIn * 1000,
    ...(account === null ? {} : { username: account.username, password: account.password }),
  }
}

/** 读出凭据里保存的目标账号；缺任一半都视为未保存。 */
function readSavedAccount(credential: PeerHostTokenRecord): PeerHostLoginInput | null {
  const username = typeof credential.username === 'string' ? credential.username.trim() : ''
  const password = typeof credential.password === 'string' ? credential.password : ''
  return username === '' || password === '' ? null : { username, password }
}

function toView(peerHostId: string, credential: PeerHostTokenRecord): PeerHostSessionView {
  return { peerHostId, status: 'logged_in', expiresAt: credential.expiresAt }
}

function requiredText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 不能为空`)
  return value.trim()
}
