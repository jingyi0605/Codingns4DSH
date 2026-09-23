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

export interface DebugProxyService {
  enable(input: { workspaceId: string; profileId: string; instanceId: string; port: number }): Promise<DebugProxyBinding>
  disable(bindingId: string): Promise<void>
  get(bindingId: string): DebugProxyBinding | null
}

export interface DebugWorkspaceServiceOptions {
  readonly resolveWorkspaceRoot: (workspaceId: string) => string | null
  readonly terminalProcesses: TerminalProcessService
  readonly portInspector?: DebugPortInspector
  readonly proxyService?: DebugProxyService
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
    })
  }

  listInstances(workspaceId?: string): readonly TerminalProcessInstance[] { return this.options.terminalProcesses.listInstances(workspaceId) }
  getInstance(instanceId: string): TerminalProcessInstance | undefined { return this.options.terminalProcesses.getInstance(instanceId) }
  stop(instanceId: string): Promise<TerminalProcessInstance> { return this.options.terminalProcesses.stop(instanceId) }

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
    return { ...check, listening: false, process: null, checkedAt: new Date().toISOString() }
  }

  async enableProxy(workspaceId: string, profileId: string, instanceId: string): Promise<DebugProxyBinding> {
    if (this.options.proxyService === undefined) throw new Error('CodingNS 反向代理服务不可用')
    const profile = findProfile(await this.getConfig(workspaceId), profileId)
    if (!profile.proxy.enabled || profile.port === null) throw new Error('配置项未启用代理或没有端口')
    const instance = this.getInstance(instanceId)
    if (instance === undefined || instance.workspaceId !== workspaceId || instance.profileId !== profileId || !isActive(instance.state)) throw new Error('运行实例不存在或未运行')
    const process = await this.portInspector.inspect(profile.port)
    if (process === null) throw new Error('配置端口当前未监听')
    if (instance.pid !== null && process.pid !== instance.pid) throw new Error('配置端口未由当前运行实例监听')
    const binding = await this.options.proxyService.enable({ workspaceId, profileId, instanceId, port: profile.port })
    this.bindings.set(binding.id, binding)
    return binding
  }

  async disableProxy(workspaceId: string, bindingId: string): Promise<void> {
    const binding = this.bindings.get(bindingId) ?? this.options.proxyService?.get(bindingId) ?? null
    if (binding === null || binding.workspaceId !== workspaceId) throw new Error('代理绑定不存在')
    if (this.options.proxyService === undefined) throw new Error('CodingNS 反向代理服务不可用')
    await this.options.proxyService.disable(bindingId)
    this.bindings.delete(bindingId)
  }

  getProxy(bindingId: string): DebugProxyBinding | null { return this.bindings.get(bindingId) ?? this.options.proxyService?.get(bindingId) ?? null }

  private workspaceRoot(workspaceId: string): string {
    const root = this.options.resolveWorkspaceRoot(workspaceId)
    if (root === null || !isAbsolute(root)) throw new Error('Workspace 根目录不可用')
    return normalize(root)
  }

  private configFilename(workspaceId: string): string { return join(this.workspaceRoot(workspaceId), '.codingns', 'debug.json') }
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
