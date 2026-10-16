import { createElement, Fragment, useEffect, useRef, useState, type ReactElement } from 'react'
import type { CodingNsCliAdapterDescriptor } from '../shared/contracts/cli-adapter.js'
import type { CliManagementAction, CliManagementOperation, CliManagementPlan } from '../shared/contracts/cli-management.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsTranslator } from './locale.js'
import { callCliRpc, errorMessage } from './cli-catalog.js'
import { CliSettingsDialog } from './cli-settings-dialog.js'
import { CliManagementTerminal } from './cli-management-terminal.js'
import { uiFontSize } from './font-scale.js'
import { dshSettingsButtonStyle, dshSettingsHelpStyle, dshThemeColor } from './theme.js'

export function cliManagementAction(adapter: CodingNsCliAdapterDescriptor): CliManagementAction | null {
  if (adapter.detectionState === 'pending' || adapter.detectionState === 'running' || adapter.detectionState === 'error' || adapter.detectionFailure) return null
  if (!adapter.installed) return 'install'
  return adapter.update?.state === 'available' && adapter.update.latestVersion ? 'update' : null
}

export interface CliManagementDialogProps {
  readonly adapter: CodingNsCliAdapterDescriptor
  readonly rpc: CodingNsRpcClient
  readonly hostLabel: string
  readonly t: CodingNsTranslator
  readonly visible?: boolean
  readonly onClose: (keepTracking?: boolean) => void
  readonly onCatalogChanged: (operation?: CliManagementOperation) => void | Promise<void>
}

export function CliManagementDialog({ adapter, rpc, hostLabel, t, visible = true, onClose, onCatalogChanged }: CliManagementDialogProps): ReactElement {
  const action = adapter.installed ? 'update' : 'install'
  const [plan, setPlan] = useState<CliManagementPlan | null>(null)
  const [operation, setOperation] = useState<CliManagementOperation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [catalogRefresh, setCatalogRefresh] = useState<'idle' | 'refreshing' | 'refreshed' | 'failed'>('idle')
  const active = useRef(false)
  const submitting = useRef(false)
  const automaticAttempted = useRef(false)
  const callback = useRef(onCatalogChanged)
  callback.current = onCatalogChanged
  const reported = useRef<string | null>(null)
  const running = operation?.state === 'running'
  const ownOperation = operation?.adapterId === adapter.id ? operation : null
  const method = plan?.methods.find(entry => entry.id === plan.automaticMethodId)
    ?? (plan?.action === 'install' ? plan.methods[0] : plan?.methods.find(entry => !entry.executable))
  const currentAction = ownOperation?.action ?? plan?.action ?? action
  const automatic = plan?.action === 'update' && plan.automaticMethodId !== undefined
  const close = (): void => onClose(running || submitting.current)
  const refreshCatalog = async (completed: CliManagementOperation): Promise<void> => {
    setCatalogRefresh('refreshing')
    try { await callback.current(completed); if (active.current) setCatalogRefresh('refreshed') }
    catch { if (active.current) setCatalogRefresh('failed') }
  }

  const startPlan = async (nextPlan: CliManagementPlan, nextMethodId: string): Promise<void> => {
    if (submitting.current || !nextPlan.methods.some(entry => entry.id === nextMethodId && entry.executable)) return
    submitting.current = true
    setBusy(true); setError('')
    try {
      const result = await callCliRpc<CliManagementOperation>(rpc, 'management/start', { adapterId: adapter.id, action: nextPlan.action, methodId: nextMethodId, fingerprint: nextPlan.fingerprint }, AbortSignal.timeout(10_000))
      if (active.current) setOperation(result)
    } catch (cause) { if (active.current) setError(errorMessage(cause)) }
    finally { submitting.current = false; if (active.current) setBusy(false) }
  }

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  useEffect(() => {
    let valid = true
    const abort = new AbortController()
    setLoading(true)
    setError('')
    void (async () => {
      const status = await callCliRpc<CliManagementOperation | null>(rpc, 'management/status', {}, AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]))
      if (!valid) return
      const completedTarget = status?.adapterId === adapter.id && status.state === 'succeeded'
        && adapter.update?.latestVersion !== undefined && status.adapter?.version === adapter.update.latestVersion
      setOperation(status?.state === 'running' || completedTarget ? status : null)
      if (status?.adapterId === adapter.id && (status.state === 'running' || completedTarget)) return
      const result = await callCliRpc<CliManagementPlan>(rpc, 'management/plan', { adapterId: adapter.id, action }, AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]))
      if (!valid) return
      setPlan(result)
      if (action === 'update' && result.automaticMethodId && status?.state !== 'running' && !automaticAttempted.current) {
        automaticAttempted.current = true
        await startPlan(result, result.automaticMethodId)
      }
    })().catch((cause: unknown) => { if (valid) setError(errorMessage(cause)) })
      .finally(() => { if (valid) setLoading(false) })
    return () => { valid = false; abort.abort() }
  }, [rpc, adapter.id, action, revision])

  useEffect(() => {
    if (operation === null) return
    if (operation.state !== 'running') {
      if (reported.current !== operation.id) {
        reported.current = operation.id
        void refreshCatalog(operation)
      }
      return
    }
    let valid = true
    const abort = new AbortController()
    const poll = async (): Promise<void> => {
      try {
        const value = await callCliRpc<CliManagementOperation | null>(rpc, 'management/status', {}, AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]))
        if (valid) { setOperation(value); setError('') }
      } catch (cause) { if (valid) setError(errorMessage(cause)) }
      finally { if (valid) timer = setTimeout(() => { void poll() }, 1_500) }
    }
    let timer = setTimeout(() => { void poll() }, 750)
    return () => { valid = false; clearTimeout(timer); abort.abort() }
  }, [rpc, operation, adapter.id, revision])

  const start = async (): Promise<void> => {
    if (submitting.current || busy || running || !method?.executable || plan === null) return
    await startPlan(plan, method.id)
  }
  const reviewAgain = async (): Promise<void> => {
    if (busy || running) return
    setBusy(true); setError('')
    try {
      const nextAction = (ownOperation?.adapter ?? adapter).installed ? 'update' : 'install'
      const result = await callCliRpc<CliManagementPlan>(rpc, 'management/plan', { adapterId: adapter.id, action: nextAction }, AbortSignal.timeout(120_000))
      if (active.current) {
        setPlan(result); setOperation(null)
        if (result.action === 'update' && result.automaticMethodId) await startPlan(result, result.automaticMethodId)
      }
    } catch (cause) { if (active.current) setError(errorMessage(cause)) }
    finally { if (active.current) setBusy(false) }
  }
  const cancel = async (): Promise<void> => {
    if (!ownOperation || busy) return
    setBusy(true)
    try {
      const result = await callCliRpc<CliManagementOperation>(rpc, 'management/cancel', { operationId: ownOperation.id }, AbortSignal.timeout(10_000))
      if (active.current) setOperation(result)
    } catch (cause) { if (active.current) setError(errorMessage(cause)) }
    finally { if (active.current) setBusy(false) }
  }
  const redetect = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await callCliRpc(rpc, 'catalog/refresh', { adapterId: adapter.id, checkUpdates: true }, AbortSignal.timeout(120_000)); if (active.current) { await callback.current(); if (active.current) onClose() } }
    catch (cause) { if (active.current) setError(errorMessage(cause)) }
    finally { if (active.current) setBusy(false) }
  }
  if (!visible) return createElement(Fragment)
  return createElement(CliSettingsDialog, { titleId: 'codingns-agent-management-title', onClose: close },
    createElement('div', { style: { padding: 18, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } },
      createElement('h3', { id: 'codingns-agent-management-title', style: { margin: 0, fontSize: uiFontSize(18), lineHeight: 1.35 } }, t('cli.manage.title', { action: t(`cli.manage.${currentAction}`), name: adapter.name })),
      createElement('div', { style: dshSettingsHelpStyle }, t('cli.manage.host', { name: hostLabel, platform: plan?.platform ?? '—' })),
      loading && createElement('div', { role: 'status' }, t('cli.manage.loading')),
      plan && createElement('a', { href: plan.sourceUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: uiFontSize(12), color: dshThemeColor.accent, alignSelf: 'flex-start' } }, t('cli.manage.source')),
      plan?.action === 'update' && plan.methods.some(entry => entry.executable) && !automatic && !running && ownOperation === null && createElement('div', { style: dshSettingsHelpStyle }, t('cli.manage.methodUnknown')),
      method && createElement('details', { open: !automatic },
        createElement('summary', { style: { ...dshSettingsHelpStyle, cursor: 'pointer' } }, t('cli.manage.details')),
        createElement('div', { style: dshSettingsHelpStyle }, method.instructions),
        method.command && createElement('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 12, background: dshThemeColor.surfaceSubtle, borderRadius: 6 } }, method.command),
      ),
      method?.executable && !automatic && !running && ownOperation === null && createElement('div', { style: dshSettingsHelpStyle }, t('cli.manage.review')),
      running && !ownOperation && createElement('div', { role: 'status' }, t('cli.manage.otherBusy', { name: operation.adapterId })),
      ownOperation && createElement(ManagementStatus, { operation: ownOperation, t }),
      ownOperation && createElement(CliManagementTerminal, { operation: ownOperation, t }),
      ownOperation?.state === 'succeeded' && catalogRefresh !== 'idle' && createElement('div', {
        role: catalogRefresh === 'failed' ? 'alert' : 'status', style: { ...dshSettingsHelpStyle, color: catalogRefresh === 'failed' ? dshThemeColor.warning : dshThemeColor.labelSecondary },
      }, t(`cli.manage.catalog.${catalogRefresh}`), catalogRefresh === 'failed' && createElement('button', {
        type: 'button', style: { ...dshSettingsButtonStyle, marginLeft: 8 }, onClick: () => { void refreshCatalog(ownOperation) },
      }, t('cli.manage.refreshList'))),
      error && createElement('div', { role: 'alert', style: { color: dshThemeColor.error } }, error),
      running && createElement('div', { style: dshSettingsHelpStyle }, t('cli.manage.background')),
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 } },
        ownOperation && !running && ownOperation.state !== 'succeeded' && createElement('button', { type: 'button', style: dshSettingsButtonStyle, disabled: busy || loading, onClick: () => { void reviewAgain() } }, t('cli.manage.reviewAgain')),
        error && createElement('button', { type: 'button', style: dshSettingsButtonStyle, disabled: busy, onClick: () => { setRevision((value) => value + 1) } }, t('cli.manage.retryStatus')),
        !running && ownOperation?.state !== 'succeeded' && createElement('button', { type: 'button', style: dshSettingsButtonStyle, disabled: busy || loading, onClick: () => { void redetect() } }, t('cli.manage.redetect')),
        method?.executable && !running && ownOperation === null && createElement('button', { type: 'button', style: dshSettingsButtonStyle, disabled: busy || loading, onClick: () => { void start() } }, t('cli.manage.run', { action: t(`cli.manage.${currentAction}`) })),
        ownOperation?.state === 'running' && createElement('button', { type: 'button', style: dshSettingsButtonStyle, disabled: busy, onClick: () => { void cancel() } }, t('cli.manage.cancel')),
        createElement('button', { type: 'button', style: dshSettingsButtonStyle, onClick: close }, t('cli.manage.close')),
      ),
    ),
  )
}

export function ManagementStatus({ operation, t }: { readonly operation: CliManagementOperation; readonly t: CodingNsTranslator }): ReactElement {
  const state = operation.state
  const color = state === 'succeeded' ? dshThemeColor.success : state === 'failed' ? dshThemeColor.error : state === 'cancelled' ? dshThemeColor.warning : dshThemeColor.accent
  return createElement('div', { role: state === 'failed' ? 'alert' : 'status', 'data-state': state,
    style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 10, border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`, background: `color-mix(in srgb, ${color} 8%, transparent)`, color },
  },
    createElement('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flexShrink: 0 } },
      createElement('circle', { cx: 12, cy: 12, r: 9 }),
      createElement('path', { d: state === 'succeeded' ? 'm8 12 3 3 5-6' : state === 'failed' ? 'm9 9 6 6m0-6-6 6' : state === 'cancelled' ? 'M8 12h8' : 'M12 7v5l3 2' })),
    createElement('div', { style: { minWidth: 0 } },
      createElement('strong', { style: { display: 'block', fontSize: uiFontSize(13) } }, t(`cli.manage.result.${state}`, { action: t(`cli.manage.${operation.action}`) })),
      state !== 'running' && createElement('div', { style: { marginTop: 4, fontSize: uiFontSize(12), color: dshThemeColor.labelPrimary, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } },
        state === 'succeeded' ? t('cli.manage.succeeded', { version: operation.adapter?.version ?? '—' }) : operation.error ?? t(`cli.manage.${state}`)),
    ),
  )
}
