import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliModel,
  CodingNsCliModelCatalog,
} from '../../shared/contracts/cli-adapter.js'
import type { FeaturePanelProps, CodingNsClientFeatureModule } from './types.js'
import type { PeerHostClientRecord } from '../../shared/contracts/peer-host.js'
import { createVirtualSessionId } from '../../shared/contracts/peer-host.js'
import { normalizeSubagentBridgeSettings, SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS } from '../../shared/contracts/config.js'
import { adapterDetectionLabel, callCliRpc, catalogRefreshErrorMessage, errorMessage } from '../cli-catalog.js'
import { dshFormRootStyle, dshPopupSurfaceStyle, dshSettingsButtonStyle, dshSettingsFieldStyle, dshSettingsHelpStyle, dshSettingsListRowStyle, dshThemeColor } from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'
import { backdropPointerDownHandler } from '../popup-dismiss.js'
import { registerExternalToolStreamUi } from '../external-tool-stream.js'
import { startContextBreakdownDom } from '../context-breakdown-dom.js'
import { fetchSessionAdapters, replaceSessionAdapters, sessionAdapterId } from '../session-adapter-cache.js'
import { providerIconUrl } from '../provider-icons.js'
import { notifyAdapterCatalogChanged, watchAdapterCatalog } from '../adapter-catalog-watch.js'
import { invalidateModelCatalogCache } from '../model-catalog-cache.js'
import { resolveRefreshIcon } from '../../dsh-capabilities/client/primitives-adapter.js'
import { createCliSettingsRpc } from '../cli-settings-rpc.js'
import { createPeerHostManagementApi } from '../peer-host-management-api.js'
import { SettingsSwitch } from '../settings-controls.js'
import { uiFontSize } from '../font-scale.js'

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
  detectButton: 'codingns4dsh-cli-adapter-detect-button',
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
.${cliAdapterClass.listHeader}{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:0 6px 10px;color:var(--dsw-alias-label-tertiary,GrayText);border-bottom:1px solid var(--dsw-alias-border-l4,#eef0f2);font-size:13px;font-weight:600;letter-spacing:.02em}
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
.${cliAdapterClass.detectButton}{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,GrayText);cursor:pointer}
.${cliAdapterClass.detectButton}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,CanvasText)}
.${cliAdapterClass.detectButton}:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1677ff);outline-offset:2px}
.${cliAdapterClass.detectButton}:disabled{opacity:.45;cursor:not-allowed}
.${cliAdapterClass.detectButton}[aria-busy="true"] svg{animation:codingns-cli-detect-spin 1s linear infinite}
@keyframes codingns-cli-detect-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.${cliAdapterClass.detectButton}[aria-busy="true"] svg{animation:none}}
@media (max-width:768px){
  .${cliAdapterClass.row}{display:grid!important;grid-template-columns:minmax(0,1fr) auto;align-items:center!important;gap:7px 10px!important;min-height:0!important;padding:12px 14px!important}
  .${cliAdapterClass.main}{grid-column:1 / -1;display:flex!important;align-items:center!important;width:100%;gap:10px!important}
  .${cliAdapterClass.identity}{gap:4px}
  .${cliAdapterClass.name}{white-space:normal;overflow-wrap:anywhere;text-overflow:clip}
  .${cliAdapterClass.metadata}{grid-column:1;grid-row:2;display:flex;flex-wrap:wrap;gap:7px!important;min-width:0;max-width:100%}
  .${cliAdapterClass.status},.${cliAdapterClass.version}{max-width:100%;min-width:0!important}
  .${cliAdapterClass.toggle}{grid-column:2;grid-row:2;justify-self:end;align-self:center;min-width:0;max-width:100%;white-space:nowrap}
  .${cliAdapterClass.toggle}>span:first-child{max-width:7em;overflow:hidden;text-overflow:ellipsis}
  .${cliAdapterClass.row}>.${cliAdapterClass.detectButton}{grid-column:1;grid-row:2;justify-self:start}
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
  const disabled = !enabled
  const [peerHosts, setPeerHosts] = useState<readonly PeerHostClientRecord[]>([])
  const [peerHostId, setPeerHostId] = useState<string | null>(null)
  const [hostsError, setHostsError] = useState('')
  const peerHostEnabled = snapshot.value?.modules.peerHost === true
  const peerHost = peerHosts.find((host) => host.id === peerHostId)
  const hostLabel = peerHostId === null ? t('cli.localHost') : peerHost?.displayName ?? peerHostId
  const catalogAvailable = peerHostId === null || (peerHostEnabled && (peerHost?.status === 'ready' || peerHost?.status === 'session_required') && peerHost.route.kind === 'lan')
  const catalogRpc = useMemo(() => createCliSettingsRpc(services.rpc, peerHostId, services.locale), [services.rpc, peerHostId, services.locale])
  const refreshHosts = useRef<() => void>(() => undefined)
  // 切换 Host 的当次渲染立即使旧请求失效，不能等下一次 effect 才隔离迟到结果。
  const requestContext = useMemo(() => ({ rpc: catalogRpc }), [catalogRpc, disabled, catalogAvailable])
  const currentRequest = useRef<typeof requestContext | null>(requestContext)
  currentRequest.current = requestContext
  const [catalog, setCatalog] = useState<readonly CodingNsCliAdapterDescriptor[]>([])
  const [selected, setSelected] = useState<CodingNsCliAdapterDescriptor | null>(null)
  const [models, setModels] = useState<CodingNsCliModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyAdapterId, setBusyAdapterId] = useState<string | null>(null)
  const [bridgeBusy, setBridgeBusy] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [detecting, setDetecting] = useState<string | null>(null)

  useEffect(() => { installCliAdapterStyles() }, [])
  useEffect(() => {
    currentRequest.current = requestContext
    return () => { if (currentRequest.current === requestContext) currentRequest.current = null }
  }, [requestContext])

  useEffect(() => {
    if (disabled || !peerHostEnabled) { setPeerHosts([]); setPeerHostId(null); setHostsError(''); return }
    let active = true
    let busy = false
    const api = createPeerHostManagementApi(services.rpc)
    const refresh = async (): Promise<void> => {
      if (!active || busy) return
      busy = true
      try {
        const hosts = await api.list(AbortSignal.timeout(10_000))
        if (!active) return
        setPeerHosts(hosts)
        setHostsError('')
        setPeerHostId((current) => current !== null && !hosts.some((host) => host.id === current) ? null : current)
      } catch (error) { if (active) setHostsError(errorMessage(error)) }
      finally { busy = false }
    }
    refreshHosts.current = () => { void refresh() }
    void refresh()
    // 返回设置页时重新读取已登记主机，不增加长期后台轮询。
    globalThis.addEventListener?.('focus', refresh)
    return () => { active = false; refreshHosts.current = () => undefined; globalThis.removeEventListener?.('focus', refresh) }
  }, [disabled, peerHostEnabled, services.rpc])

  useEffect(() => {
    setCatalog([])
    setSelected(null)
    setModels(null)
    setModelsError('')
    setCatalogError('')
    setDetecting(null)
    setBusyAdapterId(null)
    if (disabled || !catalogAvailable) { setLoading(false); return }
    setLoading(true)
    return watchAdapterCatalog(catalogRpc, undefined,
      (value) => { if (currentRequest.current === requestContext) { setCatalog(value); setLoading(false); setCatalogError('') } },
      (error) => { if (currentRequest.current === requestContext) { setLoading(false); setCatalogError(errorMessage(error)) } },
    )
  }, [disabled, requestContext, catalogAvailable])

  useEffect(() => {
    if (selected === null || disabled || !catalogAvailable || !selected.installed || !selected.enabled) {
      setModels(null)
      return
    }
    let active = true
    setModels(null)
    setModelsError('')
    void callCliRpc<CodingNsCliModelCatalog>(catalogRpc, 'models', { adapterId: selected.id }, AbortSignal.timeout(10_000))
      .then((value) => { if (active && currentRequest.current === requestContext) setModels(value) })
      .catch((error: unknown) => { if (active && currentRequest.current === requestContext) { const message = errorMessage(error); setModelsError(message); notify({ kind: 'error', message }) } })
    return () => { active = false }
  }, [disabled, selected, requestContext, catalogAvailable])

  const buttonStyle = { ...dshSettingsButtonStyle, cursor: disabled ? 'not-allowed' : 'pointer' }
  const redetect = async (adapterId?: string): Promise<void> => {
    if (disabled || !catalogAvailable || detecting !== null) return
    setDetecting(adapterId ?? '*')
    try {
      const value = await callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(catalogRpc, 'catalog/refresh', adapterId === undefined ? {} : { adapterId }, AbortSignal.timeout(120_000))
      invalidateModelCatalogCache(services.rpc, adapterId, peerHostId === null ? undefined : createVirtualSessionId(peerHostId, '__catalog__'))
      notifyAdapterCatalogChanged(services.rpc)
      if (currentRequest.current !== requestContext) return
      setCatalog(value)
      setCatalogError('')
      setSelected((current) => current === null ? null : value.find((entry) => entry.id === current.id) ?? null)
      notifyAdapterCatalogChanged(catalogRpc)
    } catch (error) {
      if (currentRequest.current === requestContext) {
        const message = catalogRefreshErrorMessage(error, t)
        setCatalogError(message)
        notify({ kind: 'error', message })
      }
    }
    finally { if (currentRequest.current === requestContext) setDetecting(null) }
  }
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
    if (disabled || peerHostId !== null) return
    setBusyAdapterId(adapter.id)
    try {
      await callCliRpc(services.rpc, 'adapter/set', { adapterId: adapter.id, enabled: next })
      const refreshed = await callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(catalogRpc, 'catalog', {})
      notifyAdapterCatalogChanged(services.rpc)
      if (currentRequest.current !== requestContext) return
      setCatalog(refreshed)
      notifyAdapterCatalogChanged(catalogRpc)
      notify({ kind: 'success', message: t(next ? 'cli.adapterEnabled' : 'cli.adapterDisabled', { name: adapter.name }) })
    } catch (error) {
      if (currentRequest.current === requestContext) notify({ kind: 'error', message: errorMessage(error) })
    } finally {
      if (currentRequest.current === requestContext) setBusyAdapterId(null)
    }
  }

  return createElement(
    'div',
    { className: cliAdapterClass.panel, 'aria-disabled': disabled, style: { ...dshFormRootStyle, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' } },
    peerHostId === null && createElement('label', { style: dshSettingsListRowStyle },
      createElement('span', { style: { flex: '1 1 auto', minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: uiFontSize(13), lineHeight: 1.4 } }, t('cli.subagentBridge')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle, opacity: 0.75 } }, t('cli.subagentBridgeDescription')),
      ),
      createElement(SettingsSwitch, {
        'aria-label': t('cli.subagentBridgeToggle'),
        checked: bridgeEnabled,
        disabled: !bridgeWritable || bridgeBusy,
        onChange: (event: { currentTarget: { checked: boolean } }) => { void toggleSubagentBridge(event.currentTarget.checked) },
      }),
    ),
    peerHostId === null && createElement('label', { style: { ...dshSettingsListRowStyle, opacity: bridgeEnabled ? 1 : 0.5 } },
      createElement('span', { style: { flex: '1 1 auto', minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: uiFontSize(13), lineHeight: 1.4 } }, t('cli.subagentBridgeConcurrency')),
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
        style: { ...dshSettingsFieldStyle, flex: '0 0 auto', width: 96, minHeight: 32, padding: '5px 8px', fontSize: uiFontSize(13) },
      }),
    ),
    createElement('div', { className: cliAdapterClass.listHeader },
      createElement('span', undefined, t('cli.agentList')),
      createElement('select', {
        'aria-label': t('cli.agentHost'), value: peerHostId ?? '', disabled,
        onFocus: () => refreshHosts.current(),
        onChange: (event: { currentTarget: { value: string } }) => {
          setPeerHostId(event.currentTarget.value || null)
          setCatalog([]); setSelected(null); setModels(null); setModelsError(''); setCatalogError('')
        },
        style: { ...dshSettingsFieldStyle, flex: '1 1 160px', width: 'auto', maxWidth: 280, minWidth: 0, minHeight: 32, padding: '5px 8px', fontSize: uiFontSize(13) },
      },
        createElement('option', { value: '' }, t('cli.localHost')),
        ...peerHosts.map((host) => createElement('option', { key: host.id, value: host.id }, host.displayName)),
      ),
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flex: '0 0 auto' } },
        catalog.length > 0 && createElement('span', undefined, t('cli.agentCount', { count: catalog.length })),
        createElement(AdapterDetectButton, { label: t(detecting === '*' ? 'cli.detecting' : 'cli.redetectAll'), busy: detecting === '*', disabled: disabled || !catalogAvailable || detecting !== null, onClick: () => { void redetect() } }),
      ),
    ),
    hostsError && createElement('div', { role: 'alert', style: dshSettingsHelpStyle }, t('cli.peerHostListError', { message: hostsError })),
    peerHostId !== null && createElement('div', { style: dshSettingsHelpStyle }, t('cli.peerHostReadOnly', { name: hostLabel })),
    !catalogAvailable && createElement('div', { role: 'status', style: dshSettingsHelpStyle }, t('cli.peerHostUnavailable', { name: hostLabel })),
    catalogError && createElement('div', { role: 'alert', style: { ...dshSettingsHelpStyle, color: dshThemeColor.error } }, catalogError),
    loading && createElement('div', { role: 'status' }, t('cli.readingAgents')),
    !loading && catalogAvailable && !catalogError && catalog.length === 0 && createElement('div', { role: 'status', style: { opacity: 0.7 } }, t('cli.noAgents')),
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
              createElement('span', { className: cliAdapterClass.status, style: {
                color: adapter.installed ? (adapter.runtimeState === 'installed' ? dshThemeColor.labelSecondary : dshThemeColor.success) : dshThemeColor.labelTertiary,
                background: adapter.installed && adapter.runtimeState !== 'installed' ? 'rgba(22,163,74,.12)' : dshThemeColor.surfaceSubtle,
              } }, adapterStatus(adapter, t)),
              createElement('span', { className: cliAdapterClass.version }, adapter.version ?? t('cli.notDetectedVersion')),
            ),
          ),
        ),
        createElement(AdapterDetectButton, { label: `${adapter.name} · ${t(detecting === adapter.id || detecting === '*' ? 'cli.detecting' : 'cli.redetect')}`, busy: detecting === adapter.id || detecting === '*', disabled: disabled || detecting !== null, onClick: () => { void redetect(adapter.id) } }),
        createElement('label', { className: cliAdapterClass.toggle, style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' } },
          createElement('span', { 'aria-hidden': true }, adapter.enabled ? t('cli.enabled') : t('cli.disabled')),
          createElement(SettingsSwitch, { 'aria-label': t('cli.adapterToggle', { name: adapter.name }), checked: adapter.enabled, disabled: peerHostId !== null || !adapter.installed || busyAdapterId === adapter.id, onChange: (event: { currentTarget: { checked: boolean } }) => { void toggleAdapter(adapter, event.currentTarget.checked) } }),
        ),
      )),
    ),
    selected !== null && createElement(AdapterDetailsDialog, {
      adapter: selected,
      models,
      hostLabel,
      modelsError,
      loading: selected.installed && selected.enabled && models === null && modelsError === '',
      onClose: () => setSelected(null),
      buttonStyle,
      t,
    }),
  )
}

const CIRCULAR_ADAPTER_ICON_IDS = new Set(['gemini', 'grok'])

/** 顶部和单个 Agent 共用刷新图标；文字保留在悬停提示和无障碍名称中。 */
function AdapterDetectButton({ label, busy, disabled, onClick }: {
  readonly label: string
  readonly busy: boolean
  readonly disabled: boolean
  readonly onClick: () => void
}): ReactElement {
  return createElement('button', { type: 'button', className: cliAdapterClass.detectButton, title: label, 'aria-label': label, 'aria-busy': busy, disabled, onClick },
    createElement('span', { 'aria-hidden': true, style: { display: 'inline-flex' } }, createElement(resolveRefreshIcon(), { size: 18 })),
  )
}

function adapterStatus(adapter: CodingNsCliAdapterDescriptor, t: ReturnType<typeof useCodingNsTranslator>): string {
  return t(adapterDetectionLabel(adapter))
}

/** 设置页列表中的 Agent logo；资产缺失时用首字母占位，避免出现破图或空白。 */
function AdapterIcon({ adapter }: { readonly adapter: CodingNsCliAdapterDescriptor }): ReactElement {
  const icon = providerIconUrl(adapter.id)
  if (icon === undefined) {
    return createElement('span', {
      className: cliAdapterClass.icon,
      'aria-hidden': true,
      style: { borderRadius: 6, background: dshThemeColor.surfaceSubtle, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), fontWeight: 700 },
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
  readonly hostLabel: string
  readonly models: CodingNsCliModelCatalog | null
  readonly modelsError: string
  readonly loading: boolean
  readonly onClose: () => void
  readonly buttonStyle: CSSProperties
  readonly t: ReturnType<typeof useCodingNsTranslator>
}

function AdapterDetailsDialog({ adapter, hostLabel, models, modelsError, loading, onClose, buttonStyle, t }: AdapterDetailsDialogProps): ReactElement {
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
        createElement('h3', { id: 'codingns-cli-adapter-title', style: { margin: 0, fontSize: uiFontSize(18) } }, adapter.name),
      createElement('button', { type: 'button', onClick: onClose, style: buttonStyle, 'aria-label': t('cli.closeDetails') }, t('cli.closeDetails')),
      ),
      createElement('dl', { style: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', margin: '20px 0' } },
        createElement('dt', undefined, t('cli.agentHost')), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, hostLabel),
        createElement('dt', undefined, t('cli.installStatus')), createElement('dd', { style: { margin: 0 } }, adapterStatus(adapter, t)),
        createElement('dt', undefined, t('cli.enabledStatus')), createElement('dd', { style: { margin: 0 } }, adapter.enabled ? t('cli.enabled') : t('cli.disabled')),
        createElement('dt', undefined, t('cli.version')), createElement('dd', { style: { margin: 0 } }, adapter.version ?? t('cli.notDetectedVersion')),
        createElement('dt', undefined, t('cli.commandPath')), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, adapter.command ?? t('cli.notDetectedCommand')),
        adapter.diagnostic && createElement('dt', undefined, t('cli.diagnostic')),
        adapter.diagnostic && createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere', color: dshThemeColor.labelSecondary } }, adapter.diagnostic),
        createElement('dt', undefined, t('cli.protocol')), createElement('dd', { style: { margin: 0 } }, adapter.protocol ?? t('cli.undeclared')),
        createElement('dt', undefined, t('cli.capabilities')), createElement('dd', { style: { margin: 0, overflowWrap: 'anywhere' } }, adapter.capabilities?.join(t('common.listSeparator')) ?? t('cli.undeclared')),
      ),
      createElement('h4', { style: { margin: '16px 0 8px' } }, t('cli.modelCatalog')),
      modelsError && createElement('div', { role: 'alert', style: { color: dshThemeColor.error } }, modelsError),
      !adapter.installed && createElement('div', { style: { opacity: 0.7 } }, adapter.diagnostic ?? adapterStatus(adapter, t)),
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
    model.description && createElement('div', { style: { marginTop: 3, opacity: 0.7, fontSize: uiFontSize(13) } }, model.description),
    createElement('div', { style: { marginTop: 5, opacity: 0.7, fontSize: uiFontSize(13) } }, t('cli.thinkingLevel', { value: model.efforts.length > 0 ? model.efforts.map((effort) => model.effortLabels?.[effort] ?? effort).join(t('common.listSeparator')) : t('cli.defaultEffort') })),
  )
}
