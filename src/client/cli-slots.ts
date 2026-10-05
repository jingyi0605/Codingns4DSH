import { createElement, useEffect, useRef, useState } from 'react'
import { useDismissOnOutsidePointer } from './popup-dismiss.js'
import type { ReactElement } from 'react'
import type { CSSProperties } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodingNsCliAdapterDescriptor, CodingNsCliModel, CodingNsCliModelCatalog, CodingNsCliSessionConfig } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { adapterCatalogWithDsh, callCliRpc, findModel, firstModel } from './cli-catalog.js'
import {
  activeServiceTier,
  canSelectServiceTier,
  carriedServiceTierId,
  isServiceTierEnabled,
  modelServiceTiers,
  needsServiceTierRevalidation,
  toggledServiceTierId,
} from './service-tier.js'
import { resolveDataIcon } from '../dsh-capabilities/client/primitives-adapter.js'
import { providerIconUrl } from './provider-icons.js'
import { publishSessionAdapter } from './session-adapter-cache.js'
import {
  getModelCatalogCache,
  invalidateModelCatalogCache,
  loadModelCatalog,
  MODEL_CATALOG_REVALIDATE_INTERVAL_MS,
  shouldRevalidateModelCatalog,
} from './model-catalog-cache.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { useCodingNsTranslator, type CodingNsLocale } from './locale.js'

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
  style.textContent = [
    'html[data-codingns-agent]:not([data-codingns-agent="dsh"]) [data-slot="conversation.input.model"],',
    'body[data-codingns-agent]:not([data-codingns-agent="dsh"]) [data-slot="conversation.input.model"]{display:none!important}',
    // DSH 在控制行放不下时给行加 data-model-compact，原生模型席位据此把文本收成图标。
    // 这里不再强制工具行 nowrap：保留原生 flex-wrap 语义，DSH 的测量口径才能反映真实占用，
    // 放不下时先收起模型，而不是把左侧工具组（权限/规划组）压到内容溢出与相邻按钮重叠。
    // 插件模型选择器跟随同一判定：紧凑时收起名称与思考等级，只留图标与下拉箭头。
    '.codingns4dsh-model-icon{display:none}',
    '[data-composer-card] [data-model-compact] .codingns4dsh-model-root .codingns4dsh-model-name,',
    '[data-composer-card] [data-model-compact] .codingns4dsh-model-root .codingns4dsh-model-effort{display:none!important}',
    '[data-composer-card] [data-model-compact] .codingns4dsh-model-root .codingns4dsh-model-icon{display:block!important;flex:none}',
    '[data-composer-card] > div:has([data-slot="conversation.input.right"]) > div:has(> [data-slot="conversation.input.right"]){min-width:0;width:0;flex:1 1 0}',
    '[data-composer-card] > div:has([data-slot="conversation.input.right"]) [data-slot="conversation.input.right"] > .codingns4dsh-model-root{min-width:0;max-width:min(360px,45cqw);flex:1 1 min(360px,45cqw)}',
    '[data-composer-card] > div:has([data-slot="conversation.input.right"]) [data-slot="conversation.input.model"] > select{width:100%;min-width:0;max-width:min(150px,45cqw);flex:1 1 min(150px,45cqw);overflow:hidden;white-space:nowrap}',
    '[data-composer-card] > div:has([data-slot="conversation.input.right"]) [data-slot="conversation.input.model"] > button{width:100%;min-width:0;max-width:min(360px,45cqw);overflow:hidden;white-space:nowrap}',
    // 与 DSH 原生同类控件一致（权限选择器 460px、预设标签 540px 都用容器查询）：
    // composer 控制行收窄到 650px 以内时，适配器按钮让出名称与右侧状态图标（下拉箭头/锁形），
    // 只保留适配器图标；行宽恢复后名称自动回来。这是纯 CSS 判定，不随任何折叠状态摆动。
    // 650 取自实测「适配器名称开始与左侧控件冲突」的临界宽度（容器查询按行的内容盒计，
    // 比输入框的可见宽度小左右各 8px 内边距）。
    '@container (width<=650px){[data-composer-card] .codingns4dsh-agent-trigger > .codingns4dsh-agent-label{display:none}[data-composer-card] .codingns4dsh-agent-trigger > svg{display:none!important}[data-composer-card] .codingns4dsh-agent-trigger{padding-left:4px;padding-right:4px;gap:0}}',
    // 移动端工具栏空间有限，收掉控件组自身的间距；控件组按 CSS Modules 本地名匹配，
    // 不绑定构建哈希（npm 分发的 Web 构建是 uV2eYG_*，Desktop 内嵌构建是 yhfFVG_*）。
    '@media (max-width: 768px){[data-composer-card] > div:has([data-slot="conversation.input.right"]) > div:has(> [data-slot="conversation.input.right"]),[data-composer-card] [data-slot="conversation.input.right"],[data-composer-card] [class*="_standardControls"],[data-composer-card] [class*="_trailing"]{gap:0!important;column-gap:0!important}}',
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
    '@media (prefers-reduced-motion:reduce){.codingns4dsh-cli-spinner{animation-duration:1.6s}.codingns4dsh-model-name[data-overflow="true"]>span{animation:none;transform:translateX(0)}}',
  ].join('')
  document.head.appendChild(style)
}

interface CliSlotProps {
  readonly sessionId?: string
  readonly useSession?: SessionSelector
  readonly rpc: CodingNsRpcClient
  readonly locale: CodingNsLocale
}

interface SelectionState extends CodingNsCliSessionConfig {}

const DEFAULT_SELECTION: SelectionState = { adapterId: 'dsh' }
const selections = new Map<string, SelectionState>()
const selectionListeners = new Map<string, Set<() => void>>()
/** Slot 会随 DSH 会话状态重挂载；保留最近选择，避免重挂载时再次闪回默认值。 */
const selectionLastUsed = new Map<string, number>()
const MAX_SELECTION_CACHE = 256
/** 两个 Slot 共用同一条初始化读取，避免响应顺序造成状态回退。 */
const selectionLoads = new Map<string, Promise<CodingNsCliSessionConfig>>()
/** 记录每个会话最新的写入，旧响应不能覆盖用户较新的选择。 */
const selectionUpdates = new Map<string, { readonly revision: number; readonly promise: Promise<CodingNsCliSessionConfig> }>()
const selectionRevisions = new Map<string, number>()
/** 在 Agent 和模型两个 Slot 之间共享当前会话选择。 */
function useSelection(sessionId: string | undefined, rpc: CodingNsRpcClient): [SelectionState, (next: SelectionState) => void] {
  const [selection, setSelection] = useState<SelectionState>(() => sessionId ? selections.get(sessionId) ?? DEFAULT_SELECTION : DEFAULT_SELECTION)

  useEffect(() => {
    if (sessionId === undefined || sessionId.trim() === '') return
    let active = true
    const loaded = selectionLoads.get(sessionId) ?? callCliRpc<CodingNsCliSessionConfig>(rpc, 'session/get', { sessionId })
    selectionLoads.set(sessionId, loaded)
    void loaded
      .then((value) => {
        if (!active) return
        // 用户可能已在 session/get 返回前切换 Agent；旧响应不能覆盖本地最新选择。
        if (selections.has(sessionId)) return
        publishSelection(sessionId, value)
      })
      .catch(() => undefined)
      .finally(() => {
        if (selectionLoads.get(sessionId) === loaded) selectionLoads.delete(sessionId)
      })
    const listeners = selectionListeners.get(sessionId) ?? new Set<() => void>()
    selectionListeners.set(sessionId, listeners)
    const listener = (): void => setSelection(selections.get(sessionId) ?? DEFAULT_SELECTION)
    listeners.add(listener)
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

  const update = (next: SelectionState): void => {
    if (sessionId === undefined || sessionId.trim() === '') return
    publishSelection(sessionId, next)
    const revision = (selectionRevisions.get(sessionId) ?? 0) + 1
    selectionRevisions.set(sessionId, revision)
    const promise = callCliRpc<CodingNsCliSessionConfig>(rpc, 'session/set', { sessionId, ...next })
    selectionUpdates.set(sessionId, { revision, promise })
    void promise
      .then((normalized) => {
        if (selectionUpdates.get(sessionId)?.revision === revision) publishSelection(sessionId, normalized)
      })
      .catch(() => undefined)
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
  }
  selections.set(sessionId, normalized)
  selectionLastUsed.set(sessionId, Date.now())
  publishSessionAdapter(sessionId, normalized.adapterId)
  for (const listener of selectionListeners.get(sessionId) ?? []) listener()
}

/** 把 Agent 与模型选择器注册到同一工具栏，使用顺序保证 Agent 始终位于模型左侧。 */
export function registerCliConversationSlots(slots: SlotRegistry, rpc: CodingNsRpcClient, locale: CodingNsLocale): () => void {
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
    inject: (sessionId: string) => ({ rpc, sessionId, locale }),
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
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const locked = isSessionLocked(session)

  useDismissOnOutsidePointer(rootRef, open, () => setOpen(false))

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.codingnsAgent = selection.adapterId
    document.body?.setAttribute('data-codingns-agent', selection.adapterId)
    return () => {
      if (document.documentElement.dataset.codingnsAgent === selection.adapterId) delete document.documentElement.dataset.codingnsAgent
      if (document.body?.dataset.codingnsAgent === selection.adapterId) document.body.removeAttribute('data-codingns-agent')
    }
  }, [selection.adapterId])

  useEffect(() => {
    let active = true
    void callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(props.rpc, 'catalog', sessionId === undefined ? {} : { sessionId })
      .then((value) => { if (active) setAgents(adapterCatalogWithDsh(value)) })
      .catch(() => undefined)
    return () => { active = false }
  }, [props.rpc, sessionId])

  useEffect(() => { if (locked) setOpen(false) }, [locked])

  const current = agents.find((agent) => agent.id === selection.adapterId) ?? agents[0]!
  const choose = (agent: CodingNsCliAdapterDescriptor): void => {
    if (locked || !agent.installed || !agent.enabled || sessionId === undefined) return
    update({ adapterId: agent.id })
    setOpen(false)
  }
  const currentIcon = providerIconUrl(current.id)
  return createElement('div', { ref: rootRef, style: agentRootStyle },
    createElement('button', { type: 'button', className: 'codingns4dsh-agent-trigger', disabled: locked, onClick: () => setOpen((value) => !value), 'aria-label': t('cli.currentAgent', { name: current.name, locked: locked ? t('cli.locked') : '' }), 'aria-haspopup': 'menu', 'aria-expanded': open, style: { ...agentTriggerStyle, cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.7 : 1 } },
      currentIcon === undefined
        ? createElement(ProviderIconFallback, { name: current.name, size: 20 })
        : createElement('img', { src: currentIcon, alt: '', 'aria-hidden': true, style: applyProviderIconShape(current.id, agentTriggerIconStyle) }),
      createElement('span', { className: 'codingns4dsh-agent-label', style: agentTriggerLabelStyle }, current.name),
      createElement(NativeDropdownChevron, { open, locked }),
    ),
    open && !locked && createElement('div', { role: 'menu', 'aria-label': t('cli.selectAgent'), style: agentMenuStyle },
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
          !agent.installed && createElement('span', { style: agentStatusStyle }, t('cli.notInstalled')),
          agent.installed && !agent.enabled && createElement('span', { style: agentStatusStyle }, t('cli.disabled')),
        )
      }),
    ),
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
const agentTriggerStyle = { height: 30, minWidth: 0, color: dshThemeColor.labelPrimary, border: 0, borderRadius: 8, padding: '0 6px', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14, lineHeight: '20px', whiteSpace: 'nowrap' as const }
const agentTriggerIconStyle = { width: 20, height: 20, flex: '0 0 20px', objectFit: 'contain' as const }
const agentTriggerLabelStyle = { flex: '0 0 auto', whiteSpace: 'nowrap' as const }
const nativeDropdownChevronStyle = { display: 'block', flex: '0 0 14px', color: dshThemeColor.labelCaption, transformOrigin: 'center' }
const agentMenuStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1100, bottom: 'calc(100% + 8px)', left: 0, minWidth: 238, maxWidth: 'min(320px, calc(100vw - 32px))', maxHeight: 'min(400px, calc(100vh - 96px))', overflowY: 'auto' as const, padding: 5, border: 0, borderRadius: 8 }
const agentOptionStyle = { width: '100%', minHeight: 40, color: 'inherit', border: 0, borderRadius: 6, padding: '5px 8px 5px 4px', background: 'transparent', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' as const, fontSize: 14, lineHeight: '20px' }
const agentCheckStyle = { width: 18, flex: '0 0 18px', textAlign: 'center' as const, fontSize: 16, lineHeight: 1 }
const agentOptionIconStyle = { width: 22, height: 22, flex: '0 0 22px', objectFit: 'contain' as const }
const agentOptionLabelStyle = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const agentStatusStyle = { flex: '0 0 auto', color: dshThemeColor.labelTertiary, fontSize: 12, whiteSpace: 'nowrap' as const }
const agentFallbackIconStyle = { flexGrow: 0, flexShrink: 0, borderRadius: 5, color: '#fff', background: dshThemeColor.labelTertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, lineHeight: 1 }

type ModelPane = 'root' | 'model' | 'effort'

interface ModelCatalogState {
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
  const rootRef = useRef<HTMLDivElement | null>(null)

  useDismissOnOutsidePointer(rootRef, open, () => { setOpen(false); setPane('root') })

  const catalog = catalogState?.adapterId === selection.adapterId ? catalogState.value : null
  // 目录必须和当前适配器绑定；切换后的第一次渲染立即进入加载态，不能短暂展示旧目录。
  const loading = selection.adapterId !== 'dsh'
    // 有 stale 目录时直接可用，后台刷新不应阻塞模型/思考强度选择。
    && catalog === null
    && refreshingAdapterId === selection.adapterId
  // 目录声明了服务档位、却未确认官方订阅时，可能只是判定过期（用户在外部工具里
  // 刚切回官方订阅）。这种状态值得再探测一次，但不代表应该展示开关。
  const serviceTierRevalidation = needsServiceTierRevalidation(catalog)

  useEffect(() => {
    if (selection.adapterId === 'dsh') {
      setCatalogState(null)
      setRefreshingAdapterId(null)
      return
    }
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const adapterId = selection.adapterId
    const cached = getModelCatalogCache(props.rpc).get(adapterId)
    if (cached !== undefined) setCatalogState({ adapterId, value: cached })
    setRefreshingAdapterId(adapterId)
    // 档位判定过期时先作废 Client 缓存，让本次请求真正走到 Host 的指纹比对。
    // 用节流避免真实第三方接入下每次挂载都重复探测。
    if (shouldRevalidateModelCatalog(props.rpc, adapterId, needsServiceTierRevalidation(cached ?? null))) {
      invalidateModelCatalogCache(props.rpc, adapterId)
    }
    void loadModelCatalog(props.rpc, adapterId, sessionId)
      .then((value) => {
        if (!active) return
        setCatalogState({ adapterId, value })
        if (value.fallback === true) {
          // 回退目录通常来自启动竞态或产品快照尚未落盘；等待 Host 的短周期
          // 重试后重新执行一次 RPC，避免当前页面永久停留在默认模型。
          retryTimer = setTimeout(() => {
            if (active) setCatalogRetry((value) => value + 1)
          }, 15_000)
        }
        const normalize = (): void => {
          if (!active) return
          // session/set 可能正在回填适配器级记忆值；必须等它完成后再补默认值，
          // 否则目录第一项会先写入 Host，随后覆盖真正的记忆选择。
          const currentSelection = sessionId === undefined
            ? selection
            : selections.get(sessionId) ?? selection
          if (currentSelection.adapterId !== adapterId) return
          const model = findModel(value, currentSelection.modelId) ?? firstModel(value)
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
              ...(effort ? { effortId: effort } : {}),
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
        if (getModelCatalogCache(props.rpc).get(adapterId) === undefined) {
          setCatalogState({ adapterId, value: { groups: [], currentModel: null, currentEffort: null } })
        }
      })
      .finally(() => { if (active) setRefreshingAdapterId(null) })
    return () => {
      active = false
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
  }, [props.rpc, selection.adapterId, sessionId, catalogRetry])

  /**
   * 档位判定处于「未确认官方订阅」时周期复检。
   *
   * 用户在 cc-switch 之类的工具里切回官方订阅不会触发页面事件，唯一能发现变化的
   * 方式就是再探测一次。这里只负责到点触发一次目录重读，是否真正作废缓存交给主
   * effect 的节流判定——若在本 effect 里调用节流函数，会先消耗掉窗口，紧接着主
   * effect 的判定就被挡下，反而不会重新请求。
   *
   * 探测本身很廉价：Host 比对配置指纹后，配置没变就直接返回缓存，不会重启 CLI。
   * 真实第三方接入会长期停在该状态，因此轮询持续存在，代价是每分钟一次缓存命中的
   * RPC；这换取的是用户切换供应商后无需刷新页面。
   */
  useEffect(() => {
    if (!serviceTierRevalidation) return
    // 比节流窗口多留 5 秒：setInterval 的实际触发可能略早于标称间隔，
    // 若两者相等，到点时节的流窗口可能还差几毫秒没到期，这一轮就白跑了。
    const timer = setInterval(() => {
      setCatalogRetry((value) => value + 1)
    }, MODEL_CATALOG_REVALIDATE_INTERVAL_MS + 5_000)
    return () => clearInterval(timer)
  }, [selection.adapterId, serviceTierRevalidation])

  useEffect(() => { if (selection.adapterId === 'dsh') setOpen(false) }, [selection.adapterId])

  if (selection.adapterId === 'dsh') return null

  const model = catalog === null ? undefined : findModel(catalog, selection.modelId) ?? firstModel(catalog)
  const efforts = model?.efforts ?? []
  const effortValue = selection.effortId ?? (efforts.length > 0 ? defaultEffort(efforts) : undefined) ?? 'default'
  const modelLabel = model?.name ?? (loading ? t('cli.loadingModel') : t('cli.noModelsAvailable'))
  const effortLabel = effortDisplayName(model, effortValue, t('cli.defaultEffort'))
  const modelUnavailable = model === undefined
  const triggerDisabled = !loading && modelUnavailable
  const chooseModel = (next: CodingNsCliModel): void => {
    const nextEffort = next.efforts.includes(effortValue) ? effortValue : defaultEffort(next.efforts)
    // 档位必须随模型切换一起携带：新模型不声明该档位时显式回落 `default`，
    // 不能省略——省略会让 Host 保留旧档位，继续下发该模型不支持的 serviceTier。
    const nextTier = carriedServiceTierId(next, selection.serviceTierId)
    update({
      adapterId: selection.adapterId,
      modelId: next.id,
      ...(nextEffort ? { effortId: nextEffort } : {}),
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
    update({ adapterId: selection.adapterId, modelId: model.id, ...(selection.effortId ? { effortId: selection.effortId } : {}), serviceTierId })
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
      ]
    : pane === 'model'
      ? [
          createElement('button', { key: 'back', type: 'button', onClick: () => setPane('root'), style: nativeBackStyle }, t('cli.back')),
          ...((catalog?.groups ?? []).map((group) => createElement('section', { key: group.id, role: 'group', 'aria-label': group.name, style: { marginTop: 4 } },
            createElement('div', { style: nativeGroupTitleStyle }, group.name),
            ...group.models.map((item) => createElement('button', { key: `${group.id}:${item.id}`, type: 'button', role: 'menuitemradio', 'aria-checked': item.id === model?.id, onClick: () => chooseModel(item), style: nativeOptionStyle },
              createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
              item.id === model?.id && createElement('span', { 'aria-hidden': true }, '✓'),
            )),
          )))
        ]
      : [
          createElement('button', { key: 'back', type: 'button', onClick: () => setPane('root'), style: nativeBackStyle }, t('cli.back')),
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
    open && createElement('div', { role: 'menu', 'aria-label': t('cli.chooseModelMenu'), style: nativeMenuStyle }, ...menu),
  )
}

function effortDisplayName(model: CodingNsCliModel | undefined, effort: string, defaultLabel: string): string {
  if (effort === 'default') return defaultLabel
  return model?.effortLabels?.[effort] ?? effort
}

const nativeTriggerStyle = { width: '100%', minWidth: 0, maxWidth: 'min(360px, 45cqw)', height: 28, color: dshThemeColor.labelSecondary, cursor: 'pointer', background: 'transparent', border: 0, borderRadius: 24, padding: '0 4px 0 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, lineHeight: '20px' }
const modelNameStyle = { minWidth: 0, maxWidth: 150, flex: '0 1 150px', display: 'block', overflow: 'hidden', whiteSpace: 'nowrap' as const }
const nativeMenuStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1100, right: 0, bottom: 'calc(100% + 8px)', minWidth: 240, maxWidth: 'min(420px, calc(100vw - 32px))', maxHeight: 'min(360px, calc(100vh - 96px))', overflowX: 'hidden' as const, overflowY: 'auto' as const, padding: 4, border: 0, borderRadius: 20 }
// 菜单行同时用于 <button> 和 <div>：button 由 DSH 全局样式给了 border-box，
// div 没有，若只写 width:100%+padding，div 会按 content-box 多出左右各 10px，
// 把整行撑出面板并触发横向滚动条（档位开关因此被推到贴住右边缘）。
// 显式声明 border-box，让两种元素的内边距都算进宽度。
const nativeMenuCellStyle = { width: '100%', minHeight: 40, boxSizing: 'border-box' as const, color: 'inherit', cursor: 'pointer', background: 'transparent', border: 0, borderRadius: 10, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' as const, fontSize: 14, lineHeight: '22px' }
// 档位行与相邻菜单行保持同一高度、内边距与盒模型，Switch 右对齐到与菜单箭头同一列。
const serviceTierRowStyle = { width: '100%', minHeight: 40, boxSizing: 'border-box' as const, color: 'inherit', borderRadius: 10, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, lineHeight: '22px' }
const serviceTierLabelStyle = { flex: 'none', whiteSpace: 'nowrap' as const }
const nativeMenuLabelStyle = { flex: 'none', whiteSpace: 'nowrap' as const }
const nativeMenuValueStyle = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, textAlign: 'right' as const, color: dshThemeColor.labelTertiary }
const nativeChevronStyle = { flex: 'none', color: dshThemeColor.labelTertiary, fontSize: 20, lineHeight: 1 }
const nativeBackStyle = { width: '100%', height: 30, color: dshThemeColor.labelSecondary, cursor: 'pointer', textAlign: 'left' as const, background: 'transparent', border: 0, borderRadius: 8, padding: '0 8px', fontSize: 13 }
const nativeGroupTitleStyle = { position: 'sticky' as const, top: 0, zIndex: 1, padding: '5px 8px 3px', color: dshThemeColor.labelTertiary, background: dshThemeColor.menuBackground, fontSize: 12, fontWeight: 500, lineHeight: '18px' }
const nativeOptionStyle = { width: '100%', minHeight: 38, color: 'inherit', cursor: 'pointer', textAlign: 'left' as const, background: 'transparent', border: 0, borderRadius: 10, padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, lineHeight: '20px' }
const modelSpinnerStyle = { width: 12, height: 12, flex: '0 0 12px', boxSizing: 'border-box' as const, border: '2px solid currentColor', borderRightColor: 'transparent', borderRadius: '50%' }
const modelLoadingMenuStyle = { minHeight: 56, padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: dshThemeColor.labelTertiary, fontSize: 13 }

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
