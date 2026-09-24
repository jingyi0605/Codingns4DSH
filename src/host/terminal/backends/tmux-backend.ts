import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { spawn as spawnPty, type IPty } from '@lydell/node-pty'
import {
  TerminalRuntimeError,
  normalizeTerminalSize,
  type TerminalRuntimeAdapter,
  type TerminalRuntimeAttachInput,
  type TerminalRuntimeAttachment,
  type TerminalRuntimeCreateInput,
  type TerminalRuntimeIdentity,
  type TerminalRuntimeResizeInput,
  type TerminalRuntimeSession,
  type TerminalRuntimeWriteInput,
} from '../runtime-adapter.js'

export interface TmuxCommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface TmuxCommandRunner {
  run(command: string, args: readonly string[]): TmuxCommandResult
}

export interface TmuxBackendOptions {
  readonly tmuxPath?: string
  readonly platform?: string
  readonly commandRunner?: TmuxCommandRunner
  readonly ptySpawner?: typeof spawnPty
  readonly createAttachmentId?: () => string
}

interface TmuxAttachmentState {
  readonly sessionName: string
  readonly pty: IPty
  detached: boolean
}

/** tmux 拥有持久 shell，node-pty 这里只承载可随 generation 销毁的 tmux client。 */
export class TmuxTerminalBackend implements TerminalRuntimeAdapter {
  readonly runtimeTypes = ['tmux'] as const
  private readonly tmuxPath: string | null
  private readonly platform: string
  private readonly runner: TmuxCommandRunner
  private readonly ptySpawner: typeof spawnPty
  private readonly createAttachmentId: () => string
  private readonly attachments = new Map<string, TmuxAttachmentState>()

  constructor(options: TmuxBackendOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.tmuxPath = options.tmuxPath ?? detectTmuxPath(this.platform)
    this.runner = options.commandRunner ?? { run: runCommand }
    this.ptySpawner = options.ptySpawner ?? spawnPty
    this.createAttachmentId = options.createAttachmentId ?? randomUUID
  }

  async create(input: TerminalRuntimeCreateInput): Promise<TerminalRuntimeIdentity> {
    this.assertSupported(input.session)
    const tmuxPath = this.requireTmuxPath()
    const current = await this.inspect(input.session)
    if (current.alive) return current
    const name = tmuxSessionName(input.session.runtimeSessionKey)
    const result = this.runner.run(tmuxPath, [
      'new-session', '-d', '-s', name,
      ...Object.entries(input.session.commandEnv ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '-c', input.session.cwd,
      input.session.commandPath ?? input.session.shellPath,
      ...(input.session.commandArgs ?? input.session.shellArgs),
    ])
    if (result.status !== 0) {
      throw new TerminalRuntimeError(
        result.status === null ? 'TERMINAL_RUNTIME_UNAVAILABLE' : 'TERMINAL_RUNTIME_CREATE_FAILED',
        sanitizeCommandError('tmux 会话创建失败', result.stderr),
      )
    }
    return this.inspect(input.session)
  }

  async inspect(session: TerminalRuntimeSession): Promise<TerminalRuntimeIdentity> {
    this.assertSupported(session)
    if (this.tmuxPath === null) return {
      alive: false,
      runtimeSessionKey: session.runtimeSessionKey,
      runtimePid: null,
      shellPid: null,
      detail: '未找到可执行的 tmux',
    }
    const result = this.runner.run(this.tmuxPath, ['has-session', '-t', tmuxSessionName(session.runtimeSessionKey)])
    if (result.status === null) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_UNAVAILABLE', sanitizeCommandError('tmux 不可执行', result.stderr))
    }
    if (result.status !== 0 && !isMissingSession(result.stderr)) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_UNAVAILABLE', sanitizeCommandError('tmux 会话检查失败', result.stderr))
    }
    return {
      alive: result.status === 0,
      runtimeSessionKey: session.runtimeSessionKey,
      runtimePid: null,
      shellPid: null,
      ...(result.status === 0 ? {} : { detail: sanitizeCommandError('tmux 会话不存在', result.stderr) }),
    }
  }

  async attach(input: TerminalRuntimeAttachInput): Promise<TerminalRuntimeAttachment> {
    const identity = await this.inspect(input.session)
    if (!identity.alive) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', 'tmux 会话已经丢失')
    }
    const size = normalizeTerminalSize(input.cols, input.rows)
    const tmuxPath = this.requireTmuxPath()
    const attachmentId = this.createAttachmentId()
    const name = tmuxSessionName(input.session.runtimeSessionKey)
    const pty = this.ptySpawner(tmuxPath, ['attach-session', '-t', name], {
      cwd: input.session.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      cols: size.cols,
      rows: size.rows,
      name: 'xterm-256color',
    })
    const state: TmuxAttachmentState = { sessionName: name, pty, detached: false }
    this.attachments.set(attachmentId, state)
    pty.onData((data) => {
      if (!state.detached) input.onData(data)
    })
    pty.onExit(({ exitCode }) => {
      if (this.attachments.get(attachmentId) === state) this.attachments.delete(attachmentId)
      if (!state.detached) input.onExit?.(exitCode)
    })
    return { attachmentId, identity }
  }

  async write(input: TerminalRuntimeWriteInput): Promise<void> {
    this.getAttachment(input.attachmentId).pty.write(input.data)
  }

  async resize(input: TerminalRuntimeResizeInput): Promise<void> {
    const size = normalizeTerminalSize(input.cols, input.rows)
    this.getAttachment(input.attachmentId).pty.resize(size.cols, size.rows)
  }

  async detach(attachmentId: string): Promise<void> {
    const state = this.attachments.get(attachmentId)
    if (state === undefined) return
    state.detached = true
    this.attachments.delete(attachmentId)
    // 杀掉的只是 tmux client；tmux server 和其中的 shell 继续运行。
    try { state.pty.kill() } catch { /* attach 可能已经自然退出 */ }
  }

  async terminate(session: TerminalRuntimeSession): Promise<void> {
    this.assertSupported(session)
    const tmuxPath = this.requireTmuxPath()
    const name = tmuxSessionName(session.runtimeSessionKey)
    for (const [attachmentId, state] of this.attachments) {
      if (state.sessionName === name) await this.detach(attachmentId)
    }
    const result = this.runner.run(tmuxPath, ['kill-session', '-t', name])
    // tmux 的“目标不存在”视为幂等成功。
    if (result.status !== 0 && !isMissingSession(result.stderr)) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_CREATE_FAILED', sanitizeCommandError('tmux 会话关闭失败', result.stderr))
    }
  }

  private getAttachment(attachmentId: string): TmuxAttachmentState {
    const state = this.attachments.get(attachmentId)
    if (state === undefined) throw new TerminalRuntimeError('TERMINAL_ATTACHMENT_NOT_FOUND', '终端 attach 不存在或已经释放')
    return state
  }

  private assertSupported(session: TerminalRuntimeSession): void {
    if (this.platform !== 'darwin' && this.platform !== 'linux') {
      throw new TerminalRuntimeError('TERMINAL_PLATFORM_UNSUPPORTED', 'tmux backend 只支持 macOS 和 Linux')
    }
    if (session.runtimeType !== 'tmux') {
      throw new TerminalRuntimeError('TERMINAL_PLATFORM_UNSUPPORTED', `tmux backend 不支持 ${session.runtimeType}`)
    }
  }

  private requireTmuxPath(): string {
    if (this.tmuxPath === null) throw new TerminalRuntimeError('TERMINAL_RUNTIME_UNAVAILABLE', '未找到可执行的 tmux')
    return this.tmuxPath
  }
}

export function tmuxSessionName(runtimeSessionKey: string): string {
  const digest = createHash('sha256').update(runtimeSessionKey).digest('hex').slice(0, 32)
  return `dsh-codingns-${digest}`
}

function runCommand(command: string, args: readonly string[]): TmuxCommandResult {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: false })
}

function detectTmuxPath(platform: string): string | null {
  const candidates = platform === 'darwin'
    ? ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
    : ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux']
  return candidates.find(isExecutable) ?? null
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isMissingSession(stderr: string): boolean {
  return /no (server running|sessions|session)|can't find session|error connecting to .*no such file or directory/i.test(stderr)
}

function sanitizeCommandError(prefix: string, stderr: string): string {
  const detail = stderr.trim().replace(/[\r\n]+/g, ' ').slice(0, 300)
  return detail ? `${prefix}：${detail}` : prefix
}
