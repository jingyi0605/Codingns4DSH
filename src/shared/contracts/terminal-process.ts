import type {
  CodingNsTerminalRuntimeType,
  CodingNsTerminalShell,
  CodingNsWebTerminalInfo,
} from './terminal.js'

/** 终端侧可直接启动的配置；完整调试编排仍由 Spec003 负责。 */
export interface TerminalLaunchProfile {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  /** 相对于 Workspace 根目录，禁止保存绝对路径。 */
  readonly cwdRelative: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly shell: CodingNsTerminalShell
  readonly runtimeType: CodingNsTerminalRuntimeType
  readonly runtimeMode: 'pty'
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TerminalLaunchProfileInput {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly cwdRelative: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly shell: CodingNsTerminalShell
  readonly runtimeType: CodingNsTerminalRuntimeType
  readonly runtimeMode?: 'pty'
}

export type TerminalProcessState = 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'lost'

/** 一次由 Host 创建、并可附着到终端的实际进程记录。 */
export interface TerminalProcessInstance {
  readonly id: string
  readonly workspaceId: string
  readonly profileId: string
  readonly terminalId: string
  readonly runtimeSessionKey: string | null
  readonly state: TerminalProcessState
  readonly pid: number | null
  readonly resolvedCommand: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
  }
  readonly exitCode: number | null
  readonly error?: string
  readonly startedAt: string | null
  readonly stoppedAt: string | null
}

export interface TerminalProcessLaunchRequest {
  readonly workspaceId: string
  readonly profileId: string
  readonly dshSessionId?: string
  readonly terminalId?: string
  readonly cols: number
  readonly rows: number
}

export interface TerminalProcessLaunchResult {
  readonly instance: TerminalProcessInstance
  readonly terminal: CodingNsWebTerminalInfo
}
