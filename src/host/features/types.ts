import type { CodingNsRpcTable } from '../rpc-table.js'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { DshHostSettingsProvider, DshHostSettingsScope } from '../../dsh-capabilities/host/config-forms-adapter.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import type { TerminalProcessService } from '../terminal/terminal-process-service.js'
import type { DebugWorkspaceService } from '../debug.js'
import type { CodingNsNativeTeamProxy } from '../cli-adapters/native-team-proxy.js'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantSessionSourceRecord } from './assistant-session-index.js'
import type { AssistantWaitingKind } from '../../shared/contracts/assistant.js'

export interface CodingNsHostEvents {
  on(name: string, listener: (...args: any[]) => any): unknown
  /** 向 DSH 原生事件总线发布 Host 状态，供客户端会话状态投影消费。 */
  emit?(name: string, ...args: any[]): unknown
}

export interface AssistantHostGateway {
  /** 已显式加入聚合的工作区元数据；不读取远端会话正文。 */
  workspaces?(): Promise<readonly { readonly workspaceId: string; readonly name: string; readonly path: string | null }[]>
  list(managedWorkspaceIds: readonly string[]): Promise<{
    readonly sessions: readonly AssistantSessionSourceRecord[]
    readonly archivedSessionIds: readonly string[]
    /** 远端来源没有本地事件总线；调用方必须在下次请求时重新取快照。 */
    readonly volatile?: boolean
    readonly readSummary?: (session: AssistantSessionSourceRecord) => Promise<string | null>
    readonly readWaiting?: (session: AssistantSessionSourceRecord) => Promise<AssistantWaitingKind | null>
  }>
  dispatch(request: { readonly hostId: string; readonly requestId: string; readonly sessionId: string; readonly mode: 'queue' | 'steer'; readonly content: readonly [{ readonly type: 'text'; readonly text: string }]}, signal?: AbortSignal): Promise<void>
}

/**
 * Host 侧功能模块可用的服务集合。
 *
 * 模块在 start 中通过 context.services 取用；未来接入工作区、终端或进程能力时
 * 在这里增加字段，模块数量本身不改变这个契约的形状。
 */
export interface CodingNsHostServices {
  readonly rpc: CodingNsRpcTable
  /** 当前 DSH Host Context；仅供需要结构探测原生服务的适配层使用。 */
  readonly dshContext?: Context
  /** 当前 DSH 宿主的真实版本；由 Host 入口启动门禁解析并向功能模块传递。 */
  readonly dshVersion?: string
  /** 持久化设置；测试或嵌入式调用未提供时，局域网映射仍可手动启动。 */
  readonly settings?: DshHostSettingsScope<CodingNsSettings>
  /** Host 设置提供器，供远程设置 RPC 做版本校验和持久化写入。 */
  readonly settingsProvider?: DshHostSettingsProvider
  /** 当前 DSH Web 服务实际监听端口，用于自动定位本机 DSH。 */
  readonly dshWebPort?: number
  /** DSH 官方生成的一次性 Web 认证 URL；只留在 Host 内部完成 Cookie 交换。 */
  readonly dshWebAuthenticatedUrl?: string
  /** DSH 事件总线；CLI 模块用它接入 llm/stream，测试环境可以不提供。 */
  readonly events?: CodingNsHostEvents
  /** DSH 原生会话桥接；不可用时为 undefined，插件不因此阻断启动。 */
  readonly nativeSessions?: CodingNsNativeSessionBridge
  /** DSH 0.2 原生 Agent Team Proxy；未安装实验 Team 包时为空。 */
  readonly nativeTeam?: CodingNsNativeTeamProxy
  /** 终端启动项和 PTY 进程服务；只由 Host RPC 使用。 */
  readonly terminalProcesses?: TerminalProcessService
  /** Workspace 级调试服务；只使用 Host 解析出的根目录。 */
  readonly debug?: DebugWorkspaceService
  /** Debug 模块启用时注册其专属 Fetch 路由，停用时由模块资源注销。 */
  readonly registerDebugProxyRoute?: (handler: (request: Request) => Promise<Response>) => () => Promise<void>
  /** PeerHost 固定握手入口；只允许模块返回脱敏能力摘要。 */
  readonly registerPeerHostHandshakeRoute?: (handler: (request: Request) => Promise<Response>) => () => Promise<void>
  /** 全局助理二进制 PCM 流入口；只由语音模块注册和注销。 */
  readonly registerAssistantVoiceStreamRoute?: (handler: (request: Request) => Promise<Response>) => () => Promise<void>
  /** 由 Host 权威解析 Workspace ID，Client 不可覆盖。 */
  readonly resolveWorkspaceRoot?: (workspaceId: string) => string | null
  /** 返回 Host 当前已知的工作区根目录，用于文件管理路径校验。 */
  readonly listWorkspaceRoots?: () => readonly string[]
  /** PeerHost 已装配时提供跨 Host 的助理摘要与派发通道。 */
  readonly assistantGateway?: AssistantHostGateway
}
