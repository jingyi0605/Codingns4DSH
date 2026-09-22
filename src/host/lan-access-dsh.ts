import { connect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Transform, type TransformCallback } from 'node:stream'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CodingNsSettings, LanAccessDshSettings } from '../shared/contracts/config.js'
import type { LanAccessDshConfig, LanAccessDshSnapshot } from '../shared/contracts/lan-access-dsh.js'
import { CodingNsRpcError } from './rpc-table.js'

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
      const server = createServer((socket) => onConnection(socket))
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
      socket.once('connect', () => onConnect(socket))
      socket.once('error', (error: unknown) => onError(error instanceof Error ? error : new Error(String(error))))
    },
  }
}

/** 管理唯一一条“监听地址/端口 -> 当前 DSH Web 端口”的映射。 */
export class LanAccessDshProxy {
  private active: ActiveProxy | null = null
  private detectedDshPorts: readonly number[] = []

  constructor(private readonly runtime: LanAccessDshRuntime = createNodeLanAccessDshRuntime()) {}

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
    }, this.listenHosts())
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
    await active.close()
  }

  async close(): Promise<void> {
    await this.stop()
  }

  get(): LanAccessDshSnapshot | null {
    return this.active ? this.snapshot(this.active) : null
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
      // 只改写请求头，响应和 WebSocket 帧仍然原样双向转发。测试运行时的最小
      // FakeStream 没有 Node Writable 接口，保留原始 pipe 以便验证连接关系。
      if (typeof (dshSocket as unknown as { on?: unknown }).on === 'function') {
        const requestTransform = new LanAccessDshRequestTransform(`127.0.0.1:${active.config.dshPort}`)
        localSocket.pipe(requestTransform as unknown as LanAccessDshStream)
        requestTransform.pipe(dshSocket)
      } else localSocket.pipe(dshSocket)
      dshSocket.pipe(localSocket)
    }, (error) => localSocket.destroy(error))
  }

  private snapshot(active: ActiveProxy): LanAccessDshSnapshot {
    return {
      ...active.config,
      state: active.state,
      actualListenPort: active.actualListenPort || null,
      detectedDshPorts: this.detectedDshPorts,
      error: active.error,
    }
  }
}

/**
 * 将局域网入口发往上游 DSH 的 HTTP 请求头改成上游自身的 authority。
 *
 * 代理是单用途的：每个普通 HTTP 请求都要求上游关闭连接，避免在不知道
 * Content-Length/分块边界时误把 keep-alive 上的第二个请求当成正文。WebSocket
 * 升级请求则保持 Upgrade，升级后的帧不再经过头部解析。
 */
class LanAccessDshRequestTransform extends Transform {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private bodyRemaining = 0
  private finished = false

  constructor(private readonly targetAuthority: string) {
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
    if (this.pending.length > 0) callback(null, this.pending)
    else callback()
  }

  private drainPending(): void {
    while (!this.finished) {
      if (this.bodyRemaining > 0) {
        const size = Math.min(this.bodyRemaining, this.pending.length)
        if (size === 0) return
        this.push(this.pending.subarray(0, size))
        this.pending = this.pending.subarray(size)
        this.bodyRemaining -= size
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
      this.push(rewriteLanAccessDshRequestHeaders(head, this.targetAuthority))
      if (upgrade) {
        // WebSocket 头部之后全部是帧数据，不能再次进入 HTTP 头缓存。
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
        this.finished = true
        if (this.pending.length > 0) {
          this.push(this.pending)
          this.pending = new Uint8Array(0)
        }
        return
      }
      this.bodyRemaining = contentLengthOf(head)
    }
  }
}

/** 改写请求中的 Host、Origin，并关闭普通 HTTP 上游连接。 */
export function rewriteLanAccessDshRequestHeaders(input: Uint8Array, targetAuthority: string): Uint8Array {
  const text = decodeLatin1(input)
  const lines = text.split('\r\n')
  const upgrade = isUpgradeRequest(input)
  let hasConnection = false
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
    }
  }
  if (!upgrade && !hasConnection) lines.splice(-2, 0, 'Connection: close')
  return encodeLatin1(lines.join('\r\n'))
}

function contentLengthOf(input: Uint8Array): number {
  const match = /\r\ncontent-length:\s*(\d+)/iu.exec(decodeLatin1(input))
  return match?.[1] === undefined ? 0 : Number(match[1])
}

function isUpgradeRequest(input: Uint8Array): boolean {
  const text = decodeLatin1(input)
  return /\r\nconnection:\s*[^\r\n]*\bupgrade\b/iu.test(text)
    && /\r\nupgrade:\s*websocket\b/iu.test(text)
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
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
  return { listenHost, listenPort, dshPort }
}

export function createLanAccessDshRpcHandler(
  proxy: LanAccessDshProxy,
  settings?: SettingsScope<CodingNsSettings>,
): (action: string, payload: unknown) => unknown | Promise<unknown> {
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
        if (settings === undefined) throw new CodingNsRpcError('CODINGNS_SETTINGS_UNAVAILABLE', 'CodingNS 设置服务不可用')
        const next = parseLanAccessDshSettings(payload, proxy.listenHosts())
        await settings.update({ lanAccessDsh: next })
        return settings.get().lanAccessDsh
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

function defaultLanAccessDshSettings(): LanAccessDshSettings {
  return { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 }
}

function parseLanAccessDshSettings(value: unknown, allowedListenHosts: readonly string[]): LanAccessDshSettings {
  if (!value || typeof value !== 'object') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '局域网访问 DSH 设置必须是对象')
  const input = value as Record<string, unknown>
  if (typeof input.autoStart !== 'boolean') throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', 'autoStart 必须是布尔值')
  const listenHost = requireText(input.listenHost, 'listenHost')
  const listenPort = requirePort(input.listenPort, 'listenPort', true)
  const dshPort = requirePort(input.dshPort, 'dshPort', true)
  if (!new Set(allowedListenHosts).has(listenHost)) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '监听地址必须来自本机网卡或 0.0.0.0')
  return { autoStart: input.autoStart, listenHost, listenPort, dshPort }
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
