/** 插件 Sidebar 终端兼容层使用的终端状态。 */
export type WebTerminalId = string
export type TerminalAttachmentId = string

export type CodingNsTerminalState =
  | 'starting'
  | 'running'
  | 'exited'
  | 'closing'
  | 'lost'
  | 'closed'
  | 'error'

/** 持久终端所使用的本机运行时。 */
export type CodingNsTerminalRuntimeType =
  | 'local-pty'
  | 'tmux'
  | 'conpty-powershell'
  | 'conpty-cmd'
  | 'conpty-git-bash'

/**
 * 可跨浏览器、插件 generation 和 DSH 重启恢复的记录。
 *
 * 这里故意不包含 generation、stream、Socket、订阅回调或本机控制凭据；这些
 * 都是一次 attach 的短命资源，不能反过来拥有 tmux/ConPTY 进程。
 */
export interface PersistentTerminalRecord {
  readonly hostId: string
  readonly workspaceId: string
  /** 最近一次 attach 所在的 DSH session；仅兼容旧记录和诊断，不参与归属或主键。 */
  readonly dshSessionId?: string
  readonly terminalId: string
  readonly runtimeSessionKey: string
  readonly runtimeType: CodingNsTerminalRuntimeType
  /** 终端 UI 显示的 shell；启动项 PTY 可以另外指定实际命令。 */
  readonly shellPath: string
  readonly shellProfileId?: CodingNsTerminalShell['profileId']
  readonly shellName?: string
  readonly shellArgs?: readonly string[]
  /** 由 Host 直接启动的 PTY 命令；普通交互终端不设置。 */
  readonly commandPath?: string
  readonly commandArgs?: readonly string[]
  readonly commandEnv?: Readonly<Record<string, string>>
  readonly launchProfileId?: string
  readonly cwd: string
  readonly title: string
  readonly cols: number
  readonly rows: number
  readonly state: CodingNsTerminalState
  readonly exitCode: number | null
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 当前连接到持久运行时的一次短命 attach，只保存在内存中。 */
export interface TerminalAttachmentRecord {
  readonly terminalId: string
  readonly generation: string
  readonly streamId: string
  readonly subscriptionId: string
  readonly runtimeAttachmentId: string
}

/** 持久终端按 Host 与工作区归属；dshSessionId 只作为本次请求的 attach 上下文。 */
export interface TerminalOwnerScope {
  readonly hostId: string
  readonly workspaceId: string
  readonly dshSessionId?: string
}

export interface TerminalRecordIdentity extends TerminalOwnerScope {
  readonly terminalId: string
}

export interface CodingNsTerminalShell {
  readonly profileId: 'zsh' | 'bash' | 'powershell' | 'cmd' | 'git-bash'
  readonly path: string
  readonly args: readonly string[]
  readonly name: string
}

/** 与 DSH 0.1.6-alpha.2 官方终端 wire shape 对齐，但由 Codingns4DSH 独立命名空间承载。 */
export interface CodingNsWebTerminalInfo {
  readonly id: string
  readonly title: string
  /** 浏览器 wire 不暴露 Host 内部 profileId。 */
  readonly shell: CodingNsTerminalShellOption
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  /**
   * 浏览器可见的终端状态。
   *
   * `lost` 与 `exited` 必须分开：`exited` 表示 shell 真的结束并带退出码，`lost`
   * 表示运行时消失（服务器被外部结束等），此时退出码不可信，用户应重建而不是
   * 看到一个假的"进程已退出"。
   */
  readonly state: 'running' | 'exited' | 'failed' | 'lost'
  readonly exitCode: number | null
  readonly error?: string
  readonly controllerId?: string
}

export interface CodingNsTerminalCreateRequest {
  readonly id: string
  readonly shellPath?: string
  readonly cols: number
  readonly rows: number
}

export interface CodingNsTerminalEnvironment {
  readonly cwd: string
  /** DSH Workspace Registry 的稳定身份；缺失时 Client 仅使用会话级兼容键。 */
  readonly workspaceId?: string
  readonly maxInputBytes: number
  readonly maxCols: number
  readonly maxRows: number
  readonly scrollback: number
}

export interface CodingNsTerminalShellOption {
  readonly path: string
  readonly args: readonly string[]
  readonly name: string
}

/** Host 对设置页公开的终端启动状态；只含平台能力，不含本机控制凭据。 */
export interface CodingNsTerminalStatus {
  readonly platform: 'darwin' | 'linux' | 'win32' | 'unsupported'
  readonly controllerMode: 'baseline' | 'enhanced'
  readonly effectiveEnabled: boolean
  /** 当前 Host 实际注册的 backend；调试启动必须以此为准。 */
  readonly runtimeTypes?: readonly CodingNsTerminalRuntimeType[]
  readonly runtimeWarning?: string
  readonly profiles: readonly {
    readonly profileId: CodingNsTerminalShell['profileId']
    readonly name: string
    readonly path: string
  }[]
  readonly resolvedProfileId: CodingNsTerminalShell['profileId'] | null
  readonly fallbackReason?: string
}

export type CodingNsTerminalFrame =
  | {
    readonly type: 'snapshot'
    readonly sequence: number
    readonly screen: string
    readonly info: CodingNsWebTerminalInfo
  }
  | {
    readonly type: 'output'
    readonly sequence: number
    readonly data: string
  }
  | {
    readonly type: 'state'
    readonly info: CodingNsWebTerminalInfo
  }

export interface CodingNsTerminalRetentionFrame {
  readonly type: 'retained'
}
