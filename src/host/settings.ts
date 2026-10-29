import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { DshHostSettingsProvider, DshHostSettingsScope } from '../dsh-capabilities/host/config-forms-adapter.js'
import type { CodingNsSettingsOperation } from '../dsh-capabilities/settings-store.js'
import {
  CODINGNS_SETTINGS_NAMESPACE,
  isCodingNsSettingsEntryId,
  DEFAULT_CODINGNS_SETTINGS,
  MOBILE_VIEWPORT_MAX_PX_LIMITS,
  SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS,
  SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS,
  SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS,
  SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS,
  SESSION_HANDLE_EVICTION_IDLE_TTL_MS_LIMITS,
  SESSION_HANDLE_EVICTION_MAX_OPEN_HANDLES_LIMITS,
  type CodingNsConfig,
  type CodingNsSettings,
} from '../shared/contracts/config.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS } from '../shared/contracts/session-translation.js'
import { DEFAULT_GIT_MANAGEMENT_SETTINGS, MAX_GIT_COMMIT_PROMPT_CHARS } from '../shared/contracts/git.js'
import { debugInfo } from '../shared/debug.js'

/**
 * DSH 设置服务使用的 Codingns4DSH namespace schema。
 *
 * 模块开关用字典表达：新增模块只是字典里多一个键，既不需要改这个 schema，
 * 也不需要改 CodingNsSettings 接口。
 */
export const CodingNsSettingsSchema = z.object({
  controlBaseUrl: z.string().default(DEFAULT_CODINGNS_SETTINGS.controlBaseUrl),
  controlBaseUrls: z.array(z.string()).default(DEFAULT_CODINGNS_SETTINGS.controlBaseUrls),
  modules: z.dict(z.boolean()).default(DEFAULT_CODINGNS_SETTINGS.modules),
  quickApps: z.array(z.object({
    id: z.string().min(1).max(512), title: z.string().min(1).max(512), hostId: z.string().min(1).max(512),
    workspaceId: z.string().min(1).max(512), entryPath: z.string().max(2048), documentRoot: z.string().max(2048),
    kind: z.union([z.const('html'), z.const('text')]), spaFallback: z.boolean(),
    fileAccess: z.union([z.const('workspace'), z.const(undefined)]),
    networkAllow: z.union([z.array(z.string().min(1).max(253)).max(16), z.const(undefined)]),
    mounts: z.array(z.object({ urlPrefix: z.string().max(2048), workspacePath: z.string().max(2048), read: z.const(true) })).max(8),
    revision: z.number().min(1).step(1), order: z.number().step(1),
  })).max(200).default([]),
  agentAdapters: z.dict(z.boolean()).default(DEFAULT_CODINGNS_SETTINGS.agentAdapters ?? {}),
  agentAdapterPreferences: z.dict(z.object({
    modelId: z.union([z.string(), z.const(undefined)]),
    effortId: z.union([z.string(), z.const(undefined)]),
    serviceTierId: z.union([z.string(), z.const(undefined)]),
    translationEnabled: z.union([z.boolean(), z.const(undefined)]),
  })).default({}),
  subagentBridge: z.object({
    enabled: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.subagentBridge?.enabled ?? false),
    maxConcurrentSubagents: z.number()
      .min(SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS.min)
      .max(SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS.max)
      .default(DEFAULT_CODINGNS_SETTINGS.subagentBridge?.maxConcurrentSubagents ?? 8),
  }).default(DEFAULT_CODINGNS_SETTINGS.subagentBridge ?? { enabled: false, maxConcurrentSubagents: 8 }),
  sessionHandleEviction: z.object({
    enabled: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.sessionHandleEviction.enabled),
    idleTtlMs: z.number().step(1)
      .min(SESSION_HANDLE_EVICTION_IDLE_TTL_MS_LIMITS.min)
      .max(SESSION_HANDLE_EVICTION_IDLE_TTL_MS_LIMITS.max)
      .default(DEFAULT_CODINGNS_SETTINGS.sessionHandleEviction.idleTtlMs),
    maxOpenHandles: z.number().step(1)
      .min(SESSION_HANDLE_EVICTION_MAX_OPEN_HANDLES_LIMITS.min)
      .max(SESSION_HANDLE_EVICTION_MAX_OPEN_HANDLES_LIMITS.max)
      .default(DEFAULT_CODINGNS_SETTINGS.sessionHandleEviction.maxOpenHandles),
  }).default(DEFAULT_CODINGNS_SETTINGS.sessionHandleEviction),
  gitManagement: z.object({
    commitMessageEnabled: z.boolean().default(true),
    commitMessageDetail: z.union([z.const('concise'), z.const('detailed')]).default('concise'),
    commitMessageModels: z.array(z.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200) })).default([]),
    commitMessagePrompt: z.string().max(MAX_GIT_COMMIT_PROMPT_CHARS).default(''),
  }).default({ ...DEFAULT_GIT_MANAGEMENT_SETTINGS, commitMessageModels: [...DEFAULT_GIT_MANAGEMENT_SETTINGS.commitMessageModels] }),
  sessionTranslation: z.object({
    inputEnabled: z.boolean().default(true),
    reasoningEnabled: z.boolean().default(true),
    assistantEnabled: z.boolean().default(true),
    adapterOptions: z.dict(z.object({
      inputEnabled: z.union([z.boolean(), z.const(undefined)]),
      reasoningEnabled: z.union([z.boolean(), z.const(undefined)]),
      assistantEnabled: z.union([z.boolean(), z.const(undefined)]),
    })).default({}),
    // 输入语言放开中文：DSH 原生会话的典型用法正是「中文输入 → 英文请求」。
    inputLanguage: z.union([z.const('zh'), z.const('en'), z.const('fr'), z.const('de'), z.const('ja')]).default(DEFAULT_SESSION_TRANSLATION_SETTINGS.inputLanguage),
    outputLanguage: z.union([z.const('zh'), z.const('en'), z.const('fr'), z.const('de'), z.const('ja')]).default(DEFAULT_SESSION_TRANSLATION_SETTINGS.outputLanguage),
    bilingual: z.boolean().default(DEFAULT_SESSION_TRANSLATION_SETTINGS.bilingual),
    // DSH 原生会话默认不翻译：输出翻译会把 assistant 正文写成译文，不能默认改变既有行为。
    nativeEnabled: z.boolean().default(DEFAULT_SESSION_TRANSLATION_SETTINGS.nativeEnabled === true),
    translationModel: z.union([z.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200) }), z.const(undefined)]),
    translationModels: z.union([z.array(z.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200) })), z.const(undefined)]),
    translationRules: z.union([z.array(z.string()), z.const(undefined)]),
  }).default({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: undefined, translationRules: undefined }),
  // 会话索引是 Host 摘要数据，不能让它进入浏览器状态或模型上下文。
  cliSessions: z.array(z.any()).default(DEFAULT_CODINGNS_SETTINGS.cliSessions ?? []),
  lanAccessDsh: z.object({
    autoStart: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.autoStart),
    listenHost: z.string().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.listenHost),
    listenPort: z.number().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.listenPort),
    dshPort: z.number().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.dshPort),
    pwa: z.object({
      enabled: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.pwa.enabled),
      serviceWorker: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.pwa.serviceWorker),
      installPrompt: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.pwa.installPrompt),
      notifications: z.union([z.const('off'), z.const('local'), z.const('push')])
        .default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.pwa.notifications),
    }).default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh.pwa),
  }).default(DEFAULT_CODINGNS_SETTINGS.lanAccessDsh),
  terminalEnhancement: z.object({
    bindingScope: z.union([z.const('workspace'), z.const('session')])
      .default(DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.bindingScope ?? 'workspace'),
    defaultProfile: z.union([
      z.const('system'), z.const('zsh'), z.const('bash'),
      z.const('powershell'), z.const('cmd'), z.const('git-bash'),
    ]).default(DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.defaultProfile),
    appearance: z.object({
      theme: z.union([z.const('inherit'), z.const('custom')])
        .default(DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.appearance.theme),
      background: nullableColorSchema(),
      foreground: nullableColorSchema(),
      cursorColor: nullableColorSchema(),
      fontFamily: z.union([
        z.string().min(1).max(128).pattern(/^[^\u0000-\u001F\u007F]+$/u),
        z.const(null),
      ]).default(null),
      fontSize: nullableNumberSchema(10, 32),
      lineHeight: nullableNumberSchema(1, 2),
      cursorStyle: z.union([
        z.const('block'), z.const('bar'), z.const('underline'), z.const(null),
      ]).default(null),
      cursorBlink: z.union([z.boolean(), z.const(null)]).default(null),
      scrollback: z.union([z.number().step(1).min(1000).max(100000), z.const(null)]).default(null),
    }).default(DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.appearance),
  }).default({
    ...DEFAULT_CODINGNS_SETTINGS.terminalEnhancement,
    bindingScope: DEFAULT_CODINGNS_SETTINGS.terminalEnhancement.bindingScope ?? 'workspace',
  }),
  workspaceSessionEnhancement: z.object({
    showAdapterLogo: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.showAdapterLogo),
    showArchivedSessions: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.showArchivedSessions),
    showWorkspaceHiding: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.showWorkspaceHiding),
    hiddenWorkspaceIds: z.array(z.string().min(1).max(512)).default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.hiddenWorkspaceIds),
    showSubscriptionUsage: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.showSubscriptionUsage),
    showQuickPhrases: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.showQuickPhrases),
    showSkillQuickReference: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.showSkillQuickReference),
    optimizeSessionTitles: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.optimizeSessionTitles),
    rememberConversationRightbarRatio: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.rememberConversationRightbarRatio),
    quickPhrases: z.array(z.object({
      id: z.string().min(1).max(128),
      text: z.string().min(1).max(4000),
    })).default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.quickPhrases),
    // 缺少该字段说明是旧配置；Client 首次加载时会补齐内置快捷会话。
    quickPhrasesSeeded: z.boolean().default(false),
  }).default(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement),
  fileManagement: z.object({
    menuEnhancement: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.fileManagement.menuEnhancement),
    fileEditor: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.fileManagement.fileEditor),
    sessionChangedFiles: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.fileManagement.sessionChangedFiles),
  }).default(DEFAULT_CODINGNS_SETTINGS.fileManagement),
  mobileAccess: z.object({
    hideSidebarOnMobile: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.mobileAccess.hideSidebarOnMobile),
    optimizeSettingsOnMobile: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.mobileAccess.optimizeSettingsOnMobile),
    mobileViewportMaxPx: z.number().step(1)
      .min(MOBILE_VIEWPORT_MAX_PX_LIMITS.min)
      .max(MOBILE_VIEWPORT_MAX_PX_LIMITS.max)
      .default(DEFAULT_CODINGNS_SETTINGS.mobileAccess.mobileViewportMaxPx),
    // 手势字段不设置 schema 默认值，让旧配置可以由 Client 从 workspaceSessionEnhancement 回填。
    sidebarGestures: z.union([z.boolean(), z.const(undefined)]),
    sidebarGestureMapping: z.union([z.const('swipe-inward'), z.const('swap'), z.const(undefined)]),
    sidebarGestureEdge: z.union([z.const('avoid'), z.const('edge'), z.const(undefined)]),
    sidebarGestureDistancePercent: z.union([
      z.number().step(1)
        .min(SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.min)
        .max(SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.max),
      z.const(undefined),
    ]),
    // 旧像素门槛保留在 schema 里，保证升级后仍能读到并换算成比例；新写入不再使用。
    sidebarGestureThresholdPx: z.union([z.number(), z.const(undefined)]),
  }).default({
    hideSidebarOnMobile: DEFAULT_CODINGNS_SETTINGS.mobileAccess.hideSidebarOnMobile,
    optimizeSettingsOnMobile: DEFAULT_CODINGNS_SETTINGS.mobileAccess.optimizeSettingsOnMobile,
    mobileViewportMaxPx: DEFAULT_CODINGNS_SETTINGS.mobileAccess.mobileViewportMaxPx,
  }),
  subscriptionUsage: z.object({
    timeoutSecs: z.number().step(1)
      .min(SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS.min)
      .max(SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS.max)
      .default(DEFAULT_CODINGNS_SETTINGS.subscriptionUsage.timeoutSecs),
    refreshIntervalMins: z.number().step(1)
      .min(SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS.min)
      .max(SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS.max)
      .default(DEFAULT_CODINGNS_SETTINGS.subscriptionUsage.refreshIntervalMins),
  }).default(DEFAULT_CODINGNS_SETTINGS.subscriptionUsage),
  // 订阅用量页面的显示口径存在 Host：刷新页面、换浏览器或换设备后读法保持一致。
  subscriptionReports: z.object({
    quotaView: z.union([z.const('used'), z.const('remaining')])
      .default(DEFAULT_CODINGNS_SETTINGS.subscriptionReports?.quotaView ?? 'remaining'),
  }).default(DEFAULT_CODINGNS_SETTINGS.subscriptionReports ?? { quotaView: 'remaining' }),
}) as unknown as z<CodingNsSettings>

/**
 * DSH 0.1.7 只会把 `volatile` 配置投影成可编辑 ConfigForm。
 *
 * 整个根节点标记为 volatile，保留 Host 侧 `cliSessions` 的持久化能力；
 * Client 适配器会在镜像配置时剔除这个 Host-only 字段，避免会话索引进入浏览器。
 */
export const CodingNsConfigSchema = CodingNsSettingsSchema.volatile() as unknown as z<CodingNsConfig>

let lastConfigDescriptorSignature: string | undefined

/** 颜色字段只接受完整十六进制颜色，`null` 表示继承 DSH 原生值。 */
function nullableColorSchema(): z<string | null> {
  return z.union([z.string().pattern(/^#[0-9A-Fa-f]{6}$/u), z.const(null)]).default(null) as unknown as z<string | null>
}

function nullableNumberSchema(min: number, max: number): z<number | null> {
  return z.union([z.number().min(min).max(max), z.const(null)]).default(null) as unknown as z<number | null>
}

/**
 * 在 Host 设置文档中注册 Codingns4DSH 的持久化选项。
 *
 * 必须在已经注入 `settings` 的上下文里调用。返回的 scope 既用于读取当前值，
 * 也通过 watch 驱动功能模块启停。
 * readRuntimeConfig 必须读取入口 Fiber 已校验的 Config，供原生表单尚未激活时使用。
 */
export function registerCodingNsSettings(
  ctx: Context,
  readRuntimeConfig?: () => unknown,
): DshHostSettingsScope<CodingNsSettings> {
  const settings = ctx.settings as unknown as DshHostSettingsProvider
  const legacyRegister = (settings as DshHostSettingsProvider & {
    readonly register?: (
      namespace: string,
      schema: typeof CodingNsSettingsSchema,
      options?: { readonly applies?: 'live' | 'restart' },
    ) => DshHostSettingsScope<CodingNsSettings>
  }).register
  if (typeof legacyRegister === 'function') {
    debugInfo('codingns4dsh: host settings source=legacy-settings')
    return legacyRegister.call(settings, CODINGNS_SETTINGS_NAMESPACE, CodingNsSettingsSchema, {
      applies: 'live',
    }) as DshHostSettingsScope<CodingNsSettings>
  }
  debugInfo('codingns4dsh: host settings source=config-forms')
  return createConfigSettingsScope(ctx, settings, readRuntimeConfig)
}

export interface LegacyAssistantSettingsCleanupResult {
  readonly status: 'cleaned' | 'unchanged' | 'skipped'
  readonly reason?: 'missing' | 'readonly' | 'unsupported'
}

/**
 * Remove only the donor-owned assistant configuration left by older releases.
 *
 * This touches the CodingNS settings document only. Conversation files, voice
 * models, avatar packages, and other assistant data remain available to the
 * standalone package's explicit migration flow.
 */
export async function cleanupLegacyAssistantSettings(
  provider: DshHostSettingsProvider,
): Promise<LegacyAssistantSettingsCleanupResult> {
  const descriptor = findConfigSettingsDescriptor(provider)
  if (descriptor === undefined) return { status: 'skipped', reason: 'missing' }
  if (descriptor.writable === false) return { status: 'skipped', reason: 'readonly' }

  const current = asRecord(descriptor.value)
  const modules = asRecord(current?.modules)
  const hasAssistant = current !== undefined && Object.prototype.hasOwnProperty.call(current, 'assistant')
  const hasAssistantModule = modules !== undefined
    && Object.prototype.hasOwnProperty.call(modules, 'globalVoiceAssistant')
  if (!hasAssistant && !hasAssistantModule) return { status: 'unchanged' }

  const namespace = descriptor.ns
  if (typeof provider.mutate === 'function') {
    const operations: CodingNsSettingsOperation[] = []
    if (hasAssistant) operations.push({ op: 'unset', path: ['assistant'] })
    if (hasAssistantModule) operations.push({ op: 'unset', path: ['modules', 'globalVoiceAssistant'] })
    await provider.mutate(namespace, operations, descriptor.revision)
    return { status: 'cleaned' }
  }

  if (typeof provider.replace === 'function' && current !== undefined) {
    const next = structuredClone(current)
    delete next.assistant
    if (asRecord(next.modules) !== undefined) delete next.modules.globalVoiceAssistant
    await provider.replace(namespace, next, descriptor.revision)
    return { status: 'cleaned' }
  }

  return { status: 'skipped', reason: 'unsupported' }
}

/** 将 DSH 0.1.7 SettingsForms 适配成 Host 业务沿用的 SettingsScope。 */
function createConfigSettingsScope(
  ctx: Context,
  settings: DshHostSettingsProvider,
  readRuntimeConfig?: () => unknown,
): DshHostSettingsScope<CodingNsSettings> {
  const provider = settings
  const read = (): CodingNsSettings => readConfigSettings(provider, readRuntimeConfig)
  let previous = read()
  const listeners = new Set<(next: CodingNsSettings, prev: CodingNsSettings) => void | Promise<void>>()
  const eventContext = ctx as Context & {
    on?: (name: string, listener: (namespace: string) => void) => () => void
  }
  const disposeEvent = eventContext.on?.('settings/document-updated', (namespace) => {
    if (!isCodingNsSettingsNamespace(namespace)) return
    const next = read()
    const prev = previous
    previous = next
    if (next === prev) return
    for (const listener of [...listeners]) void listener(next, prev)
  })
  if (disposeEvent !== undefined) {
    ctx.effect(() => disposeEvent, 'codingns4dsh: ConfigForm 设置监听')
  }
  return {
    get: read,
    watch: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: async (patch) => {
      if (typeof provider.update !== 'function') throw new Error('DSH ConfigForms 不支持 update')
      await provider.update(resolveConfigSettingsNamespace(provider), patch)
    },
    replace: async (section) => {
      if (typeof provider.replace !== 'function') throw new Error('DSH ConfigForms 不支持 replace')
      await provider.replace(resolveConfigSettingsNamespace(provider), section)
    },
  }
}

function readConfigSettings(
  settings: Pick<DshHostSettingsProvider, 'describe'>,
  readRuntimeConfig?: () => unknown,
): CodingNsSettings {
  const descriptor = findConfigSettingsDescriptor(settings)
  if (descriptor !== undefined) return descriptor.value as CodingNsSettings

  // 原生热重载时插件仍处于加载态，SettingsForms 只投影已经激活的 entry。
  // 此时读取当前插件 Fiber 已解析的配置，不能用默认值冻结终端等启动开关。
  // 根 Config 是 volatile 引用；每次解引用，设置后续更新仍来自同一份原生配置。
  const config = readRuntimeConfig?.()
  if (config !== undefined) {
    const value = config as CodingNsSettings & { get?: () => CodingNsSettings }
    // Fiber 配置已经通过 schema 校验；volatile 值被深冻结，不能再次原地校验。
    return structuredClone(typeof value.get === 'function' ? value.get() : value)
  }
  console.warn('codingns4dsh: host ConfigForms 未找到设置 namespace，使用默认值')
  return DEFAULT_CODINGNS_SETTINGS
}

/** DSH 0.1.7 使用插件 entry id；旧 SettingsScope 使用显式 namespace。 */
function findConfigSettingsDescriptor(settings: Pick<DshHostSettingsProvider, 'describe'>) {
  const descriptors = settings.describe({ redactSecrets: false })
  const signature = JSON.stringify(descriptors.map((item) => ({
    ns: item.ns,
    revision: item.revision,
    writable: (item as { writable?: unknown }).writable,
    hasValue: item.value !== undefined,
  })))
  if (signature !== lastConfigDescriptorSignature) {
    lastConfigDescriptorSignature = signature
    debugInfo('codingns4dsh: host ConfigForms descriptors', JSON.parse(signature) as unknown)
  }
  return descriptors.find((item) => isCodingNsSettingsNamespace(item.ns))
}

function resolveConfigSettingsNamespace(settings: Pick<DshHostSettingsProvider, 'describe'>): string {
  const namespace = findConfigSettingsDescriptor(settings)?.ns
  // 未激活的 entry 不能编辑；不要把现代 Profile 写入误路由到旧版 namespace。
  if (namespace === undefined) throw new Error('DSH ConfigForms 设置条目尚未激活，无法写入 CodingNS 设置')
  return namespace
}

function isCodingNsSettingsNamespace(namespace: unknown): namespace is string {
  return isCodingNsSettingsEntryId(namespace)
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined
}
