import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliModel,
  CodingNsCliModelCatalog,
  CodingNsCliSessionRecord,
} from '../../shared/contracts/cli-adapter.js'
import type { FeaturePanelProps, CodingNsClientFeatureModule } from './types.js'
import { registerCliConversationSlots } from '../cli-slots.js'
import { callCliRpc, errorMessage, listCliSessions, restoreCliSession } from '../cli-catalog.js'
import { dshButtonStyle, dshFormRootStyle, dshPopupSurfaceStyle, dshThemeColor } from '../theme.js'

/** 外部 Agent 集成模块。Agent 进程在 Host 运行，浏览器只读取目录和状态。 */
export const cliAdaptersFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'cliAdapters',
    version: '0.1.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '外部Agent集成',
      description: '查看外部 Agent 的安装状态、版本、命令路径和可用模型，并单独启用或停用。',
      order: 30,
      defaultOpen: true,
    },
  },
  start: (context) => {
    const slots = context.services.slots
    if (slots === undefined) return
    const disposeSlots = registerCliConversationSlots(slots, context.services.rpc)
    context.resources.add(disposeSlots)
  },
  settingsPanel: CliAdaptersPanel,
}

/** 设置页中的 Agent 列表和详情模态框。 */
export function CliAdaptersPanel({ services, enabled }: FeaturePanelProps): ReactElement {
  const [catalog, setCatalog] = useState<readonly CodingNsCliAdapterDescriptor[]>([])
  const [selected, setSelected] = useState<CodingNsCliAdapterDescriptor | null>(null)
  const [models, setModels] = useState<CodingNsCliModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyAdapterId, setBusyAdapterId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<readonly CodingNsCliSessionRecord[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const disabled = !enabled

  useEffect(() => {
    if (disabled) return
    let active = true
    setLoading(true)
    void callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(services.rpc, 'catalog', {})
      .then((value) => { if (active) setCatalog(value) })
      .catch((error: unknown) => { if (active) setMessage(errorMessage(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [disabled, services.rpc])

  useEffect(() => {
    if (disabled) {
      setSessions([])
      return
    }
    let active = true
    setSessionsLoading(true)
    void listCliSessions(services.rpc)
      .then((value) => { if (active) setSessions(value) })
      .catch((error: unknown) => { if (active) setMessage(errorMessage(error)) })
      .finally(() => { if (active) setSessionsLoading(false) })
    return () => { active = false }
  }, [disabled, services.rpc])

  useEffect(() => {
    if (selected === null || disabled || !selected.installed || !selected.enabled) {
      setModels(null)
      return
    }
    let active = true
    setModels(null)
    setMessage('')
    void callCliRpc<CodingNsCliModelCatalog>(services.rpc, 'models', { adapterId: selected.id })
      .then((value) => { if (active) setModels(value) })
      .catch((error: unknown) => { if (active) setMessage(errorMessage(error)) })
    return () => { active = false }
  }, [disabled, selected, services.rpc])

  const rowStyle = { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `1px solid ${dshThemeColor.border}` }
  const buttonStyle = { ...dshButtonStyle, padding: '7px 12px', borderRadius: '6px', cursor: disabled ? 'not-allowed' : 'pointer' }
  const toggleAdapter = async (adapter: CodingNsCliAdapterDescriptor, next: boolean): Promise<void> => {
    setBusyAdapterId(adapter.id)
    setMessage('')
    try {
      await callCliRpc(services.rpc, 'adapter/set', { adapterId: adapter.id, enabled: next })
      const refreshed = await callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(services.rpc, 'catalog', {})
      setCatalog(refreshed)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusyAdapterId(null)
    }
  }

  const restoreSession = async (record: CodingNsCliSessionRecord): Promise<void> => {
    setRestoringSessionId(record.dshSessionId)
    setMessage('')
    try {
      await restoreCliSession(services.rpc, record)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setRestoringSessionId(null)
    }
  }

  return createElement(
    'div',
    { 'aria-disabled': disabled, style: { ...dshFormRootStyle, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' } },
    loading && createElement('div', { role: 'status' }, '正在读取外部 Agent 状态…'),
    !loading && catalog.length === 0 && createElement('div', { role: 'status', style: { opacity: 0.7 } }, '当前没有可用的外部 Agent。'),
    createElement('div', undefined,
      ...catalog.map((adapter) => createElement('div', { key: adapter.id, style: rowStyle },
        createElement('button', {
          type: 'button',
          onClick: () => setSelected(adapter),
          style: { flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, padding: 0, border: 0, color: 'inherit', textAlign: 'left', background: 'transparent', cursor: 'pointer' },
          'aria-label': `查看 ${adapter.name} 详情`,
        },
          createElement('span', { style: { flex: '1 1 auto', minWidth: 0, fontWeight: 600 } }, adapter.name),
          createElement('span', { style: { color: adapter.installed ? dshThemeColor.success : dshThemeColor.labelTertiary } }, adapter.installed ? '已安装' : '未安装'),
          createElement('span', { style: { minWidth: 70, color: dshThemeColor.labelTertiary } }, adapter.version ?? '未检测到版本'),
        ),
        createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' } },
          createElement('input', { type: 'checkbox', role: 'switch', 'aria-label': `${adapter.name}启用开关`, checked: adapter.enabled, disabled: !adapter.installed || busyAdapterId === adapter.id, onChange: (event: { currentTarget: { checked: boolean } }) => { void toggleAdapter(adapter, event.currentTarget.checked) }, style: { accentColor: dshThemeColor.accent } }),
          createElement('span', undefined, adapter.enabled ? '已启用' : '已停用'),
        ),
      )),
    ),
    createElement(CliSessionList, {
      sessions,
      loading: sessionsLoading,
      restoringSessionId,
      onRestore: (record) => { void restoreSession(record) },
    }),
    message && createElement('div', { role: 'alert', style: { marginTop: 10, color: dshThemeColor.error } }, message),
    selected !== null && createElement(AdapterDetailsDialog, {
      adapter: selected,
      models,
      loading: selected.installed && selected.enabled && models === null && !message,
      onClose: () => setSelected(null),
      buttonStyle,
    }),
  )
}

interface CliSessionListProps {
  readonly sessions: readonly CodingNsCliSessionRecord[]
  readonly loading: boolean
  readonly restoringSessionId: string | null
  readonly onRestore: (record: CodingNsCliSessionRecord) => void
}

/** 外部会话索引入口；打开后交给 DSH 原生会话页面渲染消息。 */
function CliSessionList({ sessions, loading, restoringSessionId, onRestore }: CliSessionListProps): ReactElement {
  return createElement('section', { 'aria-labelledby': 'codingns-cli-session-title', style: { marginTop: 20 } },
    createElement('h4', { id: 'codingns-cli-session-title', style: { margin: '0 0 8px' } }, '外部 Agent 会话'),
    loading && createElement('div', { role: 'status' }, '正在读取外部会话…'),
    !loading && sessions.length === 0 && createElement('div', { style: { opacity: 0.7 } }, '尚未创建外部 Agent 会话。'),
    !loading && sessions.length > 0 && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      ...sessions.map((record) => createElement('div', {
        key: record.dshSessionId,
        style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${dshThemeColor.border}` },
      },
        createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          createElement('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }, record.title ?? `${record.adapterId} 会话`),
          createElement('div', { style: { marginTop: 2, opacity: 0.65, fontSize: 12 } }, `${record.adapterId} · ${sessionStatusLabel(record.status)}`),
        ),
        createElement('button', {
          type: 'button',
          onClick: () => onRestore(record),
          disabled: restoringSessionId !== null,
          'aria-label': `打开${record.title ?? `${record.adapterId} 会话`}`,
          style: { ...dshButtonStyle, flex: '0 0 auto', padding: '6px 10px', borderRadius: 6, cursor: restoringSessionId === null ? 'pointer' : 'not-allowed' },
        }, restoringSessionId === record.dshSessionId ? '打开中…' : '打开'),
      )),
    ),
  )
}

function sessionStatusLabel(status: CodingNsCliSessionRecord['status']): string {
  if (status === 'active') return '运行中'
  if (status === 'error') return '异常'
  if (status === 'archived') return '已归档'
  return '已暂停'
}

interface AdapterDetailsDialogProps {
  readonly adapter: CodingNsCliAdapterDescriptor
  readonly models: CodingNsCliModelCatalog | null
  readonly loading: boolean
  readonly onClose: () => void
  readonly buttonStyle: CSSProperties
}

function AdapterDetailsDialog({ adapter, models, loading, onClose, buttonStyle }: AdapterDetailsDialogProps): ReactElement {
  return createElement('div', {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': 'codingns-cli-adapter-title',
    style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: dshThemeColor.overlay },
  },
    createElement('div', { style: { ...dshPopupSurfaceStyle, width: 'min(100%, 620px)', maxHeight: 'min(720px, 90vh)', overflow: 'auto', boxSizing: 'border-box', padding: 24, borderRadius: 8 } },
      createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
        createElement('h3', { id: 'codingns-cli-adapter-title', style: { margin: 0, fontSize: 18 } }, adapter.name),
      createElement('button', { type: 'button', onClick: onClose, style: buttonStyle, 'aria-label': '关闭 Agent 详情' }, '关闭'),
      ),
      createElement('dl', { style: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', margin: '20px 0' } },
        createElement('dt', undefined, '安装状态'), createElement('dd', { style: { margin: 0 } }, adapter.installed ? '已安装' : '未安装'),
        createElement('dt', undefined, '启用状态'), createElement('dd', { style: { margin: 0 } }, adapter.enabled ? '已启用' : '已停用'),
        createElement('dt', undefined, '版本'), createElement('dd', { style: { margin: 0 } }, adapter.version ?? '未检测到版本'),
        createElement('dt', undefined, '命令路径'), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, adapter.command ?? '未检测到命令'),
        createElement('dt', undefined, '标准协议'), createElement('dd', { style: { margin: 0 } }, adapter.protocol ?? '未声明'),
        createElement('dt', undefined, '已验证能力'), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, adapter.capabilities?.join('、') ?? '未声明'),
      ),
      createElement('h4', { style: { margin: '16px 0 8px' } }, '模型目录'),
      !adapter.installed && createElement('div', { style: { opacity: 0.7 } }, 'Agent 未安装，无法读取模型目录。'),
      adapter.installed && !adapter.enabled && createElement('div', { style: { opacity: 0.7 } }, 'Agent 已停用，启用后才能读取模型目录。'),
      adapter.installed && loading && createElement('div', { role: 'status' }, '正在读取模型目录…'),
      adapter.installed && !loading && models !== null && createElement(ModelCatalog, { catalog: models }),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 20 } },
        createElement('button', { type: 'button', onClick: onClose, style: buttonStyle }, '完成'),
      ),
    ),
  )
}

function ModelCatalog({ catalog }: { readonly catalog: CodingNsCliModelCatalog }): ReactElement {
  if (catalog.groups.length === 0) return createElement('div', { style: { opacity: 0.7 } }, '没有读取到模型。')
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
    ...catalog.groups.map((group) => createElement('section', { key: group.id },
      createElement('strong', undefined, group.name),
      createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
        ...group.models.map((model) => createElement(ModelRow, { key: model.id, model })),
      ),
    )),
  )
}

function ModelRow({ model }: { readonly model: CodingNsCliModel }): ReactElement {
  return createElement('div', { style: { padding: '8px 10px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 6 } },
    createElement('div', { style: { fontWeight: 600 } }, model.name),
    model.description && createElement('div', { style: { marginTop: 3, opacity: 0.7, fontSize: 13 } }, model.description),
    createElement('div', { style: { marginTop: 5, opacity: 0.7, fontSize: 13 } }, `思考等级：${model.efforts.length > 0 ? model.efforts.join('、') : '默认'}`),
  )
}
