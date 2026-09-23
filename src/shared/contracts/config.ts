import type { FeatureDescriptor } from './feature.js'
import type { CodingNsCliSessionRecord } from './cli-adapter.js'

/** CodingNS 在 DSH 设置文档中持久化的用户选项。 */
export interface CodingNsSettings {
  /** Control API 地址不是秘密，可以由 Web 设置页保存到 Host 设置。 */
  controlBaseUrl: string
  /** Control API 地址候选列表；列表本身不包含任何凭据。 */
  controlBaseUrls: string[]
  /** 局域网访问 DSH 的唯一监听映射及启动策略。 */
  lanAccessDsh: LanAccessDshSettings
  /** 插件 Sidebar 终端的默认 profile 与受控外观设置。 */
  terminalEnhancement: TerminalEnhancementSettings
  /** 原生工作区会话行的浏览器端增强选项。 */
  workspaceSessionEnhancement: WorkspaceSessionEnhancementSettings
  /**
   * 功能模块启用意图：模块名 -> 是否启用。
   *
   * 缺省时回落到模块自己声明的 enabledByDefault，因此设置结构不随模块数量变化。
  */
  modules: Record<string, boolean>
  /** 外部 Agent 启用意图：适配器 id -> 是否启用；缺省时所有已注册 Agent 启用。 */
  agentAdapters?: Record<string, boolean>
  /** Host 侧外部 Agent 会话索引；不含凭据和原始消息。 */
  cliSessions?: CodingNsCliSessionRecord[]
}

/** 跨平台终端 profile；`system` 由 Host 根据平台和已安装 shell 解析。 */
export type TerminalProfileId = 'system' | 'zsh' | 'bash' | 'powershell' | 'cmd' | 'git-bash'
/** 终端持久记录的归属范围；工作区模式允许不同 DSH 会话共享终端。 */
export type TerminalBindingScope = 'workspace' | 'session'

export type TerminalAppearanceTheme = 'inherit' | 'custom'
export type TerminalCursorStyle = 'block' | 'bar' | 'underline'

/** 仅保存可映射到 xterm 公开选项的外观字段。 */
export interface TerminalAppearanceSettings {
  theme: TerminalAppearanceTheme
  background: string | null
  foreground: string | null
  cursorColor: string | null
  fontFamily: string | null
  fontSize: number | null
  lineHeight: number | null
  cursorStyle: TerminalCursorStyle | null
  cursorBlink: boolean | null
  scrollback: number | null
}

export interface TerminalEnhancementSettings {
  /** 缺省按工作区归属；旧设置缺少此字段时由 schema 回填。 */
  bindingScope?: TerminalBindingScope
  defaultProfile: TerminalProfileId
  appearance: TerminalAppearanceSettings
}

/** 工作区会话增强的用户可见设置；归档入口跟随模块启停，不增加额外开关。 */
export interface WorkspaceSessionEnhancementSettings {
  showAdapterLogo: boolean
  /** 是否在每个有归档会话的工作区中显示归档入口。 */
  showArchivedSessions: boolean
  /** 是否在对话底部显示订阅与上游用量检测。 */
  showSubscriptionUsage: boolean
}

/** 局域网访问 DSH 的持久化配置；dshPort 为 0 表示启动时自动探测。 */
export interface LanAccessDshSettings {
  autoStart: boolean
  listenHost: string
  listenPort: number
  dshPort: number
}

export const CODINGNS_SETTINGS_NAMESPACE = 'codingns'
export const CODINGNS_CONTROL_BASE_URL_FIELD = 'controlBaseUrl'
export const CODINGNS_CONTROL_BASE_URLS_FIELD = 'controlBaseUrls'
export const CODINGNS_MODULES_FIELD = 'modules'
export const CODINGNS_LAN_ACCESS_DSH_FIELD = 'lanAccessDsh'
export const CODINGNS_TERMINAL_ENHANCEMENT_FIELD = 'terminalEnhancement'
export const CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD = 'workspaceSessionEnhancement'
export const DEFAULT_CODINGNS_CONTROL_BASE_URL = 'https://channel.codingns.com:1443'
export const DEFAULT_CODINGNS_CONTROL_BASE_URLS = [DEFAULT_CODINGNS_CONTROL_BASE_URL]
export const DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS: TerminalEnhancementSettings = {
  bindingScope: 'workspace',
  defaultProfile: 'system',
  appearance: {
    theme: 'inherit',
    background: null,
    foreground: null,
    cursorColor: null,
    fontFamily: null,
    fontSize: null,
    lineHeight: null,
    cursorStyle: null,
    cursorBlink: null,
    scrollback: null,
  },
}
export const DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS: WorkspaceSessionEnhancementSettings = {
  showAdapterLogo: true,
  showArchivedSessions: true,
  showSubscriptionUsage: true,
}
export const DEFAULT_CODINGNS_SETTINGS: CodingNsSettings = {
  controlBaseUrl: DEFAULT_CODINGNS_CONTROL_BASE_URL,
  controlBaseUrls: [...DEFAULT_CODINGNS_CONTROL_BASE_URLS],
  modules: {},
  agentAdapters: {},
  terminalEnhancement: DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
  workspaceSessionEnhancement: DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
  lanAccessDsh: {
    autoStart: false,
    listenHost: '0.0.0.0',
    listenPort: 13080,
    dshPort: 0,
  },
}

/** 重启生效模块在当前进程启动时捕获的有效状态。 */
export type RestartFeatureStates = Readonly<Record<string, boolean>>

export function captureRestartFeatureStates(
  descriptors: readonly FeatureDescriptor[],
  settings: CodingNsSettings | undefined,
): Record<string, boolean> {
  const states: Record<string, boolean> = {}
  for (const descriptor of descriptors) {
    if (descriptor.activation === 'restart') states[descriptor.name] = isFeatureEnabled(descriptor, settings)
  }
  return states
}

/**
 * 判定一个功能模块当前是否应当启用。
 *
 * 常驻模块（ui.alwaysEnabled）始终启用；其余模块读取设置里的用户意图，
 * 用户没有表达过意图时使用模块自己声明的 enabledByDefault。
 */
export function isFeatureEnabled(
  descriptor: FeatureDescriptor,
  settings: CodingNsSettings | undefined,
): boolean {
  if (descriptor.ui?.alwaysEnabled === true) return true
  return settings?.modules[descriptor.name] ?? descriptor.enabledByDefault
}

/** 汇总当前应当启用的模块名，交给 FeatureRegistry.reconcile 对齐状态。 */
export function enabledFeatureNames(
  descriptors: readonly FeatureDescriptor[],
  settings: CodingNsSettings | undefined,
  restartStates?: RestartFeatureStates,
): string[] {
  const names: string[] = []
  for (const descriptor of descriptors) {
    const enabled = descriptor.activation === 'restart' && restartStates !== undefined
      ? restartStates[descriptor.name] ?? descriptor.enabledByDefault
      : isFeatureEnabled(descriptor, settings)
    if (enabled) names.push(descriptor.name)
  }
  return names
}
