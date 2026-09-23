import type { CodingNsRpcTable } from '../rpc-table.js'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import type { TerminalProcessService } from '../terminal/terminal-process-service.js'
import type { DebugProxyService, DebugWorkspaceService } from '../debug.js'

export interface CodingNsHostEvents {
  on(name: string, listener: (...args: any[]) => any): unknown
}

/**
 * Host 侧功能模块可用的服务集合。
 *
 * 模块在 start 中通过 context.services 取用；未来接入工作区、终端或进程能力时
 * 在这里增加字段，模块数量本身不改变这个契约的形状。
 */
export interface CodingNsHostServices {
  readonly rpc: CodingNsRpcTable
  /** 持久化设置；测试或嵌入式调用未提供时，局域网映射仍可手动启动。 */
  readonly settings?: SettingsScope<CodingNsSettings>
  /** Host 设置提供器，供远程设置 RPC 做版本校验和持久化写入。 */
  readonly settingsProvider?: SettingsProvider
  /** 当前 DSH Web 服务实际监听端口，用于自动定位本机 DSH。 */
  readonly dshWebPort?: number
  /** DSH 事件总线；CLI 模块用它接入 llm/stream，测试环境可以不提供。 */
  readonly events?: CodingNsHostEvents
  /** DSH 原生会话桥接；不可用时为 undefined，插件不因此阻断启动。 */
  readonly nativeSessions?: CodingNsNativeSessionBridge
  /** 终端启动项和 PTY 进程服务；只由 Host RPC 使用。 */
  readonly terminalProcesses?: TerminalProcessService
  /** Workspace 级调试服务；只使用 Host 解析出的根目录。 */
  readonly debug?: DebugWorkspaceService
  /** DSH/CodingNS 已有代理的绑定适配器，不在插件内重复实现代理协议。 */
  readonly debugProxy?: DebugProxyService
  /** 由 Host 权威解析 Workspace ID，Client 不可覆盖。 */
  readonly resolveWorkspaceRoot?: (workspaceId: string) => string | null
}
