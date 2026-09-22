import { connect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
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
export function createNodeLanAccessDshRuntime(): LanAccessDshRuntime {
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
    detectDshPorts: async () => detectDshPortsFromRuntime(),
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
    })
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
      localSocket.pipe(dshSocket)
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

export class LanAccessDshError extends Error {
  constructor(readonly code: 'LAN_ACCESS_DSH_INVALID' | 'DSH_PORT_NOT_FOUND' | 'DSH_PORT_AMBIGUOUS', message: string) {
    super(message)
    this.name = code
  }
}

export function normalizeLanAccessDshConfig(value: Partial<LanAccessDshConfig>): LanAccessDshConfig {
  const listenHost = requireText(value.listenHost, 'listenHost')
  const listenPort = requirePort(value.listenPort ?? 13080, 'listenPort', true)
  const dshPort = requirePort(value.dshPort, 'dshPort', false)
  if (!LISTEN_HOSTS.has(listenHost)) throw new LanAccessDshError('LAN_ACCESS_DSH_INVALID', '监听地址必须来自本机网卡或 0.0.0.0')
  return { listenHost, listenPort, dshPort }
}

export function createLanAccessDshRpcHandler(proxy: LanAccessDshProxy): (action: string, payload: unknown) => unknown | Promise<unknown> {
  return async (action, payload) => {
    switch (action) {
      case 'addresses':
        return proxy.listenHosts()
      case 'detect':
        return { ports: await proxy.detect() }
      case 'get':
        return proxy.get()
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

function detectDshPortsFromRuntime(): readonly number[] {
  const runtime = globalThis as typeof globalThis & {
    __DSH_WEB_PORT__?: unknown
    process?: { argv?: unknown; env?: Record<string, unknown> }
  }
  const values: unknown[] = [runtime.__DSH_WEB_PORT__, runtime.process?.env?.DSH_WEB_PORT, runtime.process?.env?.DSH_PORT]
  const argv = Array.isArray(runtime.process?.argv) ? runtime.process.argv : []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--port' || value === '--dsh-port') values.push(argv[index + 1])
    if (typeof value === 'string' && (value.startsWith('--port=') || value.startsWith('--dsh-port='))) values.push(value.slice(value.indexOf('=') + 1))
  }
  return uniquePorts(values
    .map((value) => typeof value === 'string' ? Number(value) : value)
    .filter((value): value is number => typeof value === 'number'))
}
