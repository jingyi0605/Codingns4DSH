import { connect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Transform, type TransformCallback } from 'node:stream'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CodingNsSettings, LanAccessDshLoginSettings, LanAccessDshPwaSettings, LanAccessDshSettings, LoginProtectionScopes } from '../shared/contracts/config.js'
import { normalizeLanAccessDshPwaSettings, DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS } from '../shared/contracts/config.js'
import type { LanAccessDshConfig, LanAccessDshLoginConfig, LanAccessDshPwaStatus, LanAccessDshSnapshot } from '../shared/contracts/lan-access-dsh.js'
import { PWA_ASSET_PREFIX, PWA_MANIFEST_PATH, PWA_SERVICE_WORKER_PATH, type LanAccessDshPwaBundle, type LanAccessDshPwaProvider, type PwaPushService, type PwaPushSubscriptionInput } from './modules/pwa/index.js'
import { CodingNsRpcError } from './rpc-table.js'
import type { DshHostSettingsScope } from '../dsh-capabilities/host/config-forms-adapter.js'
import { createLoginAttemptContext, LoginAttemptGuard, type LoginAttemptContext } from './login-attempt-guard.js'
import { hostBrowserText, resolveAcceptLanguageLocale, resolveHostPushLocale, type HostLocale } from './browser-text.js'
import { isPeerHostHttpRoute } from '../shared/peer-host-http-routes.js'

export interface LanAccessDshStream {
  pipe(destination: LanAccessDshStream): LanAccessDshStream
  destroy(error?: Error): void
  once(event: 'error' | 'close' | 'connect', listener: (...args: unknown[]) => void): LanAccessDshStream
}

export interface LanAccessDshRuntime {
  listListenHosts(): readonly string[]
  detectDshPorts(): Promise<readonly number[]>
  listen(
    config: LanAccessDshConfig,
    onConnection: (socket: LanAccessDshStream) => void,
  ): Promise<{ actualPort: number; close: () => Promise<void> }>
  connect(
    dshPort: number,
    onConnect: (socket: LanAccessDshStream) => void,
    onError: (error: Error) => void,
  ): void
}

interface ActiveProxy {
  config: LanAccessDshConfig
  actualListenPort: number
  close: () => Promise<void>
  sockets: Set<LanAccessDshStream>
  state: LanAccessDshSnapshot['state']
  error: string | null
}

export interface LanAccessDshLoginRecord extends LanAccessDshLoginConfig {}

export interface LanAccessDshLoginStore {
  read(): Promise<LanAccessDshLoginRecord | null>
  write(record: LanAccessDshLoginRecord): Promise<void>
  clear(): Promise<void>
}

/**
 * Cookie 不包含端口信息；多个 DSH 实例若共用名称，浏览器会在实例之间覆盖会话。
 * 正式环境保留旧名称，开发环境由启动包装命令显式指定独立名称。
 */
export const DEFAULT_LOGIN_PROTECTION_COOKIE_NAME = 'dsh_codingns_session'
const LOGIN_PROTECTION_COOKIE_NAME_ENV = 'CODINGNS4DSH_LOGIN_COOKIE_NAME'
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/u

export function resolveLoginProtectionCookieName(configured = process.env[LOGIN_PROTECTION_COOKIE_NAME_ENV]): string {
  const value = configured?.trim()
  return value !== undefined && value !== '' && value.length <= 128 && COOKIE_NAME_PATTERN.test(value)
    ? value
    : DEFAULT_LOGIN_PROTECTION_COOKIE_NAME
}

/** 浏览器中继只携带短期签名票据，密码哈希和签名密钥始终留在 Host。 */
export async function openLoginProtectionSession(
  store: LanAccessDshLoginStore,
  username: string,
  password: string,
  scope: keyof LoginProtectionScopes,
): Promise<{ token: string; expiresAt: string }> {
  const config = await store.read()
  if (config === null || !config.enabled || !config.scopes[scope]) return { token: '', expiresAt: new Date().toISOString() }
  if (username !== config.username || !verifyPassword(password, config)) throw new CodingNsRpcError('CODINGNS_RPC_UNAUTHENTICATED', '本地用户名或密码错误')
  return issueLoginProtectionSession(config, scope)
}

/** 在旧票据仍有效时滚动续签；过期票据不能借此恢复登录。 */
export async function refreshLoginProtectionSession(
  store: LanAccessDshLoginStore,
  token: string | undefined,
  scope: keyof LoginProtectionScopes,
): Promise<{ token: string; expiresAt: string }> {
  const config = await store.read()
  if (config === null || !config.enabled || !config.scopes[scope] || typeof token !== 'string' || !verifySignedSessionToken(token, config, scope)) {
    throw new CodingNsRpcError('CODINGNS_RPC_UNAUTHENTICATED', '登录保护会话已失效，请重新登录')
  }
  return issueLoginProtectionSession(config, scope)
}

/** 校验中继票据；配置关闭或未覆盖该范围时保持向后兼容，直接放行。 */
export async function verifyLoginProtectionSession(
  store: LanAccessDshLoginStore,
  token: string | undefined,
  scope: keyof LoginProtectionScopes,
): Promise<boolean> {
  const config = await store.read()
  if (config === null || !config.enabled || !config.scopes[scope]) return true
  return typeof token === 'string' && verifySignedSessionToken(token, config, scope)
}

/** 测试和嵌入式宿主使用的内存凭据存储。 */
export class InMemoryLanAccessDshLoginStore implements LanAccessDshLoginStore {
  private value: LanAccessDshLoginRecord | null = null
  async read(): Promise<LanAccessDshLoginRecord | null> { return this.value === null ? null : { ...this.value } }
  async write(record: LanAccessDshLoginRecord): Promise<void> { this.value = { ...record } }
  async clear(): Promise<void> { this.value = null }
}

/** 登录保护凭据与 Codingns4DSH refresh token 分离保存，文件权限限制为当前用户。 */
export class FileLanAccessDshLoginStore implements LanAccessDshLoginStore {
  constructor(private readonly filePath = join(defaultStateDir(), 'lan-access-login.json')) {}
  async read(): Promise<LanAccessDshLoginRecord | null> {
    try { return parseLoginRecord(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown) }
    catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw error }
  }
  async write(record: LanAccessDshLoginRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temp = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.filePath)
  }
  async clear(): Promise<void> {
    try { await (await import('node:fs/promises')).unlink(this.filePath) }
    catch (error) { if (!isNodeError(error, 'ENOENT')) throw error }
  }
}

function defaultStateDir(): string {
  const configured = process.env.CODINGNS4DSH_STATE_DIR?.trim()
  return configured === undefined || configured === '' ? join(homedir(), '.config', 'codingns4dsh') : configured
}

const LISTEN_HOSTS = new Set(['127.0.0.1', '0.0.0.0', '::1', '::'])

/** Host 侧默认运行时：枚举网卡、读取 DSH 启动参数并建立 TCP 转发。 */
export function createNodeLanAccessDshRuntime(dshWebPort?: number): LanAccessDshRuntime {
  return {
    listListenHosts: () => {
      const addresses = new Set<string>(['0.0.0.0', '127.0.0.1'])
      for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
          if (entry.address !== '127.0.0.1' && entry.address !== '::1') addresses.add(entry.address)
        }
      }
      return [...addresses]
    },
    detectDshPorts: async () => detectDshPortsFromRuntime(dshWebPort),
    listen: (config, onConnection) => new Promise((resolve, reject) => {
      const server = createServer((socket) => onConnection(socket as unknown as LanAccessDshStream))
      const onError = (error: Error): void => {
        server.removeListener('error', onError)
        reject(error)
      }
      server.once('error', onError)
      server.listen({ port: config.listenPort, host: config.listenHost }, () => {
        server.removeListener('error', onError)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('局域网访问 DSH 监听器未返回有效端口'))
          return
        }
        resolve({
          actualPort: address.port,
          close: () => new Promise((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose())
          }),
        })
      })
    }),
    connect: (dshPort, onConnect, onError) => {
      const socket = connect({ port: dshPort, host: '127.0.0.1' })
      socket.once('connect', () => onConnect(socket as unknown as LanAccessDshStream))
      socket.once('error', (error: unknown) => onError(error instanceof Error ? error : new Error(String(error))))
    },
  }
}

/** 管理唯一一条“监听地址/端口 -> 当前 DSH Web 端口”的映射。 */
export class LanAccessDshProxy {
  private active: ActiveProxy | null = null
  private detectedDshPorts: readonly number[] = []
  private loginConfig: LanAccessDshLoginConfig | null = null
  /** 当前进程内主动退出的会话；正常会话由签名令牌承载，可跨代理重建复用。 */
  private readonly revokedSessions = new Set<string>()
  private readonly loginAttempts = new LoginAttemptGuard()
  private upstreamCookie: string | null = null
  private pwaProvider: LanAccessDshPwaProvider | null = null

  constructor(
    private readonly runtime: LanAccessDshRuntime = createNodeLanAccessDshRuntime(),
    private readonly authenticatedUrl?: string,
    sessionCookieName = resolveLoginProtectionCookieName(),
  ) {
    this.sessionCookieName = resolveLoginProtectionCookieName(sessionCookieName)
  }

  private readonly sessionCookieName: string

  listenHosts(): readonly string[] {
    return this.runtime.listListenHosts()
  }

  async detect(): Promise<readonly number[]> {
    this.detectedDshPorts = uniquePorts(await this.runtime.detectDshPorts())
    return this.detectedDshPorts
  }

  async start(input: Partial<LanAccessDshConfig>): Promise<LanAccessDshSnapshot> {
    const dshPort = input.dshPort ?? (await this.resolveDetectedPort())
    const config = normalizeLanAccessDshConfig({
      listenHost: input.listenHost ?? '0.0.0.0',
      listenPort: input.listenPort ?? 13080,
      dshPort,
      ...(input.login === undefined
        ? (this.loginConfig === null ? {} : { login: this.loginConfig })
        : { login: normalizeLoginConfig(input.login) }),
    }, this.listenHosts())
    this.setLoginConfig(config.login ?? null)
    if (this.active) await this.stop()

    const active: ActiveProxy = {
      config,
      actualListenPort: 0,
      close: async () => undefined,
      sockets: new Set(),
      state: 'starting',
      error: null,
    }
    this.active = active
    try {
      const listener = await this.runtime.listen(config, (socket) => this.accept(active, socket))
      active.actualListenPort = listener.actualPort
      active.close = listener.close
      active.state = 'listening'
      try {
        await this.takeOverDshWebToken()
      } catch (error) {
        // Token 交换失败不能撤销已经绑定的局域网端口；保留监听并记录错误，后续请求会收到上游认证状态。
        active.error = error instanceof Error ? error.message : String(error)
        console.error('codingns4dsh: DSH Web Token 接管失败，局域网监听仍保持可用', error)
      }
      return this.snapshot(active)
    } catch (error) {
      this.active = null
      active.state = 'error'
      active.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async stop(): Promise<void> {
    const active = this.active
    if (!active) return
    this.active = null
    active.state = 'stopped'
    for (const socket of active.sockets) socket.destroy()
    active.sockets.clear()
    this.revokedSessions.clear()
    this.loginAttempts.reset()
    await active.close()
  }

  async close(): Promise<void> {
    await this.stop()
  }

  get(): LanAccessDshSnapshot | null {
    return this.active ? this.snapshot(this.active) : null
  }

  setLoginConfig(config: LanAccessDshLoginConfig | null): void {
    this.loginConfig = config === null ? null : normalizeLoginConfig(config)
    this.loginAttempts.reset()
    if (config === null || !config.enabled) this.revokedSessions.clear()
  }

  /** 注入 PWA 资产来源；传 null 表示回到“不提供 PWA 资产”的原始行为。 */
  setPwaProvider(provider: LanAccessDshPwaProvider | null): void {
    this.pwaProvider = provider
  }

  /** PWA 资产就绪状态；只描述代理侧能力，不含浏览器状态与凭据。 */
  pwaStatus(): LanAccessDshPwaStatus {
    const bundle = this.pwaProvider?.snapshot() ?? null
    return {
      listening: this.active?.state === 'listening',
      manifest: bundle !== null,
      serviceWorker: bundle?.serviceWorker !== null && bundle?.serviceWorker !== undefined,
      marker: bundle?.marker ?? null,
      assetPaths: bundle === null ? [] : [...bundle.assets.keys()],
      paths: { manifest: PWA_MANIFEST_PATH, serviceWorker: PWA_SERVICE_WORKER_PATH },
    }
  }

  loginSettings(): LanAccessDshLoginSettings {
    const config = this.loginConfig
    return {
      enabled: config?.enabled === true,
      username: config?.username ?? '',
      passwordConfigured: config !== null && config.passwordHash.length > 0,
      timeoutSeconds: config?.timeoutSeconds ?? 1800,
      scopes: config?.scopes ?? defaultLoginScopes(),
    }
  }

  private async resolveDetectedPort(): Promise<number> {
    const ports = this.detectedDshPorts.length > 0 ? this.detectedDshPorts : await this.detect()
    if (ports.length === 0) throw new LanAccessDshError('DSH_PORT_NOT_FOUND', '未能自动探测 DSH Web 端口，请手动填写')
    if (ports.length > 1) throw new LanAccessDshError('DSH_PORT_AMBIGUOUS', `自动探测到多个 DSH Web 端口，请手动选择: ${ports.join(', ')}`)
    return ports[0]!
  }

  private accept(active: ActiveProxy, localSocket: LanAccessDshStream): void {
    if (active.state !== 'listening') {
      localSocket.destroy()
      return
    }
    active.sockets.add(localSocket)
    const removeLocal = (): void => { active.sockets.delete(localSocket) }
    localSocket.once('close', removeLocal)
    localSocket.once('error', removeLocal)
    this.runtime.connect(active.config.dshPort, (dshSocket) => {
      if (active.state !== 'listening') {
        dshSocket.destroy()
        localSocket.destroy()
        return
      }
      active.sockets.add(dshSocket)
      const removeDsh = (): void => { active.sockets.delete(dshSocket) }
      dshSocket.once('close', removeDsh)
      dshSocket.once('error', removeDsh)
      // DSH 的 API 信任校验依据上游看到的 Host/Origin。局域网入口的地址
      // 与真实 DSH 地址不同，直接透传会导致静态页面能打开但所有 /api 返回 403。
      // 改写请求头，并兼容旧版 Connection RPC 的正文格式；响应和 WebSocket 帧仍然
      // 原样双向转发。测试运行时的最小 FakeStream 没有 Node Writable 接口，保留原始
      // pipe 以便验证连接关系。
      if (typeof (dshSocket as unknown as { on?: unknown }).on === 'function') {
        const localAddress = isLoopbackSocket(localSocket)
        const authTransform = new LanAccessDshAuthTransform(localSocket, (request) => this.authorize(request, localAddress, localSocket))
        const requestTransform = new LanAccessDshRequestTransform(`127.0.0.1:${active.config.dshPort}`, this.upstreamCookie)
        localSocket.pipe(authTransform as unknown as LanAccessDshStream)
        authTransform.pipe(requestTransform as unknown as NodeJS.WritableStream)
        requestTransform.pipe(dshSocket as unknown as NodeJS.WritableStream)
      } else localSocket.pipe(dshSocket)
      dshSocket.pipe(localSocket)
    }, (error) => localSocket.destroy(error))
  }

  private snapshot(active: ActiveProxy): LanAccessDshSnapshot {
    const { login: _login, ...publicConfig } = active.config
    return {
      ...publicConfig,
      state: active.state,
      actualListenPort: active.actualListenPort || null,
      detectedDshPorts: this.detectedDshPorts,
      error: active.error,
      loginEnabled: this.loginConfig?.enabled === true,
    }
  }

  private authorize(request: ParsedLanRequest, localAddress: boolean, localSocket: LanAccessDshStream): Uint8Array | 'pass' {
    const config = this.loginConfig
    // 登录页与登录错误按浏览器自己的语言渲染；DSH 只支持 zh/en，其它语言回退中文。
    const locale = resolveAcceptLanguageLocale(request.headers['accept-language'])
    const loginContext = createLoginAttemptContext(readRemoteAddress(localSocket), request.headers)
    // PeerHost 的握手和目标 Host 认证端点必须在建立登录保护会话前可达：
    // 握手只返回公开能力摘要，auth/login 负责交换目标 Host 自己签发的短期票据。
    // 其他 API 仍然经过登录保护，不把业务数据面暴露给未登录客户端。
    if (request.method === 'GET' && request.path === '/api/public/host-handshake') return 'pass'
    const authResponse = resolvePeerHostAuthResponse(request, config, this.revokedSessions, this.loginAttempts, loginContext)
    if (authResponse !== undefined) return authResponse
    // Host-to-Host 请求不持有浏览器 Cookie，而是由 PeerHost Host 侧注入目标 Host
    // 签发的 Bearer 票据；只放行固定资源白名单，票据本身必须通过签名校验。
    if (isPeerHostRouteRequest(request)) {
      const token = readBearerToken(request.headers.authorization)
      if (token !== undefined) {
        return verifyPeerHostAccessToken(config, token, this.revokedSessions)
          ? 'pass'
          : loginResponse(401, '需要登录')
      }
    }
    // PWA 静态资产先于登录判定：它们只包含公开元数据，未登录时也可取；命中时
    // 直接合成响应，不进入上游转发路径。
    const pwaResponse = this.authorizePwa(request)
    if (pwaResponse !== undefined) return pwaResponse
    if (request.path === '/__codingns/captcha' && request.method === 'GET') {
      const captchaId = readQueryParameter(request.query, 'id')
      const svg = !localAddress && config !== null && config.enabled && config.scopes.lan && captchaId !== undefined
        ? this.loginAttempts.renderCaptcha(captchaId, loginContext)
        : undefined
      return svg === undefined
        ? synthLanResponse({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not Found' })
        : synthLanResponse({ status: 200, contentType: 'image/svg+xml; charset=utf-8', body: svg })
    }
    if (request.path === '/__codingns/session' && request.method === 'GET') {
      const token = readCookie(request.headers.cookie, this.sessionCookieName)
      const authenticated = !localAddress && config !== null && config.enabled && config.scopes.lan
        && token !== undefined && !this.revokedSessions.has(token)
        && verifySignedSessionToken(token, config, 'lan')
      const expiresAt = authenticated && config !== null && token !== undefined ? readLoginProtectionSessionExpiresAt(token, config, 'lan') : null
      return loginJsonResponse(200, authenticated
        ? { authenticated: true, username: config.username, ...(expiresAt === null ? {} : { expiresAt }) }
        : { authenticated: false })
    }
    if (request.path === '/__codingns/session/refresh' && request.method === 'POST') {
      const token = readCookie(request.headers.cookie, this.sessionCookieName)
      if (localAddress || config === null || !config.enabled || !config.scopes.lan || token === undefined || this.revokedSessions.has(token) || !verifySignedSessionToken(token, config, 'lan')) {
        return loginJsonResponse(401, { authenticated: false })
      }
      const session = issueLoginProtectionSession(config, 'lan')
      this.revokedSessions.delete(session.token)
      return loginJsonResponse(200, { authenticated: true, username: config.username, expiresAt: session.expiresAt }, {
        'Set-Cookie': sessionCookie(this.sessionCookieName, session.token, config.timeoutSeconds),
      })
    }
    if (localAddress || config === null || !config.enabled || !config.scopes.lan) return 'pass'
    if (request.path === '/__codingns/login' && request.method === 'POST') {
      const form = new URLSearchParams(new TextDecoder().decode(request.body))
      const username = form.get('username') ?? ''
      const captchaId = form.get('captchaId') ?? undefined
      const captchaCode = form.get('captchaCode') ?? undefined
      const attempt = this.loginAttempts.beforeLogin(loginContext, {
        ...(captchaId === undefined ? {} : { captchaId }),
        ...(captchaCode === undefined ? {} : { captchaCode }),
      })
      if (!attempt.allowed) {
        const challenge = this.loginAttempts.requiresCaptcha(loginContext) ? this.loginAttempts.issueCaptcha(loginContext) : undefined
        const message = attempt.reason === 'rate_limited'
          ? hostBrowserText(locale, 'login.rateLimited', { seconds: attempt.retryAfterSeconds })
          : hostBrowserText(locale, 'login.badCaptcha')
        return loginResponse(429, loginPageWithError(message, username, challenge, locale), { 'Retry-After': String(attempt.retryAfterSeconds) })
      }
      if (username !== config.username || !verifyPassword(form.get('password') ?? '', config)) {
        this.loginAttempts.recordFailure(loginContext)
        const challenge = this.loginAttempts.requiresCaptcha(loginContext) ? this.loginAttempts.issueCaptcha(loginContext) : undefined
        return loginResponse(401, loginPageWithError(hostBrowserText(locale, 'login.badCredentials'), username, challenge, locale))
      }
      this.loginAttempts.recordSuccess(loginContext)
      const expiresAt = Date.now() + config.timeoutSeconds * 1000
      const payload = encodeSessionPayload({ username: config.username, scope: 'lan', expiresAt, nonce: randomBytes(16).toString('base64url') })
      const token = `${payload}.${signSessionPayload(payload, config)}`
      this.revokedSessions.delete(token)
      return loginResponse(303, '', { 'Set-Cookie': sessionCookie(this.sessionCookieName, token, config.timeoutSeconds), Location: '/' })
    }
    if (request.path === '/__codingns/logout') {
      const token = readCookie(request.headers.cookie, this.sessionCookieName)
      if (token !== undefined && verifySignedSessionToken(token, config, 'lan')) this.revokedSessions.add(token)
      return loginResponse(303, '', { 'Set-Cookie': clearSessionCookie(this.sessionCookieName), Location: '/' })
    }
    // 浏览器会在页面刷新时独立请求 Web App manifest；它只包含静态元数据，
    // 不应因为登录保护缺少 Cookie 而产生 401 控制台噪声。
    if (request.path === '/manifest.webmanifest' && request.method === 'GET') return 'pass'
    const token = readCookie(request.headers.cookie, this.sessionCookieName)
    if (token !== undefined && !this.revokedSessions.has(token) && verifySignedSessionToken(token, config, 'lan')) {
      return 'pass'
    }
    // 只有真正渲染登录页的 HTML 请求才签发验证码。浏览器会为 favicon、图标等
    // 静态资源发出额外的未登录请求，如果它们也签发验证码，就会不断翻转页面上
    // 已经渲染的 captchaId，用户永远提交不到与图片一致的答案。
    if (request.path !== '/' && !request.path.endsWith('.html')) return loginResponse(401, hostBrowserText(locale, 'login.required'))
    const challenge = this.loginAttempts.requiresCaptcha(loginContext) ? this.loginAttempts.issueCaptcha(loginContext) : undefined
    return loginResponse(200, loginPage(challenge, locale))
  }

  /**
   * PWA 白名单：`/manifest.webmanifest`、`/sw.js` 与 `/__codingns/pwa/*`。
   *
   * 返回 undefined 表示“不属于 PWA 白名单，或当前未启用”，交回原有登录与转发
   * 语义；这样关闭增强时行为与改造前完全一致。合成内容只有公开元数据与图标，
   * 不允许出现任何 Cookie、令牌或宿主路径。
   */
  private authorizePwa(request: ParsedLanRequest): Uint8Array | undefined {
    // manifest 的 description 属于浏览器可见文案，按请求语言选择。
    const locale = resolveAcceptLanguageLocale(request.headers['accept-language'])
    return resolveLanAccessDshPwaResponse(request, this.pwaProvider?.snapshot(locale) ?? null)
  }

  /** DSH 启动时的认证 URL 只在 Host 内交换一次 Cookie，绝不下发到浏览器。 */
  private async takeOverDshWebToken(): Promise<void> {
    if (this.authenticatedUrl === undefined) return
    const response = await fetch(this.authenticatedUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const cookie = getSetCookie(response.headers)
    if (response.status !== 303 || cookie === undefined) throw new Error(`DSH Web Token 接管失败 (${response.status})`)
    this.upstreamCookie = cookie
  }
}

/**
 * PeerHost 出站请求允许访问的固定路由白名单。
 *
 * 票据校验在调用方完成：这里只回答“这条路由是否属于 Host-to-Host 数据面”，
 * 避免把路径判定和签名校验混在一起，也避免把整个 LAN API 变成公开入口。
 */
export function isPeerHostRouteRequest(request: LanAccessDshPwaRequest): boolean {
  // WebSocket 只在目标入口鉴权，HTTP 则必须与发送端代理使用同一份规则。
  if (request.path === '/ws' || request.path.startsWith('/ws/')) return request.method.toUpperCase() === 'GET'
  return isPeerHostHttpRoute(request.method, request.path)
}

/** 已解析到登录保护边界的请求；PeerHost 认证与转发共用同一份最小字段。 */
export interface ParsedLanRequest {
  method: string
  path: string
  query?: string
  headers: Record<string, string>
  body: Uint8Array
}

/** PeerHost 目标侧认证端点；路径固定，客户端不能自定义目标或凭据格式。 */
export const PEER_HOST_AUTH_PATHS = {
  login: '/api/auth/login',
  refresh: '/api/auth/refresh',
  logout: '/api/auth/logout',
} as const

/**
 * PeerHost 目标侧认证裁决。
 *
 * 目标 Host 自己签发短期票据，当前 Host 才能在不保存目标密码的前提下代理请求。
 * 票据复用登录保护的签名材料；登录保护未覆盖局域网范围时返回占位票据，与
 * “未启用保护即放行”的既有语义保持一致。返回 undefined 表示不是认证端点。
 */
export function resolvePeerHostAuthResponse(
  request: ParsedLanRequest,
  config: LanAccessDshLoginConfig | null,
  revoked: Set<string>,
  loginAttempts?: LoginAttemptGuard,
  loginContext?: LoginAttemptContext,
): Uint8Array | undefined {
  if (request.method.toUpperCase() !== 'POST') return undefined
  if (request.path === PEER_HOST_AUTH_PATHS.login) {
    const credentials = readJsonBody(request.body)
    const username = typeof credentials?.username === 'string' ? credentials.username : ''
    const password = typeof credentials?.password === 'string' ? credentials.password : ''
    if (!peerHostLoginProtected(config)) return loginJsonResponse(200, issueOpenPeerHostCredential())
    const attempt = loginAttempts?.beforeLogin(loginContext ?? { ipAddress: 'unknown', deviceFingerprint: 'unknown-device' }, { allowCaptcha: false })
    if (attempt !== undefined && !attempt.allowed) {
      return loginJsonResponse(429, { error: { code: 'PEER_HOST_LOGIN_RATE_LIMITED', message: '目标 Host 登录尝试过于频繁' } }, { 'Retry-After': String(attempt.retryAfterSeconds) })
    }
    if (username === '' || password === '' || username !== config.username || !verifyPassword(password, config)) {
      if (loginAttempts !== undefined) loginAttempts.recordFailure(loginContext ?? { ipAddress: 'unknown', deviceFingerprint: 'unknown-device' })
      return loginJsonResponse(401, { error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '目标 Host 用户名或密码错误' } })
    }
    if (loginAttempts !== undefined) loginAttempts.recordSuccess(loginContext ?? { ipAddress: 'unknown', deviceFingerprint: 'unknown-device' })
    return loginJsonResponse(200, issuePeerHostCredential(config))
  }
  if (request.path === PEER_HOST_AUTH_PATHS.refresh) {
    const body = readJsonBody(request.body)
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : ''
    if (!peerHostLoginProtected(config)) return loginJsonResponse(200, issueOpenPeerHostCredential())
    if (refreshToken === '' || revoked.has(refreshToken) || !verifySignedSessionToken(refreshToken, config, 'lan')) {
      return loginJsonResponse(401, { error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '目标 Host 登录态已失效' } })
    }
    return loginJsonResponse(200, issuePeerHostCredential(config))
  }
  if (request.path === PEER_HOST_AUTH_PATHS.logout) {
    const token = readBearerToken(request.headers.authorization)
    if (token !== undefined && peerHostLoginProtected(config)) revoked.add(token)
    return loginJsonResponse(200, { ok: true })
  }
  return undefined
}

/** 校验 PeerHost 出站票据；登录保护未覆盖局域网范围时保持向后兼容。 */
export function verifyPeerHostAccessToken(config: LanAccessDshLoginConfig | null, token: string, revoked: ReadonlySet<string> = new Set()): boolean {
  if (!peerHostLoginProtected(config)) return true
  return !revoked.has(token) && verifySignedSessionToken(token, config, 'lan')
}

export function readBearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/u.exec(value?.trim() ?? '')
  return match?.[1]
}

function peerHostLoginProtected(config: LanAccessDshLoginConfig | null): config is LanAccessDshLoginConfig {
  return config !== null && config.enabled && config.scopes.lan
}

function issuePeerHostCredential(config: LanAccessDshLoginConfig): { accessToken: string; refreshToken: string; expiresIn: number } {
  return {
    accessToken: issueLoginProtectionSession(config, 'lan').token,
    refreshToken: issueLoginProtectionSession(config, 'lan').token,
    expiresIn: config.timeoutSeconds,
  }
}

/** 未启用登录保护时目标不校验票据，这里只保证 Host 侧凭据格式一致。 */
function issueOpenPeerHostCredential(): { accessToken: string; refreshToken: string; expiresIn: number } {
  return {
    accessToken: `open.${randomBytes(16).toString('base64url')}`,
    refreshToken: `open.${randomBytes(16).toString('base64url')}`,
    expiresIn: 3600,
  }
}

function readJsonBody(body: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** PWA 白名单判定所需的请求子集；单独抽出来便于直接单测。 */
export interface LanAccessDshPwaRequest {
  readonly method: string
  readonly path: string
}

/**
 * PWA 静态资产白名单：`/manifest.webmanifest`、`/sw.js` 与 `/__codingns/pwa/*`。
 *
 * 返回 undefined 表示“不属于白名单，或当前未启用”，交回原有登录与转发语义；
 * 这样关闭增强时行为与改造前完全一致。合成内容只有公开元数据与图标，不允许
 * 出现任何 Cookie、令牌或宿主路径。
 */
export function resolveLanAccessDshPwaResponse(
  request: LanAccessDshPwaRequest,
  bundle: LanAccessDshPwaBundle | null,
): Uint8Array | undefined {
  const path = request.path
  const inWhitelist = path === PWA_MANIFEST_PATH || path === PWA_SERVICE_WORKER_PATH || path.startsWith(PWA_ASSET_PREFIX)
  if (!inWhitelist) return undefined
  const headOnly = request.method === 'HEAD'
  if (request.method !== 'GET' && !headOnly) {
    return synthLanResponse({
      status: 405,
      contentType: 'text/plain; charset=utf-8',
      body: 'Method Not Allowed',
      headers: { Allow: 'GET, HEAD' },
    })
  }
  if (bundle === null) {
    // 未启用：manifest 与 SW 保持原有语义（manifest 透传上游、/sw.js 走登录/上游），
    // 图标路径没有上游对应物，直接 404 以免落到 SPA 兜底。
    return path.startsWith(PWA_ASSET_PREFIX)
      ? synthLanResponse({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not Found' })
      : undefined
  }
  if (path === PWA_MANIFEST_PATH) {
    return synthLanResponse({
      status: 200,
      contentType: 'application/manifest+json; charset=utf-8',
      body: bundle.manifest,
      cacheControl: 'public, max-age=300',
      headOnly,
    })
  }
  if (path === PWA_SERVICE_WORKER_PATH) {
    if (bundle.serviceWorker === null) return undefined
    return synthLanResponse({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: bundle.serviceWorker,
      // SW 脚本必须每次回源校验：插件升级后要能立刻安装新版本。
      cacheControl: 'no-cache',
      headOnly,
    })
  }
  const asset = bundle.assets.get(path)
  if (asset === undefined) {
    return synthLanResponse({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not Found' })
  }
  return synthLanResponse({
    status: 200,
    contentType: asset.contentType,
    body: asset.body,
    cacheControl: asset.cacheControl,
    headOnly,
  })
}

function isLoopbackSocket(socket: LanAccessDshStream): boolean {
  const remoteAddress = (socket as unknown as { remoteAddress?: unknown }).remoteAddress
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

function readRemoteAddress(socket: LanAccessDshStream): string | undefined {
  const remoteAddress = (socket as unknown as { remoteAddress?: unknown }).remoteAddress
  return typeof remoteAddress === 'string' ? remoteAddress : undefined
}

/** 在 TCP 转发前完成登录校验；未通过时直接向局域网客户端返回页面/错误。 */
class LanAccessDshAuthTransform extends Transform {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private handled = false
  constructor(
    private readonly client: LanAccessDshStream,
    private readonly authorize: (request: ParsedLanRequest) => Uint8Array | 'pass',
  ) { super() }
  _transform(chunk: Uint8Array, _encoding: string, callback: TransformCallback): void {
    if (this.handled) { callback(null, chunk); return }
    this.pending = concatBytes(this.pending, chunk)
    const end = findHeaderEnd(this.pending)
    if (end < 0) { if (this.pending.length > 64 * 1024) this.finish(loginResponse(431, '请求头过大')); callback(); return }
    const head = this.pending.subarray(0, end + 4)
    const headers = parseHeaders(head)
    const bodyLength = contentLengthOf(head)
    if (this.pending.length < end + 4 + bodyLength) { callback(); return }
    const requestLine = decodeLatin1(head).split('\r\n', 1)[0] ?? ''
    const parts = requestLine.split(' ')
    const target = parts[1] ?? '/'
    const querySeparator = target.indexOf('?')
    const request: ParsedLanRequest = {
      method: parts[0] ?? 'GET',
      path: querySeparator < 0 ? target : target.slice(0, querySeparator),
      ...(querySeparator < 0 ? {} : { query: target.slice(querySeparator + 1) }),
      headers,
      body: this.pending.subarray(end + 4, end + 4 + bodyLength),
    }
    const decision = this.authorize(request)
    if (decision === 'pass') {
      this.handled = true
      this.push(this.pending)
      this.pending = new Uint8Array(0)
    } else this.finish(decision)
    callback()
  }
  _flush(callback: TransformCallback): void { callback() }
  private finish(response: Uint8Array): void {
    if (this.handled) return
    this.handled = true
    const writable = this.client as unknown as { end?: (chunk?: Uint8Array) => void }
    // 让 Node Socket 自己 flush 完响应后关闭，不能 end 后立即 destroy，否则登录页可能被截断。
    writable.end?.(response)
  }
}

function parseHeaders(input: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of decodeLatin1(input).split('\r\n').slice(1)) {
    const separator = line.indexOf(':')
    if (separator > 0) result[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  return result
}

function readCookie(value: string | undefined, name: string): string | undefined {
  for (const item of (value ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator > 0 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim()
  }
  return undefined
}

function readQueryParameter(query: string | undefined, name: string): string | undefined {
  if (query === undefined) return undefined
  try {
    const value = new URLSearchParams(query).get(name)?.trim()
    return value === undefined || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

function sessionCookie(name: string, token: string, timeoutSeconds: number): string {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${timeoutSeconds}`
}

function issueLoginProtectionSession(config: LanAccessDshLoginConfig, scope: keyof LoginProtectionScopes): { token: string; expiresAt: string } {
  const expiresAt = Date.now() + config.timeoutSeconds * 1000
  const payload = encodeSessionPayload({ username: config.username, scope, expiresAt, nonce: randomBytes(16).toString('base64url') })
  return { token: `${payload}.${signSessionPayload(payload, config)}`, expiresAt: new Date(expiresAt).toISOString() }
}

function clearSessionCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

function getSetCookie(headers: Headers): string | undefined {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() ?? (headers.get('set-cookie') === null ? [] : [headers.get('set-cookie')!])
  return values.map((value) => value.split(';', 1)[0]).find((value) => value !== '')
}

/**
 * 合成响应助手。
 *
 * `loginResponse` 会把非 HTML/JSON 正文做 HTML 转义并强制 `text/plain`，不适合
 * 输出脚本与二进制。这里按字节原样发送，由调用方显式给出 Content-Type 与缓存
 * 策略；`headOnly` 用于 HEAD 请求，保留 Content-Length 但不发送正文。
 */
export interface LanSynthesizedResponse {
  readonly status: number
  readonly contentType: string
  readonly body?: Uint8Array | string
  readonly cacheControl?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly headOnly?: boolean
}

export function synthLanResponse(input: LanSynthesizedResponse): Uint8Array {
  const body = typeof input.body === 'string'
    ? new TextEncoder().encode(input.body)
    : input.body ?? new Uint8Array(0)
  const headers: Record<string, string> = {
    'Content-Type': input.contentType,
    'Content-Length': String(body.length),
    'Cache-Control': input.cacheControl ?? 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
    ...input.headers,
  }
  const head = encodeLatin1(`HTTP/1.1 ${input.status} ${statusText(input.status)}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
  return input.headOnly === true ? head : concatBytes(head, body)
}

function loginResponse(status: number, body: string, extra: Record<string, string> = {}): Uint8Array {
  const isHtml = body.startsWith('<!doctype html>')
  const isJson = extra['Content-Type']?.startsWith('application/json') === true
  const content = new TextEncoder().encode(isHtml || isJson ? body : escapeHtml(body))
  const headers = {
    'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': String(content.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
    ...extra,
  }
  const head = encodeLatin1(`HTTP/1.1 ${status} ${statusText(status)}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
  return concatBytes(head, content)
}

function loginJsonResponse(status: number, value: unknown, extra: Record<string, string> = {}): Uint8Array {
  return loginResponse(status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...extra })
}

function loginPage(captcha: { readonly id: string } | undefined, locale: HostLocale): string {
  const captchaFields = captcha === undefined ? '' : `<input type="hidden" name="captchaId" value="${escapeHtml(captcha.id)}"><div class="cyber-captcha" style="display:flex;flex-direction:row;align-items:center;gap:12px;width:100%;"><img src="/__codingns/captcha?id=${encodeURIComponent(captcha.id)}" width="140" height="52" alt="${escapeHtml(hostBrowserText(locale, 'login.captchaAlt'))}" style="display:block;flex:0 0 140px;width:140px;height:52px;border:1px solid rgba(59,130,246,.5);border-radius:7px;background:rgba(15,23,42,.68);"><input class="cyber-input" name="captchaCode" autocomplete="off" inputmode="text" maxlength="5" placeholder="${escapeHtml(hostBrowserText(locale, 'login.captchaPlaceholder'))}" required style="flex:1 1 auto;min-width:0;width:auto;height:52px;padding:12px 14px;border:1px solid rgba(59,130,246,.5);border-radius:8px;background:rgba(15,23,42,.68);box-shadow:inset 0 0 8px rgba(59,130,246,.12);color:#f1f5f9;font:14px var(--font-mono);outline:0;"></div>`
  // 视觉规则直接复用 codingns4dsh-h5/styles.css 的 Cyber 登录区，只把 Connect
  // 账号字段替换成本地用户名/密码；不能依赖外部 CSS，避免局域网入口离线时失效。
  // 与主页面使用相同的状态栏模式，登录前后都由系统保留顶部空间。
  return `<!doctype html><html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a0f1d"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><link rel="apple-touch-icon" sizes="180x180" href="/__codingns/pwa/apple-touch-icon.png"><title>${escapeHtml(hostBrowserText(locale, 'login.documentTitle'))}</title><style>
:root{font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;color:#f1f5f9;background:#0a0f1d}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0}body{overflow:hidden}.cyber-login-page{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:radial-gradient(ellipse at center,#0f172a 0%,#0a0f1d 100%);color:#f1f5f9}.cyber-login-page:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(59,130,246,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(59,130,246,.08) 1px,transparent 1px);background-size:50px 50px;transform:perspective(500px) rotateX(60deg);transform-origin:center top}.cyber-login-page:after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.15) 2px,rgba(0,0,0,.15) 4px)}.cyber-login-container{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:30px;width:min(440px,calc(100% - 32px));padding:calc(24px + env(safe-area-inset-top,0px)) calc(24px + env(safe-area-inset-right,0px)) calc(24px + env(safe-area-inset-bottom,0px)) calc(24px + env(safe-area-inset-left,0px))}.cyber-login-content{display:flex;flex-direction:column;align-items:center;gap:28px;width:100%}.cyber-brand{display:flex;flex-direction:column;align-items:center;gap:13px;text-align:center}.cyber-logo{display:grid;place-items:center;width:80px;height:80px;border:1px solid rgba(59,130,246,.48);border-radius:22px;color:#60a5fa;font-size:19px;font-weight:700;letter-spacing:2px;box-shadow:0 0 25px rgba(0,212,255,.35),inset 0 0 22px rgba(59,130,246,.18);transform:rotate(30deg)}.cyber-logo span{transform:rotate(-30deg)}.cyber-brand-title{margin:0;color:#f1f5f9;font-size:28px;font-weight:700;letter-spacing:4px}.cyber-brand-subtitle{margin:0;color:#94a3b8;font-size:12px;letter-spacing:1.5px}.cyber-card{width:100%;padding:30px;border:1px solid rgba(59,130,246,.28);border-radius:12px;background:rgba(30,41,59,.78);backdrop-filter:blur(10px);box-shadow:0 8px 32px rgba(0,0,0,.4),0 0 0 1px rgba(59,130,246,.28)}.cyber-card-header{display:flex;align-items:center;gap:12px;margin-bottom:22px}.cyber-line{flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(59,130,246,.48),transparent)}.cyber-card-label{color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:3px;white-space:nowrap}.cyber-form{display:flex;flex-direction:column;gap:18px}.cyber-connect-hint{margin:0;color:#94a3b8;font-size:12px;line-height:1.7}.cyber-field{position:relative;padding:12px 16px;border:1px solid rgba(59,130,246,.28);border-radius:8px;background:rgba(15,23,42,.68)}.cyber-field-label{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:#94a3b8;font-size:11px;letter-spacing:1px}.cyber-field-icon{color:#60a5fa}.cyber-input{width:100%;padding:0;border:0;outline:0;background:transparent;color:#f1f5f9;font:14px var(--font-mono)}.cyber-input::placeholder{color:#94a3b8;opacity:.55}.cyber-captcha{display:flex;align-items:center;gap:12px}.cyber-captcha img{display:block;flex:0 0 140px;width:140px;height:52px;border:1px solid rgba(59,130,246,.28);border-radius:7px}.cyber-captcha .cyber-input{flex:1;min-width:0;width:auto;padding:12px;border:1px solid rgba(59,130,246,.28);border-radius:8px;background:rgba(15,23,42,.68)}.cyber-submit{position:relative;width:100%;min-height:48px;margin-top:4px;padding:14px 24px;overflow:hidden;border:0;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:white;font:600 13px var(--font-mono);letter-spacing:2px;cursor:pointer;box-shadow:0 0 18px rgba(59,130,246,.32)}.cyber-submit:hover{filter:brightness(1.12)}.cyber-submit:active{transform:translateY(1px)}.cyber-submit:disabled{cursor:wait;opacity:.6}.cyber-submit-text{position:relative;display:flex;align-items:center;justify-content:center;gap:8px}.cyber-status{display:flex;align-items:center;gap:8px;margin:0;padding:10px 12px;border:1px solid rgba(239,68,68,.25);border-radius:6px;background:rgba(239,68,68,.1);color:#fca5a5;font-size:12px;line-height:1.5}.cyber-footer{margin-top:2px}.cyber-divider{display:flex;align-items:center;gap:12px;margin-bottom:14px}.cyber-divider-line{flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(59,130,246,.48),transparent)}.cyber-divider-text{color:#64748b;font-size:10px;letter-spacing:2px}.cyber-version{display:flex;align-items:center;gap:12px;color:#64748b;font-size:10px;letter-spacing:2px;opacity:.65}@media(prefers-color-scheme:light){.cyber-login-page{color:#0f172a;background:radial-gradient(ellipse at center,#f8fafc 0%,#eef4fb 100%)}.cyber-card{background:rgba(255,255,255,.86);box-shadow:0 8px 28px rgba(15,23,42,.12),0 0 0 1px rgba(37,99,235,.13)}.cyber-brand-title{color:#0f172a}.cyber-input{color:#0f172a}.cyber-connect-hint,.cyber-field-label,.cyber-card-label{color:#64748b}.cyber-field{background:rgba(241,245,249,.86)}}@media(max-width:520px){.cyber-login-container{width:100%;padding:calc(20px + env(safe-area-inset-top,0px)) calc(16px + env(safe-area-inset-right,0px)) calc(20px + env(safe-area-inset-bottom,0px)) calc(16px + env(safe-area-inset-left,0px))}.cyber-card{padding:24px 20px}.cyber-brand-subtitle{font-size:10px;letter-spacing:1px}}
</style></head><body><main class="cyber-login-page"><div class="cyber-login-container"><div class="cyber-login-content"><div class="cyber-brand"><div class="cyber-logo"><span>DSH</span></div><h1 class="cyber-brand-title">DSH Web</h1><p class="cyber-brand-subtitle">LOCAL SECURE DSH ENVIRONMENT</p></div><div class="cyber-card"><form class="cyber-form" method="post" action="/__codingns/login"><div class="cyber-card-header"><div class="cyber-line"></div><span class="cyber-card-label">LOCAL ACCESS</span><div class="cyber-line"></div></div><p class="cyber-connect-hint">${escapeHtml(hostBrowserText(locale, 'login.description'))}</p><div class="cyber-field"><label class="cyber-field-label" for="login-username"><span class="cyber-field-icon" aria-hidden="true">⌁</span>${escapeHtml(hostBrowserText(locale, 'login.username'))}</label><input class="cyber-input" id="login-username" name="username" autocomplete="username" placeholder="${escapeHtml(hostBrowserText(locale, 'login.usernamePlaceholder'))}" required></div><div class="cyber-field"><label class="cyber-field-label" for="login-password"><span class="cyber-field-icon" aria-hidden="true">⚷</span>${escapeHtml(hostBrowserText(locale, 'login.password'))}</label><input class="cyber-input" id="login-password" name="password" type="password" autocomplete="current-password" placeholder="${escapeHtml(hostBrowserText(locale, 'login.passwordPlaceholder'))}" required></div>${captchaFields}<button class="cyber-submit" type="submit"><span class="cyber-submit-text"><span aria-hidden="true">➤</span>${escapeHtml(hostBrowserText(locale, 'login.submit'))}</span></button><div class="cyber-footer"><div class="cyber-divider"><span class="cyber-divider-line"></span><span class="cyber-divider-text">CODINGNS</span><span class="cyber-divider-line"></span></div></div></form></div></div><div class="cyber-version"><span>CODINGNS4DSH</span><span>|</span><span>LOCAL AUTH READY</span></div></div></main></body></html>`
}

/** 登录失败时继续渲染完整登录页，避免浏览器落到无样式的纯文本错误页。 */
function loginPageWithError(message: string, username: string, captcha: { readonly id: string } | undefined, locale: HostLocale): string {
  const page = loginPage(captcha, locale)
  const status = `<p class="cyber-status" role="alert" aria-live="polite"><span aria-hidden="true">!</span>${escapeHtml(message)}</p>`
  return page
    .replace('<p class="cyber-connect-hint">', `${status}<p class="cyber-connect-hint">`)
    .replace('name="username" autocomplete="username"', `name="username" autocomplete="username" value="${escapeHtml(username)}"`)
}

function statusText(status: number): string {
  switch (status) {
    case 200: return 'OK'
    case 204: return 'No Content'
    case 301: return 'Moved Permanently'
    case 302: return 'Found'
    case 303: return 'See Other'
    case 400: return 'Bad Request'
    case 401: return 'Unauthorized'
    case 404: return 'Not Found'
    case 405: return 'Method Not Allowed'
    case 429: return 'Too Many Requests'
    case 431: return 'Request Header Fields Too Large'
    case 500: return 'Internal Server Error'
    default: return 'Request Error'
  }
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char) }

/**
 * 将局域网入口发往上游 DSH 的 HTTP 请求头改成上游自身的 authority。
 *
 * 代理是单用途的：每个普通 HTTP 请求都要求上游关闭连接，避免在不知道
 * Content-Length/分块边界时误把 keep-alive 上的第二个请求当成正文。WebSocket
 * 升级请求则保持 Upgrade，升级后的帧不再经过头部解析。
 */
export class LanAccessDshRequestTransform extends Transform {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private pendingRequest: PendingLanRequest | null = null
  private finished = false

  constructor(private readonly targetAuthority: string, private readonly upstreamCookie: string | null = null) {
    super()
  }

  _transform(chunk: Uint8Array, _encoding: string, callback: TransformCallback): void {
    if (this.finished) {
      callback(null, chunk)
      return
    }
    this.pending = concatBytes(this.pending, chunk)
    this.drainPending()
    callback()
  }

  _flush(callback: TransformCallback): void {
    if (this.pendingRequest !== null) {
      // 请求正文不完整时无法判断是否为 JSON，保留原正文并只改写请求头。
      this.push(rewriteLanAccessDshRequestHeaders(this.pendingRequest.head, this.targetAuthority, this.upstreamCookie ?? undefined))
      if (this.pending.length > 0) this.push(this.pending)
      callback()
      return
    }
    if (this.pending.length > 0) callback(null, this.pending)
    else callback()
  }

  private drainPending(): void {
    while (!this.finished) {
      if (this.pendingRequest !== null) {
        if (this.pending.length < this.pendingRequest.bodyLength) return
        const body = this.pending.subarray(0, this.pendingRequest.bodyLength)
        this.pending = this.pending.subarray(this.pendingRequest.bodyLength)
        const normalizedBody = normalizeLanAccessDshRpcBody(this.pendingRequest.path, this.pendingRequest.method, body)
        const head = rewriteLanAccessDshRequestHeaders(this.pendingRequest.head, this.targetAuthority, this.upstreamCookie ?? undefined)
        this.push(concatBytes(rewriteContentLength(head, normalizedBody.length), normalizedBody))
        this.pendingRequest = null
        continue
      }

      const end = findHeaderEnd(this.pending)
      if (end < 0) {
        // 请求头不应超过这个上限；超过时直接透传，避免代理因异常请求无限缓存。
        if (this.pending.length > 64 * 1024) {
          this.finished = true
          this.push(this.pending)
          this.pending = new Uint8Array(0)
        }
        return
      }

      const head = this.pending.subarray(0, end + 4)
      this.pending = this.pending.subarray(end + 4)
      const upgrade = isUpgradeRequest(head)
      if (upgrade) {
        // WebSocket 头部之后全部是帧数据，不能再次进入 HTTP 头缓存。
        this.push(rewriteLanAccessDshRequestHeaders(head, this.targetAuthority, this.upstreamCookie ?? undefined))
        this.finished = true
        if (this.pending.length > 0) {
          this.push(this.pending)
          this.pending = new Uint8Array(0)
        }
        return
      }
      // DSH 的普通请求均为无体 GET 或带 Content-Length 的 JSON POST。
      // 分块上传无法安全识别下一条请求，遇到它时透传本连接剩余字节。
      if (/\r\ntransfer-encoding:\s*[^\r\n]*\bchunked\b/iu.test(decodeLatin1(head))) {
        this.push(rewriteLanAccessDshRequestHeaders(head, this.targetAuthority, this.upstreamCookie ?? undefined))
        this.finished = true
        if (this.pending.length > 0) {
          this.push(this.pending)
          this.pending = new Uint8Array(0)
        }
        return
      }
      const bodyLength = contentLengthOf(head)
      if (bodyLength === 0) {
        this.push(rewriteLanAccessDshRequestHeaders(head, this.targetAuthority, this.upstreamCookie ?? undefined))
        continue
      }
      const requestLine = decodeLatin1(head).split('\r\n', 1)[0] ?? ''
      const parts = requestLine.split(' ')
      this.pendingRequest = {
        head,
        method: parts[0] ?? 'GET',
        path: (parts[1] ?? '/').split('?', 1)[0] ?? '/',
        bodyLength,
      }
    }
  }
}

interface PendingLanRequest {
  head: Uint8Array
  method: string
  path: string
  bodyLength: number
}

/** 兼容旧版 DSH Web Client 直接把 RPC 参数放入 payload 的请求格式。 */
export function normalizeLanAccessDshRpcBody(path: string, method: string, body: Uint8Array): Uint8Array {
  if (method.toUpperCase() !== 'POST' || !path.startsWith('/api/')) return body
  try {
    const message = JSON.parse(new TextDecoder().decode(body)) as unknown
    if (!isOfficialConnectionRpcMessage(message) || !isRecord(message.payload) || 'args' in message.payload) return body
    return new TextEncoder().encode(JSON.stringify({ ...message, payload: { args: message.payload } }))
  } catch {
    return body
  }
}

/** 只兼容 DSH 官方两段式 Remote endpoint，不能改写 CodingNS 自有 RPC。 */
function isOfficialConnectionRpcMessage(value: unknown): value is { type: 'client-request'; method: string; payload: unknown } {
  if (!isRecord(value) || value.type !== 'client-request' || typeof value.method !== 'string') return false
  const parts = value.method.split('/')
  return parts.length === 2 && parts.every((part) => part !== '') && parts[0] !== 'codingns'
}

/** 改写请求中的 Host、Origin，并关闭普通 HTTP 上游连接。 */
export function rewriteLanAccessDshRequestHeaders(input: Uint8Array, targetAuthority: string, upstreamCookie?: string): Uint8Array {
  const text = decodeLatin1(input)
  const lines = text.split('\r\n')
  const upgrade = isUpgradeRequest(input)
  let hasConnection = false
  let hasCookie = false
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line === '') continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).toLowerCase()
    if (name === 'host') lines[index] = `Host: ${targetAuthority}`
    else if (name === 'origin') lines[index] = `Origin: http://${targetAuthority}`
    else if (name === 'connection') {
      hasConnection = true
      if (!upgrade) lines[index] = 'Connection: close'
    } else if (name === 'cookie') hasCookie = true
  }
  if (upstreamCookie !== undefined) {
    if (hasCookie) {
      for (let index = 1; index < lines.length; index += 1) {
        if (lines[index]?.toLowerCase().startsWith('cookie:')) lines[index] = `Cookie: ${lines[index]!.slice(lines[index]!.indexOf(':') + 1).trim()}; ${upstreamCookie}`
      }
    } else lines.splice(-2, 0, `Cookie: ${upstreamCookie}`)
  }
  if (!upgrade && !hasConnection) lines.splice(-2, 0, 'Connection: close')
  return encodeLatin1(lines.join('\r\n'))
}

function contentLengthOf(input: Uint8Array): number {
  const match = /\r\ncontent-length:\s*(\d+)/iu.exec(decodeLatin1(input))
  return match?.[1] === undefined ? 0 : Number(match[1])
}

function rewriteContentLength(input: Uint8Array, length: number): Uint8Array {
  const lines = decodeLatin1(input).split('\r\n')
  for (let index = 1; index < lines.length; index += 1) {
    if (/^content-length\s*:/iu.test(lines[index] ?? '')) lines[index] = `Content-Length: ${length}`
  }
  return encodeLatin1(lines.join('\r\n'))
}

function isUpgradeRequest(input: Uint8Array): boolean {
  const text = decodeLatin1(input)
  return /\r\nconnection:\s*[^\r\n]*\bupgrade\b/iu.test(text)
    && /\r\nupgrade:\s*websocket\b/iu.test(text)
}

function concatBytes(first: Uint8Array<ArrayBufferLike>, second: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(first.length + second.length)
  result.set(first)
  result.set(second, first.length)
  return result
}

function findHeaderEnd(input: Uint8Array): number {
  for (let index = 0; index <= input.length - 4; index += 1) {
    if (input[index] === 13 && input[index + 1] === 10 && input[index + 2] === 13 && input[index + 3] === 10) return index
  }
  return -1
}

function decodeLatin1(input: Uint8Array): string {
  return Array.from(input, (byte) => String.fromCharCode(byte)).join('')
}

function encodeLatin1(input: string): Uint8Array {
  const result = new Uint8Array(input.length)
  for (let index = 0; index < input.length; index += 1) result[index] = input.charCodeAt(index) & 0xff
  return result
}

export class LanAccessDshError extends Error {
  constructor(readonly code: 'LAN_ACCESS_DSH_INVALID' | 'DSH_PORT_NOT_FOUND' | 'DSH_PORT_AMBIGUOUS', message: string) {
    super(message)
    this.name = code
  }
}

export function normalizeLanAccessDshConfig(value: Partial<LanAccessDshConfig>, allowedListenHosts?: readonly string[]): LanAccessDshConfig {
  const listenHost = requireText(value.listenHost, 'listenHost')
  const listenPort = requirePort(value.listenPort ?? 13080, 'listenPort', true)
  const dshPort = requirePort(value.dshPort, 'dshPort', false)
  const allowedHosts = allowedListenHosts === undefined ? LISTEN_HOSTS : new Set(allowedListenHosts)
  if (!allowedHosts.has(listenHost)) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '监听地址必须来自本机网卡或 0.0.0.0')
  return {
    listenHost,
    listenPort,
    dshPort,
    ...(value.login === undefined ? {} : { login: normalizeLoginConfig(value.login) }),
  }
}

export interface LanAccessDshRpcOptions {
  /** 推送服务；未提供时 `pwa/push/*` 返回可解释的不可用错误。 */
  readonly push?: PwaPushService
  /** 推送通知语言；缺省 `zh`。Host 侧主动推送没有浏览器请求上下文，只能读持久化偏好。 */
  readonly resolveLocale?: () => HostLocale
}

export function createLanAccessDshRpcHandler(
  proxy: LanAccessDshProxy,
  settings?: DshHostSettingsScope<CodingNsSettings>,
  loginStore: LanAccessDshLoginStore = new FileLanAccessDshLoginStore(),
  options: LanAccessDshRpcOptions = {},
): (action: string, payload: unknown) => unknown | Promise<unknown> {
  const requirePush = (): PwaPushService => {
    if (options.push === undefined) throw new CodingNsRpcError('CODINGNS_PWA_PUSH_UNAVAILABLE', '推送服务未启用')
    return options.push
  }
  return async (action, payload) => {
    switch (action) {
      case 'addresses':
        return proxy.listenHosts()
      case 'detect':
        return { ports: await proxy.detect() }
      case 'get':
        return proxy.get()
      case 'settings/get':
        return settings?.get().lanAccessDsh ?? defaultLanAccessDshSettings()
      case 'settings/set': {
        if (settings === undefined) throw new CodingNsRpcError('CODINGNS_SETTINGS_UNAVAILABLE', 'Codingns4DSH 设置服务不可用')
        const next = parseLanAccessDshSettings(payload, proxy.listenHosts(), settings.get().lanAccessDsh.pwa)
        await settings.update({ lanAccessDsh: next })
        return settings.get().lanAccessDsh
      }
      case 'login/get':
        return proxy.loginSettings()
      case 'pwa/status':
        return proxy.pwaStatus()
      case 'pwa/vapid': {
        const push = requirePush()
        return { available: true, publicKey: (await push.vapidKeys()).publicKey }
      }
      case 'pwa/push/status': {
        if (options.push === undefined) return { available: false, subscriptions: 0 }
        const subscriptions = await options.push.listSubscriptions()
        return { available: true, subscriptions: subscriptions.length }
      }
      case 'pwa/push/subscribe': {
        const push = requirePush()
        const input = parsePushSubscribePayload(payload)
        const record = await push.subscribe(input, readPushLabel(payload))
        return { endpoint: record.endpoint, createdAt: record.createdAt, subscriptions: (await push.listSubscriptions()).length }
      }
      case 'pwa/push/unsubscribe': {
        const push = requirePush()
        const endpoint = readPushEndpoint(payload)
        return { removed: await push.unsubscribe(endpoint) }
      }
      case 'pwa/push/test': {
        const push = requirePush()
        const locale = options.resolveLocale?.() ?? 'zh'
        const summary = await push.sendToAll({
          title: hostBrowserText(locale, 'push.testTitle'),
          body: hostBrowserText(locale, 'push.testBody'),
          tag: 'codingns4dsh-test',
        })
        return summary
      }
      case 'login/set': {
        const current = await loginStore.read()
        const next = parseLoginSettings(payload, current)
        if (next === null) {
          await loginStore.clear()
          proxy.setLoginConfig(null)
        } else {
          await loginStore.write(next)
          proxy.setLoginConfig(next)
        }
        const settings = proxy.loginSettings()
        if (next !== null && next.scopes.relay && isRecord(payload) && typeof payload.password === 'string' && payload.password !== '') {
          const sessionInput = parseLoginSessionPayload({ username: next.username, password: payload.password, scope: 'relay' })
          return { ...settings, relaySession: await openLoginProtectionSession(loginStore, sessionInput.username, sessionInput.password, 'relay') }
        }
        return settings
      }
      case 'login/session/open': {
        const input = parseLoginSessionPayload(payload)
        return openLoginProtectionSession(loginStore, input.username, input.password, input.scope)
      }
      case 'login/session/refresh': {
        const input = parseLoginSessionRefreshPayload(payload)
        return refreshLoginProtectionSession(loginStore, input.token, input.scope)
      }
      case 'start':
        return proxy.start(parseStartPayload(payload))
      case 'stop':
        await proxy.stop()
        return { stopped: true }
      default:
        throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知局域网访问 DSH RPC: lanAccessDsh/${action}`)
    }
  }
}

function parseLoginSessionPayload(value: unknown): { username: string; password: string; scope: keyof LoginProtectionScopes } {
  if (!value || typeof value !== 'object') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录会话参数必须是对象')
  const input = value as Record<string, unknown>
  const username = requireLoginText(input.username, '用户名', 1, 128)
  if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 256) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '密码格式无效')
  const scope = input.scope
  if (scope !== 'lan' && scope !== 'relay') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录会话应用范围无效')
  return { username, password: input.password, scope }
}

function parseLoginSessionRefreshPayload(value: unknown): { token: string; scope: keyof LoginProtectionScopes } {
  if (!value || typeof value !== 'object') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录会话刷新参数必须是对象')
  const input = value as Record<string, unknown>
  const token = requireLoginText(input.token, '会话票据', 32, 4096)
  const scope = input.scope === 'lan' || input.scope === 'relay' ? input.scope : undefined
  if (scope === undefined) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录会话范围无效')
  return { token, scope }
}

function defaultLanAccessDshSettings(): LanAccessDshSettings {
  return { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0, pwa: { ...DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS } }
}

function parseLoginSettings(value: unknown, current: LanAccessDshLoginRecord | null): LanAccessDshLoginRecord | null {
  if (!value || typeof value !== 'object') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录保护设置必须是对象')
  const input = value as Record<string, unknown>
  if (input.enabled === false) return null
  if (input.enabled !== true) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录保护 enabled 必须是布尔值')
  const username = requireLoginText(input.username, '用户名', 1, 128)
  const timeoutSeconds = requireInteger(input.timeoutSeconds, '超时时间', 60, 604800)
  const scopes = parseLoginScopes(input.scopes ?? current?.scopes)
  const password = typeof input.password === 'string' ? input.password : ''
  if (password === '') {
    if (current === null) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '启用登录保护时必须设置密码')
    return { enabled: true, username, passwordHash: current.passwordHash, passwordSalt: current.passwordSalt, timeoutSeconds, scopes }
  }
  return createLoginProtectionConfig({ username, password, timeoutSeconds, scopes })
}

/** 由明文密码生成登录保护配置；只在设置写入与测试夹具中使用，不回显密码。 */
export function createLoginProtectionConfig(input: {
  readonly username: string
  readonly password: string
  readonly timeoutSeconds: number
  readonly scopes: LoginProtectionScopes
}): LanAccessDshLoginConfig {
  const username = requireLoginText(input.username, '用户名', 1, 128)
  const timeoutSeconds = requireInteger(input.timeoutSeconds, '超时时间', 60, 604800)
  if (input.password.length < 8 || input.password.length > 256) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '密码长度必须是 8 到 256 个字符')
  const passwordSalt = randomBytes(16).toString('hex')
  return {
    enabled: true,
    username,
    passwordHash: hashPassword(input.password, passwordSalt),
    passwordSalt,
    timeoutSeconds,
    scopes: parseLoginScopes(input.scopes),
  }
}

function normalizeLoginConfig(value: LanAccessDshLoginConfig): LanAccessDshLoginConfig {
  if (typeof value !== 'object' || value === null) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录保护配置无效')
  return {
    enabled: value.enabled === true,
    username: requireLoginText(value.username, '用户名', 1, 128),
    passwordHash: requireLoginText(value.passwordHash, '密码哈希', 1, 512),
    passwordSalt: requireLoginText(value.passwordSalt, '密码盐', 1, 128),
    timeoutSeconds: requireInteger(value.timeoutSeconds, '超时时间', 60, 604800),
    scopes: parseLoginScopes(value.scopes),
  }
}

function parseLoginRecord(value: unknown): LanAccessDshLoginRecord {
  return normalizeLoginConfig(value as LanAccessDshLoginConfig)
}

function hashPassword(password: string, salt: string): string { return scryptSync(password, salt, 64).toString('hex') }
function verifyPassword(password: string, config: LanAccessDshLoginConfig): boolean {
  try {
    const expected = Buffer.from(config.passwordHash, 'hex')
    const actual = Buffer.from(hashPassword(password, config.passwordSalt), 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch { return false }
}
function encodeSessionPayload(value: { username: string; scope: keyof LoginProtectionScopes; expiresAt: number; nonce: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}
function signSessionPayload(payload: string, config: LanAccessDshLoginConfig): string {
  return createHmac('sha256', `${config.passwordSalt}:${config.passwordHash}`).update(payload).digest('base64url')
}
function verifySignedSessionToken(token: string, config: LanAccessDshLoginConfig, scope: keyof LoginProtectionScopes): boolean {
  if (token.length < 32 || token.length > 4096) return false
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return false
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  const expectedBytes = Buffer.from(signSessionPayload(payload, config))
  const actualBytes = Buffer.from(signature)
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) return false
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { username?: unknown; scope?: unknown; expiresAt?: unknown; nonce?: unknown }
    return value.username === config.username && value.scope === scope && typeof value.nonce === 'string' && typeof value.expiresAt === 'number' && value.expiresAt > Date.now()
  } catch { return false }
}

function readLoginProtectionSessionExpiresAt(token: string, config: LanAccessDshLoginConfig, scope: keyof LoginProtectionScopes): number | null {
  if (!verifySignedSessionToken(token, config, scope)) return null
  try {
    const value = JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString('utf8')) as { expiresAt?: unknown }
    return typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : null
  } catch { return null }
}
function requireLoginText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u001F\u007F]/u.test(value)) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', `${field} 格式无效`)
  return value.trim()
}
function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', `${field} 必须是 ${min} 到 ${max} 的整数`)
  return value as number
}
function defaultLoginScopes(): LoginProtectionScopes { return { lan: true, relay: true } }
function parseLoginScopes(value: unknown): LoginProtectionScopes {
  if (value === undefined) return defaultLoginScopes()
  if (!value || typeof value !== 'object') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录保护应用范围无效')
  const input = value as Record<string, unknown>
  if (typeof input.lan !== 'boolean' || typeof input.relay !== 'boolean') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '登录保护应用范围必须是布尔值')
  if (!input.lan && !input.relay) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '至少选择一个登录保护应用范围')
  return { lan: input.lan, relay: input.relay }
}
function isNodeError(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code }
/** 推送订阅只接受 endpoint + 两个密钥，其余字段忽略；非法输入给出稳定错误码。 */
function parsePushSubscribePayload(value: unknown): PwaPushSubscriptionInput {
  if (!isRecord(value)) throw new CodingNsRpcError('CODINGNS_PWA_PUSH_INVALID', '推送订阅参数无效')
  const keys = value.keys
  if (typeof value.endpoint !== 'string' || !isRecord(keys) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    throw new CodingNsRpcError('CODINGNS_PWA_PUSH_INVALID', '推送订阅参数无效')
  }
  return { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}

function readPushLabel(value: unknown): string {
  if (!isRecord(value)) return ''
  return typeof value.label === 'string' ? value.label : ''
}

function readPushEndpoint(value: unknown): string {
  if (!isRecord(value) || typeof value.endpoint !== 'string' || value.endpoint === '') {
    throw new CodingNsRpcError('CODINGNS_PWA_PUSH_INVALID', '推送订阅 endpoint 无效')
  }
  return value.endpoint
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

/**
 * 解析监听映射设置。
 *
 * PWA 设置已经移到「移动端访问增强」卡片，它的写入走设置 RPC 的 `lanAccessDsh.pwa` 路径；
 * 这里在请求未携带 `pwa` 时沿用当前值，避免用户在局域网卡片里只改监听端口就把手机端
 * 资产配置重置成默认档位。显式传入 `pwa` 时仍然走归一化。
 */
function parseLanAccessDshSettings(
  value: unknown,
  allowedListenHosts: readonly string[],
  currentPwa: LanAccessDshPwaSettings | null = null,
): LanAccessDshSettings {
  if (!value || typeof value !== 'object') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '局域网访问 DSH 设置必须是对象')
  const input = value as Record<string, unknown>
  if (typeof input.autoStart !== 'boolean') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', 'autoStart 必须是布尔值')
  const listenHost = requireText(input.listenHost, 'listenHost')
  const listenPort = requirePort(input.listenPort, 'listenPort', true)
  const dshPort = requirePort(input.dshPort, 'dshPort', true)
  if (!new Set(allowedListenHosts).has(listenHost)) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '监听地址必须来自本机网卡或 0.0.0.0')
  const pwa = input.pwa === undefined && currentPwa !== null
    ? currentPwa
    : parseLanAccessDshPwaSettings(input.pwa)
  return { autoStart: input.autoStart, listenHost, listenPort, dshPort, pwa }
}

/** PWA 档位走归一化而非严格校验：非法值收敛到保守默认，避免设置页写不进去。 */
function parseLanAccessDshPwaSettings(value: unknown): LanAccessDshPwaSettings {
  return normalizeLanAccessDshPwaSettings(value)
}

function parseStartPayload(value: unknown): Partial<LanAccessDshConfig> {
  if (!value || typeof value !== 'object') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '局域网访问 DSH 参数必须是对象')
  const input = value as Record<string, unknown>
  return {
    ...(typeof input.listenHost === 'string' ? { listenHost: input.listenHost } : {}),
    ...(typeof input.listenPort === 'number' ? { listenPort: input.listenPort } : {}),
    ...(typeof input.dshPort === 'number' ? { dshPort: input.dshPort } : {}),
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', `${field} 不能为空`)
  return value.trim()
}

function requirePort(value: unknown, field: string, allowZero: boolean): number {
  const minimum = allowZero ? 0 : 1
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > 65535) {
    throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', `${field} 必须是 ${minimum} 到 65535 的整数`)
  }
  return value as number
}

function uniquePorts(ports: readonly number[]): number[] {
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))]
}

function detectDshPortsFromRuntime(dshWebPort?: number): readonly number[] {
  const runtime = globalThis as typeof globalThis & {
    __DSH_WEB_PORT__?: unknown
    process?: { argv?: unknown; env?: Record<string, unknown> }
  }
  const values: unknown[] = [
    dshWebPort,
    runtime.__DSH_WEB_PORT__,
    runtime.process?.env?.DSH_WEB_PORT,
    runtime.process?.env?.DSH_PORT,
    runtime.process?.env?.PORT,
  ]
  const argv = Array.isArray(runtime.process?.argv) ? runtime.process.argv : []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--port' || value === '--dsh-port' || value === '--web-port') values.push(argv[index + 1])
    if (typeof value === 'string' && (value.startsWith('--port=') || value.startsWith('--dsh-port=') || value.startsWith('--web-port='))) values.push(value.slice(value.indexOf('=') + 1))
  }
  return uniquePorts(values
    .map((value) => typeof value === 'string' ? Number(value) : value)
    .filter((value): value is number => typeof value === 'number'))
}
