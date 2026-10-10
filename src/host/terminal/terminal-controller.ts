import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TerminalBindingScope, TerminalEnhancementSettings } from '../../shared/contracts/config.js'
import type {
  CodingNsTerminalCreateRequest,
  CodingNsTerminalEnvironment,
  CodingNsTerminalFrame,
  CodingNsTerminalRetentionFrame,
  CodingNsTerminalRuntimeType,
  CodingNsTerminalShell,
  CodingNsTerminalShellOption,
  CodingNsWebTerminalInfo,
  TerminalOwnerScope,
  TerminalRecordIdentity,
} from '../../shared/contracts/terminal.js'
import {
  detectTerminalShells,
  resolveTerminalShell,
  type DetectedTerminalShell,
  type TerminalShellProfileId,
} from './shell-detection.js'
import { CodingNsTerminalService, TerminalServiceError } from './terminal-service.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'
import { stripTerminalDeviceAttributeResponses } from '../../shared/terminal-input.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'terminal/unavailable': Record<string, never>
    'terminal/control-unavailable': { readonly reason: 'read-only' | 'not-running' }
    'terminal/limit-reached': { readonly limit: number }
  }
}

export interface DshTerminalAgent {
  readonly id: string
  readonly session: { readonly header?: { readonly cwd?: string } }
}

/** 只依赖 DSH Workspace Registry 的公开消费面，不导入 Host 私有实现。 */
interface WorkspaceRegistryLike {
  readonly list: () => readonly WorkspaceLike[]
}

interface WorkspaceLike {
  readonly id: string
  readonly sessionIds: readonly string[]
}

export interface CodingNsTerminalControllerOptions {
  readonly hostId: string
  readonly service: CodingNsTerminalService
  readonly settings: () => TerminalEnhancementSettings
  readonly platform?: string
  readonly generation?: (agent: DshTerminalAgent, attachmentId: string) => string
  readonly workspaceId?: (agent: DshTerminalAgent, cwd: string) => string
  /**
   * 会话的「当前目录」。
   *
   * alpha.2 起由 `ctx.workingDirectory` 提供（可被模型用 `working_directory` 工具切换）；
   * 旧版本没有该服务，缺省时回退到不可变的 `session.header.cwd`。回调只读不写，
   * 因此不会触发上游的目录恢复或 `working-directory/change` 事件。
   */
  readonly workingDirectory?: (agent: DshTerminalAgent) => string | undefined
  /** 终端解析出 Workspace 后登记 Host 侧可信根目录，供调试服务复用。 */
  readonly registerWorkspaceRoot?: (workspaceId: string, cwd: string) => void
  /** 基线模式固定使用进程内 PTY；强化模式再按平台选择持久 backend。 */
  readonly runtimeType?: (
    profileId: Exclude<TerminalShellProfileId, 'system'>,
    platform: string,
  ) => CodingNsTerminalRuntimeType
  readonly detectShells?: () => readonly DetectedTerminalShell[]
  readonly maxTerminals?: number
  readonly maxInputBytes?: number
  readonly maxCols?: number
  readonly maxRows?: number
}

/** Codingns4DSH 自有终端 Host controller，避免与 DSH 官方 `remote.terminal` 冲突。 */
export class CodingNsTerminalController extends TypertRemoteService {
  static inject = ['typert']
  private readonly platform: string
  private readonly detectShells: () => readonly DetectedTerminalShell[]
  private readonly maxTerminals: number
  private readonly maxInputBytes: number
  private readonly maxCols: number
  private readonly maxRows: number
  /** 绑定范围与 controller 一样在 DSH 启动时锁定，避免运行中切换造成终端集合瞬间变化。 */
  private readonly bindingScope: TerminalBindingScope
  /** list/retain 的官方 wire 只有 sessionId；这里把它解析到工作区后再查持久终端。 */
  private readonly sessionWorkspaces = new Map<string, string>()

  constructor(ctx: Context, private readonly options: CodingNsTerminalControllerOptions) {
    super(ctx, 'terminalController', { namespace: 'codingnsTerminal' })
    this.platform = options.platform ?? process.platform
    this.detectShells = options.detectShells ?? (() => detectTerminalShells({ platform: this.platform }))
    this.maxTerminals = options.maxTerminals ?? 8
    this.maxInputBytes = options.maxInputBytes ?? 64 * 1024
    this.maxCols = options.maxCols ?? 500
    this.maxRows = options.maxRows ?? 200
    this.bindingScope = options.settings().bindingScope ?? 'workspace'
  }

  @Remote
  environment(agent: DshTerminalAgent, signal: AbortSignal): CodingNsTerminalEnvironment {
    signal.throwIfAborted()
    const workspaceId = this.rememberWorkspace(agent)
    debugInfo('codingns4dsh: terminal environment', {
      sessionId: agent.id,
      cwd: this.cwd(agent),
      bindingScope: this.bindingScope,
      workspaceId,
      wireWorkspaceId: isSessionWorkspaceId(workspaceId) ? undefined : workspaceId,
    })
    return {
      cwd: this.cwd(agent),
      // 旧版 DSH 没有 Workspace Registry；不要把 cwd 伪装成稳定 Workspace ID，
      // 否则旧版 Client 会把同目录的不同会话错误合并。
      ...(isSessionWorkspaceId(workspaceId) ? {} : { workspaceId }),
      platform: normalizeTerminalPlatform(this.platform),
      maxInputBytes: this.maxInputBytes,
      maxCols: this.maxCols,
      maxRows: this.maxRows,
      scrollback: this.options.settings().appearance.scrollback ?? 1000,
    }
  }

  @Remote
  shells(agent: DshTerminalAgent, signal: AbortSignal): CodingNsTerminalShellOption[] {
    signal.throwIfAborted()
    const detected = this.detectShells()
    const preferred = resolveTerminalShell(this.options.settings().defaultProfile, detected, this.platform)
    const available = detected.filter((shell): shell is DetectedTerminalShell & { path: string } => shell.available && shell.path !== null)
    const ordered = [
      ...available.filter((shell) => shell.path === preferred.path),
      ...available.filter((shell) => shell.path !== preferred.path),
    ]
    if (ordered.length === 0) throw new Error('当前平台没有可用的受支持终端 shell')
    return ordered.map(shellOption)
  }

  @Remote
  list(sessionId: string): CodingNsWebTerminalInfo[] {
    const workspaceId = this.workspaceForSession(sessionId)
    const result = [...this.options.service.listSession(this.options.hostId, sessionId, workspaceId)]
    debugInfo('codingns4dsh: terminal list', {
      sessionId,
      workspaceId,
      registryResolved: workspaceId !== undefined && !isSessionWorkspaceId(workspaceId),
      terminals: result.map((terminal) => ({
        id: terminal.id,
        state: terminal.state,
        title: terminal.title,
        cwd: terminal.cwd,
        workspaceId,
        error: terminal.error ?? null,
      })),
    })
    return result
  }

  @Remote
  async create(
    agent: DshTerminalAgent,
    request: CodingNsTerminalCreateRequest,
    signal: AbortSignal,
  ): Promise<CodingNsWebTerminalInfo> {
    signal.throwIfAborted()
    const scope = this.scope(agent)
    this.rememberWorkspace(agent)
    const existing = this.options.service.list(scope).find((terminal) => terminal.id === request.id)
    debugInfo('codingns4dsh: terminal create request', {
      sessionId: agent.id,
      terminalId: request.id,
      scope,
      existing: existing?.id ?? null,
      currentTerminalIds: this.options.service.list(scope).map((terminal) => terminal.id),
      cols: request.cols,
      rows: request.rows,
    })
    if (existing !== undefined) return existing
    if (this.options.service.list(scope).length >= this.maxTerminals) {
      throw new RemoteError('terminal/limit-reached', '当前 DSH 会话的终端数量已达到上限', { limit: this.maxTerminals })
    }
    const selected = this.selectShell(request.shellPath)
    try {
      const result = await this.options.service.create({
        scope,
        terminalId: request.id,
        runtimeType: this.options.runtimeType?.(selected.profileId, this.platform)
          ?? runtimeType(this.platform, selected.profileId),
        shell: shellProfile(selected),
        cwd: this.cwd(agent),
        cols: request.cols,
        rows: request.rows,
      })
      debugInfo('codingns4dsh: terminal create success', {
        sessionId: agent.id,
        terminalId: request.id,
        scope,
        result: { id: result.id, state: result.state, controllerId: result.controllerId ?? null, error: result.error ?? null },
      })
      return result
    } catch (error) {
      debugWarn('codingns4dsh: terminal create failed', {
        sessionId: agent.id,
        terminalId: request.id,
        scope,
        error: errorMessage(error),
      })
      throw remoteTerminalError(error)
    }
  }

  @Remote({ mode: 'stream' })
  retain(sessionId: string, id: string, signal: AbortSignal): AsyncIterable<CodingNsTerminalRetentionFrame> {
    try {
      const workspaceId = this.workspaceForSession(sessionId)
      const identity = this.options.service.findIdentity(this.options.hostId, sessionId, id, workspaceId)
      debugInfo('codingns4dsh: terminal retain', { sessionId, terminalId: id, workspaceId, identity })
      return translateTerminalStream(this.options.service.retain(identity, signal))
    } catch (error) {
      debugWarn('codingns4dsh: terminal retain failed', { sessionId, terminalId: id, error: errorMessage(error) })
      throw remoteTerminalError(error)
    }
  }

  @Remote({ mode: 'stream' })
  follow(
    agent: DshTerminalAgent,
    id: string,
    attachmentId: string,
    signal: AbortSignal,
  ): AsyncIterable<CodingNsTerminalFrame> {
    if (!/^[\w-]{1,128}$/u.test(attachmentId)) throw new TypeError('终端 attach 标识无效')
    try {
      const identity = this.identity(agent, id)
      debugInfo('codingns4dsh: terminal follow request', { sessionId: agent.id, terminalId: id, attachmentId, identity })
      return translateTerminalStream(this.options.service.follow({
        identity,
        attachmentId,
        // attachmentId 由原生 Client 每次物理 attach 重新生成，正好作为短命
        // generation；它不会进入持久记录，也不会让旧 attach 的回调控制新流。
        generation: this.options.generation?.(agent, attachmentId) ?? `terminal-attach:${attachmentId}`,
        signal,
      }))
    } catch (error) {
      debugWarn('codingns4dsh: terminal follow failed', { sessionId: agent.id, terminalId: id, attachmentId, error: errorMessage(error) })
      throw remoteTerminalError(error)
    }
  }

  @Remote
  async write(agent: DshTerminalAgent, id: string, attachmentId: string, data: string): Promise<void> {
    const encoder = new TextEncoder()
    const originalBytes = encoder.encode(data).byteLength
    data = stripTerminalDeviceAttributeResponses(data)
    if (data.length === 0) {
      debugInfo('codingns4dsh: terminal device response filtered', {
        sessionId: agent.id,
        terminalId: id,
        attachmentId,
        originalBytes,
      })
      return
    }
    const remainingBytes = encoder.encode(data).byteLength
    if (remainingBytes !== originalBytes) {
      debugInfo('codingns4dsh: terminal device response filtered before write', {
        sessionId: agent.id,
        terminalId: id,
        attachmentId,
        originalBytes,
        remainingBytes,
      })
    }
    if (remainingBytes > this.maxInputBytes) throw new TypeError('终端输入超过允许上限')
    try {
      await this.options.service.write(this.identity(agent, id), attachmentId, data)
    } catch (error) {
      throw remoteTerminalError(error)
    }
  }

  @Remote
  async resize(
    agent: DshTerminalAgent,
    id: string,
    attachmentId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    try {
      await this.options.service.resize(this.identity(agent, id), attachmentId, cols, rows)
    } catch (error) {
      throw remoteTerminalError(error)
    }
  }

  @Remote
  async rename(agent: DshTerminalAgent, id: string, title: string): Promise<void> {
    try {
      await this.options.service.rename(this.identity(agent, id), title)
    } catch (error) {
      throw remoteTerminalError(error)
    }
  }

  @Remote
  async close(agent: DshTerminalAgent, id: string): Promise<void> {
    try {
      const identity = this.optionalIdentity(agent, id)
      debugInfo('codingns4dsh: terminal close entered', {
        sessionId: agent.id,
        terminalId: id,
        identity: identity ?? null,
      })
      if (identity !== undefined) {
        await this.options.service.close(identity)
        debugInfo('codingns4dsh: terminal close success', { sessionId: agent.id, terminalId: id, identity })
      }
    } catch (error) {
      debugWarn('codingns4dsh: terminal close failed', { sessionId: agent.id, terminalId: id, error: errorMessage(error) })
      throw remoteTerminalError(error)
    }
  }

  private selectShell(shellPath?: string): DetectedTerminalShell & { path: string } {
    const detected = this.detectShells()
    if (shellPath !== undefined) {
      const selected = detected.find((shell) => shell.available && shell.path === shellPath)
      if (selected?.path !== null && selected?.path !== undefined) return selected as DetectedTerminalShell & { path: string }
      throw new TypeError('所选 shell 不在 Host 白名单或当前不可用')
    }
    const resolved = resolveTerminalShell(this.options.settings().defaultProfile, detected, this.platform)
    const selected = detected.find((shell) => shell.available && shell.path === resolved.path)
    if (selected?.path === null || selected?.path === undefined) throw new Error('默认 shell 解析结果无效')
    return selected as DetectedTerminalShell & { path: string }
  }

  private cwd(agent: DshTerminalAgent): string {
    // 会话「当前目录」优先；旧版本没有该服务时回退到不可变的会话头目录。
    return this.options.workingDirectory?.(agent) ?? agent.session.header?.cwd ?? process.cwd()
  }

  private scope(agent: DshTerminalAgent): TerminalOwnerScope {
    const cwd = this.cwd(agent)
    return {
      hostId: this.options.hostId,
      workspaceId: this.workspaceId(agent, cwd),
      dshSessionId: agent.id,
    }
  }

  private rememberWorkspace(agent: DshTerminalAgent): string {
    const workspaceId = this.workspaceId(agent, this.cwd(agent))
    this.sessionWorkspaces.set(agent.id, workspaceId)
    return workspaceId
  }

  /**
   * list/retain 的 wire 只有 sessionId，可能早于 agent-scoped environment 到达。
   * 这时仍从 Host 侧 Registry 解析工作区，避免暂时缺少缓存就退回会话列表。
   */
  private workspaceForSession(sessionId: string): string | undefined {
    const cached = this.sessionWorkspaces.get(sessionId)
    if (cached !== undefined) {
      debugInfo('codingns4dsh: terminal workspace lookup', { sessionId, source: 'cache', workspaceId: cached })
      return cached
    }
    if (this.bindingScope === 'session') {
      const fallback = `session:${sessionId}`
      debugInfo('codingns4dsh: terminal workspace lookup', { sessionId, source: 'binding-scope-session', workspaceId: fallback })
      return fallback
    }
    try {
      const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      if (registry === undefined) {
        debugWarn('codingns4dsh: terminal workspace lookup unavailable', { sessionId, reason: 'registry-undefined' })
        return undefined
      }
      const entries = registry.list()
      const workspace = entries.find((entry) => entry.sessionIds.includes(sessionId))
      if (workspace === undefined) {
        debugWarn('codingns4dsh: terminal workspace lookup miss', { sessionId, registryCount: entries.length })
        return undefined
      }
      this.sessionWorkspaces.set(sessionId, workspace.id)
      debugInfo('codingns4dsh: terminal workspace lookup', { sessionId, source: 'registry', workspaceId: workspace.id, registryCount: entries.length })
      return workspace.id
    } catch (error) {
      debugWarn('codingns4dsh: terminal workspace lookup failed', { sessionId, error: errorMessage(error) })
      return undefined
    }
  }

  /**
   * Workspace Registry 是跨会话的稳定身份；找不到正式工作区时回退到会话身份，
   * 避免旧版 DSH 把 cwd 误当成跨会话的工作区。
   */
  private workspaceId(agent: DshTerminalAgent, cwd: string): string {
    if (this.bindingScope === 'session') {
      const value = `session:${agent.id}`
      debugInfo('codingns4dsh: terminal workspace identity', { sessionId: agent.id, cwd, source: 'binding-scope-session', workspaceId: value })
      return value
    }
    // Cordis 未注入可选服务时直接读 ctx.workspaceRegistry 会抛出 "without inject"；
    // 通过 get 探测是官方允许的可选服务读取方式。
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry !== undefined) {
      try {
        const entries = registry.list()
        const workspace = entries.find((entry) => entry.sessionIds.includes(agent.id))
        if (workspace !== undefined) {
          this.options.registerWorkspaceRoot?.(workspace.id, cwd)
          debugInfo('codingns4dsh: terminal workspace identity', { sessionId: agent.id, cwd, source: 'registry', workspaceId: workspace.id, registryCount: entries.length })
          return workspace.id
        }
        debugWarn('codingns4dsh: terminal workspace identity miss', { sessionId: agent.id, cwd, registryCount: entries.length })
      } catch (error) {
        // Workspace Registry 尚未完成启动时继续使用兼容回退，不能让终端功能阻塞 DSH。
        debugWarn('codingns4dsh: terminal workspace identity lookup failed', { sessionId: agent.id, cwd, error: errorMessage(error) })
      }
    }
    // 没有正式 Registry 时只能保证当前会话隔离。options.workspaceId 保留在
    // 接口中供旧调用方编译兼容，但不能把 cwd 当作跨会话身份。
    const value = `session:${agent.id}`
    debugWarn('codingns4dsh: terminal workspace identity fallback', { sessionId: agent.id, cwd, reason: registry === undefined ? 'registry-undefined' : 'registry-miss-or-not-ready', workspaceId: value })
    return value
  }

  private identity(agent: DshTerminalAgent, terminalId: string): TerminalRecordIdentity {
    return { ...this.scope(agent), terminalId }
  }

  private optionalIdentity(agent: DshTerminalAgent, terminalId: string): TerminalRecordIdentity | undefined {
    try {
      return this.options.service.findIdentity(this.options.hostId, agent.id, terminalId, this.rememberWorkspace(agent))
    } catch (error) {
      if (!(error instanceof TerminalServiceError) || error.code !== 'TERMINAL_UNAVAILABLE') throw error
      return undefined
    }
  }
}

function normalizeTerminalPlatform(platform: string): 'darwin' | 'linux' | 'win32' | 'unsupported' {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'unsupported'
}

function isSessionWorkspaceId(value: string): boolean {
  return value.startsWith('session:')
}

function shellOption(shell: DetectedTerminalShell & { path: string }): CodingNsTerminalShellOption {
  return { path: shell.path, name: shell.displayName, args: shellArgs(shell.profileId) }
}

function shellProfile(shell: DetectedTerminalShell & { path: string }): CodingNsTerminalShell {
  return { profileId: shell.profileId, path: shell.path, name: shell.displayName, args: shellArgs(shell.profileId) }
}

function shellArgs(profileId: Exclude<TerminalShellProfileId, 'system'>): readonly string[] {
  if (profileId === 'cmd') return []
  if (profileId === 'powershell') return ['-NoLogo']
  return ['-i']
}

function runtimeType(
  platform: string,
  profileId: Exclude<TerminalShellProfileId, 'system'>,
): CodingNsTerminalRuntimeType {
  if (platform !== 'win32') return 'tmux'
  if (profileId === 'cmd') return 'conpty-cmd'
  if (profileId === 'git-bash') return 'conpty-git-bash'
  return 'conpty-powershell'
}

function remoteTerminalError(error: unknown): unknown {
  if (!(error instanceof TerminalServiceError)) return error
  if (error.code === 'TERMINAL_CONTROL_UNAVAILABLE') {
    return new RemoteError('terminal/control-unavailable', error.message, { reason: 'read-only' })
  }
  return new RemoteError('terminal/unavailable', error.message, {})
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function* translateTerminalStream<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
  try {
    yield* stream
  } catch (error) {
    throw remoteTerminalError(error)
  }
}
