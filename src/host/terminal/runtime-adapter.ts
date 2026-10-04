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
  /**
   * 持久 shell 自己报告的真实退出码。
   *
   * 只有运行时已经结束且能确认真实退出码时才设置；attach 客户端断开、服务器被
   * 外部杀掉等"连接层"故障不能借用它，否则会把连接问题伪装成进程退出。
   */
  readonly exitCode?: number | null
}

/**
 * attach 结束的原因。
 *
 * - `exited`：持久 shell 真的结束了，`exitCode` 是它的真实退出码。
 * - `lost`：运行时消失但没有退出码（服务器被外部结束、socket 被清理等）。
 * - `detached`：只有这次的 attach 客户端断开，运行时仍然存活，可以重新连接。
 */
export type TerminalRuntimeExitKind = 'exited' | 'lost' | 'detached'

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

/** 可从持久运行时读取已经产生的屏幕历史；不支持时由上层回退到输出重放。 */
export interface TerminalRuntimeHistory {
  captureHistory(session: TerminalRuntimeSession, lines: number): Promise<string | undefined>
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

/**
 * 不建立 attach 就能向持久 shell 写入输入的 backend 能力。
 *
 * 刻意不放进 `TerminalRuntimeAdapter`：可选成员会改变既有实现的类型推断，
 * 而这只是一种可选优化，调用方用结构化探测即可。
 */
export interface TerminalRuntimeServerInput {
  sendInput(session: TerminalRuntimeSession, data: string): Promise<void>
}

/** 探测 backend 是否支持无 attach 输入。 */
export function supportsServerInput(
  adapter: TerminalRuntimeAdapter,
): adapter is TerminalRuntimeAdapter & TerminalRuntimeServerInput {
  return typeof (adapter as Partial<TerminalRuntimeServerInput>).sendInput === 'function'
}

/** 探测 backend 是否能直接读取持久终端历史。 */
export function supportsHistory(
  adapter: TerminalRuntimeAdapter,
): adapter is TerminalRuntimeAdapter & TerminalRuntimeHistory {
  return typeof (adapter as Partial<TerminalRuntimeHistory>).captureHistory === 'function'
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
