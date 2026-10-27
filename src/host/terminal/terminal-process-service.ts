import { randomUUID } from 'node:crypto'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import type {
  TerminalLaunchProfile,
  TerminalLaunchProfileInput,
  TerminalProcessInstance,
  TerminalProcessLaunchRequest,
  TerminalProcessLaunchResult,
} from '../../shared/contracts/terminal-process.js'
import type { CodingNsWebTerminalInfo, TerminalOwnerScope } from '../../shared/contracts/terminal.js'
import { CodingNsTerminalService } from './terminal-service.js'
import { TerminalProcessStore, validateProfile } from './terminal-process-store.js'

export interface TerminalProcessServiceOptions {
  readonly hostId: string
  readonly terminalService: CodingNsTerminalService
  readonly resolveWorkspaceRoot: (workspaceId: string) => string | null
  readonly now?: () => Date
}

/** 终端侧最小启动器：Host 先创建 PTY 命令，再让现有终端 controller attach。 */
export class TerminalProcessService {
  private readonly now: () => Date

  constructor(
    private readonly store: TerminalProcessStore,
    private readonly options: TerminalProcessServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<void> { await this.store.load() }

  listProfiles(workspaceId?: string): readonly TerminalLaunchProfile[] { return this.store.listProfiles(workspaceId) }

  listWorkspaceTerminals(workspaceId: string): readonly CodingNsWebTerminalInfo[] {
    if (this.options.resolveWorkspaceRoot(workspaceId) === null) throw new Error('工作区不可用')
    const runningIds = new Set(this.store.listInstances(workspaceId)
      .filter((instance) => instance.state === 'running')
      .map((instance) => instance.terminalId))
    return this.options.terminalService.listWorkspace(this.options.hostId, workspaceId)
      .filter((terminal) => terminal.state === 'running' && runningIds.has(terminal.id))
  }

  listWorkspaceTerminalsForSession(workspaceId: string, sessionId: string): readonly CodingNsWebTerminalInfo[] {
    const instances = this.liveInstancesForSession(workspaceId, sessionId, true)
    const terminals = new Map(this.options.terminalService.listWorkspace(this.options.hostId, workspaceId).map((terminal) => [terminal.id, terminal]))
    return instances.flatMap((instance) => {
      const info = terminals.get(instance.terminalId)
      return info === undefined || info.state !== 'running' ? [] : [info]
    })
  }

  async readSessionTerminalOutput(workspaceId: string, sessionId: string, terminalId: string, maxBytes = 16 * 1024): Promise<{ readonly text: string; readonly truncated: boolean }> {
    const instance = this.requireLiveSessionInstance(workspaceId, sessionId, terminalId, true)
    const identity = { hostId: this.options.hostId, workspaceId, dshSessionId: sessionId, terminalId: instance.terminalId }
    return this.options.terminalService.readOutput(identity, maxBytes)
  }

  async writeSessionTerminalInput(workspaceId: string, sessionId: string, terminalId: string, data: string): Promise<void> {
    if (typeof data !== 'string' || data.length === 0 || Buffer.byteLength(data, 'utf8') > 16 * 1024) {
      throw new TypeError('终端输入必须为 1 到 16384 UTF-8 字节')
    }
    const instance = this.requireLiveSessionInstance(workspaceId, sessionId, terminalId, true)
    const identity = { hostId: this.options.hostId, workspaceId, dshSessionId: sessionId, terminalId: instance.terminalId }
    await this.options.terminalService.writeInitialInput(identity, data)
  }

  async readTerminalOutput(workspaceId: string, terminalId: string, maxBytes = 16 * 1024, dshSessionId?: string): Promise<{ readonly text: string; readonly truncated: boolean }> {
    this.requireLiveAuthorizedInstance(workspaceId, terminalId)
    const record = this.options.terminalService.getRecord({ hostId: this.options.hostId, workspaceId, terminalId })
    if (dshSessionId !== undefined && record?.dshSessionId !== dshSessionId) throw new Error('终端不属于指定 DSH Session')
    const identity = { hostId: this.options.hostId, workspaceId, ...(record?.dshSessionId === undefined ? {} : { dshSessionId: record.dshSessionId }), terminalId }
    return this.options.terminalService.readOutput(identity, maxBytes)
  }

  async writeTerminalInput(workspaceId: string, terminalId: string, data: string, dshSessionId?: string): Promise<void> {
    if (typeof data !== 'string' || data.length === 0 || Buffer.byteLength(data, 'utf8') > 16 * 1024) {
      throw new TypeError('终端输入必须为 1 到 16384 UTF-8 字节')
    }
    this.requireLiveAuthorizedInstance(workspaceId, terminalId)
    const record = this.options.terminalService.getRecord({ hostId: this.options.hostId, workspaceId, terminalId })
    if (dshSessionId !== undefined && record?.dshSessionId !== dshSessionId) throw new Error('终端不属于指定 DSH Session')
    const identity = { hostId: this.options.hostId, workspaceId, ...(record?.dshSessionId === undefined ? {} : { dshSessionId: record.dshSessionId }), terminalId }
    await this.options.terminalService.writeInitialInput(identity, data)
  }

  async createProfile(input: TerminalLaunchProfileInput): Promise<TerminalLaunchProfile> {
    const current = this.store.getProfile(input.workspaceId, input.id)
    const timestamp = this.now().toISOString()
    const profile: TerminalLaunchProfile = {
      id: input.id,
      workspaceId: input.workspaceId,
      name: input.name,
      cwdRelative: input.cwdRelative,
      command: input.command,
      args: [...(input.args ?? [])],
      env: { ...(input.env ?? {}) },
      shell: { ...input.shell, args: [...input.shell.args] },
      // 配置可能来自 tmux 不可用时的旧版本；Host 以当前实际注册的 backend 为准，
      // 保证已有调试配置不会因为运行模式切换而彻底无法启动。
      runtimeType: this.options.terminalService.resolveRuntimeType(input.runtimeType),
      runtimeMode: 'pty',
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    validateProfile(profile)
    await this.store.putProfile(profile)
    return profile
  }

  async deleteProfile(workspaceId: string, profileId: string): Promise<boolean> {
    if (this.store.listInstances(workspaceId).some((instance) => instance.profileId === profileId && isActive(instance.state))) {
      throw new Error('终端启动项仍有活动进程，不能删除')
    }
    return this.store.deleteProfile(workspaceId, profileId)
  }

  getInstance(instanceId: string): TerminalProcessInstance | undefined { return this.store.getInstance(instanceId) }
  listInstances(workspaceId?: string): readonly TerminalProcessInstance[] { return this.store.listInstances(workspaceId) }

  async readInstanceOutput(instanceId: string, maxBytes = 16 * 1024): Promise<{ readonly text: string; readonly truncated: boolean }> {
    const instance = this.requireLiveAuthorizedProcessInstance(instanceId)
    return this.options.terminalService.readOutput({
      hostId: this.options.hostId,
      workspaceId: instance.workspaceId,
      terminalId: instance.terminalId,
    }, maxBytes)
  }

  async writeInstanceInput(instanceId: string, data: string): Promise<void> {
    if (typeof data !== 'string' || data.length === 0 || Buffer.byteLength(data, 'utf8') > 16 * 1024) {
      throw new TypeError('终端输入必须为 1 到 16384 UTF-8 字节')
    }
    const instance = this.requireLiveAuthorizedProcessInstance(instanceId)
    await this.options.terminalService.writeInitialInput({
      hostId: this.options.hostId,
      workspaceId: instance.workspaceId,
      terminalId: instance.terminalId,
    }, data)
  }

  async launch(request: TerminalProcessLaunchRequest): Promise<TerminalProcessLaunchResult> {
    const profile = this.store.getProfile(request.workspaceId, request.profileId)
    if (profile === undefined) throw new Error('终端启动项不存在')
    const cwd = this.resolveCwd(profile)
    const terminalId = request.terminalId ?? `process-${randomUUID()}`
    const instanceId = `instance-${randomUUID()}`
    const startedAt = this.now().toISOString()
    let instance: TerminalProcessInstance = {
      id: instanceId,
      workspaceId: request.workspaceId,
      profileId: profile.id,
      terminalId,
      runtimeSessionKey: null,
      state: 'starting',
      pid: null,
      resolvedCommand: { command: profile.command, args: [...profile.args], cwd },
      exitCode: null,
      startedAt,
      stoppedAt: null,
    }
    await this.store.putInstance(instance)
    const scope: TerminalOwnerScope = {
      hostId: this.options.hostId,
      workspaceId: request.workspaceId,
      ...(request.dshSessionId === undefined ? {} : { dshSessionId: request.dshSessionId }),
    }
    const identity = { ...scope, terminalId }
    try {
      if (this.options.terminalService.getRecord(identity) !== undefined) throw new Error('指定 terminalId 已经存在，不能覆盖已有终端')
      const terminal = await this.options.terminalService.create({
        scope,
        terminalId,
        runtimeType: profile.runtimeType,
        shell: profile.shell,
        ...(request.commandMode === 'shell-input' ? { title: `${profile.name}(${profile.shell.name})` } : {}),
        ...(request.commandMode === 'shell-input' ? {} : { commandPath: profile.command, commandArgs: profile.args }),
        commandEnv: profile.env,
        launchProfileId: profile.id,
        cwd,
        cols: request.cols,
        rows: request.rows,
        onExit: (exitCode, kind) => { void this.handleExit(instanceId, exitCode, kind) },
      })
      if (request.commandMode === 'shell-input') {
        await this.options.terminalService.writeInitialInput(identity, buildShellInput(profile))
      }
      const record = this.options.terminalService.getRecord(identity)
      const runtime = await this.options.terminalService.inspect(identity)
      if (record === undefined) throw new Error('终端启动后记录丢失')
      instance = {
        ...instance,
        runtimeSessionKey: record.runtimeSessionKey,
        state: 'running',
        // Shell-input 模式的 runtime PID 是交互 Shell，不是实际监听端口的业务进程。
        // 业务进程身份由 DebugWorkspaceService 的端口快照单独确认。
        pid: request.commandMode === 'shell-input' ? null : runtime.runtimePid,
      }
      await this.store.putInstance(instance)
      return { instance, terminal }
    } catch (error) {
      await this.store.putInstance({ ...instance, state: 'failed', error: errorMessage(error), stoppedAt: this.now().toISOString() })
      try { await this.options.terminalService.close(identity) } catch { /* 创建失败时可能尚未有终端记录 */ }
      throw error
    }
  }

  async stop(instanceId: string): Promise<TerminalProcessInstance> {
    const instance = this.store.getInstance(instanceId)
    if (instance === undefined) throw new Error('终端进程实例不存在')
    if (!isActive(instance.state)) return instance
    await this.store.putInstance({ ...instance, state: 'stopping' })
    try {
      await this.options.terminalService.close({
        hostId: this.options.hostId,
        workspaceId: instance.workspaceId,
        terminalId: instance.terminalId,
      })
      const latest = this.store.getInstance(instanceId) ?? instance
      const stopped: TerminalProcessInstance = { ...latest, state: 'exited', stoppedAt: this.now().toISOString() }
      await this.store.putInstance(stopped)
      return stopped
    } catch (error) {
      const failed = { ...instance, state: 'failed' as const, error: errorMessage(error), stoppedAt: this.now().toISOString() }
      await this.store.putInstance(failed)
      throw error
    }
  }

  async recover(): Promise<void> {
    for (const instance of this.store.listInstances()) {
      if (!isActive(instance.state)) continue
      const identity = { hostId: this.options.hostId, workspaceId: instance.workspaceId, terminalId: instance.terminalId }
      try {
        const runtime = await this.options.terminalService.inspect(identity)
        await this.store.putInstance({ ...instance, state: runtime.alive ? 'running' : 'lost', pid: runtime.runtimePid, ...(runtime.alive ? {} : { error: runtime.detail ?? '终端运行时不存在' }) })
      } catch (error) {
        await this.store.putInstance({ ...instance, state: 'lost', error: errorMessage(error) })
      }
    }
  }

  private async handleExit(instanceId: string, exitCode: number | null, kind: 'exited' | 'lost'): Promise<void> {
    const current = this.store.getInstance(instanceId)
    if (current === undefined || !isActive(current.state)) return
    // 连接层断开不能写成 exited；调试面板必须能区分"进程结束"和"运行时丢失"。
    if (kind === 'lost') {
      await this.store.putInstance({
        ...current,
        state: 'lost',
        error: '终端运行时已丢失（不是进程正常退出）',
        stoppedAt: this.now().toISOString(),
      })
      return
    }
    await this.store.putInstance({ ...current, state: 'exited', exitCode, stoppedAt: this.now().toISOString() })
  }

  private resolveCwd(profile: TerminalLaunchProfile): string {
    const root = this.options.resolveWorkspaceRoot(profile.workspaceId)
    if (root === null || !isAbsolute(root)) throw new Error('Workspace 根目录不可用')
    const cwd = normalize(join(root, profile.cwdRelative))
    const escaped = relative(root, cwd)
    if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error('终端启动项工作目录越出 Workspace')
    return cwd
  }

  private requireLiveAuthorizedProcessInstance(instanceId: string): TerminalProcessInstance {
    const instance = this.store.getInstance(instanceId)
    if (instance === undefined || instance.state !== 'running'
      || this.options.resolveWorkspaceRoot(instance.workspaceId) === null) {
      throw new Error('终端实例不存在、未运行或工作区不可用')
    }
    return instance
  }

  private requireLiveAuthorizedInstance(workspaceId: string, terminalId: string): TerminalProcessInstance {
    if (this.options.resolveWorkspaceRoot(workspaceId) === null) throw new Error('工作区不可用')
    const matches = this.store.listInstances(workspaceId).filter((instance) => instance.terminalId === terminalId && instance.state === 'running')
    if (matches.length !== 1) throw new Error('终端进程实例不存在、未运行或不唯一')
    return matches[0]!
  }

  private liveInstancesForSession(workspaceId: string, sessionId: string, requireRecordedOwner = false): readonly TerminalProcessInstance[] {
    if (this.options.resolveWorkspaceRoot(workspaceId) === null) throw new Error('工作区不可用')
    return this.store.listInstances(workspaceId).filter((instance) => {
      if (instance.state !== 'running') return false
      const record = this.options.terminalService.getRecord({ hostId: this.options.hostId, workspaceId, terminalId: instance.terminalId })
      if (record?.state !== 'running') return false
      return requireRecordedOwner ? record.dshSessionId === sessionId : record.dshSessionId === undefined || record.dshSessionId === sessionId
    })
  }

  private requireLiveSessionInstance(workspaceId: string, sessionId: string, terminalId: string, requireRecordedOwner = false): TerminalProcessInstance {
    const matches = this.liveInstancesForSession(workspaceId, sessionId, requireRecordedOwner).filter((instance) => instance.terminalId === terminalId)
    if (matches.length !== 1) throw new Error('终端实例不存在、未运行或不属于该会话')
    return matches[0]!
  }
}

/** 与 Spec003 约定的名称；当前只承载 runtimeMode=pty 的终端进程。 */
export { TerminalProcessService as ProcessRuntimeService }

function isActive(state: TerminalProcessInstance['state']): boolean { return state === 'starting' || state === 'running' || state === 'stopping' }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** 按目标 Shell 的语法编码命令参数，避免把参数中的空格重新拆开。 */
function buildShellInput(profile: TerminalLaunchProfile): string {
  const command = [profile.command, ...profile.args]
  const shellType = profile.shell.profileId === 'cmd'
    ? 'cmd'
    : profile.shell.profileId === 'powershell'
      ? 'powershell'
      : 'posix'
  const line = shellType === 'powershell'
    ? `& ${command.map(powerShellQuote).join(' ')}`
    : command.map(shellType === 'cmd' ? cmdQuote : posixQuote).join(' ')
  return `${line}${shellType === 'posix' ? '\n' : '\r'}`
}

function posixQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function powerShellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'` }
function cmdQuote(value: string): string { return `"${value.replaceAll('"', '""')}"` }
