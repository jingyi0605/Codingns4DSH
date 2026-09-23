import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsCliAdapterDescriptor, CodingNsCliModel, CodingNsCliModelCatalog, CodingNsCliSessionConfig } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { adapterCatalogWithDsh, callCliRpc, findModel, firstModel } from './cli-catalog.js'
import { providerIconUrl } from './provider-icons.js'
import { publishSessionAdapter } from './session-adapter-cache.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { useCodingNsTranslator, type CodingNsLocale } from './locale.js'

interface SessionSnapshot {
  readonly sessionId?: string
  readonly blank?: boolean
  readonly promptAttempted?: boolean
  readonly running?: boolean
  readonly queue?: readonly unknown[]
}

type SessionSelector = <Selected>(selector: (session: SessionSnapshot) => Selected) => Selected

/** DSH Web 当前版本的对话工具栏 Slot 契约。Slot 包没有预声明这些业务名称，插件在此补齐类型。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.right': { kind: 'list'; scope: 'session' }
  }
  interface SessionStandardProps {
    sessionId: string
    useSession: SessionSelector
  }
}

const CLI_STYLE_ID = 'dsh-codingns-cli-composer-style'
const CIRCULAR_PROVIDER_ICON_IDS = new Set(['gemini', 'grok'])

function installComposerStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${CLI_STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-codingns'
  style.dataset.pluginCss = CLI_STYLE_ID
  style.textContent = [
    'html[data-codingns-agent]:not([data-codingns-agent="dsh"]) [data-slot="conversation.input.model"],',
    'body[data-codingns-agent]:not([data-codingns-agent="dsh"]) [data-slot="conversation.input.model"]{display:none!important}',
    '@keyframes dsh-codingns-cli-spin{to{transform:rotate(360deg)}}',
    '.dsh-codingns-cli-spinner{animation:dsh-codingns-cli-spin .8s linear infinite}',
    '.dsh-codingns-agent-trigger:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}',
    '.dsh-codingns-agent-option:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)!important}',
    '.dsh-codingns-agent-option[data-selected="true"]{background:color-mix(in srgb,currentColor 10%,transparent)!important}',
    '@media (prefers-reduced-motion:reduce){.dsh-codingns-cli-spinner{animation-duration:1.6s}}',
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

/** 在 Agent 和模型两个 Slot 之间共享当前会话选择。 */
function useSelection(sessionId: string | undefined, rpc: CodingNsRpcClient): [SelectionState, (next: SelectionState) => void] {
  const [selection, setSelection] = useState<SelectionState>(() => sessionId ? selections.get(sessionId) ?? DEFAULT_SELECTION : DEFAULT_SELECTION)

  useEffect(() => {
    if (sessionId === undefined || sessionId.trim() === '') return
    let active = true
    void callCliRpc<CodingNsCliSessionConfig>(rpc, 'session/get', { sessionId })
      .then((value) => {
        if (!active) return
        publishSelection(sessionId, value)
      })
      .catch(() => undefined)
    const listeners = selectionListeners.get(sessionId) ?? new Set<() => void>()
    selectionListeners.set(sessionId, listeners)
    const listener = (): void => setSelection(selections.get(sessionId) ?? DEFAULT_SELECTION)
    listeners.add(listener)
    return () => {
      active = false
      listeners.delete(listener)
      if (listeners.size === 0) {
        selectionListeners.delete(sessionId)
        selections.delete(sessionId)
      }
    }
  }, [rpc, sessionId])

  const update = (next: SelectionState): void => {
    if (sessionId === undefined || sessionId.trim() === '') return
    publishSelection(sessionId, next)
    void callCliRpc<CodingNsCliSessionConfig>(rpc, 'session/set', { sessionId, ...next }).catch(() => undefined)
  }
  return [selection, update]
}

function publishSelection(sessionId: string, next: SelectionState): void {
  const normalized: SelectionState = {
    adapterId: next.adapterId,
    ...(next.modelId ? { modelId: next.modelId } : {}),
    ...(next.effortId ? { effortId: next.effortId } : {}),
  }
  selections.set(sessionId, normalized)
  publishSessionAdapter(sessionId, normalized.adapterId)
  for (const listener of selectionListeners.get(sessionId) ?? []) listener()
}

/** 把 Agent 与模型选择器注册到同一工具栏，使用顺序保证 Agent 始终位于模型左侧。 */
export function registerCliConversationSlots(slots: SlotRegistry, rpc: CodingNsRpcClient, locale: CodingNsLocale): () => void {
  installComposerStyles()
  const t = locale.bind('codingns')
  const disposeAgent = slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'dsh-codingns-agent',
    order: -20,
    label: t('cli.agentSelector'),
    inject: (sessionId: string) => ({ rpc, sessionId, locale }),
  }, AgentSlot))
  const disposeModel = slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'dsh-codingns-model',
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
  const locked = session !== undefined && (!session.blank || Boolean(session.promptAttempted) || Boolean(session.running) || (session.queue?.length ?? 0) > 0)

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
    void callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(props.rpc, 'catalog', {})
      .then((value) => { if (active) setAgents(adapterCatalogWithDsh(value)) })
      .catch(() => undefined)
    return () => { active = false }
  }, [props.rpc])

  useEffect(() => { if (locked) setOpen(false) }, [locked])

  const current = agents.find((agent) => agent.id === selection.adapterId) ?? agents[0]!
  const choose = (agent: CodingNsCliAdapterDescriptor): void => {
    if (locked || !agent.installed || !agent.enabled || sessionId === undefined) return
    update({ adapterId: agent.id })
    setOpen(false)
  }
  const currentIcon = providerIconUrl(current.id)
  return createElement('div', { style: agentRootStyle },
    createElement('button', { type: 'button', className: 'dsh-codingns-agent-trigger', disabled: locked, onClick: () => setOpen((value) => !value), 'aria-label': t('cli.currentAgent', { name: current.name, locked: locked ? t('cli.locked') : '' }), 'aria-haspopup': 'menu', 'aria-expanded': open, style: { ...agentTriggerStyle, cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.7 : 1 } },
      currentIcon === undefined
        ? createElement(ProviderIconFallback, { name: current.name, size: 20 })
        : createElement('img', { src: currentIcon, alt: '', 'aria-hidden': true, style: applyProviderIconShape(current.id, agentTriggerIconStyle) }),
      createElement('span', { style: agentTriggerLabelStyle }, current.name),
      createElement(NativeDropdownChevron, { open, locked }),
    ),
    open && !locked && createElement('div', { role: 'menu', 'aria-label': t('cli.selectAgent'), style: agentMenuStyle },
      ...agents.map((agent) => {
        const selected = agent.id === selection.adapterId
        const available = agent.installed && agent.enabled
        const icon = providerIconUrl(agent.id)
        return createElement('button', { key: agent.id, type: 'button', className: 'dsh-codingns-agent-option', role: 'menuitemradio', 'aria-checked': selected, 'data-selected': String(selected), disabled: !available, onClick: () => choose(agent), style: { ...agentOptionStyle, cursor: available ? 'pointer' : 'not-allowed', opacity: available ? 1 : 0.45 } },
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

const agentRootStyle = { position: 'relative' as const, minWidth: 0, display: 'inline-flex' }
const agentTriggerStyle = { height: 30, maxWidth: 220, minWidth: 0, color: dshThemeColor.labelPrimary, border: 0, borderRadius: 8, padding: '0 6px', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14, lineHeight: '20px' }
const agentTriggerIconStyle = { width: 20, height: 20, flex: '0 0 20px', objectFit: 'contain' as const }
const agentTriggerLabelStyle = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
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

function ModelSlot(props: CliSlotProps): ReactElement | null {
  // 语言词典中的中文值仍保留“正在加载模型列表…”语义，切换语言时由 t() 取值。
  const t = useCodingNsTranslator(props.locale)
  const session = props.useSession?.((value) => value)
  const sessionId = props.sessionId ?? session?.sessionId
  const [selection, update] = useSelection(sessionId, props.rpc)
  const [catalogState, setCatalogState] = useState<ModelCatalogState | null>(null)
  const [refreshingAdapterId, setRefreshingAdapterId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<ModelPane>('root')

  const catalog = catalogState?.adapterId === selection.adapterId ? catalogState.value : null
  // 目录必须和当前适配器绑定；切换后的第一次渲染立即进入加载态，不能短暂展示旧目录。
  const loading = selection.adapterId !== 'dsh'
    && (catalog === null || refreshingAdapterId === selection.adapterId)

  useEffect(() => {
    if (selection.adapterId === 'dsh') {
      setCatalogState(null)
      setRefreshingAdapterId(null)
      return
    }
    let active = true
    const adapterId = selection.adapterId
    setRefreshingAdapterId(adapterId)
    void callCliRpc<CodingNsCliModelCatalog>(props.rpc, 'models', { adapterId })
      .then((value) => {
        if (!active) return
        setCatalogState({ adapterId, value })
        const model = findModel(value, selection.modelId) ?? firstModel(value)
        if (model === undefined) return
        const effort = model.efforts.includes(selection.effortId ?? '') ? selection.effortId : defaultEffort(model.efforts)
        if (model.id !== selection.modelId || effort !== selection.effortId) update({ adapterId, modelId: model.id, ...(effort ? { effortId: effort } : {}) })
      })
      .catch(() => { if (active) setCatalogState({ adapterId, value: { groups: [], currentModel: null, currentEffort: null } }) })
      .finally(() => { if (active) setRefreshingAdapterId(null) })
    return () => { active = false }
  }, [props.rpc, selection.adapterId])

  useEffect(() => { if (selection.adapterId === 'dsh') setOpen(false) }, [selection.adapterId])

  if (selection.adapterId === 'dsh') return null

  const model = catalog === null ? undefined : findModel(catalog, selection.modelId) ?? firstModel(catalog)
  const efforts = model?.efforts ?? []
  const effortValue = selection.effortId ?? (efforts.length > 0 ? defaultEffort(efforts) : undefined) ?? 'default'
  const modelLabel = model?.name ?? (loading ? t('cli.loadingModel') : t('cli.noModelsAvailable'))
  const effortLabel = efforts.find((effort) => effort === effortValue) ?? 'Default'
  const modelUnavailable = model === undefined
  const triggerDisabled = !loading && modelUnavailable
  const chooseModel = (next: CodingNsCliModel): void => {
    const nextEffort = next.efforts.includes(effortValue) ? effortValue : defaultEffort(next.efforts)
    update({ adapterId: selection.adapterId, modelId: next.id, ...(nextEffort ? { effortId: nextEffort } : {}) })
    setOpen(false)
    setPane('root')
  }
  const chooseEffort = (effort: string): void => {
    if (model === undefined) return
    update({ adapterId: selection.adapterId, modelId: model.id, effortId: effort })
    setOpen(false)
    setPane('root')
  }
  const menu = loading
    ? [
        createElement('div', { key: 'loading', role: 'status', 'aria-live': 'polite', style: modelLoadingMenuStyle },
          createElement('span', { className: 'dsh-codingns-cli-spinner', 'aria-hidden': true, style: modelSpinnerStyle }),
          createElement('span', undefined, t('cli.loadingModel')),
        ),
      ]
    : pane === 'root'
      ? [
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
          createElement('div', { key: 'title', style: nativeGroupTitleStyle }, `${t('cli.thinking')}（${modelLabel}）`),
          ...(efforts.length > 0 ? efforts : ['default']).map((effort) => createElement('button', { key: effort, type: 'button', role: 'menuitemradio', 'aria-checked': effort === effortValue, onClick: () => chooseEffort(effort), style: nativeOptionStyle },
            createElement('span', { style: { flex: '1 1 auto' } }, effort === 'default' ? 'Default' : effort), effort === effortValue && createElement('span', { 'aria-hidden': true }, '✓'),
          )),
        ]
  return createElement('div', { style: { position: 'relative', minWidth: 0, display: 'inline-flex' } },
    createElement('button', { type: 'button', disabled: triggerDisabled, 'aria-label': t('cli.chooseModel', { model: modelLabel, effort: effortLabel }), 'aria-busy': loading, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => { setPane('root'); setOpen((value) => !value) }, style: nativeTriggerStyle },
      loading && createElement('span', { className: 'dsh-codingns-cli-spinner', 'aria-hidden': true, style: modelSpinnerStyle }),
      createElement('span', { role: loading ? 'status' : undefined, 'aria-live': loading ? 'polite' : undefined, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, modelLabel),
      !loading && createElement('span', { style: { color: dshThemeColor.labelCaption, whiteSpace: 'nowrap' } }, effortLabel),
      !loading && createElement(NativeDropdownChevron, { open }),
    ),
    open && createElement('div', { role: 'menu', 'aria-label': t('cli.chooseModelMenu'), style: nativeMenuStyle }, ...menu),
  )
}

const nativeTriggerStyle = { minWidth: 0, maxWidth: 'min(360px, 45cqw)', height: 28, color: dshThemeColor.labelSecondary, cursor: 'pointer', background: 'transparent', border: 0, borderRadius: 24, padding: '0 4px 0 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, lineHeight: '20px' }
const nativeMenuStyle = { ...dshPopupSurfaceStyle, position: 'absolute' as const, zIndex: 1100, right: 0, bottom: 'calc(100% + 8px)', minWidth: 240, maxWidth: 'min(420px, calc(100vw - 32px))', maxHeight: 'min(360px, calc(100vh - 96px))', overflowY: 'auto' as const, padding: 4, border: 0, borderRadius: 20 }
const nativeMenuCellStyle = { width: '100%', minHeight: 40, color: 'inherit', cursor: 'pointer', background: 'transparent', border: 0, borderRadius: 10, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' as const, fontSize: 14, lineHeight: '22px' }
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

export { AgentSlot, ModelSlot }
export type { SessionSnapshot }
