import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { debugInfo, debugWarn } from '../../../shared/debug.js'

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
  /**
   * 插件私有 tmux 服务器目录。
   *
   * 默认放在系统临时目录下按 uid 隔离；测试可以指向自己的目录，避免污染正在
   * 使用的终端。目录里同时保存 socket、配置文件和退出码文件。
   */
  readonly serverDirectory?: string
}

interface TmuxAttachmentState {
  readonly sessionName: string
  readonly pty: IPty
  detached: boolean
}

interface TmuxServerPaths {
  readonly directory: string
  readonly socket: string
  readonly config: string
  readonly exitDirectory: string
}

/** 插件私有 socket 名，避免与用户自己的 tmux 以及其它 DSH Profile 共用默认 socket。 */
export const TMUX_SERVER_SOCKET_NAME = 'codingns4dsh'

/**
 * 插件自有服务器选项。
 *
 * - `exit-empty off`：用户关掉最后一个终端后服务器继续存活，其它已连接的客户端
 *   不会突然收到 `[server exited]`。
 * - `status off`：终端区域只显示 shell 内容，不再把 tmux 状态栏画进用户屏幕。
 * - `prefix None`：DSH 终端是给 shell 用的，Ctrl-B 必须原样送到 shell。
 * - `destroy-unattached off`：attach 之间的空档不能让会话被回收。
 */
const SERVER_CONFIG_LINES = [
  'set-option -g exit-empty off',
  'set-option -g status off',
  'set-option -g prefix None',
  'set-option -g prefix2 None',
  'set-option -g escape-time 10',
  'set-option -g destroy-unattached off',
  'set-option -g history-limit 50000',
] as const

/** `-f` 只在服务器首次启动时读取；这里显式补写，保证复用的服务器也带上选项。 */
const SERVER_OPTION_ARGUMENTS = [
  'set-option', '-g', 'exit-empty', 'off', ';',
  'set-option', '-g', 'status', 'off', ';',
  'set-option', '-g', 'prefix', 'None', ';',
  'set-option', '-g', 'prefix2', 'None', ';',
  'set-option', '-g', 'escape-time', '10', ';',
  'set-option', '-g', 'destroy-unattached', 'off',
] as const

/**
 * 每个会话单独的尺寸策略。
 *
 * 只把客户端标成 `ignore-size` 还不够：`window-size latest` 仍会让后 attach 的
 * 客户端抢走窗口尺寸，正在看的用户就会看到整屏重绘。设为 `manual` 后，窗口尺寸
 * 只由 `resize-window` 决定，任何 attach/detach 都不再改变它。
 */
function sessionSizeArguments(name: string): readonly string[] {
  return ['set-option', '-t', name, 'window-size', 'manual']
}

/**
 * tmux 拥有的持久 shell；node-pty 这里只承载可随 generation 销毁的 tmux client。
 *
 * 客户端一律带 `ignore-size`：谁在 attach 都不改变窗口尺寸，尺寸只由显式
 * `resize-window` 驱动，避免多个客户端互相触发全屏重绘。
 */
export class TmuxTerminalBackend implements TerminalRuntimeAdapter {
  readonly runtimeTypes = ['tmux'] as const
  private readonly tmuxPath: string | null
  private readonly platform: string
  private readonly runner: TmuxCommandRunner
  private readonly ptySpawner: typeof spawnPty
  private readonly createAttachmentId: () => string
  private readonly attachments = new Map<string, TmuxAttachmentState>()
  private readonly server: TmuxServerPaths
  private serverReady: Promise<void> | undefined

  constructor(options: TmuxBackendOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.tmuxPath = options.tmuxPath ?? detectTmuxPath(this.platform)
    this.runner = options.commandRunner ?? { run: runCommand }
    this.ptySpawner = options.ptySpawner ?? spawnPty
    this.createAttachmentId = options.createAttachmentId ?? randomUUID
    this.server = resolveServerPaths(options.serverDirectory, this.platform)
  }

  async create(input: TerminalRuntimeCreateInput): Promise<TerminalRuntimeIdentity> {
    this.assertSupported(input.session)
    const tmuxPath = this.requireTmuxPath()
    await this.ensureServer()
    debugInfo('codingns4dsh: tmux create start', {
      runtimeSessionKey: input.session.runtimeSessionKey,
      cwd: input.session.cwd,
      shellPath: input.session.shellPath,
      commandPath: input.session.commandPath ?? null,
      shellArgCount: input.session.shellArgs.length,
      commandArgCount: input.session.commandArgs?.length ?? 0,
      cols: input.cols,
      rows: input.rows,
    })
    const current = await this.inspect(input.session)
    if (current.alive) return current
    const name = tmuxSessionName(input.session.runtimeSessionKey)
    const size = normalizeTerminalSize(input.cols ?? 120, input.rows ?? 30)
    const result = this.runner.run(tmuxPath, [
      '-S', this.server.socket,
      '-f', this.server.config,
      'new-session', '-d', '-s', name,
      '-x', String(size.cols),
      '-y', String(size.rows),
      ...Object.entries(input.session.commandEnv ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '-c', input.session.cwd,
      ...tmuxLaunchCommand(input.session, this.exitCodePath(name)),
    ])
    if (result.status !== 0) {
      debugWarn('codingns4dsh: tmux create command failed', {
        runtimeSessionKey: input.session.runtimeSessionKey,
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      })
      throw new TerminalRuntimeError(
        result.status === null ? 'TERMINAL_RUNTIME_UNAVAILABLE' : 'TERMINAL_RUNTIME_CREATE_FAILED',
        sanitizeCommandError('tmux 会话创建失败', result.stderr),
      )
    }
    // 会话级尺寸策略必须在任何客户端 attach 之前锁定，否则第一次 attach 就会
    // 按客户端尺寸改写窗口。
    const sized = this.runner.run(tmuxPath, ['-S', this.server.socket, ...sessionSizeArguments(name)])
    debugInfo('codingns4dsh: tmux create command result', {
      runtimeSessionKey: input.session.runtimeSessionKey,
      status: result.status,
      stderr: result.stderr,
      sizeStatus: sized.status,
      sizeStderr: sized.stderr,
    })
    if (sized.status !== 0 && !isMissingSession(sized.stderr)) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_CREATE_FAILED', sanitizeCommandError('tmux 会话尺寸策略设置失败', sized.stderr))
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
    const name = tmuxSessionName(session.runtimeSessionKey)
    const result = this.runner.run(this.tmuxPath, ['-S', this.server.socket, 'has-session', '-t', name])
    debugInfo('codingns4dsh: tmux inspect result', {
      runtimeSessionKey: session.runtimeSessionKey,
      status: result.status,
      stderr: result.stderr,
    })
    if (result.status === null) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_UNAVAILABLE', sanitizeCommandError('tmux 不可执行', result.stderr))
    }
    if (result.status !== 0 && !isMissingSession(result.stderr)) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_UNAVAILABLE', sanitizeCommandError('tmux 会话检查失败', result.stderr))
    }
    if (result.status === 0) {
      return {
        alive: true,
        runtimeSessionKey: session.runtimeSessionKey,
        runtimePid: this.readPanePid(name),
        shellPid: null,
      }
    }
    // 会话已经销毁：包装 Shell 写下的退出码才是"进程已退出"的真实依据。
    // 没有它就只能报告运行时丢失，不能借用 attach 客户端的退出码。
    const recorded = this.readRecordedExitCode(name)
    if (recorded !== undefined) {
      return {
        alive: false,
        runtimeSessionKey: session.runtimeSessionKey,
        runtimePid: null,
        shellPid: null,
        exitCode: recorded,
        detail: `tmux 会话已退出（退出码 ${recorded}）`,
      }
    }
    return {
      alive: false,
      runtimeSessionKey: session.runtimeSessionKey,
      runtimePid: null,
      shellPid: null,
      exitCode: null,
      detail: sanitizeCommandError('tmux 会话不存在', result.stderr),
    }
  }

  async attach(input: TerminalRuntimeAttachInput): Promise<TerminalRuntimeAttachment> {
    const identity = await this.inspect(input.session)
    if (!identity.alive) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', identity.detail ?? 'tmux 会话已经丢失')
    }
    const size = normalizeTerminalSize(input.cols, input.rows)
    const tmuxPath = this.requireTmuxPath()
    const attachmentId = this.createAttachmentId()
    const name = tmuxSessionName(input.session.runtimeSessionKey)
    const pty = this.ptySpawner(tmuxPath, [
      '-S', this.server.socket,
      'attach-session',
      // 客户端不参与尺寸计算：窗口尺寸只由 resize() 显式下发。
      '-f', 'ignore-size',
      '-t', name,
    ], {
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
      debugInfo('codingns4dsh: tmux client exit', {
        runtimeSessionKey: input.session.runtimeSessionKey,
        attachmentId,
        exitCode,
        detached: state.detached,
      })
      if (this.attachments.get(attachmentId) === state) this.attachments.delete(attachmentId)
      if (!state.detached) input.onExit?.(exitCode)
    })
    return { attachmentId, identity }
  }

  async write(input: TerminalRuntimeWriteInput): Promise<void> {
    this.getAttachment(input.attachmentId).pty.write(input.data)
  }

  async resize(input: TerminalRuntimeResizeInput): Promise<void> {
    const state = this.getAttachment(input.attachmentId)
    const size = normalizeTerminalSize(input.cols, input.rows)
    // 客户端是 ignore-size 的，改它自己的 pty 尺寸不会影响窗口；必须显式调整
    // tmux 窗口，shell 才会收到与浏览器视口一致的 SIGWINCH。
    const result = this.runner.run(this.tmuxPath!, [
      '-S', this.server.socket, 'resize-window', '-t', state.sessionName,
      '-x', String(size.cols), '-y', String(size.rows),
    ])
    if (result.status !== 0 && !isMissingSession(result.stderr)) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', sanitizeCommandError('tmux 窗口尺寸调整失败', result.stderr))
    }
    try { state.pty.resize(size.cols, size.rows) } catch { /* 客户端可能已经退出 */ }
  }

  /**
   * 从 tmux 的 server buffer 读取历史，而不是依赖 attach 首屏的 ANSI 重绘。
   * attach 首屏只描述当前视口，无法让浏览器端 xterm 生成 scrollback。
   */
  async captureHistory(session: TerminalRuntimeSession, lines: number): Promise<string | undefined> {
    this.assertSupported(session)
    const tmuxPath = this.requireTmuxPath()
    const name = tmuxSessionName(session.runtimeSessionKey)
    const count = Math.min(50000, Math.max(1, Math.trunc(lines)))
    const result = this.runner.run(tmuxPath, [
      '-S', this.server.socket,
      'capture-pane', '-p', '-J', '-S', `-${count}`, '-t', name,
    ])
    debugInfo('codingns4dsh: tmux capture history', {
      runtimeSessionKey: session.runtimeSessionKey,
      lines: count,
      status: result.status,
      characters: result.stdout.length,
      stderr: result.stderr,
    })
    if (result.status !== 0) {
      if (isMissingSession(result.stderr)) return undefined
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', sanitizeCommandError('tmux 历史读取失败', result.stderr))
    }
    return result.stdout
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
    const result = this.runner.run(tmuxPath, ['-S', this.server.socket, 'kill-session', '-t', name])
    debugInfo('codingns4dsh: tmux terminate result', {
      runtimeSessionKey: session.runtimeSessionKey,
      status: result.status,
      stderr: result.stderr,
    })
    // tmux 的“目标不存在”视为幂等成功。
    if (result.status !== 0 && !isMissingSession(result.stderr)) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_CREATE_FAILED', sanitizeCommandError('tmux 会话关闭失败', result.stderr))
    }
    this.removeExitCode(name)
  }

  /**
   * 向持久 Shell 写入一次输入。
   *
   * 刻意不再临时 attach 一个 tmux 客户端：多出来的客户端会改变窗口尺寸并触发
   * 全屏重绘，而 `send-keys` 由服务器直接完成，不产生任何客户端。
   */
  async sendInput(session: TerminalRuntimeSession, data: string): Promise<void> {
    this.assertSupported(session)
    const tmuxPath = this.requireTmuxPath()
    const name = tmuxSessionName(session.runtimeSessionKey)
    const result = this.runner.run(tmuxPath, ['-S', this.server.socket, 'send-keys', '-t', name, '-l', data])
    if (result.status !== 0 && !isMissingSession(result.stderr)) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', sanitizeCommandError('tmux 终端输入失败', result.stderr))
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

  /**
   * 保证插件私有服务器存在且带有我们的全局选项。
   *
   * 服务器可能因为外部原因退出（例如系统清理临时目录）；每个会话创建前都按幂等
   * 方式重建，失败则让调用方看到明确的不可用错误，而不是静默降级。
   */
  private async ensureServer(): Promise<void> {
    if (this.serverReady !== undefined) return this.serverReady
    const pending = (async () => {
      const tmuxPath = this.requireTmuxPath()
      try {
        mkdirSync(this.server.directory, { recursive: true, mode: 0o700 })
        mkdirSync(this.server.exitDirectory, { recursive: true, mode: 0o700 })
        writeFileSync(this.server.config, `${SERVER_CONFIG_LINES.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        throw new TerminalRuntimeError('TERMINAL_RUNTIME_UNAVAILABLE', `tmux 配置目录不可写：${errorMessage(error)}`)
      }
      const started = this.runner.run(tmuxPath, ['-S', this.server.socket, '-f', this.server.config, 'start-server'])
      if (started.status !== 0) {
        throw new TerminalRuntimeError('TERMINAL_RUNTIME_UNAVAILABLE', sanitizeCommandError('tmux 服务器启动失败', started.stderr))
      }
      const options = this.runner.run(tmuxPath, ['-S', this.server.socket, ...SERVER_OPTION_ARGUMENTS])
      if (options.status !== 0) {
        throw new TerminalRuntimeError('TERMINAL_RUNTIME_UNAVAILABLE', sanitizeCommandError('tmux 服务器选项写入失败', options.stderr))
      }
    })()
    this.serverReady = pending.catch((error: unknown) => {
      // 失败不缓存：下一次 create 重新尝试，避免一次偶发失败永久禁用终端。
      this.serverReady = undefined
      throw error
    })
    return this.serverReady
  }

  private readPanePid(name: string): number | null {
    const result = this.runner.run(this.tmuxPath!, ['-S', this.server.socket, 'display-message', '-p', '-t', name, '#{pane_pid}'])
    if (result.status !== 0) return null
    const pid = Number.parseInt(result.stdout.trim(), 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  }

  private exitCodePath(name: string): string {
    return join(this.server.exitDirectory, `${name}.exit`)
  }

  private readRecordedExitCode(name: string): number | null | undefined {
    try {
      const raw = readFileSync(this.exitCodePath(name), 'utf8').trim()
      if (raw === '') return undefined
      const code = Number.parseInt(raw, 10)
      return Number.isSafeInteger(code) ? code : undefined
    } catch {
      return undefined
    }
  }

  private removeExitCode(name: string): void {
    try { rmSync(this.exitCodePath(name), { force: true }) } catch { /* 退出码文件缺失时无需清理 */ }
  }
}

/**
 * 调试命令必须是 Shell 的子进程：杀掉端口对应的业务进程后，tmux pane 仍然回到
 * 交互 Shell；只有显式停止才会调用 terminate 销毁整个会话。
 *
 * 末尾的包装负责把交互 Shell 的真实退出码写进插件私有目录：tmux 客户端在会话
 * 结束时统一以 0 退出，只有 Shell 自己知道用户敲的 `exit 3` 到底返回了什么。
 *
 * 注意这里不能用 `exec`：exec 会用交互 Shell 替换掉包装进程，后面的记录代码
 * 永远不会执行，退出码也就永远丢失。调试命令跑完直接回到同一个交互 Shell。
 */
function tmuxLaunchCommand(session: TerminalRuntimeSession, exitCodePath: string): readonly string[] {
  const shell = [session.shellPath, ...session.shellArgs].map(shellQuote).join(' ')
  const inner = session.commandPath === undefined
    ? shell
    : `${[session.commandPath, ...(session.commandArgs ?? [])].map(shellQuote).join(' ')}; ${shell}`
  return [
    session.shellPath,
    '-c',
    `${inner}; __codingns4dsh_exit=$?; printf %s "$__codingns4dsh_exit" > ${shellQuote(exitCodePath)}; exit $__codingns4dsh_exit`,
  ]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function tmuxSessionName(runtimeSessionKey: string): string {
  const digest = createHash('sha256').update(runtimeSessionKey).digest('hex').slice(0, 32)
  return `codingns4dsh-${digest}`
}

function runCommand(command: string, args: readonly string[]): TmuxCommandResult {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: false })
}

export function detectTmuxPath(platform: string, pathValue = process.env.PATH): string | null {
  const fixedCandidates = platform === 'darwin'
    ? ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
    : ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux']
  const pathCandidates = (pathValue ?? '').split(':').filter(Boolean).map((directory) => `${directory}/tmux`)
  const candidates = [...new Set([...fixedCandidates, ...pathCandidates])]
  return candidates.find(isExecutable) ?? null
}

function resolveServerPaths(directory: string | undefined, platform: string): TmuxServerPaths {
  const base = directory ?? join(
    platform === 'win32' ? tmpdir() : '/tmp',
    `${TMUX_SERVER_SOCKET_NAME}-${process.getuid?.() ?? 0}`,
  )
  return {
    directory: base,
    socket: join(base, `${TMUX_SERVER_SOCKET_NAME}.sock`),
    config: join(base, 'tmux.conf'),
    exitDirectory: join(base, 'exit'),
  }
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
  // `no current target` 是服务器存活但一个会话都没有时的报错：`exit-empty off`
  // 让这种状态成为常态，必须和"服务器没起来"区分开，否则会被误判成运行时故障。
  return /no (server running|sessions|session|current target)|can't find session|error connecting to .*no such file or directory/i.test(stderr)
}

function sanitizeCommandError(prefix: string, stderr: string): string {
  const detail = stderr.trim().replace(/[\r\n]+/g, ' ').slice(0, 300)
  return detail ? `${prefix}：${detail}` : prefix
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
