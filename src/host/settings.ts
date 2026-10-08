import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { DshHostSettingsProvider, DshHostSettingsScope } from '../dsh-capabilities/host/config-forms-adapter.js'
import {
  CODINGNS_SETTINGS_NAMESPACE,
  isCodingNsSettingsEntryId,
  DEFAULT_CODINGNS_SETTINGS,
  DEFAULT_ASSISTANT_SETTINGS,
  DEFAULT_ASSISTANT_VOICE_SETTINGS,
  MOBILE_VIEWPORT_MAX_PX_LIMITS,
  SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS,
  SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS,
  SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS,
  SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS,
  type CodingNsConfig,
  type CodingNsSettings,
} from '../shared/contracts/config.js'
import { debugInfo } from '../shared/debug.js'
import { ASSISTANT_AVATAR_FLOATING_MINI_SIZE, ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE, DEFAULT_ASSISTANT_APPEARANCE } from '../shared/assistant-avatar.js'
import { ASSISTANT_PROMPT_MAX_CHARS, DEFAULT_ASSISTANT_PROMPTS } from '../shared/assistant-prompts.js'
import { ASSISTANT_TTS_PARAMETER_LIMITS as ttsLimits, DEFAULT_ASSISTANT_TTS_PARAMETERS } from '../shared/assistant-tts.js'
import { ASSISTANT_PERSONALITY_MAX_CHARS } from '../shared/assistant-lifecycle.js'

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
  agentAdapters: z.dict(z.boolean()).default(DEFAULT_CODINGNS_SETTINGS.agentAdapters ?? {}),
  agentAdapterPreferences: z.dict(z.object({
    modelId: z.union([z.string(), z.const(undefined)]),
    effortId: z.union([z.string(), z.const(undefined)]),
    serviceTierId: z.union([z.string(), z.const(undefined)]),
  })).default({}),
  subagentBridge: z.object({
    enabled: z.boolean().default(DEFAULT_CODINGNS_SETTINGS.subagentBridge?.enabled ?? false),
    maxConcurrentSubagents: z.number()
      .min(SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS.min)
      .max(SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS.max)
      .default(DEFAULT_CODINGNS_SETTINGS.subagentBridge?.maxConcurrentSubagents ?? 8),
  }).default(DEFAULT_CODINGNS_SETTINGS.subagentBridge ?? { enabled: false, maxConcurrentSubagents: 8 }),
  assistant: z.object({
    profile: z.union([z.object({
      name: z.string().min(1).max(80), initialized: z.boolean(),
      personality: z.union([z.string().max(ASSISTANT_PERSONALITY_MAX_CHARS), z.const(undefined)]),
      createdAt: z.union([z.number().min(0), z.const(null)]),
    }), z.const(undefined)]),
    model: z.union([z.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200) }), z.const(undefined)]),
    managedWorkspaceIds: z.array(z.string().min(1).max(512)).default(DEFAULT_ASSISTANT_SETTINGS.managedWorkspaceIds),
    prompts: z.object({
      index: z.string().max(ASSISTANT_PROMPT_MAX_CHARS).default(DEFAULT_ASSISTANT_PROMPTS.index),
      chat: z.string().max(ASSISTANT_PROMPT_MAX_CHARS).default(DEFAULT_ASSISTANT_PROMPTS.chat),
    }).default(DEFAULT_ASSISTANT_PROMPTS),
    appearance: z.object({
      floatingEnabled: z.boolean().default(false),
      dialogEnabled: z.boolean().default(true),
      floatingSize: z.number().min(ASSISTANT_AVATAR_FLOATING_MINI_SIZE).max(320).default(ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE),
      dialogSize: z.number().min(120).max(480).default(240),
      selectedId: z.string().max(80).default('codingns-default'),
      thirdPartyConsent: z.union([z.object({ version: z.string().min(1).max(80), acceptedAt: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER) }), z.const(undefined)]),
      engineConsent: z.union([z.object({ version: z.string().min(1).max(80), acceptedAt: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER) }), z.const(undefined)]),
      models: z.array(z.object({
        id: z.string().min(1).max(80), name: z.string().min(1).max(80),
        renderer: z.string().min(1).max(80), source: z.string().max(2048),
        spriteVersion: z.union([z.const(1), z.const(2)]),
        // 包字段由共享契约严格校验；schema 保留 JSON，不静默剥掉双展示与状态映射。
        package: z.union([z.any(), z.const(undefined)]),
        surfaces: z.union([z.any(), z.const(undefined)]),
        stateSources: z.union([z.any(), z.const(undefined)]),
        motionGroups: z.union([z.any(), z.const(undefined)]),
        live2d: z.union([z.any(), z.const(undefined)]),
      })).default([...DEFAULT_ASSISTANT_APPEARANCE.models]),
    }).default({ ...DEFAULT_ASSISTANT_APPEARANCE, models: [...DEFAULT_ASSISTANT_APPEARANCE.models] }),
    tts: z.object({
      backend: z.union([z.const('browser'), z.const('moss-onnx')]).default('browser'),
      selectedId: z.string().max(80).default('moss:Junhao'),
      parameters: z.object({
        rate: z.number().min(ttsLimits.rate.min).max(ttsLimits.rate.max).default(1),
        volume: z.number().min(ttsLimits.volume.min).max(ttsLimits.volume.max).default(1),
        segmentPauseMs: z.number().step(1).min(ttsLimits.segmentPauseMs.min).max(ttsLimits.segmentPauseMs.max).default(0),
        chunkTokens: z.number().step(1).min(ttsLimits.chunkTokens.min).max(ttsLimits.chunkTokens.max).default(75),
        seed: z.union([z.number().step(1).min(ttsLimits.seed.min).max(ttsLimits.seed.max), z.const(null)]).default(null),
      }).default({ ...DEFAULT_ASSISTANT_TTS_PARAMETERS }),
      voices: z.array(z.object({
        id: z.string().min(1).max(80), name: z.string().min(1).max(80), language: z.string().max(16),
        gender: z.union([z.const('male'), z.const('female'), z.const('unknown')]),
        kind: z.const('reference'), reference: z.string().max(80), source: z.string().max(2048), license: z.string().max(160),
      })).max(50).default([]),
    }).default({ backend: 'browser', selectedId: 'moss:Junhao', voices: [], parameters: { ...DEFAULT_ASSISTANT_TTS_PARAMETERS } }),
    voice: z.object({
      initialized: z.boolean().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.initialized),
      provider: z.union([z.const('dsh-speech-to-text'), z.const('sherpa-onnx')])
        .default(DEFAULT_ASSISTANT_VOICE_SETTINGS.provider),
      modelId: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.modelId ?? ''),
      asrEncoder: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.asrEncoder),
      asrDecoder: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.asrDecoder),
      asrJoiner: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.asrJoiner),
      asrTokens: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.asrTokens),
      vadModel: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.vadModel),
      ttsModel: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.ttsModel),
      ttsTokens: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.ttsTokens),
      ttsLexicon: z.string().default(DEFAULT_ASSISTANT_VOICE_SETTINGS.ttsLexicon),
    }).default(DEFAULT_ASSISTANT_VOICE_SETTINGS),
  }).default({ managedWorkspaceIds: DEFAULT_ASSISTANT_SETTINGS.managedWorkspaceIds, voice: DEFAULT_ASSISTANT_SETTINGS.voice }),
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
