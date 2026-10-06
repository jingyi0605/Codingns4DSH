import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliModel,
  CodingNsCliModelCatalog,
} from '../../shared/contracts/cli-adapter.js'
import type { FeaturePanelProps, CodingNsClientFeatureModule } from './types.js'
import { normalizeSubagentBridgeSettings, SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS } from '../../shared/contracts/config.js'
import { callCliRpc, errorMessage } from '../cli-catalog.js'
import { dshFormRootStyle, dshPopupSurfaceStyle, dshSettingsButtonStyle, dshSettingsFieldStyle, dshSettingsHelpStyle, dshSettingsListRowStyle, dshThemeColor } from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'
import { backdropPointerDownHandler } from '../popup-dismiss.js'
import { registerExternalToolStreamUi } from '../external-tool-stream.js'
import { startContextBreakdownDom } from '../context-breakdown-dom.js'
import { fetchSessionAdapters, replaceSessionAdapters, sessionAdapterId } from '../session-adapter-cache.js'
import { providerIconUrl } from '../provider-icons.js'

const CLI_ADAPTER_STYLE_ID = 'codingns4dsh-cli-adapter-settings-style'
const cliAdapterClass = {
  panel: 'codingns4dsh-cli-adapter-panel',
  listHeader: 'codingns4dsh-cli-adapter-list-header',
  listCard: 'codingns4dsh-cli-adapter-list-card',
  row: 'codingns4dsh-cli-adapter-row',
  main: 'codingns4dsh-cli-adapter-main',
  identity: 'codingns4dsh-cli-adapter-identity',
  icon: 'codingns4dsh-cli-adapter-icon',
  name: 'codingns4dsh-cli-adapter-name',
  metadata: 'codingns4dsh-cli-adapter-metadata',
  status: 'codingns4dsh-cli-adapter-status',
  version: 'codingns4dsh-cli-adapter-version',
  toggle: 'codingns4dsh-cli-adapter-toggle',
} as const

/** 设置页 Agent 行的响应式布局；内联样式无法表达移动端换行规则，因此集中注入。 */
function installCliAdapterStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${CLI_ADAPTER_STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = CLI_ADAPTER_STYLE_ID
  style.textContent = `
.${cliAdapterClass.panel}{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0}
.${cliAdapterClass.listCard}{overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:14px;background:var(--dsw-alias-bg-layer-1,Canvas);box-shadow:0 1px 3px rgba(15,23,42,.04)}
.${cliAdapterClass.listHeader}{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 6px 10px;color:var(--dsw-alias-label-tertiary,GrayText);border-bottom:1px solid var(--dsw-alias-border-l4,#eef0f2);font-size:13px;font-weight:600;letter-spacing:.02em}
.${cliAdapterClass.row}{display:flex;align-items:center;width:100%;min-width:0;min-height:76px;gap:16px;padding:13px 18px;box-sizing:border-box;background:transparent}
.${cliAdapterClass.row}+.${cliAdapterClass.row}{border-top:1px solid var(--dsw-alias-border-l4,#eef0f2)}
.${cliAdapterClass.main}{display:flex;align-items:center;gap:13px;flex:1 1 auto;min-width:0}
.${cliAdapterClass.identity}{display:flex;flex-direction:column;justify-content:center;gap:5px;min-width:0}
.${cliAdapterClass.icon}{display:inline-flex;align-items:center;justify-content:center;flex:0 0 44px;width:44px;height:44px;padding:7px;box-sizing:border-box;object-fit:contain;border:1px solid var(--dsw-alias-border-l4,#eef0f2);border-radius:12px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06)))}
.${cliAdapterClass.name}{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:1.25}
.${cliAdapterClass.metadata}{display:inline-flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px;line-height:1.2}
.${cliAdapterClass.status},.${cliAdapterClass.version}{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${cliAdapterClass.status}{padding:3px 7px;border-radius:5px;background:var(--dsw-alias-state-success-bg,rgba(22,163,74,.12))}
.${cliAdapterClass.toggle}{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;color:var(--dsw-alias-label-secondary,GrayText);font-size:13px;font-weight:500}
.${cliAdapterClass.toggle} input{width:18px;height:18px;margin:0;accent-color:var(--dsw-alias-state-success-primary,#16a34a)}
@media (max-width:768px){
  .${cliAdapterClass.row}{display:grid!important;grid-template-columns:minmax(0,1fr) auto;align-items:center!important;gap:7px 10px!important;min-height:0!important;padding:12px 14px!important}
  .${cliAdapterClass.main}{grid-column:1 / -1;display:flex!important;align-items:center!important;width:100%;gap:10px!important}
  .${cliAdapterClass.identity}{gap:4px}
  .${cliAdapterClass.name}{white-space:normal;overflow-wrap:anywhere;text-overflow:clip}
  .${cliAdapterClass.metadata}{grid-column:1;grid-row:2;display:flex;flex-wrap:wrap;gap:7px!important;min-width:0;max-width:100%}
  .${cliAdapterClass.status},.${cliAdapterClass.version}{max-width:100%;min-width:0!important}
  .${cliAdapterClass.toggle}{grid-column:2;grid-row:2;justify-self:end;align-self:center;min-width:0;max-width:100%;white-space:nowrap}
  .${cliAdapterClass.toggle} span{max-width:7em;overflow:hidden;text-overflow:ellipsis}
}
`
  document.head.appendChild(style)
}

/** 外部 Agent 集成模块。Agent 进程在 Host 运行，浏览器只读取目录和状态。 */
export const cliAdaptersFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'cliAdapters',
    version: '0.1.1',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: 'External Agent integration',
      description: 'View installed external Agents, versions, command paths, available models, and enable them independently. External Agent context panels keep only the occupancy percentage and totals.',
      labelKey: 'feature.cliAdapters.label',
      descriptionKey: 'feature.cliAdapters.description',
      order: 30,
      defaultOpen: false,
    },
  },
  start: async (context) => {
    // 外部 Agent 的上下文由 Agent 自己组装，上下文面板的启发式构成与真实用量
    // 不同源；对这类适配器的会话隐藏构成明细，只保留百分比与总量。
    const contextBreakdownDom = startContextBreakdownDom({
      adapterIdForSession: sessionAdapterId,
      refreshAdapters: async () => {
        replaceSessionAdapters(await fetchSessionAdapters(context.services.rpc))
      },
    })
    context.resources.add(() => contextBreakdownDom.dispose())
    // `/委派` 只依赖 DSH 的 commandUi 契约；服务缺失时该模块内部降级为不注册，
    // 因此这里不把它挂在 slots 可用性之后。
    const uiContext = context.services.uiContext
    if (uiContext !== undefined) {
      const { registerDelegateCommand } = await import('../delegate-command.js')
      context.resources.add(registerDelegateCommand(uiContext, {
        rpc: context.services.rpc,
        locale: context.services.locale,
        dshVersion: context.services.dshVersion,
      }))
    }
    const slots = context.services.slots
    if (slots === undefined) return
    context.resources.add(registerExternalToolStreamUi(context.services))
    // CLI Slot 带有浏览器图片资源，启用模块时再加载，避免 Node 侧读取 Client 元数据时解析图片。
    const { registerCliConversationSlots } = await import('../cli-slots.js')
    const disposeSlots = registerCliConversationSlots(slots, context.services.rpc, context.services.locale)
    context.resources.add(disposeSlots)
  },
  settingsPanel: CliAdaptersPanel,
}

/**
 * 设置页中的 Agent 列表和详情模态框。
 *
 * 面板只管理 Agent 本身：安装状态、版本、命令、启用开关与模型目录。外部会话由
 * DSH 原生侧栏和工作区归档入口承载，这里不再重复一份会话列表。
 */
export function CliAdaptersPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [catalog, setCatalog] = useState<readonly CodingNsCliAdapterDescriptor[]>([])
  const [selected, setSelected] = useState<CodingNsCliAdapterDescriptor | null>(null)
  const [models, setModels] = useState<CodingNsCliModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyAdapterId, setBusyAdapterId] = useState<string | null>(null)
  const [bridgeBusy, setBridgeBusy] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const disabled = !enabled

  useEffect(() => { installCliAdapterStyles() }, [])

  useEffect(() => {
    if (disabled) return
    let active = true
    setLoading(true)
    void callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(services.rpc, 'catalog', {})
      .then((value) => { if (active) setCatalog(value) })
      .catch((error: unknown) => { if (active) notify({ kind: 'error', message: errorMessage(error) }) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [disabled, services.rpc])

  useEffect(() => {
    if (selected === null || disabled || !selected.installed || !selected.enabled) {
      setModels(null)
      return
    }
    let active = true
    setModels(null)
    setModelsError('')
    void callCliRpc<CodingNsCliModelCatalog>(services.rpc, 'models', { adapterId: selected.id })
      .then((value) => { if (active) setModels(value) })
      .catch((error: unknown) => { if (active) { const message = errorMessage(error); setModelsError(message); notify({ kind: 'error', message }) } })
    return () => { active = false }
  }, [disabled, selected, services.rpc])

  const buttonStyle = { ...dshSettingsButtonStyle, cursor: disabled ? 'not-allowed' : 'pointer' }
  const bridgeEnabled = snapshot.value?.subagentBridge?.enabled === true
  const bridgeWritable = snapshot.status !== 'loading' && snapshot.writable
  const bridgeConcurrency = normalizeSubagentBridgeSettings(snapshot.value?.subagentBridge).maxConcurrentSubagents
  const [concurrencyText, setConcurrencyText] = useState(() => String(bridgeConcurrency))
  // 设置被外部改写（例如另一个页面保存）时同步输入框，但不在用户输入过程中反复覆盖。
  useEffect(() => { setConcurrencyText(String(bridgeConcurrency)) }, [bridgeConcurrency])
  const toggleSubagentBridge = async (next: boolean): Promise<void> => {
    setBridgeBusy(true)
    try {
      const accepted = await services.settings.mutate([{ op: 'set', path: ['subagentBridge', 'enabled'], value: next }])
      if (!accepted) {
        notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
        return
      }
      notify({ kind: 'success', message: t(next ? 'cli.subagentBridgeEnabled' : 'cli.subagentBridgeDisabled') })
    } catch (error) {
      notify({ kind: 'error', message: errorMessage(error) })
    } finally {
      setBridgeBusy(false)
    }
  }
  const saveBridgeConcurrency = async (): Promise<void> => {
    // 越界或非数值输入按上下限收敛，避免把 NaN/0 写进设置后彻底锁死派发。
    const next = normalizeSubagentBridgeSettings({ maxConcurrentSubagents: Number(concurrencyText) }).maxConcurrentSubagents
    setConcurrencyText(String(next))
    if (next === bridgeConcurrency) return
    setBridgeBusy(true)
    try {
      const accepted = await services.settings.mutate([{ op: 'set', path: ['subagentBridge', 'maxConcurrentSubagents'], value: next }])
      if (!accepted) {
        notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
        return
      }
      notify({ kind: 'success', message: t('cli.subagentBridgeConcurrencySaved') })
    } catch (error) {
      notify({ kind: 'error', message: errorMessage(error) })
    } finally {
      setBridgeBusy(false)
    }
  }
  const toggleAdapter = async (adapter: CodingNsCliAdapterDescriptor, next: boolean): Promise<void> => {
    setBusyAdapterId(adapter.id)
    try {
      await callCliRpc(services.rpc, 'adapter/set', { adapterId: adapter.id, enabled: next })
      const refreshed = await callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(services.rpc, 'catalog', {})
      setCatalog(refreshed)
      notify({ kind: 'success', message: t(next ? 'cli.adapterEnabled' : 'cli.adapterDisabled', { name: adapter.name }) })
    } catch (error) {
      notify({ kind: 'error', message: errorMessage(error) })
    } finally {
      setBusyAdapterId(null)
    }
  }

  return createElement(
    'div',
    { className: cliAdapterClass.panel, 'aria-disabled': disabled, style: { ...dshFormRootStyle, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' } },
    createElement('label', { style: dshSettingsListRowStyle },
      createElement('span', { style: { flex: '1 1 auto', minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('cli.subagentBridge')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle, opacity: 0.75 } }, t('cli.subagentBridgeDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('cli.subagentBridgeToggle'),
        checked: bridgeEnabled,
        disabled: !bridgeWritable || bridgeBusy,
        onChange: (event: { currentTarget: { checked: boolean } }) => { void toggleSubagentBridge(event.currentTarget.checked) },
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', { style: { ...dshSettingsListRowStyle, opacity: bridgeEnabled ? 1 : 0.5 } },
      createElement('span', { style: { flex: '1 1 auto', minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('cli.subagentBridgeConcurrency')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle, opacity: 0.75 } }, t('cli.subagentBridgeConcurrencyHelp')),
      ),
      createElement('input', {
        type: 'number',
        min: SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS.min,
        max: SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS.max,
        'aria-label': t('cli.subagentBridgeConcurrency'),
        value: concurrencyText,
        disabled: !bridgeWritable || bridgeBusy,
        onChange: (event: { currentTarget: { value: string } }) => { setConcurrencyText(event.currentTarget.value) },
        onBlur: () => { void saveBridgeConcurrency() },
        style: { ...dshSettingsFieldStyle, flex: '0 0 auto', width: 96, minHeight: 32, padding: '5px 8px', fontSize: 13 },
      }),
    ),
    loading && createElement('div', { role: 'status' }, t('cli.readingAgents')),
    !loading && catalog.length === 0 && createElement('div', { role: 'status', style: { opacity: 0.7 } }, t('cli.noAgents')),
    createElement('div', { className: cliAdapterClass.listHeader },
      createElement('span', undefined, t('cli.agentList')),
      catalog.length > 0 && createElement('span', undefined, t('cli.agentCount', { count: catalog.length })),
    ),
    createElement('div', { className: cliAdapterClass.listCard },
      ...catalog.map((adapter) => createElement('div', { key: adapter.id, className: cliAdapterClass.row },
        createElement('button', {
          type: 'button',
          className: cliAdapterClass.main,
          onClick: () => setSelected(adapter),
          style: { flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, padding: 0, border: 0, color: 'inherit', textAlign: 'left', background: 'transparent', cursor: 'pointer' },
          'aria-label': t('cli.viewDetails', { name: adapter.name }),
        },
          createElement(AdapterIcon, { adapter }),
          createElement('div', { className: cliAdapterClass.identity },
            createElement('span', { className: cliAdapterClass.name, style: { fontWeight: 600 } }, adapter.name),
            createElement('div', { className: cliAdapterClass.metadata },
              createElement('span', { className: cliAdapterClass.status, style: { color: adapter.installed ? dshThemeColor.success : dshThemeColor.labelTertiary, background: adapter.installed ? 'rgba(22,163,74,.12)' : dshThemeColor.surfaceSubtle } }, adapter.installed ? t('cli.installed') : t('cli.notInstalled')),
              createElement('span', { className: cliAdapterClass.version }, adapter.version ?? t('cli.notDetectedVersion')),
            ),
          ),
        ),
        createElement('label', { className: cliAdapterClass.toggle, style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' } },
          createElement('input', { type: 'checkbox', role: 'switch', 'aria-label': t('cli.adapterToggle', { name: adapter.name }), checked: adapter.enabled, disabled: !adapter.installed || busyAdapterId === adapter.id, onChange: (event: { currentTarget: { checked: boolean } }) => { void toggleAdapter(adapter, event.currentTarget.checked) }, style: { accentColor: dshThemeColor.accent } }),
          createElement('span', undefined, adapter.enabled ? t('cli.enabled') : t('cli.disabled')),
        ),
      )),
    ),
    selected !== null && createElement(AdapterDetailsDialog, {
      adapter: selected,
      models,
      loading: selected.installed && selected.enabled && models === null && modelsError === '',
      onClose: () => setSelected(null),
      buttonStyle,
      t,
    }),
  )
}

const CIRCULAR_ADAPTER_ICON_IDS = new Set(['gemini', 'grok'])

/** 设置页列表中的 Agent logo；资产缺失时用首字母占位，避免出现破图或空白。 */
function AdapterIcon({ adapter }: { readonly adapter: CodingNsCliAdapterDescriptor }): ReactElement {
  const icon = providerIconUrl(adapter.id)
  if (icon === undefined) {
    return createElement('span', {
      className: cliAdapterClass.icon,
      'aria-hidden': true,
      style: { borderRadius: 6, background: dshThemeColor.surfaceSubtle, color: dshThemeColor.labelSecondary, fontSize: 12, fontWeight: 700 },
    }, adapter.name.trim().charAt(0).toUpperCase() || '?')
  }
  return createElement('img', {
    className: cliAdapterClass.icon,
    src: icon,
    alt: '',
    'aria-hidden': true,
    style: CIRCULAR_ADAPTER_ICON_IDS.has(adapter.id) ? { borderRadius: '50%' } : undefined,
  })
}

interface AdapterDetailsDialogProps {
  readonly adapter: CodingNsCliAdapterDescriptor
  readonly models: CodingNsCliModelCatalog | null
  readonly loading: boolean
  readonly onClose: () => void
  readonly buttonStyle: CSSProperties
  readonly t: ReturnType<typeof useCodingNsTranslator>
}

function AdapterDetailsDialog({ adapter, models, loading, onClose, buttonStyle, t }: AdapterDetailsDialogProps): ReactElement {
  return createElement('div', {
    role: 'presentation',
    onPointerDown: backdropPointerDownHandler(onClose),
    style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: dshThemeColor.overlay },
  },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'codingns-cli-adapter-title',
      style: { ...dshPopupSurfaceStyle, width: 'min(100%, 620px)', maxHeight: 'min(720px, 90vh)', overflow: 'auto', boxSizing: 'border-box', padding: 24, borderRadius: 8 },
    },
      createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
        createElement('h3', { id: 'codingns-cli-adapter-title', style: { margin: 0, fontSize: 18 } }, adapter.name),
      createElement('button', { type: 'button', onClick: onClose, style: buttonStyle, 'aria-label': t('cli.closeDetails') }, t('cli.closeDetails')),
      ),
      createElement('dl', { style: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', margin: '20px 0' } },
        createElement('dt', undefined, t('cli.installStatus')), createElement('dd', { style: { margin: 0 } }, adapter.installed ? t('cli.installed') : t('cli.notInstalled')),
        createElement('dt', undefined, t('cli.enabledStatus')), createElement('dd', { style: { margin: 0 } }, adapter.enabled ? t('cli.enabled') : t('cli.disabled')),
        createElement('dt', undefined, t('cli.version')), createElement('dd', { style: { margin: 0 } }, adapter.version ?? t('cli.notDetectedVersion')),
        createElement('dt', undefined, t('cli.commandPath')), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, adapter.command ?? t('cli.notDetectedCommand')),
        adapter.diagnostic && createElement('dt', undefined, t('cli.diagnostic')),
        adapter.diagnostic && createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere', color: dshThemeColor.labelSecondary } }, adapter.diagnostic),
        createElement('dt', undefined, t('cli.protocol')), createElement('dd', { style: { margin: 0 } }, adapter.protocol ?? t('cli.undeclared')),
        createElement('dt', undefined, t('cli.capabilities')), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, adapter.capabilities?.join(t('common.listSeparator')) ?? t('cli.undeclared')),
      ),
      createElement('h4', { style: { margin: '16px 0 8px' } }, t('cli.modelCatalog')),
      !adapter.installed && createElement('div', { style: { opacity: 0.7 } }, adapter.diagnostic ?? t('cli.agentNotInstalled')),
      adapter.installed && !adapter.enabled && createElement('div', { style: { opacity: 0.7 } }, t('cli.agentDisabled')),
      adapter.installed && loading && createElement('div', { role: 'status' }, t('cli.readingModels')),
      adapter.installed && !loading && models !== null && createElement(ModelCatalog, { catalog: models, t }),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 20 } },
        createElement('button', { type: 'button', onClick: onClose, style: buttonStyle }, t('cli.done')),
      ),
    ),
  )
}

function ModelCatalog({ catalog, t }: { readonly catalog: CodingNsCliModelCatalog; readonly t: ReturnType<typeof useCodingNsTranslator> }): ReactElement {
  if (catalog.groups.length === 0) return createElement('div', { style: { opacity: 0.7 } }, t('cli.noModels'))
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
    ...catalog.groups.map((group) => createElement('section', { key: group.id },
      createElement('strong', undefined, group.name),
      createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
        ...group.models.map((model) => createElement(ModelRow, { key: model.id, model, t })),
      ),
    )),
  )
}

function ModelRow({ model, t }: { readonly model: CodingNsCliModel; readonly t: ReturnType<typeof useCodingNsTranslator> }): ReactElement {
  return createElement('div', { style: { padding: '8px 10px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 6 } },
    createElement('div', { style: { fontWeight: 600 } }, model.name),
    model.description && createElement('div', { style: { marginTop: 3, opacity: 0.7, fontSize: 13 } }, model.description),
    createElement('div', { style: { marginTop: 5, opacity: 0.7, fontSize: 13 } }, t('cli.thinkingLevel', { value: model.efforts.length > 0 ? model.efforts.map((effort) => model.effortLabels?.[effort] ?? effort).join(t('common.listSeparator')) : t('cli.defaultEffort') })),
  )
}
