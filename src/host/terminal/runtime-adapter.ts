import type { CodingNsTerminalRuntimeType } from '../../shared/contracts/terminal.js'

/** Host backend 直接复用共享持久记录的运行时枚举，避免 controller 做无意义转换。 */
export type TerminalRuntimeType = CodingNsTerminalRuntimeType

/** 持久运行时只保存可在 DSH 重启后重新定位会话的字段。 */
export interface TerminalRuntimeSession {
  readonly runtimeSessionKey: string
  readonly runtimeType: TerminalRuntimeType
  readonly shellPath: string
  readonly shellArgs: readonly string[]
  /** 启动项 PTY 的实际命令；未设置时使用 shellPath/shellArgs。 */
  readonly commandPath?: string
  readonly commandArgs?: readonly string[]
  readonly commandEnv?: Readonly<Record<string, string>>
  readonly cwd: string
}

export interface TerminalRuntimeIdentity {
  readonly alive: boolean
  readonly runtimeSessionKey: string
  readonly runtimePid: number | null
  readonly shellPid: number | null
  readonly detail?: string
}

export interface TerminalRuntimeCreateInput {
  readonly session: TerminalRuntimeSession
  readonly cols?: number
  readonly rows?: number
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface TerminalRuntimeAttachInput {
  readonly session: TerminalRuntimeSession
  readonly cols: number
  readonly rows: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly onData: (data: string) => void
  readonly onExit?: (exitCode: number | null) => void
}

export interface TerminalRuntimeAttachment {
  readonly attachmentId: string
  readonly identity: TerminalRuntimeIdentity
}

export interface TerminalRuntimeWriteInput {
  readonly attachmentId: string
  readonly data: string
}

export interface TerminalRuntimeResizeInput {
  readonly attachmentId: string
  readonly cols: number
  readonly rows: number
}

/**
 * controller 只依赖这个接口。持久 session 与短命 attachment 使用不同标识，
 * 因而卸载插件或切换 generation 时不会误杀 tmux/ConPTY。
 */
export interface TerminalRuntimeAdapter {
  readonly runtimeTypes: readonly TerminalRuntimeType[]
  create(input: TerminalRuntimeCreateInput): Promise<TerminalRuntimeIdentity>
  inspect(session: TerminalRuntimeSession): Promise<TerminalRuntimeIdentity>
  attach(input: TerminalRuntimeAttachInput): Promise<TerminalRuntimeAttachment>
  write(input: TerminalRuntimeWriteInput): Promise<void>
  resize(input: TerminalRuntimeResizeInput): Promise<void>
  detach(attachmentId: string): Promise<void>
  terminate(session: TerminalRuntimeSession): Promise<void>
  /** 仅供进程内 backend 释放自身拥有的运行时；持久 backend 不实现此方法。 */
  dispose?(): Promise<void>
}

export type TerminalRuntimeErrorCode =
  | 'TERMINAL_PLATFORM_UNSUPPORTED'
  | 'TERMINAL_RUNTIME_UNAVAILABLE'
  | 'TERMINAL_RUNTIME_CREATE_FAILED'
  | 'TERMINAL_RUNTIME_LOST'
  | 'TERMINAL_ATTACHMENT_NOT_FOUND'
  | 'TERMINAL_ALREADY_ATTACHED'
  | 'TERMINAL_BROKER_PROTOCOL_INVALID'
  | 'TERMINAL_BROKER_UNAUTHORIZED'

export class TerminalRuntimeError extends Error {
  constructor(
    readonly code: TerminalRuntimeErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.name = 'TerminalRuntimeError'
  }
}

export function normalizeTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: normalizeDimension(cols, 20, 500, 120),
    rows: normalizeDimension(rows, 5, 300, 30),
  }
}

function normalizeDimension(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : fallback
}
