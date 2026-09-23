import { randomUUID } from 'node:crypto'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import type {
  TerminalLaunchProfile,
  TerminalLaunchProfileInput,
  TerminalProcessInstance,
  TerminalProcessLaunchRequest,
  TerminalProcessLaunchResult,
} from '../../shared/contracts/terminal-process.js'
import type { TerminalOwnerScope } from '../../shared/contracts/terminal.js'
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
      runtimeType: input.runtimeType,
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
        commandPath: profile.command,
        commandArgs: profile.args,
        commandEnv: profile.env,
        launchProfileId: profile.id,
        cwd,
        cols: request.cols,
        rows: request.rows,
        onExit: (exitCode) => { void this.handleExit(instanceId, exitCode) },
      })
      const record = this.options.terminalService.getRecord(identity)
      const runtime = await this.options.terminalService.inspect(identity)
      if (record === undefined) throw new Error('终端启动后记录丢失')
      instance = {
        ...instance,
        runtimeSessionKey: record.runtimeSessionKey,
        state: 'running',
        pid: runtime.runtimePid,
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

  private async handleExit(instanceId: string, exitCode: number | null): Promise<void> {
    const current = this.store.getInstance(instanceId)
    if (current === undefined || !isActive(current.state)) return
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
}

/** 与 Spec003 约定的名称；当前只承载 runtimeMode=pty 的终端进程。 */
export { TerminalProcessService as ProcessRuntimeService }

function isActive(state: TerminalProcessInstance['state']): boolean { return state === 'starting' || state === 'running' || state === 'stopping' }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
