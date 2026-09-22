import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsCliAdapterDescriptor, CodingNsCliModel, CodingNsCliModelCatalog, CodingNsCliSessionConfig } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { adapterCatalogWithDsh, callCliRpc, findModel, firstModel } from './cli-catalog.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'

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
    'conversation.input.left': { kind: 'list'; scope: 'session' }
    'conversation.input.right': { kind: 'list'; scope: 'session' }
  }
  interface SessionStandardProps {
    sessionId: string
    useSession: SessionSelector
  }
}

const CLI_STYLE_ID = 'dsh-codingns-cli-composer-style'

function installComposerStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${CLI_STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-codingns'
  style.dataset.pluginCss = CLI_STYLE_ID
  style.textContent = [
    'html[data-codingns-agent]:not([data-codingns-agent="dsh"]) [data-slot="conversation.input.model"],',
    'body[data-codingns-agent]:not([data-codingns-agent="dsh"]) [data-slot="conversation.input.model"]{display:none!important}',
  ].join('')
  document.head.appendChild(style)
}

interface CliSlotProps {
  readonly sessionId?: string
  readonly useSession?: SessionSelector
  readonly rpc: CodingNsRpcClient
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
  for (const listener of selectionListeners.get(sessionId) ?? []) listener()
}

/** 注册对话输入左右两侧的 Agent 与模型/思考等级选择器。 */
export function registerCliConversationSlots(slots: SlotRegistry, rpc: CodingNsRpcClient): () => void {
  installComposerStyles()
  const disposeLeft = slots.inject('conversation.input.left', () => slots.register({
    name: 'conversation.input.left',
    id: 'dsh-codingns-agent',
    order: 0,
    label: 'Agent 选择器',
    inject: (sessionId) => ({ rpc, sessionId }),
  }, AgentSlot))
  const disposeRight = slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'dsh-codingns-model',
    order: 0,
    label: '模型与思考强度选择器',
    inject: (sessionId) => ({ rpc, sessionId }),
  }, ModelSlot))
  return () => {
    disposeRight()
    disposeLeft()
  }
}

function AgentSlot(props: CliSlotProps): ReactElement {
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
  const triggerStyle = { height: 30, maxWidth: 230, color: dshThemeColor.labelPrimary, border: 0, borderRadius: 16, padding: '0 8px', background: 'transparent', cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.7 : 1 }
  return createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
    createElement('button', { type: 'button', disabled: locked, onClick: () => setOpen((value) => !value), 'aria-label': `当前 Agent：${current.name}${locked ? '（已锁定）' : ''}`, 'aria-expanded': open, style: triggerStyle }, `${current.name}${locked ? '（已锁定）' : '⌄'}`),
    open && !locked && createElement('div', { role: 'menu', style: { ...dshPopupSurfaceStyle, position: 'absolute', zIndex: 1100, bottom: 'calc(100% + 8px)', left: 0, minWidth: 250, padding: 6, borderRadius: 8 } },
      ...agents.map((agent) => createElement('button', { key: agent.id, type: 'button', role: 'menuitemradio', 'aria-checked': agent.id === selection.adapterId, disabled: !agent.installed || !agent.enabled, onClick: () => choose(agent), style: { display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12, padding: '8px 10px', color: 'inherit', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: agent.installed && agent.enabled ? 'pointer' : 'not-allowed', opacity: agent.installed && agent.enabled ? 1 : 0.45 } },
        createElement('span', undefined, agent.name),
        createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, !agent.installed ? '未安装' : !agent.enabled ? '已停用' : (agent.id === selection.adapterId ? '当前' : '已启用')),
      )),
    ),
  )
}

type ModelPane = 'root' | 'model' | 'effort'

function ModelSlot(props: CliSlotProps): ReactElement | null {
  const session = props.useSession?.((value) => value)
  const sessionId = props.sessionId ?? session?.sessionId
  const [selection, update] = useSelection(sessionId, props.rpc)
  const [catalog, setCatalog] = useState<CodingNsCliModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<ModelPane>('root')

  useEffect(() => {
    if (selection.adapterId === 'dsh') {
      setCatalog(null)
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    void callCliRpc<CodingNsCliModelCatalog>(props.rpc, 'models', { adapterId: selection.adapterId })
      .then((value) => {
        if (!active) return
        setCatalog(value)
        const model = findModel(value, selection.modelId) ?? firstModel(value)
        if (model === undefined) return
        const effort = model.efforts.includes(selection.effortId ?? '') ? selection.effortId : defaultEffort(model.efforts)
        if (model.id !== selection.modelId || effort !== selection.effortId) update({ adapterId: selection.adapterId, modelId: model.id, ...(effort ? { effortId: effort } : {}) })
      })
      .catch(() => { if (active) setCatalog({ groups: [], currentModel: null, currentEffort: null }) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [props.rpc, selection.adapterId])

  useEffect(() => { if (selection.adapterId === 'dsh' || loading) setOpen(false) }, [loading, selection.adapterId])

  if (selection.adapterId === 'dsh') return null

  const model = catalog === null ? undefined : findModel(catalog, selection.modelId) ?? firstModel(catalog)
  const efforts = model?.efforts ?? []
  const effortValue = selection.effortId ?? (efforts.length > 0 ? defaultEffort(efforts) : undefined) ?? 'default'
  const modelLabel = model?.name ?? (loading ? '加载模型…' : '无可用模型')
  const effortLabel = efforts.find((effort) => effort === effortValue) ?? 'Default'
  const disabled = loading || model === undefined
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
  const menu = pane === 'root'
      ? [
          createElement('button', { key: 'model', type: 'button', role: 'menuitem', disabled, onClick: () => setPane('model'), style: nativeMenuCellStyle },
          createElement('span', { style: nativeMenuLabelStyle }, '模型'), createElement('span', { style: nativeMenuValueStyle }, modelLabel), createElement('span', { 'aria-hidden': true, style: nativeChevronStyle }, '›')),
        createElement('button', { key: 'effort', type: 'button', role: 'menuitem', disabled, onClick: () => setPane('effort'), style: nativeMenuCellStyle },
          createElement('span', undefined, '思考等级'), createElement('span', { style: nativeMenuValueStyle }, effortLabel), createElement('span', { 'aria-hidden': true, style: nativeChevronStyle }, '›')),
      ]
    : pane === 'model'
      ? [
          createElement('button', { key: 'back', type: 'button', onClick: () => setPane('root'), style: nativeBackStyle }, '‹ 返回'),
          ...((catalog?.groups ?? []).map((group) => createElement('section', { key: group.id, role: 'group', 'aria-label': group.name, style: { marginTop: 4 } },
            createElement('div', { style: nativeGroupTitleStyle }, group.name),
            ...group.models.map((item) => createElement('button', { key: `${group.id}:${item.id}`, type: 'button', role: 'menuitemradio', 'aria-checked': item.id === model?.id, onClick: () => chooseModel(item), style: nativeOptionStyle },
              createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
              item.id === model?.id && createElement('span', { 'aria-hidden': true }, '✓'),
            )),
          )))
        ]
      : [
          createElement('button', { key: 'back', type: 'button', onClick: () => setPane('root'), style: nativeBackStyle }, '‹ 返回'),
          createElement('div', { key: 'title', style: nativeGroupTitleStyle }, `思考等级（${modelLabel}）`),
          ...(efforts.length > 0 ? efforts : ['default']).map((effort) => createElement('button', { key: effort, type: 'button', role: 'menuitemradio', 'aria-checked': effort === effortValue, onClick: () => chooseEffort(effort), style: nativeOptionStyle },
            createElement('span', { style: { flex: '1 1 auto' } }, effort === 'default' ? 'Default' : effort), effort === effortValue && createElement('span', { 'aria-hidden': true }, '✓'),
          )),
        ]
  return createElement('div', { style: { position: 'relative', minWidth: 0, display: 'inline-flex' } },
    createElement('button', { type: 'button', disabled, 'aria-label': `选择模型，当前 ${modelLabel}，思考等级 ${effortLabel}`, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => { setPane('root'); setOpen((value) => !value) }, style: nativeTriggerStyle },
      createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, modelLabel),
      createElement('span', { style: { color: dshThemeColor.labelCaption, whiteSpace: 'nowrap' } }, effortLabel),
      createElement('span', { 'aria-hidden': true, style: { color: dshThemeColor.labelCaption, transform: open ? 'rotate(180deg)' : undefined } }, '⌄'),
    ),
    open && createElement('div', { role: 'menu', 'aria-label': '模型与思考等级', style: nativeMenuStyle }, ...menu),
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

function defaultEffort(efforts: readonly string[]): string | undefined {
  if (efforts.length === 0) return undefined
  return efforts.length > 2 ? efforts[efforts.length - 2] : efforts[efforts.length - 1]
}

export { AgentSlot, ModelSlot }
export type { SessionSnapshot }
