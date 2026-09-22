import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsCliAdapterDescriptor, CodingNsCliModel, CodingNsCliModelCatalog, CodingNsCliSessionConfig } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { adapterCatalogWithDsh, callCliRpc, findModel, firstModel } from './cli-catalog.js'
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
  const triggerStyle = { height: 30, maxWidth: 230, border: 0, borderRadius: 16, padding: '0 8px', background: 'transparent', cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.7 : 1 }
  return createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
    createElement('button', { type: 'button', disabled: locked, onClick: () => setOpen((value) => !value), 'aria-label': `当前 Agent：${current.name}${locked ? '（已锁定）' : ''}`, 'aria-expanded': open, style: triggerStyle }, `${current.name}${locked ? '（已锁定）' : '⌄'}`),
    open && !locked && createElement('div', { role: 'menu', style: { position: 'absolute', zIndex: 1100, bottom: 'calc(100% + 8px)', left: 0, minWidth: 250, padding: 6, borderRadius: 8, background: 'var(--dsw-specific-menu, #fff)', boxShadow: '0 8px 28px rgba(0,0,0,.22)' } },
      ...agents.map((agent) => createElement('button', { key: agent.id, type: 'button', role: 'menuitemradio', 'aria-checked': agent.id === selection.adapterId, disabled: !agent.installed || !agent.enabled, onClick: () => choose(agent), style: { display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12, padding: '8px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: agent.installed && agent.enabled ? 'pointer' : 'not-allowed', opacity: agent.installed && agent.enabled ? 1 : 0.45 } },
        createElement('span', undefined, agent.name),
        createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, !agent.installed ? '未安装' : !agent.enabled ? '已停用' : (agent.id === selection.adapterId ? '当前' : '已启用')),
      )),
    ),
  )
}

function ModelSlot(props: CliSlotProps): ReactElement | null {
  const session = props.useSession?.((value) => value)
  const sessionId = props.sessionId ?? session?.sessionId
  const [selection, update] = useSelection(sessionId, props.rpc)
  const [catalog, setCatalog] = useState<CodingNsCliModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)

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

  if (selection.adapterId === 'dsh') return null

  const model = catalog === null ? undefined : findModel(catalog, selection.modelId) ?? firstModel(catalog)
  const efforts = model?.efforts ?? []
  const effortValue = selection.effortId ?? (efforts.length > 0 ? defaultEffort(efforts) : 'default')
  const selectStyle = { height: 30, maxWidth: 220, border: 0, borderRadius: 16, padding: '0 8px', background: 'transparent', color: 'inherit' }
  return createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
    createElement('select', { value: model?.id ?? '', disabled: loading || model === undefined, 'aria-label': '选择模型', onChange: (event: { currentTarget: { value: string } }) => { const next = findModel(catalog!, event.currentTarget.value); if (next) { const nextEffort = defaultEffort(next.efforts); update({ adapterId: selection.adapterId, modelId: next.id, ...(nextEffort === undefined ? {} : { effortId: nextEffort }) }) } }, style: selectStyle },
      model === undefined && createElement('option', { value: '' }, loading ? '加载模型…' : '无可用模型'),
      catalog?.groups.flatMap((group) => group.models.map((item) => createElement('option', { key: `${group.id}:${item.id}`, value: item.id }, `${group.name} / ${item.name}`))) ?? [],
    ),
    createElement('select', { value: effortValue, disabled: loading || model === undefined, 'aria-label': '选择思考强度', onChange: (event: { currentTarget: { value: string } }) => update({ adapterId: selection.adapterId, ...(model ? { modelId: model.id } : {}), effortId: event.currentTarget.value }), style: { ...selectStyle, maxWidth: 130 } },
      efforts.length > 0 ? efforts.map((effort) => createElement('option', { key: effort, value: effort }, effort)) : createElement('option', { value: 'default' }, '默认'),
    ),
  )
}

function defaultEffort(efforts: readonly string[]): string | undefined {
  if (efforts.length === 0) return undefined
  return efforts.length > 2 ? efforts[efforts.length - 2] : efforts[efforts.length - 1]
}

export { AgentSlot, ModelSlot }
export type { SessionSnapshot }
