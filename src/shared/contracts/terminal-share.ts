/** 一次分享保存的是固定文本，不持有终端连接或控制凭据。 */
export interface TerminalTextSnapshot {
  readonly version: 1
  readonly terminalId: string
  readonly title: string
  readonly sourceHostId: string
  readonly sourceWorkspaceId: string
  /** 终端启动目录；不能冒充 Shell 执行 cd 后的实时目录。 */
  readonly cwd: string
  readonly shell: string
  readonly capturedAt: string
  readonly range: 'selection' | 'recent' | 'screen'
  readonly text: string
  readonly lineCount: number
  readonly originalLineCount: number
  readonly truncated: boolean
}

export interface TerminalShareTarget {
  readonly sessionId: string
  readonly title: string
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly hostId: string
  readonly adapterId: string
  readonly updatedAt?: number
}
