import { watchAdapterCatalog, subscribeAdapterCatalogChanged } from './adapter-catalog-watch.js'
import { createElement, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useDismissOnOutsidePointer } from './popup-dismiss.js'
import type { ReactElement } from 'react'
import type { CSSProperties, ChangeEvent as ReactChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodingNsCliAdapterDescriptor, CodingNsCliModel, CodingNsCliModelCatalog, CodingNsCliSessionConfig } from '../shared/contracts/cli-adapter.js'
import type { CredentialMetadata, CredentialReference } from '../shared/contracts/credentials.js'
import type { CodingNsClientServices, CodingNsRpcClient } from './features/types.js'
import { adapterCatalogWithDsh, adapterDetectionLabel, callCliRpc, findModel, firstModel } from './cli-catalog.js'
import {
  activeServiceTier,
  canSelectServiceTier,
  carriedServiceTierId,
  isServiceTierEnabled,
  modelServiceTiers,
  needsServiceTierRevalidation,
  toggledServiceTierId,
} from './service-tier.js'
import { DshInput, rankModelByName, resolveControlIcon, resolveCloseFillIcon, resolveDataIcon } from '../dsh-capabilities/client/primitives-adapter.js'
import { composerSlotSelector } from '../dsh-capabilities/client/composer-slot-selectors.js'
import { providerIconUrl } from './provider-icons.js'
import { publishSessionSelection } from './session-adapter-cache.js'
import {
  getModelCatalogCache,
  invalidateModelCatalogCache,
  loadModelCatalog,
  shouldRevalidateModelCatalog,
} from './model-catalog-cache.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { useCodingNsTranslator, type CodingNsLocale } from './locale.js'
import { loadCliSessionConfig, rememberCliSessionConfig } from './cli-session-config-cache.js'
import { uiFontSize } from './font-scale.js'
import { DSH_NATIVE_SESSION_ADAPTER_ID, supportsSessionTranslation } from '../shared/contracts/session-translation.js'
import { readNativeTranslationDefault, subscribeNativeTranslationDefault } from './native-translation-default.js'
import { watchNativeModelMenu, type NativeModelCatalogEntry } from './native-model-translation-menu.js'
import { MagpieModelTag } from './magpie-model-tag.js'
import { ConversationTranslationSettings } from './conversation-translation-settings.js'
import { settingsIconButtonStyle } from './settings-controls.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'

const claudeModelAliases = ['provider-default', 'sonnet', 'opus', 'haiku', 'fable']
const claudeModelCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base', ignorePunctuation: true })

function compareClaudeModelOptions(left: CodingNsCliModel, right: CodingNsCliModel): number {
  const aliasRank = (id: string): number => {
    const index = claudeModelAliases.indexOf(id)
    return index < 0 ? claudeModelAliases.length : index
  }
  // Compare the model name separately from provider/context decorations so variants stay adjacent.
  const baseName = (model: CodingNsCliModel): string => model.name.replace(/\[1m\]/gu, '').split(' · ')[0]!.trim()
  return aliasRank(left.id) - aliasRank(right.id)
    || claudeModelCollator.compare(left.magpieProviderId ?? '', right.magpieProviderId ?? '')
    || claudeModelCollator.compare(baseName(left), baseName(right))
    || Number(left.id.endsWith('[1m]')) - Number(right.id.endsWith('[1m]'))
    || left.id.localeCompare(right.id, 'en')
}

interface SessionSnapshot {
  readonly sessionId?: string
  readonly modelSelection?: unknown
  readonly blank?: boolean
  readonly promptAttempted?: boolean
  readonly running?: boolean
  readonly queue?: readonly unknown[]
}

type SessionSelector = <Selected>(selector: (session: SessionSnapshot) => Selected) => Selected

/** DSH Web 当前版本的对话工具栏 Slot 契约。Slot 包没有预声明这些业务名称，插件在此补齐类型。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.left': { kind: 'list'; scope: 'session' }
    'conversation.input.right': { kind: 'list'; scope: 'session' }
  }
  interface SessionStandardProps {
    sessionId: string
    useSession: SessionSelector
  }
}

const CLI_STYLE_ID = 'codingns4dsh-cli-composer-style'
const CIRCULAR_PROVIDER_ICON_IDS = new Set(['gemini', 'grok'])

function installComposerStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${CLI_STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = CLI_STYLE_ID
  const modelSlot = composerSlotSelector('conversation.input.model')
  const rightSlot = composerSlotSelector('conversation.input.right')
  style.textContent = [
    // 每个输入框只读取自己的适配器；主会话与右侧子会话可以同时使用不同 Agent。
    `[data-composer-card]:has([data-codingns-agent]:not([data-codingns-agent="dsh"])) ${modelSlot}{display:none!important}`,
    // DSH 在控制行放不下时给行加 data-model-compact，原生模型席位据此把文本收成图标。
    // 这里不再强制工具行 nowrap：保留原生 flex-wrap 语义，DSH 的测量口径才能反映真实占用，
    // 放不下时先收起模型，而不是把左侧工具组（权限/规划组）压到内容溢出与相邻按钮重叠。
    // 插件模型选择器跟随同一判定：紧凑时收起名称与思考等级，只留图标与下拉箭头。
    '.codingns4dsh-model-icon{display:none}',
    '[data-composer-card] [data-model-compact] .codingns4dsh-model-root .codingns4dsh-model-name,',
    '[data-composer-card] [data-model-compact] .codingns4dsh-model-root .codingns4dsh-model-effort{display:none!important}',
    '[data-composer-card] [data-model-compact] .codingns4dsh-model-root .codingns4dsh-model-icon{display:block!important;flex:none}',
    `[data-composer-card] > div:has(${rightSlot}) > div:has(> ${rightSlot}){min-width:0;width:0;flex:1 1 0}`,
    `[data-composer-card] > div:has(${rightSlot}) ${rightSlot} > .codingns4dsh-model-root{min-width:0;max-width:min(360px,45cqw);flex:1 1 min(360px,45cqw)}`,
    `[data-composer-card] > div:has(${rightSlot}) ${modelSlot} > select{width:100%;min-width:0;max-width:min(150px,45cqw);flex:1 1 min(150px,45cqw);overflow:hidden;white-space:nowrap}`,
    `[data-composer-card] > div:has(${rightSlot}) ${modelSlot} > button{width:100%;min-width:0;max-width:min(360px,45cqw);overflow:hidden;white-space:nowrap}`,
    // 与 DSH 原生同类控件一致（权限选择器 460px、预设标签 540px 都用容器查询）：
    // composer 控制行收窄到 650px 以内时，适配器按钮让出名称与右侧状态图标（下拉箭头/锁形），
    // 只保留适配器图标；行宽恢复后名称自动回来。这是纯 CSS 判定，不随任何折叠状态摆动。
    // 650 取自实测「适配器名称开始与左侧控件冲突」的临界宽度（容器查询按行的内容盒计，
    // 比输入框的可见宽度小左右各 8px 内边距）。
    '@container (width<=650px){[data-composer-card] .codingns4dsh-agent-trigger > .codingns4dsh-agent-label{display:none}[data-composer-card] .codingns4dsh-agent-trigger > svg{display:none!important}[data-composer-card] .codingns4dsh-agent-trigger{padding-left:4px;padding-right:4px;gap:0}}',
    // 移动端工具栏空间有限，收掉控件组自身的间距；控件组按 CSS Modules 本地名匹配，
    // 不绑定构建哈希（npm 分发的 Web 构建是 uV2eYG_*，Desktop 内嵌构建是 yhfFVG_*）。
    `@media (max-width: 768px){[data-composer-card] > div:has(${rightSlot}) > div:has(> ${rightSlot}),[data-composer-card] ${rightSlot},[data-composer-card] [class*="_standardControls"],[data-composer-card] [class*="_trailing"]{gap:0!important;column-gap:0!important}}`,
    // ContextMeter 在 pressure 尚未合并时会暂时返回 null；dock 保留同样的行高，数值回来时只更新内容。
    '[data-composer-card] + div{box-sizing:border-box;min-height:26px;align-items:center}',
    '[data-composer-card] + div svg[viewBox="0 0 14 14"] circle:last-child{transition:stroke-dasharray .18s ease,stroke .18s ease}',
    '@keyframes codingns4dsh-cli-spin{to{transform:rotate(360deg)}}',
    '@keyframes codingns4dsh-cli-model-scroll{0%,18%{transform:translateX(0)}82%,100%{transform:translateX(var(--codingns4dsh-model-scroll-offset))}}',
    '.codingns4dsh-cli-spinner{animation:codingns4dsh-cli-spin .8s linear infinite}',
    '.codingns4dsh-model-name[data-overflow="true"]>span{animation:codingns4dsh-cli-model-scroll 6s ease-in-out infinite alternate;will-change:transform}',
    '.codingns4dsh-agent-trigger:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}',
    '.codingns4dsh-agent-option:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)!important}',
    '.codingns4dsh-agent-option[data-selected="true"]{background:color-mix(in srgb,currentColor 10%,transparent)!important}',
    // 模型搜索与内置 DSH 模型选择器（ui-model-selection 的 ModelSelect）使用同一套
    // 结构与令牌：固定在菜单顶部、透明无边框的 12px 输入框，右侧 24px 圆形清除按钮，
    // 下方模型分组独立滚动。内联样式无法表达 :hover/:focus-within，因此放在这里。
    '.codingns4dsh-model-search-row{flex:none;margin:2px 0 3px;position:relative}',
    '.codingns4dsh-model-search-row .codingns4dsh-model-search{border-radius:var(--dsw-radius-md,8px);background:transparent;border:0 solid transparent;height:auto;padding:5px 7px;display:flex}',
    '.codingns4dsh-model-search-row .codingns4dsh-model-search-with-query{padding-right:34px}',
    `.codingns4dsh-model-search-row .codingns4dsh-model-search input{padding:0;font-size:${uiFontSize(12)};line-height:normal}`,
    '.codingns4dsh-model-search-row .codingns4dsh-model-search input::placeholder{color:var(--dsw-alias-label-caption,GrayText)}',
    '.codingns4dsh-model-search-row .codingns4dsh-model-search:focus-within{border-color:transparent}',
    '.codingns4dsh-model-search-clear{corner-shape:round;width:24px;height:24px;color:var(--dsw-alias-label-secondary,GrayText);cursor:pointer;background:transparent;border:none;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:50%;right:4px;transform:translateY(-50%)}',
    '.codingns4dsh-model-search-clear:hover,.codingns4dsh-model-search-clear:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));outline:none}',
    '.codingns4dsh-model-groups{min-height:0;overflow-y:auto}',
    '.codingns4dsh-model-option[data-highlighted="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
    '@media (prefers-reduced-motion:reduce){.codingns4dsh-cli-spinner{animation-duration:1.6s}.codingns4dsh-model-name[data-overflow="true"]>span{animation:none;transform:translateX(0)}}',
  ].join('')
  document.head.appendChild(style)
}

interface CliSlotProps {
  readonly settings?: CodingNsClientServices['settings'] | undefined
  readonly sessionId?: string
  readonly useSession?: SessionSelector
  readonly rpc: CodingNsRpcClient
  readonly locale: CodingNsLocale
  /** 会话未单独设置翻译开关时是否跟随「DSH 原生会话」总开关。 */
  readonly readNativeTranslationEnabled?: () => boolean | undefined
}

interface SelectionState extends CodingNsCliSessionConfig {}

const DEFAULT_SELECTION: SelectionState = { adapterId: 'dsh' }
const selections = new Map<string, SelectionState>()
const selectionListeners = new Map<string, Set<() => void>>()
/** Slot 会随 DSH 会话状态重挂载；保留最近选择，避免重挂载时再次闪回默认值。 */
const selectionLastUsed = new Map<string, number>()
const MAX_SELECTION_CACHE = 256
/** 记录每个会话最新的写入，旧响应不能覆盖用户较新的选择。 */
const selectionUpdates = new Map<string, { readonly revision: number; readonly promise: Promise<CodingNsCliSessionConfig> }>()
const selectionRevisions = new Map<string, number>()

/** 等待会话 Agent 选择写入 Host，避免切换后立即打开命令菜单仍读到旧 Agent。 */
export async function waitForCliSessionSelection(sessionId: string): Promise<void> {
  if (sessionId.trim() === '') return
  for (;;) {
    const pending = selectionUpdates.get(sessionId)
    if (pending === undefined) return
    await pending.promise
    // Agent 和模型可能连续更新；只有等待中的写入仍是最新值时才可以继续。
    if (selectionUpdates.get(sessionId) === pending) return
  }
}

/** 读取当前会话 Agent 选择版本，供按会话缓存的目录在切换 Agent 后失效。 */
export function cliSessionSelectionRevision(sessionId: string): number {
  return selectionRevisions.get(sessionId) ?? 0
}

/** Share the model menu's effective translation switch with pending message actions. */
export function useCliSessionTranslationEnabled(sessionId: string | undefined, rpc: CodingNsRpcClient): boolean {
  return useCliSessionTranslationState(sessionId, rpc).enabled
}

export function useCliSessionTranslationState(sessionId: string | undefined, rpc: CodingNsRpcClient): { adapterId: string; enabled: boolean } {
  const [selection] = useSelection(sessionId, rpc)
  const nativeDefault = useSyncExternalStore(subscribeNativeTranslationDefault, readNativeTranslationDefault, readNativeTranslationDefault)
  const enabled = supportsSessionTranslation(selection.adapterId)
    && (selection.translationEnabled ?? (selection.adapterId === DSH_NATIVE_SESSION_ADAPTER_ID && nativeDefault === true))
  return { adapterId: selection.adapterId, enabled }
}

/** 在 Agent 和模型两个 Slot 之间共享当前会话选择。 */
function useSelection(sessionId: string | undefined, rpc: CodingNsRpcClient): [SelectionState, (next: SelectionState) => Promise<boolean>] {
  const [selection, setSelection] = useState<SelectionState>(() => sessionId ? selections.get(sessionId) ?? DEFAULT_SELECTION : DEFAULT_SELECTION)

  useEffect(() => {
    if (sessionId === undefined || sessionId.trim() === '') return
    let active = true
    const loaded = loadCliSessionConfig(rpc, sessionId)
    void loaded
      .then((value) => {
        if (!active) return
        // 用户可能已在 session/get 返回前切换 Agent；旧响应不能覆盖本地最新选择。
        if (selections.has(sessionId)) return
        publishSelection(sessionId, value)
      })
      .catch(() => undefined)
    const listeners = selectionListeners.get(sessionId) ?? new Set<() => void>()
    selectionListeners.set(sessionId, listeners)
    const listener = (): void => setSelection(selections.get(sessionId) ?? DEFAULT_SELECTION)
    listeners.add(listener)
    // 同一 Slot 可切换会话；缓存命中时 session/get 不再发布，需先同步当前会话。
    listener()
    return () => {
      active = false
      listeners.delete(listener)
      if (listeners.size === 0) {
        selectionListeners.delete(sessionId)
        // DSH 的 Slot 会因发送/切换会话短暂卸载；删除这里的状态会让下一次挂载
        // 重新走 session/get，旧响应还可能覆盖用户刚刚选中的模型。
        selectionLastUsed.set(sessionId, Date.now())
        if (selectionLastUsed.size > MAX_SELECTION_CACHE) {
          const oldest = [...selectionLastUsed.entries()].sort((left, right) => left[1] - right[1])[0]?.[0]
          if (oldest !== undefined) {
            selectionLastUsed.delete(oldest)
            selections.delete(oldest)
          }
        }
      }
    }
  }, [rpc, sessionId])

  const update = (next: SelectionState): Promise<boolean> => {
    if (sessionId === undefined || sessionId.trim() === '') return Promise.resolve(false)
    const previous = selections.get(sessionId) ?? selection
    publishSelection(sessionId, next)
    const revision = (selectionRevisions.get(sessionId) ?? 0) + 1
    selectionRevisions.set(sessionId, revision)
    const promise = callCliRpc<CodingNsCliSessionConfig>(rpc, 'session/set', { sessionId, ...next })
    selectionUpdates.set(sessionId, { revision, promise })
    return promise
      .then((normalized) => {
        rememberCliSessionConfig(rpc, sessionId, normalized)
        if (selectionUpdates.get(sessionId)?.revision === revision) publishSelection(sessionId, normalized)
        return true
      })
      .catch(() => {
        if (selectionUpdates.get(sessionId)?.revision === revision) publishSelection(sessionId, previous)
        return false
      })
      .finally(() => {
        if (selectionUpdates.get(sessionId)?.revision === revision) selectionUpdates.delete(sessionId)
      })
  }
  return [selection, update]
}

function publishSelection(sessionId: string, next: SelectionState): void {
  const normalized: SelectionState = {
    adapterId: next.adapterId,
    ...(next.modelId ? { modelId: next.modelId } : {}),
    ...(next.effortId ? { effortId: next.effortId } : {}),
    ...(next.serviceTierId ? { serviceTierId: next.serviceTierId } : {}),
    ...(next.translationEnabled === undefined ? {} : { translationEnabled: next.translationEnabled }),
    ...(next.credentialRefs === undefined ? {} : { credentialRefs: next.credentialRefs }),
  }
  selections.set(sessionId, normalized)
  selectionLastUsed.set(sessionId, Date.now())
  publishSessionSelection(sessionId, normalized.adapterId)
  for (const listener of selectionListeners.get(sessionId) ?? []) listener()
}

/**
 * 把 Agent 与模型选择器注册到同一工具栏，使用顺序保证 Agent 始终位于模型左侧。
 *
 * `readNativeTranslationEnabled` 提供「DSH 原生会话未单独设置翻译开关时是否跟随总开关」
 * 的当前值；原生会话的翻译开关与外部 Agent 共用模型菜单里的同一行开关。
 */
export function registerCliConversationSlots(
  slots: SlotRegistry,
  rpc: CodingNsRpcClient,
  locale: CodingNsLocale,
  readNativeTranslationEnabled?: () => boolean | undefined,
  settings?: CodingNsClientServices['settings'],
): () => void {
  installComposerStyles()
  const t = locale.bind('codingns')
  const disposeAgent = slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'codingns4dsh-agent',
    order: -20,
    label: t('cli.agentSelector'),
    inject: (sessionId: string) => ({ rpc, sessionId, locale }),
  }, AgentSlot))
  const disposeModel = slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'codingns4dsh-model',
    order: -10,
    label: t('cli.modelSelector'),
    inject: (sessionId: string) => ({
      rpc,
      sessionId,
      locale,
      settings,
      ...(readNativeTranslationEnabled === undefined ? {} : { readNativeTranslationEnabled }),
    }),
  }, ModelSlot))
  return () => {
    disposeModel()
    disposeAgent()
  }
}

function AgentSlot(props: CliSlotProps): ReactElement {
  const t = useCodingNsTranslator(props.locale)
  const session = props.useSession?.((value) => value)
  const sessionId = props.sessionId ?? session?.sessionId
  const [selection, update] = useSelection(sessionId, props.rpc)
  const [agents, setAgents] = useState<readonly CodingNsCliAdapterDescriptor[]>([{ id: 'dsh', name: 'DeepSeek Harness', installed: true, enabled: true, version: null, command: null }])
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const locked = isSessionLocked(session)

  useDismissOnOutsidePointer(rootRef, open, () => setOpen(false))

  useEffect(() => {
    return watchAdapterCatalog(props.rpc, sessionId, (value) => {
      setAgents(adapterCatalogWithDsh(value))
      setCatalogFailed(false)
    }, () => setCatalogFailed(true))
  }, [props.rpc, sessionId, catalogRetry])

  useEffect(() => { if (locked) setOpen(false) }, [locked])

  const current = agents.find((agent) => agent.id === selection.adapterId) ?? agents[0]!
  const choose = (agent: CodingNsCliAdapterDescriptor): void => {
    if (locked || !agent.installed || !agent.enabled || sessionId === undefined) return
    update({ adapterId: agent.id })
    setOpen(false)
  }
  const currentIcon = providerIconUrl(current.id)
  return createElement('div', { ref: rootRef, style: agentRootStyle, 'data-codingns-agent': selection.adapterId },
    createElement('button', { type: 'button', className: 'codingns4dsh-agent-trigger', disabled: locked, onClick: () => setOpen((value) => !value), 'aria-label': t('cli.currentAgent', { name: current.name, locked: locked ? t('cli.locked') : '' }), 'aria-haspopup': 'menu', 'aria-expanded': open, style: { ...agentTriggerStyle, cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.7 : 1 } },
      currentIcon === undefined
        ? createElement(ProviderIconFallback, { name: current.name, size: 20 })
        : createElement('img', { src: currentIcon, alt: '', 'aria-hidden': true, style: applyProviderIconShape(current.id, agentTriggerIconStyle) }),
      createElement('span', { className: 'codingns4dsh-agent-label', style: agentTriggerLabelStyle }, current.name),
      createElement(NativeDropdownChevron, { open, locked }),
    ),
    open && !locked && createElement('div', { role: 'menu', 'aria-label': t('cli.selectAgent'), style: agentMenuStyle },
      catalogFailed && createElement('div', { role: 'alert', style: { padding: 8, fontSize: uiFontSize(13) } },
        createElement('div', null, t('cli.catalogLoadFailed')),
        createElement('button', {
          type: 'button', role: 'menuitem', style: { ...agentOptionStyle, minHeight: 30 },
          onClick: () => { setCatalogFailed(false); setCatalogRetry((value) => value + 1) },
        }, t('cli.retryCatalog')),
      ),
      ...agents.map((agent) => {
        const selected = agent.id === selection.adapterId
        const available = agent.installed && agent.enabled
        const icon = providerIconUrl(agent.id)
        return createElement('button', { key: agent.id, type: 'button', className: 'codingns4dsh-agent-option', role: 'menuitemradio', 'aria-checked': selected, 'data-selected': String(selected), disabled: !available, onClick: () => choose(agent), style: { ...agentOptionStyle, cursor: available ? 'pointer' : 'not-allowed', opacity: available ? 1 : 0.45 } },
          createElement('span', { 'aria-hidden': true, style: agentCheckStyle }, selected ? '✓' : ''),
          icon === undefined
            ? createElement(ProviderIconFallback, { name: agent.name, size: 22 })
            : createElement('img', { src: icon, alt: '', 'aria-hidden': true, style: applyProviderIconShape(agent.id, agentOptionIconStyle) }),
          createElement('span', { style: agentOptionLabelStyle }, agent.name),
          (!agent.installed || agent.detectionState === 'error' || agent.runtimeState === 'installed') && createElement('span', { style: agentStatusStyle }, t(adapterDetectionLabel(agent))),
          agent.installed && !agent.enabled && createElement('span', { style: agentStatusStyle }, t('cli.disabled')),
        )
      }),
    ),
  )
}

/**
 * 模型菜单里的「翻译对话」开关行。
 *
 * 外部 Agent 与 DSH 原生会话共用同一份样式与交互：外部会话的开关只在会话级
 * 生效，原生会话的开关写回适配器偏好；两者都复用模型菜单的行样式。
 */
function TranslationToggleRow(props: {
  readonly checked: boolean
  readonly label: string
  readonly toggleLabel: string
  readonly onChange: (next: boolean) => void
  readonly settingsLabel: string
  readonly onSettings: () => void
}): ReactElement {
  return createElement('div', { className: 'codingns4dsh-translation-toggle', style: serviceTierRowStyle },
    createElement('span', { style: { ...serviceTierLabelStyle, flex: '1 1 auto', whiteSpace: 'normal' } }, props.label),
    createElement('button', {
      type: 'button',
      'aria-label': props.settingsLabel,
      title: props.settingsLabel,
      'aria-haspopup': 'dialog',
      onClick: props.onSettings,
      style: { ...settingsIconButtonStyle, flexBasis: 24, width: 24, height: 28 },
    }, createElement(resolveControlIcon('settings'), { size: 16 })),
    createElement(Switch, {
      checked: props.checked,
      onChange: props.onChange,
      label: props.toggleLabel,
    }),
  )
}

function ProviderIconFallback(props: { readonly name: string; readonly size: number }): ReactElement {
  return createElement('span', { 'aria-hidden': true, style: { ...agentFallbackIconStyle, width: props.size, height: props.size, flexBasis: props.size } },
    props.name.trim().charAt(0).toUpperCase() || '?',
  )
}

/** Gemini 与 Grok 的原图带方形底色，只在展示时裁成圆形。 */
function applyProviderIconShape<Style extends object>(adapterId: string, style: Style): Style {
  return CIRCULAR_PROVIDER_ICON_IDS.has(adapterId) ? { ...style, borderRadius: '50%' } : style
}

/** 与 DSH 原生工具一致的下拉箭头；会话开始后改为锁形状态提示。 */
function NativeDropdownChevron({ open, locked = false }: { readonly open: boolean; readonly locked?: boolean }): ReactElement {
  return createElement('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
    style: { ...nativeDropdownChevronStyle, transform: !locked && open ? 'rotate(180deg)' : undefined },
  }, createElement('path', {
    d: locked
      ? 'M10.5 6V4.75a3.5 3.5 0 0 0-7 0V6H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5ZM5 4.75a2 2 0 0 1 4 0V6H5V4.75ZM7 8a.9.9 0 0 0-.5 1.648V11h1V9.648A.9.9 0 0 0 7 8Z'
      : 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
    fill: 'currentColor',
  }))
}

const agentRootStyle = { position: 'relative' as const, minWidth: 0, flex: '0 0 auto', display: 'inline-flex' }
const agentTriggerStyle = { height: 30, minWidth: 0, color: dshThemeColor.labelPrimary, border: 0, borderRadius: 8, padding: '0 6px', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: uiFontSize(14), lineHeight: '20px', whiteSpace: 'nowrap' as const }
const agentTriggerIconStyle = { width: 20, height: 20, flex: '0 0 20px', objectFit: 'contain' as const }
const agentTriggerLabelStyle = { flex: '0 0 auto', whiteSpace: 'nowrap' as const }
const nativeDropdownChevronStyle = { display: 'block', flex: '0 0 14px', color: dshThemeColor.labelCaption, transformOrigin: 'center' }
const agentMenuStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1100, bottom: 'calc(100% + 8px)', left: 0, minWidth: 238, maxWidth: 'min(320px, calc(100vw - 32px))', maxHeight: 'min(400px, calc(100vh - 96px))', overflowY: 'auto' as const, padding: 5, border: 0, borderRadius: 8 }
const agentOptionStyle = { width: '100%', minHeight: 40, color: 'inherit', border: 0, borderRadius: 6, padding: '5px 8px 5px 4px', background: 'transparent', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' as const, fontSize: uiFontSize(14), lineHeight: '20px' }
const agentCheckStyle = { width: 18, flex: '0 0 18px', textAlign: 'center' as const, fontSize: uiFontSize(16), lineHeight: 1 }
const agentOptionIconStyle = { width: 22, height: 22, flex: '0 0 22px', objectFit: 'contain' as const }
const agentOptionLabelStyle = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const agentStatusStyle = { flex: '0 0 auto', color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), whiteSpace: 'nowrap' as const }
const agentFallbackIconStyle = { flexGrow: 0, flexShrink: 0, borderRadius: 5, color: '#fff', background: dshThemeColor.labelTertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: uiFontSize(11), fontWeight: 600, lineHeight: 1 }

type ModelPane = 'root' | 'model' | 'effort' | 'credentials'

interface ModelCatalogState {
  readonly sessionId: string | undefined
  readonly adapterId: string
  readonly value: CodingNsCliModelCatalog
}

interface ModelNameProps {
  readonly label: string
  readonly loading: boolean
}

/** 模型名称超出 150px 时，在固定视口内往返滚动展示完整文本。 */
function ModelName({ label, loading }: ModelNameProps): ReactElement {
  const viewportRef = useRef<HTMLSpanElement | null>(null)
  const contentRef = useRef<HTMLSpanElement | null>(null)
  const [scrollDistance, setScrollDistance] = useState(0)

  useEffect(() => {
    const updateOverflow = (): void => {
      const viewport = viewportRef.current
      const content = contentRef.current
      if (viewport === null || content === null) return
      const nextDistance = Math.max(0, Math.ceil(content.getBoundingClientRect().width - viewport.clientWidth))
      setScrollDistance((current) => current === nextDistance ? current : nextDistance)
    }
    updateOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateOverflow)
    if (viewportRef.current !== null) observer.observe(viewportRef.current)
    if (contentRef.current !== null) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [label])

  const contentStyle = {
    display: 'inline-block',
    whiteSpace: 'nowrap' as const,
    '--codingns4dsh-model-scroll-offset': `-${scrollDistance}px`,
  } as CSSProperties
  return createElement('span', {
    ref: viewportRef,
    className: 'codingns4dsh-model-name',
    'data-overflow': String(scrollDistance > 0),
    role: loading ? 'status' : undefined,
    'aria-live': loading ? 'polite' : undefined,
    style: modelNameStyle,
  }, createElement('span', { ref: contentRef, style: contentStyle }, label))
}

function ModelSlot(props: CliSlotProps): ReactElement | null {
  // 语言词典中的中文值仍保留“正在加载模型列表…”语义，切换语言时由 t() 取值。
  const t = useCodingNsTranslator(props.locale)
  const session = props.useSession?.((value) => value)
  const sessionId = props.sessionId ?? session?.sessionId
  const [selection, update] = useSelection(sessionId, props.rpc)
  const [catalogState, setCatalogState] = useState<ModelCatalogState | null>(null)
  const [refreshingAdapterId, setRefreshingAdapterId] = useState<string | null>(null)
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<ModelPane>('root')
  const [translationSettingsOpen, setTranslationSettingsOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [highlightedModelIndex, setHighlightedModelIndex] = useState<number | null>(null)
  const modelSearchRef = useRef<HTMLInputElement | null>(null)
  const modelOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const modelGroupsId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const nativeMagpieModelsRef = useRef<readonly NativeModelCatalogEntry[]>([])

  // 模型列表与思考档位和内置选择器一样没有返回按钮：Escape 只退出当前子面板，
  // 回到根菜单；根菜单再按 Escape 才关闭整个弹层。
  useDismissOnOutsidePointer(rootRef, open, () => { setOpen(false); setPane('root') }, { escape: pane === 'root' })

  const nativeDefault = useSyncExternalStore(
    subscribeNativeTranslationDefault,
    () => props.readNativeTranslationEnabled?.(),
    () => props.readNativeTranslationEnabled?.(),
  )
  const nativeAvailable = nativeDefault !== undefined
  const [nativeMenu, setNativeMenu] = useState<HTMLElement | null>(null)

  const catalog = catalogState?.adapterId === selection.adapterId && catalogState.sessionId === sessionId ? catalogState.value : null
  const nativeModels = selection.adapterId === DSH_NATIVE_SESSION_ADAPTER_ID
    ? (catalog?.groups ?? []).flatMap((group) => group.models.map(({ id, name, source, magpieProviderId }) => ({ id, name, ...(source === 'magpie' ? { source } : {}), ...(magpieProviderId === undefined ? {} : { magpieProviderId }) })))
    : []
  nativeMagpieModelsRef.current = nativeModels
  const nativeMagpieModelRevision = JSON.stringify(nativeModels)
  useEffect(() => {
    setNativeMenu(null)
    if (selection.adapterId !== DSH_NATIVE_SESSION_ADAPTER_ID || rootRef.current === null) return
    return watchNativeModelMenu(rootRef.current, setNativeMenu, () => nativeMagpieModelsRef.current, nativeAvailable)
  }, [selection.adapterId, sessionId, nativeAvailable, nativeMagpieModelRevision])

  // 目录必须和当前会话、适配器绑定；跨 Host 切换时不能短暂展示上一会话的目录。
  // 有 stale 目录时直接可用，后台刷新不应阻塞模型/思考强度选择。
  const loading = catalog === null && refreshingAdapterId === selection.adapterId
  // 超过 4 个可选模型才出现搜索框，目录较少时保持原来的直接选择体验。
  const modelChoiceCount = (catalog?.groups ?? []).reduce((count, group) => count + group.models.length, 0)
  const showModelSearch = modelChoiceCount > 4
  useEffect(() => {
    if (selection.adapterId === DSH_NATIVE_SESSION_ADAPTER_ID) {
      let active = true
      const adapterId = selection.adapterId
      const cached = getModelCatalogCache(props.rpc, sessionId).get(adapterId)
      if (cached !== undefined) setCatalogState({ sessionId, adapterId, value: cached })
      void loadModelCatalog(props.rpc, adapterId, sessionId)
        .then((value) => { if (active) setCatalogState({ sessionId, adapterId, value }) })
        .catch(() => {
          if (active && getModelCatalogCache(props.rpc, sessionId).get(adapterId) === undefined) {
            setCatalogState({ sessionId, adapterId, value: { groups: [], currentModel: null, currentEffort: null } })
          }
        })
      return () => { active = false }
    }
    let active = true
    const adapterId = selection.adapterId
    const cached = getModelCatalogCache(props.rpc, sessionId).get(adapterId)
    if (cached !== undefined) setCatalogState({ sessionId, adapterId, value: cached })
    setRefreshingAdapterId(adapterId)
    // 档位判定过期时先作废 Client 缓存，让本次请求真正走到 Host 的指纹比对。
    // 用节流避免真实第三方接入下每次挂载都重复探测。
    if (shouldRevalidateModelCatalog(props.rpc, adapterId, needsServiceTierRevalidation(cached ?? null), sessionId)) {
      invalidateModelCatalogCache(props.rpc, adapterId, sessionId)
    }
    void loadModelCatalog(props.rpc, adapterId, sessionId)
      .then((value) => {
        if (!active) return
        setCatalogState({ sessionId, adapterId, value })
        const normalize = (): void => {
          if (!active) return
          // session/set 可能正在回填适配器级记忆值；必须等它完成后再补默认值，
          // 否则目录第一项会先写入 Host，随后覆盖真正的记忆选择。
          const currentSelection = sessionId === undefined
            ? selection
            : selections.get(sessionId) ?? selection
          if (currentSelection.adapterId !== adapterId) return
          const model = currentSelection.modelId === undefined
            ? firstModel(value)
            : findModel(value, currentSelection.modelId)
          if (model === undefined) return
          const effort = model.efforts.includes(currentSelection.effortId ?? '') ? currentSelection.effortId : defaultEffort(model.efforts)
          // 目录就绪后的补默认值同样是“部分更新”：必须把档位一起带上，否则用户
          // 刚开的 Fast 会在目录返回的瞬间被这次规范化悄悄清掉（父仓库同源缺陷）。
          const tier = carriedServiceTierId(model, currentSelection.serviceTierId)
          if (model.id !== currentSelection.modelId
            || effort !== currentSelection.effortId
            || tier !== currentSelection.serviceTierId) {
            update({
              adapterId,
              modelId: model.id,
              // 新模型不支持旧档位时显式回落 `default`：省略会让 Host 保留旧值，
              // 继续给 Claude 这类模型下发 `--effort` 并让整轮失败。
              effortId: effort ?? 'default',
              translationEnabled: currentSelection.translationEnabled === true,
              ...(tier ? { serviceTierId: tier } : {}),
            })
          }
        }
        const pending = sessionId === undefined ? undefined : selectionUpdates.get(sessionId)
        if (pending === undefined) {
          normalize()
        } else {
          void pending.promise.then(normalize).catch(normalize)
        }
      })
      .catch(() => {
        if (!active) return
        // 已有目录时保留 stale 值；暂时探测失败不能把思考强度列表清空，
        // 否则用户会看到模型选择器反复回到“正在加载”。
        if (getModelCatalogCache(props.rpc, sessionId).get(adapterId) === undefined) {
          setCatalogState({ sessionId, adapterId, value: { groups: [], currentModel: null, currentEffort: null } })
        }
      })
      .finally(() => { if (active) setRefreshingAdapterId(null) })
    return () => {
      active = false
    }
  }, [props.rpc, selection.adapterId, sessionId, catalogRetry])

  useEffect(() => {
    setPane('root')
  }, [sessionId, selection.adapterId])

  // 手动重新检测后刷新目录；日常读取沿用缓存，不定时重启探测。
  useEffect(() => subscribeAdapterCatalogChanged(props.rpc, (change) => {
    if (change.kind === 'models' && change.adapterId !== selection.adapterId) return
    setCatalogRetry((value) => value + 1)
  }), [props.rpc, selection.adapterId])

  useEffect(() => { if (selection.adapterId === 'dsh') setOpen(false) }, [selection.adapterId])

  // 进入模型列表、目录从少变多或重新打开菜单时，把焦点交给搜索框（与内置选择器一致）。
  useEffect(() => {
    if (!open || pane !== 'model' || !showModelSearch) return
    modelSearchRef.current?.focus()
  }, [open, pane, showModelSearch])

  // 离开模型列表、搜索被关闭或关闭菜单后清空查询，下一次打开从完整目录开始。
  useEffect(() => {
    if (open && pane === 'model' && showModelSearch) return
    setModelQuery('')
    setHighlightedModelIndex(null)
  }, [open, pane, showModelSearch])

  // 模型列表与思考档位不再提供返回按钮：Escape 退回根菜单。
  useEffect(() => {
    if (!open || pane === 'root' || typeof document === 'undefined') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setPane('root')
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, pane])

  // 所有 Hooks 都先执行；原生与外部适配器切换不能改变 Hook 调用顺序。
  const translationSettings = translationSettingsOpen && props.settings !== undefined
    ? createElement(ConversationTranslationSettings, {
        key: selection.adapterId, adapterId: selection.adapterId,
        settings: props.settings, t, onClose: () => setTranslationSettingsOpen(false),
      })
    : null
  const openTranslationSettings = (): void => {
    setOpen(false)
    setTranslationSettingsOpen(true)
  }
  const openCredentialBindings = (): void => setPane('credentials')
  if (selection.adapterId === DSH_NATIVE_SESSION_ADAPTER_ID) {
    return createElement('div', { ref: rootRef, hidden: true },
      nativeMenu !== null && nativeAvailable ? createPortal(createElement(TranslationToggleRow, {
        checked: selection.translationEnabled ?? nativeDefault === true,
        label: t('cli.translationConversation'),
        toggleLabel: t('cli.translationConversationToggle'),
        onChange: (next: boolean) => update({ ...selection, translationEnabled: next }),
        settingsLabel: t('cli.translationSettings'),
        onSettings: openTranslationSettings,
      }), nativeMenu) : null,
      translationSettings,
    )
  }

  const model = (catalog === null ? undefined : findModel(catalog, selection.modelId))
    ?? (selection.modelId ? { id: selection.modelId, name: selection.modelId, efforts: [] } : catalog === null ? undefined : firstModel(catalog))
  const efforts = model?.efforts ?? []
  // 目录已经加载、但当前模型不声明该档位时不能再沿用旧值：切到 Claude 这类没有
  // 思考档位的模型后，残留的 Gemini 档位既会显示错，也会被下发成 `--effort`，
  // 让 CLI 以 `invalid model selection` 直接拒绝整轮。
  const storedEffort = selection.effortId
  const effortValue = storedEffort !== undefined && (model === undefined || efforts.includes(storedEffort))
    ? storedEffort
    : defaultEffort(efforts) ?? 'default'
  const modelLabel = model?.name ?? (loading ? t('cli.loadingModel') : t('cli.noModelsAvailable'))
  const effortLabel = effortDisplayName(model, effortValue, t('cli.defaultEffort'))
  const modelUnavailable = model === undefined
  const triggerDisabled = !loading && modelUnavailable
  const chooseModel = (next: CodingNsCliModel): void => {
    const nextEffort = next.efforts.includes(effortValue) ? effortValue : defaultEffort(next.efforts)
    // 档位必须随模型切换一起携带：新模型不声明该档位时显式回落 `default`，
    // 不能省略——省略会让 Host 保留旧档位，继续下发该模型不支持的 serviceTier。
    // 思考档位同理：Claude 系列不支持 `--effort`，省略会让旧档位漏进命令行。
    const nextTier = carriedServiceTierId(next, selection.serviceTierId)
    update({
      adapterId: selection.adapterId,
      modelId: next.id,
      effortId: nextEffort ?? 'default',
      translationEnabled: selection.translationEnabled === true,
      ...(nextTier ? { serviceTierId: nextTier } : {}),
    })
    setOpen(false)
    setPane('root')
  }
  const chooseEffort = (effort: string): void => {
    if (model === undefined) return
    // 只改思考等级时档位必须原样保留，否则用户开了 Fast 再调等级就会掉回标准档。
    const tier = carriedServiceTierId(model, selection.serviceTierId)
    update({
      adapterId: selection.adapterId,
      modelId: model.id,
      effortId: effort,
      translationEnabled: selection.translationEnabled === true,
      ...(tier ? { serviceTierId: tier } : {}),
    })
    setOpen(false)
    setPane('root')
  }
  // 服务档位是官方订阅能力：只有目录确认官方订阅且当前模型声明了档位才展示。
  const serviceTierAvailable = canSelectServiceTier(catalog, model)
  const serviceTierEnabled = isServiceTierEnabled(catalog, selection.serviceTierId)
  const activeTier = activeServiceTier(catalog, model, selection.serviceTierId)
  const serviceTierLabel = activeTier?.name ?? t('cli.serviceTierFast')
  const toggleServiceTier = (next: boolean): void => {
    if (model === undefined) return
    const serviceTierId = toggledServiceTierId(model, next)
    if (serviceTierId === undefined) return
    update({ adapterId: selection.adapterId, modelId: model.id, ...(selection.effortId ? { effortId: selection.effortId } : {}), serviceTierId, translationEnabled: selection.translationEnabled === true })
  }
  const translationAvailable = supportsSessionTranslation(selection.adapterId)
  const toggleTranslation = (next: boolean): void => {
    if (model === undefined) return
    update({
      adapterId: selection.adapterId,
      modelId: model.id,
      ...(selection.effortId ? { effortId: selection.effortId } : {}),
      ...(selection.serviceTierId ? { serviceTierId: selection.serviceTierId } : {}),
      translationEnabled: next,
    })
  }
  const modelGroups = selection.adapterId === 'claude-code'
    ? (catalog?.groups ?? []).map((group) => ({ ...group, models: [...group.models].sort(compareClaudeModelOptions) }))
    : catalog?.groups ?? []
  // 搜索只在模型较多时启用；过滤按 Provider 分组进行，空分组直接隐藏，
  // 与内置模型选择器的 rankByName 分组结果一致。
  const modelQueryText = showModelSearch ? modelQuery.trim() : ''
  const visibleModelGroups = modelQueryText === ''
    ? modelGroups
    : modelGroups
      .map((group) => ({ ...group, models: rankModelByName(group.models, modelQueryText) }))
      .filter((group) => group.models.length > 0)
  const visibleModels = visibleModelGroups.flatMap((group) => group.models)
  const currentVisibleModelIndex = visibleModels.findIndex((item) => item.id === model?.id)
  const activeModelIndex = visibleModels.length === 0
    ? -1
    : Math.min(highlightedModelIndex ?? Math.max(0, currentVisibleModelIndex), visibleModels.length - 1)
  // 每次渲染重建可见模型的可聚焦引用，键盘高亮移动时把目标滚入可视区。
  modelOptionRefs.current = []
  let modelOptionIndex = 0
  const changeModelQuery = (next: string): void => {
    setModelQuery(next)
    setHighlightedModelIndex(0)
  }
  const moveModelHighlight = (offset: number): void => {
    if (visibleModels.length === 0) return
    const next = (activeModelIndex + offset + visibleModels.length) % visibleModels.length
    setHighlightedModelIndex(next)
    modelOptionRefs.current[next]?.scrollIntoView?.({ block: 'nearest' })
  }
  // 搜索框聚焦时 ↑/↓ 在可见模型间移动高亮，Enter 直接选中；与内置选择器同一套键盘路径。
  const onModelSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveModelHighlight(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key !== 'Enter') return
    const highlighted = visibleModels[activeModelIndex]
    if (highlighted === undefined) return
    event.preventDefault()
    chooseModel(highlighted)
  }
  const menu = loading
    ? [
        createElement('div', { key: 'loading', role: 'status', 'aria-live': 'polite', style: modelLoadingMenuStyle },
          createElement('span', { className: 'codingns4dsh-cli-spinner', 'aria-hidden': true, style: modelSpinnerStyle }),
          createElement('span', undefined, t('cli.loadingModel')),
        ),
      ]
    : pane === 'root'
      ? [
          ...(translationAvailable
            ? [createElement(TranslationToggleRow, {
                key: 'translation',
                checked: selection.translationEnabled === true,
                label: t('cli.translationConversation'),
                toggleLabel: t('cli.translationConversationToggle'),
                onChange: toggleTranslation,
                settingsLabel: t('cli.translationSettings'),
                onSettings: openTranslationSettings,
              })]
            : []),
          // 档位开关固定在「模型」行上方，与模型/思考等级同处一个弹层。
          ...(serviceTierAvailable
            ? [createElement('div', { key: 'service-tier', className: 'codingns4dsh-service-tier', style: serviceTierRowStyle },
                createElement('span', { style: serviceTierLabelStyle }, t('cli.serviceTier')),
                createElement('span', { style: nativeMenuValueStyle }, serviceTierEnabled ? serviceTierLabel : t('cli.serviceTierStandard')),
                createElement(Switch, {
                  checked: serviceTierEnabled,
                  onChange: toggleServiceTier,
                  label: t('cli.serviceTierToggle', { name: serviceTierLabel }),
                }),
              )]
            : []),
          createElement('button', { key: 'model', type: 'button', role: 'menuitem', disabled: modelUnavailable, onClick: () => setPane('model'), style: nativeMenuCellStyle },
          createElement('span', { style: nativeMenuLabelStyle }, t('cli.model')), createElement('span', { style: nativeMenuValueStyle }, modelLabel), createElement('span', { 'aria-hidden': true, style: nativeChevronStyle }, '›')),
        createElement('button', { key: 'effort', type: 'button', role: 'menuitem', disabled: modelUnavailable, onClick: () => setPane('effort'), style: nativeMenuCellStyle },
          createElement('span', undefined, t('cli.thinking')), createElement('span', { style: nativeMenuValueStyle }, effortLabel), createElement('span', { 'aria-hidden': true, style: nativeChevronStyle }, '›')),
        createElement('button', { key: 'credentials', type: 'button', role: 'menuitem', disabled: sessionId === undefined, onClick: openCredentialBindings, style: nativeMenuCellStyle },
          createElement('span', undefined, t('credentials.sessionBindings')),
          createElement('span', { style: nativeMenuValueStyle }, selection.credentialRefs?.length ? `${selection.credentialRefs.length}` : t('credentials.noneSelected')),
          createElement('span', { 'aria-hidden': true, style: nativeChevronStyle }, '›')),
      ]
    : pane === 'model'
      ? [
          // 与内置模型选择器一致：搜索行就是子面板第一项，上方不放返回按钮；
          // 返回根菜单由 Escape 完成。
          // 搜索行固定在菜单顶部，模型分组在下方独立滚动，与内置选择器结构一致。
          showModelSearch && createElement('div', { key: 'model-search', className: 'codingns4dsh-model-search-row' },
            createElement(DshInput, {
              ref: modelSearchRef,
              className: `codingns4dsh-model-search${modelQuery !== '' ? ' codingns4dsh-model-search-with-query' : ''}`,
              type: 'text',
              role: 'searchbox',
              'aria-label': t('cli.modelSearch'),
              'aria-controls': modelGroupsId,
              'aria-activedescendant': activeModelIndex < 0 ? undefined : `${modelGroupsId}-${String(activeModelIndex)}`,
              placeholder: t('cli.modelSearch'),
              value: modelQuery,
              onChange: (event: ReactChangeEvent<HTMLInputElement>) => changeModelQuery(event.currentTarget.value),
              onKeyDown: onModelSearchKeyDown,
            }),
            modelQuery !== '' && createElement('button', {
              key: 'clear',
              type: 'button',
              className: 'codingns4dsh-model-search-clear',
              'aria-label': t('cli.modelSearchClear'),
              onClick: () => { changeModelQuery(''); modelSearchRef.current?.focus() },
            }, createElement(resolveCloseFillIcon(), {})),
          ),
          createElement('div', { key: 'model-groups', id: modelGroupsId, className: 'codingns4dsh-model-groups' },
            ...visibleModelGroups.map((group) => createElement('section', { key: group.id, role: 'group', 'aria-label': group.name, style: { marginTop: 4 } },
              createElement('div', { style: nativeGroupTitleStyle }, group.name),
              ...group.models.map((item) => {
                const index = modelOptionIndex++
                return createElement('button', {
                  key: `${group.id}:${item.id}`,
                  ref: (element: HTMLButtonElement | null) => { modelOptionRefs.current[index] = element },
                  id: `${modelGroupsId}-${String(index)}`,
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': item.id === model?.id,
                  'data-highlighted': showModelSearch && index === activeModelIndex ? 'true' : undefined,
                  tabIndex: showModelSearch ? -1 : undefined,
                  className: 'codingns4dsh-model-option',
                  onMouseMove: () => { if (showModelSearch && index !== activeModelIndex) setHighlightedModelIndex(index) },
                  onClick: () => chooseModel(item),
                  style: nativeOptionStyle,
                },
                  createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
                  item.id === model?.id && createElement('span', { 'aria-hidden': true }, '✓'),
                  item.source === 'magpie' && createElement(MagpieModelTag, { providerId: item.magpieProviderId }),
                )
              }),
            )),
            visibleModelGroups.length === 0 && createElement('div', { key: 'model-empty', role: 'status', style: modelSearchEmptyStyle },
              t(modelGroups.length === 0 ? 'cli.noModelsAvailable' : 'cli.modelSearchEmpty')),
          ),
        ]
      : pane === 'credentials'
        ? [createElement(CredentialBindingPane, {
            key: 'credentials',
            rpc: props.rpc,
            selection,
            update,
            onClose: () => setPane('root'),
            t,
          })]
      : [
          // 思考档位同样是原生式下钻面板，没有返回按钮；Escape 回到根菜单。
          createElement('div', { key: 'title', style: nativeGroupTitleStyle }, t('cli.thinkingLevelTitle', { model: modelLabel })),
          ...(efforts.length > 0 ? efforts : ['default']).map((effort) => createElement('button', { key: effort, type: 'button', role: 'menuitemradio', 'aria-checked': effort === effortValue, onClick: () => chooseEffort(effort), style: nativeOptionStyle },
            createElement('span', { style: { flex: '1 1 auto' } }, effortDisplayName(model, effort, t('cli.defaultEffort'))), effort === effortValue && createElement('span', { 'aria-hidden': true }, '✓'),
          )),
        ]
  return createElement('div', { ref: rootRef, className: 'codingns4dsh-model-root', style: { position: 'relative', minWidth: 0, maxWidth: '100%', flex: '1 1 min(360px, 45cqw)', display: 'inline-flex' } },
    createElement('button', { type: 'button', disabled: triggerDisabled, 'aria-label': t('cli.chooseModel', { model: modelLabel, effort: effortLabel }), 'aria-busy': loading, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => { setPane('root'); setOpen((value) => !value) }, style: nativeTriggerStyle },
      !loading && createElement(resolveDataIcon(), { className: 'codingns4dsh-model-icon', size: 16 }),
      loading && createElement('span', { className: 'codingns4dsh-cli-spinner', 'aria-hidden': true, style: modelSpinnerStyle }),
      createElement(ModelName, { label: modelLabel, loading }),
      !loading && createElement('span', { className: 'codingns4dsh-model-effort', style: { color: dshThemeColor.labelCaption, whiteSpace: 'nowrap' } }, effortLabel),
      !loading && createElement(NativeDropdownChevron, { open }),
    ),
    open && createElement('div', { role: 'menu', 'aria-label': t('cli.chooseModelMenu'), style: pane === 'model' ? nativeModelMenuStyle : nativeMenuStyle }, ...menu),
    translationSettings,
  )
}

function effortDisplayName(model: CodingNsCliModel | undefined, effort: string, defaultLabel: string): string {
  if (effort === 'default') return defaultLabel
  return model?.effortLabels?.[effort] ?? effort
}

function CredentialBindingPane(props: {
  readonly rpc: CodingNsRpcClient
  readonly selection: SelectionState
  readonly update: (next: SelectionState) => Promise<boolean>
  readonly onClose: () => void
  readonly t: ReturnType<typeof useCodingNsTranslator>
}): ReactElement {
  const [items, setItems] = useState<readonly CredentialMetadata[]>([])
  const [draft, setDraft] = useState<readonly CredentialReference[]>(props.selection.credentialRefs ?? [])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void props.rpc.call(CODINGNS_RPC_CHANNEL, 'credentials/list', {}).then((result) => {
      if (!result.ok || !Array.isArray(result.value)) throw new Error('credential list failed')
      if (active) setItems(result.value.filter(isCredentialMetadata))
    }).catch(() => {
      if (active) setItems([])
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [props.rpc])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const accepted = await props.update({ ...props.selection, credentialRefs: draft })
      if (accepted) props.onClose()
    } finally {
      setBusy(false)
    }
  }
  const toggle = (item: CredentialMetadata, checked: boolean): void => {
    if (checked) {
      const existing = draft.find((reference) => reference.credentialId === item.id)
      if (existing !== undefined) return
      setDraft([...draft, {
        credentialId: item.id,
        bindings: item.fields.map((field) => ({ field: field.name, env: defaultCredentialEnv(field.name) })),
      }])
    } else {
      setDraft(draft.filter((reference) => reference.credentialId !== item.id))
    }
  }
  const updateEnv = (credentialId: string, field: string, env: string): void => {
    setDraft(draft.map((reference) => reference.credentialId !== credentialId
      ? reference
      : { ...reference, bindings: reference.bindings.map((binding) => binding.field === field ? { ...binding, env } : binding) }))
  }
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 6 } },
    createElement('div', { style: nativeGroupTitleStyle }, props.t('credentials.sessionBindings')),
    createElement('div', { style: { padding: '4px 8px 8px', color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), lineHeight: 1.4 } }, props.t('credentials.sessionBindingsHint')),
    loading
      ? createElement('div', { role: 'status', style: modelLoadingMenuStyle }, 'Loading…')
      : items.length === 0
        ? createElement('div', { style: modelSearchEmptyStyle }, props.t('credentials.noneSelected'))
        : items.map((item) => {
          const reference = draft.find((candidate) => candidate.credentialId === item.id)
          return createElement('div', { key: item.id, style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '6px 8px', borderRadius: 8, background: dshThemeColor.surfaceSubtle } },
            createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: uiFontSize(13) } },
              createElement('input', { type: 'checkbox', checked: reference !== undefined, onChange: (event: { currentTarget: { checked: boolean } }) => toggle(item, event.currentTarget.checked) }),
              createElement('span', undefined, item.label),
            ),
            reference?.bindings.map((binding) => createElement('label', { key: binding.field, style: { display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 22, fontSize: uiFontSize(12) } },
              createElement('span', { style: { minWidth: 72, color: dshThemeColor.labelTertiary } }, binding.field),
              createElement('input', { value: binding.env, onChange: (event: { currentTarget: { value: string } }) => updateEnv(item.id, binding.field, event.currentTarget.value), style: { ...inputStyle, padding: '4px 6px', fontSize: uiFontSize(12) } }),
            )),
          )
        }),
    createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 } },
      createElement('button', { type: 'button', style: nativeOptionStyle, disabled: busy, onClick: props.onClose }, props.t('credentials.cancel')),
      createElement('button', { type: 'button', style: { ...nativeOptionStyle, color: dshThemeColor.accent }, disabled: busy || loading, onClick: () => { void save() } }, props.t('credentials.save')),
    ),
  )
}

function defaultCredentialEnv(field: string): string {
  const value = field.replace(/[^A-Za-z0-9_]/gu, '_').toUpperCase()
  return `CREDENTIAL_${value || 'VALUE'}`
}

function isCredentialMetadata(value: unknown): value is CredentialMetadata {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string' && Array.isArray(value.fields)
    && value.fields.every((field) => isRecord(field) && typeof field.name === 'string' && typeof field.hasValue === 'boolean')
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const inputStyle = { width: '100%', boxSizing: 'border-box' as const, border: `1px solid ${dshThemeColor.border}`, borderRadius: 6, padding: '7px 8px', color: dshThemeColor.labelPrimary, background: dshThemeColor.surfaceSubtle, fontSize: uiFontSize(13) }

const nativeTriggerStyle = { width: '100%', minWidth: 0, maxWidth: 'min(360px, 45cqw)', height: 28, color: dshThemeColor.labelSecondary, cursor: 'pointer', background: 'transparent', border: 0, borderRadius: 24, padding: '0 4px 0 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: uiFontSize(13), lineHeight: '20px' }
const modelNameStyle = { minWidth: 0, maxWidth: 150, flex: '0 1 150px', display: 'block', overflow: 'hidden', whiteSpace: 'nowrap' as const }
const nativeMenuStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1100, right: 0, bottom: 'calc(100% + 8px)', minWidth: 240, maxWidth: 'min(420px, calc(100vw - 32px))', maxHeight: 'min(360px, calc(100vh - 96px))', overflowX: 'hidden' as const, overflowY: 'auto' as const, padding: 4, border: 0, borderRadius: 20 }
// 模型列表菜单改为列布局：搜索行固定在顶部，只有模型分组区域滚动，
// 与内置模型选择器的 MenuSurface + groups 结构一致。
const nativeModelMenuStyle = { ...nativeMenuStyle, display: 'flex' as const, flexDirection: 'column' as const, overflowY: 'hidden' as const }
// 菜单行同时用于 <button> 和 <div>：button 由 DSH 全局样式给了 border-box，
// div 没有，若只写 width:100%+padding，div 会按 content-box 多出左右各 10px，
// 把整行撑出面板并触发横向滚动条（档位开关因此被推到贴住右边缘）。
// 显式声明 border-box，让两种元素的内边距都算进宽度。
const nativeMenuCellStyle = { width: '100%', minHeight: 40, boxSizing: 'border-box' as const, color: 'inherit', cursor: 'pointer', background: 'transparent', border: 0, borderRadius: 10, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' as const, fontSize: uiFontSize(14), lineHeight: '22px' }
// 档位行与相邻菜单行保持同一高度、内边距与盒模型，Switch 右对齐到与菜单箭头同一列。
const serviceTierRowStyle = { width: '100%', minHeight: 40, boxSizing: 'border-box' as const, color: 'inherit', borderRadius: 10, padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: uiFontSize(14), lineHeight: '22px' }
const serviceTierLabelStyle = { flex: 'none', whiteSpace: 'nowrap' as const }
const nativeMenuLabelStyle = { flex: 'none', whiteSpace: 'nowrap' as const }
const nativeMenuValueStyle = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, textAlign: 'right' as const, color: dshThemeColor.labelTertiary }
const nativeChevronStyle = { flex: 'none', color: dshThemeColor.labelTertiary, fontSize: uiFontSize(20), lineHeight: 1 }
const nativeGroupTitleStyle = { position: 'sticky' as const, top: 0, zIndex: 1, padding: '5px 8px 3px', color: dshThemeColor.labelTertiary, background: dshThemeColor.menuBackground, fontSize: uiFontSize(12), fontWeight: 500, lineHeight: '18px' }
const nativeOptionStyle = { width: '100%', minHeight: 38, color: 'inherit', cursor: 'pointer', textAlign: 'left' as const, background: 'transparent', border: 0, borderRadius: 10, padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8, fontSize: uiFontSize(14), lineHeight: '20px' }
const modelSpinnerStyle = { width: 12, height: 12, flex: '0 0 12px', boxSizing: 'border-box' as const, border: '2px solid currentColor', borderRightColor: 'transparent', borderRadius: '50%' }
const modelLoadingMenuStyle = { minHeight: 56, padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(13) }
const modelSearchEmptyStyle = { margin: 0, padding: 8, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), lineHeight: '18px' }

function defaultEffort(efforts: readonly string[]): string | undefined {
  if (efforts.length === 0) return undefined
  return efforts.length > 2 ? efforts[efforts.length - 2] : efforts[efforts.length - 1]
}

/** 会话离开空白新建态后，适配器选择器不可再修改。 */
function isSessionLocked(session: SessionSnapshot | undefined): boolean {
  return session !== undefined
    && (!session.blank || Boolean(session.promptAttempted) || Boolean(session.running) || (session.queue?.length ?? 0) > 0)
}

export { AgentSlot, ModelSlot }
export type { SessionSnapshot }
