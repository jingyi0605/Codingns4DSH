import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, isAbsolute, normalize } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { DebugConfig, DebugProfile } from '../shared/contracts/debug-config.js'
import { EMPTY_DEBUG_CONFIG, parseDebugConfig } from '../shared/contracts/debug-config.js'
import type { TerminalProcessInstance, TerminalProcessLaunchResult } from '../shared/contracts/terminal-process.js'
import type { TerminalProcessService } from './terminal/terminal-process-service.js'

export interface DebugPortProcess {
  readonly pid: number
  readonly startToken: string
  readonly command: string | null
  readonly cwd: string | null
}

export interface DebugPortInspector {
  inspect(port: number): Promise<DebugPortProcess | null>
  terminate(process: DebugPortProcess): Promise<void>
}

export interface DebugProxyBinding {
  readonly id: string
  readonly slug: string
  readonly url: string
  readonly workspaceId: string
  readonly profileId: string
  readonly instanceId: string
  readonly port: number
}

export interface DebugWorkspaceServiceOptions {
  readonly resolveWorkspaceRoot: (workspaceId: string) => string | null
  readonly terminalProcesses: TerminalProcessService
  readonly portInspector?: DebugPortInspector
}

export interface DebugPortCheck {
  readonly id: string
  readonly workspaceId: string
  readonly profileId: string
  readonly port: number
  readonly listening: boolean
  readonly process: DebugPortProcess | null
  readonly checkedAt: string
}

/** Spec003 的最小 Host 服务：配置、PTY 启动、端口检查和代理绑定。 */
export class DebugWorkspaceService {
  private readonly portInspector: DebugPortInspector
  private readonly checks = new Map<string, DebugPortCheck>()
  private readonly bindings = new Map<string, DebugProxyBinding>()
  private readonly bindingProcesses = new Map<string, DebugPortProcess>()

  constructor(private readonly options: DebugWorkspaceServiceOptions) {
    this.portInspector = options.portInspector ?? new NodeDebugPortInspector()
  }

  async getConfig(workspaceId: string): Promise<DebugConfig> {
    const filename = this.configFilename(workspaceId)
    try {
      return parseDebugConfig(JSON.parse(await readFile(filename, 'utf8')) as unknown)
    } catch (error) {
      if (isMissingFile(error)) return EMPTY_DEBUG_CONFIG
      throw error
    }
  }

  async saveConfig(workspaceId: string, value: unknown): Promise<DebugConfig> {
    const config = parseDebugConfig(value)
    const filename = this.configFilename(workspaceId)
    await mkdir(join(this.workspaceRoot(workspaceId), '.codingns'), { recursive: true, mode: 0o700 })
    const temporary = `${filename}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filename)
    return config
  }

  /** 更新一个已有启动项；运行中的实例继续使用启动时的旧参数。 */
  async updateProfile(workspaceId: string, profileId: string, value: unknown): Promise<DebugConfig> {
    const current = await this.getConfig(workspaceId)
    if (!current.profiles.some((profile) => profile.id === profileId)) throw new Error(`Spec003 配置项不存在: ${profileId}`)
    const parsed = parseDebugConfig({ version: 1, profiles: [value] })
    const profile = parsed.profiles[0]
    if (profile === undefined || profile.id !== profileId) throw new Error('更新配置项 ID 不匹配')
    return this.saveConfig(workspaceId, {
      version: 1,
      profiles: current.profiles.map((item) => item.id === profileId ? profile : item),
    })
  }

  /** 删除一个启动项；有活动实例时拒绝删除，避免留下无法管理的终端进程。 */
  async deleteProfile(workspaceId: string, profileId: string): Promise<DebugConfig> {
    const current = await this.getConfig(workspaceId)
    if (!current.profiles.some((profile) => profile.id === profileId)) throw new Error(`Spec003 配置项不存在: ${profileId}`)
    if (this.options.terminalProcesses.listInstances(workspaceId).some((instance) => instance.profileId === profileId && isActive(instance.state))) {
      throw new Error('配置项仍有活动进程，请先停止后再删除')
    }
    await this.options.terminalProcesses.deleteProfile(workspaceId, profileId)
    return this.saveConfig(workspaceId, { version: 1, profiles: current.profiles.filter((profile) => profile.id !== profileId) })
  }

  async launch(input: { workspaceId: string; profileId: string; dshSessionId?: string; cols: number; rows: number }): Promise<TerminalProcessLaunchResult> {
    const config = await this.getConfig(input.workspaceId)
    const profile = findProfile(config, input.profileId)
    await this.options.terminalProcesses.createProfile({
      id: profile.id,
      workspaceId: input.workspaceId,
      name: profile.name,
      cwdRelative: profile.cwdRelative,
      command: profile.command,
      args: profile.args,
      env: profile.env,
      shell: profile.shell,
      runtimeType: profile.runtimeType,
      runtimeMode: 'pty',
    })
    return this.options.terminalProcesses.launch({
      workspaceId: input.workspaceId,
      profileId: profile.id,
      ...(input.dshSessionId === undefined ? {} : { dshSessionId: input.dshSessionId }),
      cols: input.cols,
      rows: input.rows,
      commandMode: 'shell-input',
    })
  }

  listInstances(workspaceId?: string): readonly TerminalProcessInstance[] { return this.options.terminalProcesses.listInstances(workspaceId) }
  getInstance(instanceId: string): TerminalProcessInstance | undefined { return this.options.terminalProcesses.getInstance(instanceId) }
  async stop(instanceId: string): Promise<TerminalProcessInstance> {
    const stopped = await this.options.terminalProcesses.stop(instanceId)
    for (const binding of this.bindings.values()) {
      if (binding.instanceId === instanceId) {
        this.bindings.delete(binding.id)
        this.bindingProcesses.delete(binding.id)
      }
    }
    return stopped
  }

  async checkPort(workspaceId: string, profileId: string): Promise<DebugPortCheck> {
    const profile = findProfile(await this.getConfig(workspaceId), profileId)
    if (profile.port === null) throw new Error('配置项没有声明端口')
    const process = await this.portInspector.inspect(profile.port)
    const check: DebugPortCheck = {
      id: randomUUID(), workspaceId, profileId, port: profile.port,
      listening: process !== null, process, checkedAt: new Date().toISOString(),
    }
    this.checks.set(check.id, check)
    return check
  }

  async terminatePort(workspaceId: string, checkId: string): Promise<DebugPortCheck> {
    return this.killPortProcess(workspaceId, checkId)
  }

  /** 只结束端口对应的业务进程，不触碰 tmux/ConPTY 终端运行时。 */
  async killPortProcess(workspaceId: string, checkId: string): Promise<DebugPortCheck> {
    const check = this.checks.get(checkId)
    if (check === undefined || check.workspaceId !== workspaceId) throw new Error('端口检查结果不存在或已失效')
    if (Date.now() - Date.parse(check.checkedAt) > 60_000) {
      this.checks.delete(checkId)
      throw new Error('端口检查结果已过期，请重新检查')
    }
    const current = await this.portInspector.inspect(check.port)
    if (!sameProcess(check.process, current)) throw new Error('端口监听进程已变化，请重新检查')
    if (current === null) {
      this.checks.delete(checkId)
      return { ...check, listening: false, process: null, checkedAt: new Date().toISOString() }
    }
    await this.portInspector.terminate(current)
    this.checks.delete(checkId)
    this.revokeBindings(workspaceId, check.profileId, check.port)
    return { ...check, listening: false, process: null, checkedAt: new Date().toISOString() }
  }

  async enableProxy(workspaceId: string, profileId: string, instanceId: string): Promise<DebugProxyBinding> {
    const profile = findProfile(await this.getConfig(workspaceId), profileId)
    if (!profile.proxy.enabled || profile.port === null) throw new Error('配置项未启用代理或没有端口')
    const instance = this.getInstance(instanceId)
    if (instance === undefined || instance.workspaceId !== workspaceId || instance.profileId !== profileId || !isActive(instance.state)) throw new Error('运行实例不存在或未运行')
    const process = await this.portInspector.inspect(profile.port)
    if (process === null) throw new Error('配置端口当前未监听')
    if (instance.pid !== null && process.pid !== instance.pid) throw new Error('配置端口未由当前运行实例监听')
    const slug = randomUUID().replaceAll('-', '')
    const binding: DebugProxyBinding = {
      id: randomUUID(), slug, url: `/api/codingns/debug-proxy?slug=${encodeURIComponent(slug)}`,
      workspaceId, profileId, instanceId, port: profile.port,
    }
    this.bindings.set(binding.id, binding)
    this.bindingProcesses.set(binding.id, process)
    return binding
  }

  async disableProxy(workspaceId: string, bindingId: string): Promise<void> {
    const binding = this.bindings.get(bindingId) ?? null
    if (binding === null || binding.workspaceId !== workspaceId) throw new Error('代理绑定不存在')
    this.bindings.delete(bindingId)
    this.bindingProcesses.delete(bindingId)
  }

  getProxy(bindingId: string): DebugProxyBinding | null { return this.bindings.get(bindingId) ?? null }

  /** 由插件自己的 Fetch 路由调用；不接受任意 Host、端口或 URL。 */
  async handleProxyRequest(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url)
    const slug = requestUrl.searchParams.get('slug')
    const binding = slug === null ? undefined : [...this.bindings.values()].find((item) => item.slug === slug)
    if (binding === undefined) return new Response('代理绑定不存在', { status: 404 })
    if (isUpgradeRequest(request.headers)) return new Response('WebSocket 代理未由 DSH Fetch 接口提供', { status: 501 })
    const instance = this.getInstance(binding.instanceId)
    if (instance === undefined || instance.workspaceId !== binding.workspaceId || !isActive(instance.state)) {
      this.bindings.delete(binding.id)
      this.bindingProcesses.delete(binding.id)
      return new Response('运行实例已停止', { status: 404 })
    }
    const process = await this.portInspector.inspect(binding.port)
    const expectedProcess = this.bindingProcesses.get(binding.id)
    if (process === null || expectedProcess === undefined || !sameProcess(expectedProcess, process) || (instance.pid !== null && process.pid !== instance.pid)) {
      this.bindings.delete(binding.id)
      this.bindingProcesses.delete(binding.id)
      return new Response('端口监听身份已变化', { status: 404 })
    }
    const targetPath = requestUrl.searchParams.get('path') ?? '/'
    let parsedPath: URL
    try { parsedPath = new URL(targetPath, 'http://127.0.0.1') } catch { return new Response('代理路径非法', { status: 400 }) }
    if (parsedPath.origin !== 'http://127.0.0.1' || !parsedPath.pathname.startsWith('/')) return new Response('代理路径非法', { status: 400 })
    const upstreamHeaders = new Headers()
    request.headers.forEach((value, key) => { if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'host') upstreamHeaders.set(key, value) })
    const init: RequestInit = { method: request.method, headers: upstreamHeaders, redirect: 'manual', signal: request.signal }
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer()
    let response: Response
    try {
      response = await fetch(`http://127.0.0.1:${binding.port}${parsedPath.pathname}${parsedPath.search}`, init)
    } catch (error) {
      return new Response(error instanceof Error ? error.message : '上游服务不可达', { status: 502 })
    }
    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => { if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value) })
    const location = response.headers.get('location')
    if (location !== null) responseHeaders.set('location', rewriteLocation(location, binding.url))
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders })
  }

  private workspaceRoot(workspaceId: string): string {
    const root = this.options.resolveWorkspaceRoot(workspaceId)
    if (root === null || !isAbsolute(root)) throw new Error('Workspace 根目录不可用')
    return normalize(root)
  }

  private revokeBindings(workspaceId: string, profileId: string, port: number): void {
    for (const binding of this.bindings.values()) {
      if (binding.workspaceId !== workspaceId || binding.profileId !== profileId || binding.port !== port) continue
      this.bindings.delete(binding.id)
      this.bindingProcesses.delete(binding.id)
    }
  }

  private configFilename(workspaceId: string): string { return join(this.workspaceRoot(workspaceId), '.codingns', 'debug.json') }
}

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function isUpgradeRequest(headers: Headers): boolean { return headers.get('upgrade')?.toLowerCase() === 'websocket' }

function rewriteLocation(location: string, proxyUrl: string): string {
  try {
    const parsed = new URL(location, 'http://127.0.0.1')
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return location
    return `${proxyUrl}&path=${encodeURIComponent(`${parsed.pathname}${parsed.search}`)}`
  } catch { return location }
}

/** Node 平台的最小端口观察器；具体系统命令只留在这一层。 */
export class NodeDebugPortInspector implements DebugPortInspector {
  async inspect(port: number): Promise<DebugPortProcess | null> {
    const result = process.platform === 'win32'
      ? spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
      : spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpct'], { encoding: 'utf8' })
    if (result.status !== 0 && result.stdout.trim() === '') return null
    const pid = process.platform === 'win32' ? parseWindowsPid(result.stdout, port) : parsePosixPid(result.stdout)
    if (pid === null) return null
    const details = spawnSync(process.platform === 'win32' ? 'powershell' : 'ps', process.platform === 'win32'
      ? ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Path`]
      : ['-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true })
    const lines = details.stdout.trim().split(/\s{2,}|\n/u).map((line) => line.trim()).filter(Boolean)
    const startToken = lines[0] ?? ''
    if (startToken === '') return null
    return { pid, startToken, command: lines.slice(1).join(' ') || null, cwd: null }
  }

  async terminate(processInfo: DebugPortProcess): Promise<void> {
    if (processInfo.startToken.trim() === '') throw new Error('无法确认进程启动身份')
    process.kill(processInfo.pid, 'SIGTERM')
  }
}

function findProfile(config: DebugConfig, profileId: string): DebugProfile {
  const profile = config.profiles.find((item) => item.id === profileId)
  if (profile === undefined) throw new Error(`Spec003 配置项不存在: ${profileId}`)
  return profile
}

function sameProcess(left: DebugPortProcess | null, right: DebugPortProcess | null): boolean {
  return left === null ? right === null : right !== null && left.pid === right.pid && left.startToken === right.startToken
}

function isActive(state: TerminalProcessInstance['state']): boolean { return state === 'starting' || state === 'running' || state === 'stopping' }
function isMissingFile(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }

function parsePosixPid(output: string): number | null {
  const match = output.match(/(?:^|\n)p(\d+)(?:\n|$)/u)
  return match?.[1] === undefined ? null : Number(match[1])
}

function parseWindowsPid(output: string, port: number): number | null {
  const suffix = `:${port}`
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u)
    if (fields[1]?.endsWith(suffix) && fields[3] === 'LISTENING') return Number(fields[4]) || null
  }
  return null
}
