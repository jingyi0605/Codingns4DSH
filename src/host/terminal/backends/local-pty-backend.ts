import { randomUUID } from 'node:crypto'
import { spawn as spawnPty, type IDisposable, type IPty } from '@lydell/node-pty'
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

export interface LocalPtyBackendOptions {
  readonly platform?: string
  readonly ptySpawner?: typeof spawnPty
  readonly createAttachmentId?: () => string
}

interface LocalPtyAttachment {
  readonly runtimeSessionKey: string
  readonly onData: (data: string) => void
  readonly onExit?: (exitCode: number | null) => void
}

interface LocalPtyProcess {
  readonly pty: IPty
  readonly dataSubscription: IDisposable
  readonly exitSubscription: IDisposable
  alive: boolean
  replay: string
}

const MAX_REPLAY_CHARACTERS = 1024 * 1024

/**
 * 非强化模式使用的进程内 PTY。
 *
 * shell 由当前 DSH 进程直接持有，不承诺跨 DSH 重启恢复。浏览器 detach 只
 * 释放订阅；显式关闭或 controller 销毁才结束 shell。
 */
export class LocalPtyTerminalBackend implements TerminalRuntimeAdapter {
  readonly runtimeTypes = ['local-pty'] as const
  private readonly platform: string
  private readonly ptySpawner: typeof spawnPty
  private readonly createAttachmentId: () => string
  private readonly processes = new Map<string, LocalPtyProcess>()
  private readonly attachments = new Map<string, LocalPtyAttachment>()

  constructor(options: LocalPtyBackendOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.ptySpawner = options.ptySpawner ?? spawnPty
    this.createAttachmentId = options.createAttachmentId ?? randomUUID
  }

  async create(input: TerminalRuntimeCreateInput): Promise<TerminalRuntimeIdentity> {
    this.assertSupported(input.session)
    const existing = this.processes.get(input.session.runtimeSessionKey)
    if (existing?.alive) return identityOf(input.session, existing.pty.pid, true)

    const size = normalizeTerminalSize(input.cols ?? 120, input.rows ?? 30)
    let pty: IPty
    try {
      pty = this.ptySpawner(input.session.commandPath ?? input.session.shellPath, [...(input.session.commandArgs ?? input.session.shellArgs)], {
        cwd: input.session.cwd,
        env: { ...process.env, ...(input.session.commandEnv ?? {}), ...(input.env ?? {}) },
        cols: size.cols,
        rows: size.rows,
        name: 'xterm-256color',
      })
    } catch (error) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_CREATE_FAILED', '本机 PTY 创建失败', { cause: error })
    }

    let state: LocalPtyProcess | undefined
    const dataSubscription = pty.onData((data) => {
      if (state === undefined || !state.alive) return
      state.replay = boundedAppend(state.replay, data)
      for (const attachment of this.attachments.values()) {
        if (attachment.runtimeSessionKey === input.session.runtimeSessionKey) attachment.onData(data)
      }
    })
    const exitSubscription = pty.onExit(({ exitCode }) => {
      if (state !== undefined) this.handleExit(input.session.runtimeSessionKey, state, exitCode)
    })
    state = { pty, dataSubscription, exitSubscription, alive: true, replay: '' }
    this.processes.set(input.session.runtimeSessionKey, state)
    return identityOf(input.session, pty.pid, true)
  }

  async inspect(session: TerminalRuntimeSession): Promise<TerminalRuntimeIdentity> {
    this.assertSupported(session)
    const state = this.processes.get(session.runtimeSessionKey)
    if (state?.alive) return identityOf(session, state.pty.pid, true)
    return {
      ...identityOf(session, null, false),
      detail: '本机 PTY 不存在或已退出',
    }
  }

  async attach(input: TerminalRuntimeAttachInput): Promise<TerminalRuntimeAttachment> {
    this.assertSupported(input.session)
    const state = this.processes.get(input.session.runtimeSessionKey)
    if (state === undefined || !state.alive) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', '本机 PTY 已经丢失')
    }
    const size = normalizeTerminalSize(input.cols, input.rows)
    state.pty.resize(size.cols, size.rows)
    const attachmentId = this.createAttachmentId()
    if (state.replay !== '') input.onData(state.replay)
    this.attachments.set(attachmentId, {
      runtimeSessionKey: input.session.runtimeSessionKey,
      onData: input.onData,
      ...(input.onExit === undefined ? {} : { onExit: input.onExit }),
    })
    return { attachmentId, identity: identityOf(input.session, state.pty.pid, true) }
  }

  async write(input: TerminalRuntimeWriteInput): Promise<void> {
    const { process } = this.requireAttachment(input.attachmentId)
    process.pty.write(input.data)
  }

  async resize(input: TerminalRuntimeResizeInput): Promise<void> {
    const { process } = this.requireAttachment(input.attachmentId)
    const size = normalizeTerminalSize(input.cols, input.rows)
    process.pty.resize(size.cols, size.rows)
  }

  async detach(attachmentId: string): Promise<void> {
    this.attachments.delete(attachmentId)
  }

  async terminate(session: TerminalRuntimeSession): Promise<void> {
    this.assertSupported(session)
    const state = this.processes.get(session.runtimeSessionKey)
    if (state === undefined) return
    this.removeAttachments(session.runtimeSessionKey)
    this.releaseProcess(session.runtimeSessionKey, state)
    try { state.pty.kill() } catch { /* PTY 可能已经自然退出 */ }
  }

  async dispose(): Promise<void> {
    this.attachments.clear()
    for (const [runtimeSessionKey, state] of [...this.processes]) {
      this.releaseProcess(runtimeSessionKey, state)
      try { state.pty.kill() } catch { /* PTY 可能已经自然退出 */ }
    }
  }

  private requireAttachment(attachmentId: string): { process: LocalPtyProcess } {
    const attachment = this.attachments.get(attachmentId)
    if (attachment === undefined) {
      throw new TerminalRuntimeError('TERMINAL_ATTACHMENT_NOT_FOUND', '终端 attach 不存在或已经释放')
    }
    const process = this.processes.get(attachment.runtimeSessionKey)
    if (process === undefined || !process.alive) {
      throw new TerminalRuntimeError('TERMINAL_RUNTIME_LOST', '本机 PTY 已经丢失')
    }
    return { process }
  }

  private handleExit(runtimeSessionKey: string, state: LocalPtyProcess, exitCode: number): void {
    if (this.processes.get(runtimeSessionKey) !== state || !state.alive) return
    const callbacks = [...this.attachments]
      .filter(([, attachment]) => attachment.runtimeSessionKey === runtimeSessionKey)
      .map(([, attachment]) => attachment.onExit)
    this.removeAttachments(runtimeSessionKey)
    this.releaseProcess(runtimeSessionKey, state)
    for (const callback of callbacks) callback?.(exitCode)
  }

  private removeAttachments(runtimeSessionKey: string): void {
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.runtimeSessionKey === runtimeSessionKey) this.attachments.delete(attachmentId)
    }
  }

  private releaseProcess(runtimeSessionKey: string, state: LocalPtyProcess): void {
    state.alive = false
    if (this.processes.get(runtimeSessionKey) === state) this.processes.delete(runtimeSessionKey)
    state.dataSubscription.dispose()
    state.exitSubscription.dispose()
  }

  private assertSupported(session: TerminalRuntimeSession): void {
    if (!['darwin', 'linux', 'win32'].includes(this.platform)) {
      throw new TerminalRuntimeError('TERMINAL_PLATFORM_UNSUPPORTED', `本机 PTY 不支持 ${this.platform}`)
    }
    if (session.runtimeType !== 'local-pty') {
      throw new TerminalRuntimeError('TERMINAL_PLATFORM_UNSUPPORTED', `本机 PTY 不支持 ${session.runtimeType}`)
    }
  }
}

function identityOf(session: TerminalRuntimeSession, pid: number | null, alive: boolean): TerminalRuntimeIdentity {
  return {
    alive,
    runtimeSessionKey: session.runtimeSessionKey,
    runtimePid: pid,
    shellPid: pid,
  }
}

function boundedAppend(current: string, data: string): string {
  const combined = current + data
  return combined.length <= MAX_REPLAY_CHARACTERS ? combined : combined.slice(-MAX_REPLAY_CHARACTERS)
}
