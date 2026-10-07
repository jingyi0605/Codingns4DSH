import type { FeatureDescriptor } from './feature.js'
import type { CodingNsCliSessionRecord } from './cli-adapter.js'
import { isDshVersionAtLeast } from './version.js'
import type { AssistantAppearanceSettings } from '../assistant-avatar.js'
import { DEFAULT_ASSISTANT_PROMPTS, type AssistantPromptSettings } from '../assistant-prompts.js'
import type { AssistantTtsSettings } from '../assistant-tts.js'

/** 适配器最近一次使用的模型、思考强度与服务档位。 */
export interface CodingNsCliAdapterPreference {
  readonly modelId?: string | undefined
  readonly effortId?: string | undefined
  /** Provider 服务档位（例如 Codex 官方订阅的 Fast）；`default` 表示标准速度。 */
  readonly serviceTierId?: string | undefined
}

/** 全局智能助理设置；默认空范围，必须由用户显式勾选工作区。 */
export type AssistantVoiceProvider = 'dsh-speech-to-text' | 'sherpa-onnx'

/** 全局语音助理初始化配置；模型目录由 Host 自动下载并写入。 */
export interface AssistantVoiceSettings {
  initialized: boolean
  provider: AssistantVoiceProvider
  /** 已安装的实时模型目录 ID；旧配置没有该字段时按空值兼容。 */
  modelId?: string
  asrEncoder: string
  asrDecoder: string
  asrJoiner: string
  asrTokens: string
  vadModel: string
  ttsModel: string
  ttsTokens: string
  ttsLexicon: string
}

export const DEFAULT_ASSISTANT_VOICE_SETTINGS: AssistantVoiceSettings = {
  initialized: false,
  provider: 'dsh-speech-to-text',
  modelId: '',
  asrEncoder: '',
  asrDecoder: '',
  asrJoiner: '',
  asrTokens: '',
  vadModel: '',
  ttsModel: '',
  ttsTokens: '',
  ttsLexicon: '',
}

export interface AssistantSettings {
  /** 只有显式 initialized=true 表示已创建；缺省或 false 时旧配置仅预填创建表单。 */
  profile?: AssistantProfileSettings
  /** 缺省跟随 DSH 默认模型；固定选择同时用于项目索引与正式对话。 */
  model?: { readonly provider: string; readonly model: string }
  /** 允许助理读取和派发的工作区 ID。 */
  managedWorkspaceIds: string[]
  /** 语音提供方与本地模型路径；未初始化时点击入口只打开模型选择页。 */
  voice: AssistantVoiceSettings
  /** 统一形象配置；旧设置缺失时由展示层补默认值。 */
  appearance?: AssistantAppearanceSettings
  /** 索引总结与对话前置提示词；旧配置使用默认口语化提示词。 */
  prompts?: AssistantPromptSettings
  /** 独立音色与输出后端；缺省保留浏览器播报以兼容旧配置。 */
  tts?: AssistantTtsSettings
}

export interface AssistantProfileSettings {
  readonly name: string
  /** 角色性格与背景，旧档案缺省时不额外限定角色；不作为项目事实。 */
  readonly personality?: string
  readonly initialized: boolean
  readonly createdAt: number | null
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  managedWorkspaceIds: [],
  voice: DEFAULT_ASSISTANT_VOICE_SETTINGS,
  prompts: DEFAULT_ASSISTANT_PROMPTS,
}

/** Codingns4DSH 在 DSH 设置文档中持久化的用户选项。 */
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
  /** DSH 文件管理侧栏的独立增强选项。 */
  fileManagement: FileManagementSettings
  /** 手机/平板窄屏访问时的界面增强选项。 */
  mobileAccess: MobileAccessSettings
  /** 用量查询设置：超时控制单次网络查询，间隔控制自动刷新。 */
  subscriptionUsage: SubscriptionUsageSettings
  /** 全局智能助理设置；不绑定当前页面会话。 */
  assistant: AssistantSettings
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
  /** 适配器级最近选择；新建会话时作为默认模型和思考强度。 */
  agentAdapterPreferences?: Record<string, CodingNsCliAdapterPreference>
  /** 外部 CLI 子代理托管：把外部 Agent 自己的子代理调用转为 DSH 原生可续子会话。 */
  subagentBridge?: SubagentBridgeSettings
}

/** 外部 CLI 子代理托管设置；关闭时所有驱动保持原样。 */
export interface SubagentBridgeSettings {
  enabled: boolean
  /**
   * 同一父会话可同时保留的托管子代理数。
   *
   * 外部 CLI（如 Command Code）会在一批里并发开出远超上限的子代理调用；超限
   * 调用过去直接失败并静默回退到 CLI 内建子代理，父会话与界面都看不出差异。
   * 与 DSH 自身的 `maxActiveSubagents`（缺省 8）保持同一量级，并允许用户按机器
   * 负载调整。
   */
  maxConcurrentSubagents: number
}

/** 并发子代理数上限：下限 1 保证至少能派发，上限避免一次性压垮本机。 */
export const SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS = { min: 1, max: 32 } as const

export const DEFAULT_SUBAGENT_BRIDGE_SETTINGS: SubagentBridgeSettings = {
  enabled: false,
  maxConcurrentSubagents: 8,
}

/** 归一化子代理托管设置：只有显式 true 才算开启；并发数按上下限收敛。 */
export function normalizeSubagentBridgeSettings(value: unknown): SubagentBridgeSettings {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    enabled: record.enabled === true,
    maxConcurrentSubagents: clampSettingsInteger(
      record.maxConcurrentSubagents,
      SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS,
      DEFAULT_SUBAGENT_BRIDGE_SETTINGS.maxConcurrentSubagents,
    ),
  }
}

/** 用量查询设置：超时控制单次网络查询，间隔控制自动刷新。 */
export interface SubscriptionUsageSettings {
  /** 单次用量查询的网络超时（秒）。 */
  timeoutSecs: number
  /** 自动查询间隔（分钟）；0 表示不自动查询。 */
  refreshIntervalMins: number
}

export const DEFAULT_SUBSCRIPTION_USAGE_SETTINGS: SubscriptionUsageSettings = { timeoutSecs: 10, refreshIntervalMins: 5 }
export const SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS = { min: 3, max: 120 } as const
export const SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS = { min: 0, max: 1440 } as const

/** 归一化用量查询设置：缺省字段回填默认值，越界值收敛到允许范围。 */
export function normalizeSubscriptionUsageSettings(value: unknown): SubscriptionUsageSettings {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    timeoutSecs: clampSettingsInteger(record.timeoutSecs, SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS, DEFAULT_SUBSCRIPTION_USAGE_SETTINGS.timeoutSecs),
    refreshIntervalMins: clampSettingsInteger(record.refreshIntervalMins, SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS, DEFAULT_SUBSCRIPTION_USAGE_SETTINGS.refreshIntervalMins),
  }
}

function clampSettingsInteger(value: unknown, limits: { readonly min: number; readonly max: number }, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(limits.max, Math.max(limits.min, numeric))
}

/** 0.1.7 ConfigForm 面向用户的持久化配置；Host-only 会话索引不在其中。 */
export type CodingNsConfig = Omit<CodingNsSettings, 'cliSessions'>

/** Host 运行时状态，与可编辑配置分离，避免泄露到 Client 配置表单。 */
export interface CodingNsRuntimeState {
  readonly cliSessions: CodingNsCliSessionRecord[]
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

/** 工作区会话增强的用户可见设置；每个子能力都可以独立开关。 */
export interface WorkspaceSessionEnhancementSettings {
  showAdapterLogo: boolean
  /** 是否在每个有归档会话的工作区中显示归档入口。 */
  showArchivedSessions: boolean
  /** 是否在工作区菜单提供隐藏与恢复工作区入口。 */
  showWorkspaceHiding: boolean
  /** 插件本地隐藏的工作区 ID；不改变 DSH 原生工作区数据。 */
  hiddenWorkspaceIds: string[]
  /** 是否在对话底部显示订阅与上游用量检测。 */
  showSubscriptionUsage: boolean
  /** 是否在输入工具区显示快捷会话入口。 */
  showQuickPhrases: boolean
  /** 是否索引当前会话所选 Agent 的 Skill，并通过指令快速引用。 */
  showSkillQuickReference: boolean
  /** 是否记忆对话窗口与右侧栏的宽度比例；具体比例保存在当前浏览器。 */
  rememberConversationRightbarRatio: boolean
  /** 插件本地保存的快捷会话条目。 */
  quickPhrases: QuickPhrase[]
  /** 内置快捷会话是否已经完成首次初始化；仅用于兼容旧配置。 */
  quickPhrasesSeeded: boolean
  /**
   * 旧版本曾把手势设置写在这里。保留可选字段只用于读取旧配置，新的设置一律写入
   * `mobileAccess`，避免升级后把用户主动关闭的手势重新打开。
   */
  sidebarGestures?: boolean
  sidebarGestureMapping?: SidebarGestureMapping
  sidebarGestureEdge?: SidebarGestureEdgeMode
  /** 已废弃的像素门槛；只在归一化时用于推导比例，新配置一律写入 `sidebarGestureDistancePercent`。 */
  sidebarGestureThresholdPx?: number
}

/** 移动端侧栏横滑设置。 */
export interface SidebarGestureSettings {
  /** 是否在触摸设备上启用横滑开合左右侧栏。 */
  sidebarGestures: boolean
  /** 手势方向映射：右滑/左滑分别对应哪一侧栏。 */
  sidebarGestureMapping: SidebarGestureMapping
  /** 手势起手区域：是否允许贴上系统边缘热区。 */
  sidebarGestureEdge: SidebarGestureEdgeMode
  /**
   * 触发手势所需的水平位移占视口宽度的百分比。
   *
   * 用比例而不是像素：同一个像素值在 360px 手机与 1024px 平板上的手势占比相差
   * 近三倍，只有比例才能让「灵敏度」这个设置在各类设备上表达同一件事。
   *
   * 该值只约束**距离通道**；位移不足时仍可由甩动通道（快速轻甩）触发。
   */
  sidebarGestureDistancePercent: number
}

/** 横滑手势的方向映射。 */
export type SidebarGestureMapping = 'swipe-inward' | 'swap'

/** 横滑手势的起手区域。 */
export type SidebarGestureEdgeMode = 'avoid' | 'edge'

export const SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS = { min: 15, max: 80 } as const
/**
 * 默认 25%：配合甩动通道，实测有意手势成功率 100%、误触率 0%。
 *
 * 旧默认 40% 与「距离与速度同时达标」的组合让正常滑动被系统性误杀（实测成功率仅 30%），
 * 用户需要重复滑动才能呼出侧栏。
 */
export const DEFAULT_SIDEBAR_GESTURE_DISTANCE_PERCENT = 25
/**
 * 旧像素门槛换算成比例时使用的参考视口宽度。
 *
 * 旧实现的有效阈值是 `max(像素值, 视口宽度 × 40%)`，像素值只有超过该下限才生效。
 * 取常见手机宽度 390px 作为换算基准，并保证结果不低于新的默认值，让「没生效过的旧值」
 * 迁移后直接落到新默认值，从而真正获得本次灵敏度修复。
 */
export const SIDEBAR_GESTURE_LEGACY_THRESHOLD_PX_REFERENCE_WIDTH = 390

export const DEFAULT_SIDEBAR_GESTURE_SETTINGS: SidebarGestureSettings = {
  sidebarGestures: true,
  sidebarGestureMapping: 'swipe-inward',
  sidebarGestureEdge: 'avoid',
  sidebarGestureDistancePercent: DEFAULT_SIDEBAR_GESTURE_DISTANCE_PERCENT,
}

/** 手势设置的归一化输入；保留旧版本写入的像素门槛用于一次性迁移。 */
export type SidebarGestureSettingsInput = Partial<SidebarGestureSettings> & {
  /** 已废弃的像素门槛；只用于推导比例，不再被写回。 */
  sidebarGestureThresholdPx?: number
}

/** 归一化手势设置：缺省回填、越界收敛，非法枚举回落到默认值。 */
export function normalizeSidebarGestureSettings(
  value: SidebarGestureSettingsInput | undefined,
): SidebarGestureSettings {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const percent = record.sidebarGestureDistancePercent === undefined
    ? legacyThresholdPxToPercent(record.sidebarGestureThresholdPx)
    : record.sidebarGestureDistancePercent
  return {
    // 移动端访问增强默认提供横滑入口；桌面端控制器仍会按触摸能力和视口门禁不挂监听。
    sidebarGestures: record.sidebarGestures === undefined
      ? DEFAULT_SIDEBAR_GESTURE_SETTINGS.sidebarGestures
      : record.sidebarGestures === true,
    sidebarGestureMapping: record.sidebarGestureMapping === 'swap' ? 'swap' : 'swipe-inward',
    sidebarGestureEdge: record.sidebarGestureEdge === 'edge' ? 'edge' : 'avoid',
    sidebarGestureDistancePercent: clampSettingsInteger(
      percent,
      SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS,
      DEFAULT_SIDEBAR_GESTURE_DISTANCE_PERCENT,
    ),
  }
}

/**
 * 把已废弃的像素门槛换算成视口百分比。
 *
 * 换算结果不低于当前默认值：旧像素值在绝大多数移动视口上本来就低于
 * `视口宽度 × 40%`，属于「从未生效」的设置，用户实际上一直在用默认手感。
 * 让它们落到新默认值，才能获得本次灵敏度修复；只有确实高于下限的旧值
 * 才保留其「更严格」的意图。
 */
function legacyThresholdPxToPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const percent = Math.round(value / SIDEBAR_GESTURE_LEGACY_THRESHOLD_PX_REFERENCE_WIDTH * 100)
  return Math.max(DEFAULT_SIDEBAR_GESTURE_DISTANCE_PERCENT, percent)
}

/** 文件管理增强的独立能力开关。 */
export interface FileManagementSettings {
  /** 是否为文件和目录显示右键操作菜单。 */
  menuEnhancement: boolean
  /** 是否为可编辑文本文件显示编辑器入口。 */
  fileEditor: boolean
  /** 是否在当前会话顶部显示“修改文件”视图。 */
  sessionChangedFiles: boolean
}

export const DEFAULT_FILE_MANAGEMENT_SETTINGS: FileManagementSettings = {
  menuEnhancement: true,
  fileEditor: true,
  sessionChangedFiles: true,
}

/** 移动端访问增强的独立能力开关；全部只作用于浏览器侧界面。 */
export interface MobileAccessSettings {
  /** 窄屏下彻底隐藏左侧边栏，只在原位置保留品牌 logo 作为唤起入口。 */
  hideSidebarOnMobile: boolean
  /** 是否启用移动端设置界面布局优化。 */
  optimizeSettingsOnMobile: boolean
  /** 判定“移动端/窄屏”的视口宽度上限（像素）。 */
  mobileViewportMaxPx: number
  /** 移动端触摸设备上是否启用横滑开合左右侧栏。 */
  sidebarGestures: boolean
  /** 手势方向映射：右滑/左滑分别对应哪一侧栏。 */
  sidebarGestureMapping: SidebarGestureMapping
  /** 手势起手区域：是否允许贴上系统边缘热区。 */
  sidebarGestureEdge: SidebarGestureEdgeMode
  /** 触发手势所需的水平位移占视口宽度的百分比（15–80，默认 25）。 */
  sidebarGestureDistancePercent: number
}

export const MOBILE_VIEWPORT_MAX_PX_LIMITS = { min: 480, max: 1280 } as const
export const DEFAULT_MOBILE_VIEWPORT_MAX_PX = 1024

export const DEFAULT_MOBILE_ACCESS_SETTINGS: MobileAccessSettings = {
  // 窄屏下 DSH 原生侧栏默认只收起成 56px 图标轨道，仍持续占用横向空间；
  // 默认开启本模块的隐藏能力，用户可随时在设置里关回原生行为。
  hideSidebarOnMobile: true,
  optimizeSettingsOnMobile: true,
  mobileViewportMaxPx: DEFAULT_MOBILE_VIEWPORT_MAX_PX,
  ...DEFAULT_SIDEBAR_GESTURE_SETTINGS,
}

/**
 * 归一化移动端访问设置：缺省回填默认值，越界值收敛到允许范围。
 * 第二个参数只用于读取旧版本写在 workspaceSessionEnhancement 下的手势设置。
 */
export function normalizeMobileAccessSettings(value: unknown, legacyGestureValue?: unknown): MobileAccessSettings {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const legacy = typeof legacyGestureValue === 'object' && legacyGestureValue !== null && !Array.isArray(legacyGestureValue)
    ? legacyGestureValue as Record<string, unknown>
    : {}
  const gestureValue = (key: string): unknown => record[key] ?? legacy[key]
  const gesture: SidebarGestureSettingsInput = {}
  const sidebarGestures = gestureValue('sidebarGestures')
  const sidebarGestureMapping = gestureValue('sidebarGestureMapping')
  const sidebarGestureEdge = gestureValue('sidebarGestureEdge')
  const sidebarGestureDistancePercent = gestureValue('sidebarGestureDistancePercent')
  const sidebarGestureThresholdPx = gestureValue('sidebarGestureThresholdPx')
  if (sidebarGestures !== undefined) gesture.sidebarGestures = sidebarGestures as boolean
  if (sidebarGestureMapping !== undefined) gesture.sidebarGestureMapping = sidebarGestureMapping as SidebarGestureMapping
  if (sidebarGestureEdge !== undefined) gesture.sidebarGestureEdge = sidebarGestureEdge as SidebarGestureEdgeMode
  if (sidebarGestureDistancePercent !== undefined) gesture.sidebarGestureDistancePercent = sidebarGestureDistancePercent as number
  // 旧像素门槛只在没有新比例值时参与换算，避免把已经迁移过的配置再次改写。
  if (sidebarGestureDistancePercent === undefined && sidebarGestureThresholdPx !== undefined) {
    gesture.sidebarGestureThresholdPx = sidebarGestureThresholdPx as number
  }
  return {
    hideSidebarOnMobile: record.hideSidebarOnMobile === undefined
      ? DEFAULT_MOBILE_ACCESS_SETTINGS.hideSidebarOnMobile
      : record.hideSidebarOnMobile === true,
    optimizeSettingsOnMobile: record.optimizeSettingsOnMobile === undefined
      ? DEFAULT_MOBILE_ACCESS_SETTINGS.optimizeSettingsOnMobile
      : record.optimizeSettingsOnMobile === true,
    mobileViewportMaxPx: clampSettingsInteger(
      record.mobileViewportMaxPx,
      MOBILE_VIEWPORT_MAX_PX_LIMITS,
      DEFAULT_MOBILE_ACCESS_SETTINGS.mobileViewportMaxPx,
    ),
    ...normalizeSidebarGestureSettings(gesture),
  }
}

/** 可复用的快捷会话文本。 */
export interface QuickPhrase {
  id: string
  text: string
}

/** 首次启用快捷会话时提供的内置指令。 */
export const DEFAULT_QUICK_PHRASES: QuickPhrase[] = [
  { id: 'builtin-quick-1', text: '请将本次会话变更的所有代码提交到git暂存区，然后总结一条中文的提交信息' },
  { id: 'builtin-quick-2', text: '分析本项目模块的代码实现，并分析存在的问题' },
  { id: 'builtin-quick-3', text: '分析当前项目中的未提交文件，按照功能模块进行分类提交，提交信息格式请参考我最近的提交记录' },
  { id: 'builtin-quick-4', text: '请给出完整的开发提示词，我将在新的页面中继续开发' },
]

/** 局域网访问 DSH 的持久化配置；dshPort 为 0 表示启动时自动探测。 */
export interface LanAccessDshSettings {
  autoStart: boolean
  listenHost: string
  listenPort: number
  dshPort: number
  /** PWA 资产与安装引导；只在局域网入口生效，不影响本机与中继入口。 */
  pwa: LanAccessDshPwaSettings
}

/** 局域网入口的 PWA 增强档位。 */
export interface LanAccessDshPwaSettings {
  /** 是否由代理提供 manifest、图标等静态资产与启动页元数据。 */
  enabled: boolean
  /** 是否合成 `/sw.js` 并在安全上下文里注册；默认关闭，避免驻留。 */
  serviceWorker: boolean
  /** 是否注入安装引导（Android 提示按钮 / iOS 指引）。 */
  installPrompt: boolean
  /** 通知档位；`push` 需要 Host 侧 VAPID 就绪。 */
  notifications: LanAccessDshNotificationMode
}

export type LanAccessDshNotificationMode = 'off' | 'local' | 'push'

export const DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS: LanAccessDshPwaSettings = {
  enabled: true,
  serviceWorker: false,
  installPrompt: true,
  notifications: 'off',
}

/** 归一化 PWA 设置：缺省回填默认值，非法枚举回落到最保守档位。 */
export function normalizeLanAccessDshPwaSettings(value: unknown): LanAccessDshPwaSettings {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    enabled: record.enabled === undefined ? DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS.enabled : record.enabled === true,
    serviceWorker: record.serviceWorker === true,
    installPrompt: record.installPrompt === undefined ? DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS.installPrompt : record.installPrompt === true,
    notifications: record.notifications === 'local' || record.notifications === 'push' ? record.notifications : 'off',
  }
}

export interface LoginProtectionScopes {
  /** 局域网网卡入口。 */
  lan: boolean
  /** Codingns4DSH 中继入口。 */
  relay: boolean
}

/** 登录保护的公开设置；密码哈希仅保存在 Host 私有凭据文件中。 */
export interface LanAccessDshLoginSettings {
  enabled: boolean
  username: string
  passwordConfigured: boolean
  timeoutSeconds: number
  scopes: LoginProtectionScopes
}

export const CODINGNS_SETTINGS_NAMESPACE = 'codingns'
/** DSH 配置表单可能使用的插件 entry id；scoped 包名是当前 Bundle 的正式 ID。 */
export const CODINGNS_SETTINGS_ENTRY_IDS = [
  '@jingyi0605/codingns4dsh',
  'codingns4dsh',
  CODINGNS_SETTINGS_NAMESPACE,
] as const

export function isCodingNsSettingsEntryId(value: unknown): value is typeof CODINGNS_SETTINGS_ENTRY_IDS[number] {
  return typeof value === 'string' && (CODINGNS_SETTINGS_ENTRY_IDS as readonly string[]).includes(value)
}

export const CODINGNS_CONTROL_BASE_URL_FIELD = 'controlBaseUrl'
export const CODINGNS_CONTROL_BASE_URLS_FIELD = 'controlBaseUrls'
export const CODINGNS_MODULES_FIELD = 'modules'
export const CODINGNS_LAN_ACCESS_DSH_FIELD = 'lanAccessDsh'
export const CODINGNS_TERMINAL_ENHANCEMENT_FIELD = 'terminalEnhancement'
export const CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD = 'workspaceSessionEnhancement'
export const CODINGNS_FILE_MANAGEMENT_FIELD = 'fileManagement'
export const CODINGNS_MOBILE_ACCESS_FIELD = 'mobileAccess'
export const CODINGNS_SUBSCRIPTION_USAGE_FIELD = 'subscriptionUsage'
export const CODINGNS_ASSISTANT_FIELD = 'assistant'
export const CODINGNS_SUBAGENT_BRIDGE_FIELD = 'subagentBridge'
export const DEFAULT_CODINGNS_CONTROL_BASE_URL = 'https://channel.codingns.com:1443'
export const DEFAULT_CODINGNS_CONTROL_BASE_URLS = [DEFAULT_CODINGNS_CONTROL_BASE_URL]
/** 控制站的网页登录地址，用于注册 Codingns4DSH 账号。 */
export const CODINGNS_CONTROL_STATION_URL = 'https://channel.codingns.com:1443'
/** 独立 H5 登录页面地址；登录控制站后可从设置页复制给其他设备。 */
export const CODINGNS_H5_LOGIN_URL = 'https://dsh.codingns.com'
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
  showWorkspaceHiding: true,
  hiddenWorkspaceIds: [],
  showSubscriptionUsage: true,
  showQuickPhrases: true,
  showSkillQuickReference: true,
  rememberConversationRightbarRatio: false,
  quickPhrases: DEFAULT_QUICK_PHRASES.map((phrase) => ({ ...phrase })),
  quickPhrasesSeeded: true,
}
export const DEFAULT_CODINGNS_SETTINGS: CodingNsSettings = {
  controlBaseUrl: DEFAULT_CODINGNS_CONTROL_BASE_URL,
  controlBaseUrls: [...DEFAULT_CODINGNS_CONTROL_BASE_URLS],
  modules: {},
  agentAdapters: {},
  agentAdapterPreferences: {},
  subagentBridge: DEFAULT_SUBAGENT_BRIDGE_SETTINGS,
  terminalEnhancement: DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
  workspaceSessionEnhancement: DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
  fileManagement: DEFAULT_FILE_MANAGEMENT_SETTINGS,
  mobileAccess: DEFAULT_MOBILE_ACCESS_SETTINGS,
  subscriptionUsage: DEFAULT_SUBSCRIPTION_USAGE_SETTINGS,
  assistant: DEFAULT_ASSISTANT_SETTINGS,
  lanAccessDsh: {
    autoStart: false,
    listenHost: '0.0.0.0',
    listenPort: 13080,
    dshPort: 0,
    pwa: DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS,
  },
}

/** 重启生效模块在当前进程启动时捕获的有效状态。 */
export type RestartFeatureStates = Readonly<Record<string, boolean>>

export function captureRestartFeatureStates(
  descriptors: readonly FeatureDescriptor[],
  settings: CodingNsSettings | undefined,
  dshVersion?: string,
): Record<string, boolean> {
  const states: Record<string, boolean> = {}
  for (const descriptor of descriptors) {
    if (descriptor.activation === 'restart') {
      states[descriptor.name] = isFeatureDshVersionCompatible(descriptor, dshVersion)
        && isFeatureEnabled(descriptor, settings)
    }
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
  if (descriptor.disabled === true) return false
  if (descriptor.ui?.alwaysEnabled === true) return true
  return settings?.modules[descriptor.name] ?? descriptor.enabledByDefault
}

/** 汇总当前应当启用的模块名，交给 FeatureRegistry.reconcile 对齐状态。 */
export function enabledFeatureNames(
  descriptors: readonly FeatureDescriptor[],
  settings: CodingNsSettings | undefined,
  restartStates?: RestartFeatureStates,
  dshVersion?: string,
): string[] {
  const names: string[] = []
  for (const descriptor of descriptors) {
    const enabled = descriptor.activation === 'restart' && restartStates !== undefined
      ? restartStates[descriptor.name] ?? descriptor.enabledByDefault
      : isFeatureEnabled(descriptor, settings)
    if (enabled && isFeatureDshVersionCompatible(descriptor, dshVersion)) names.push(descriptor.name)
  }
  return names
}

/** 判断模块是否可以在当前 DSH 版本运行。未提供运行时版本时保留旧调用方行为。 */
export function isFeatureDshVersionCompatible(
  descriptor: FeatureDescriptor,
  dshVersion?: string,
): boolean {
  if (descriptor.minimumDshVersion === undefined || dshVersion === undefined) return true
  return isDshVersionAtLeast(dshVersion, descriptor.minimumDshVersion)
}
