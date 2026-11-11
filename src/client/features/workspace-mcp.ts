import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { FeaturePanelProps, CodingNsClientFeatureModule } from './types.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { LanAccessDshSnapshot } from '../../shared/contracts/lan-access-dsh.js'
import { resolveCodingNsTranslator, useCodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsFieldStyle, dshSettingsNoteStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import { uiFontSize } from '../font-scale.js'
import { SettingsToggleRow } from '../settings-controls.js'
import { buildLanAccessUrls } from './lan-access-status.js'

const fallbackT = resolveCodingNsTranslator()

export const workspaceMcpFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'workspaceMcp',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: fallbackT('feature.workspaceMcp.label'),
      description: fallbackT('feature.workspaceMcp.description'),
      labelKey: 'feature.workspaceMcp.label',
      descriptionKey: 'feature.workspaceMcp.description',
      order: 60,
      defaultOpen: false,
    },
  },
  start() {},
  settingsPanel: WorkspaceMcpPanel,
}

interface WorkspaceMcpStatus {
  readonly apiKeyConfigured: boolean
  readonly enabled: boolean
  readonly listening: boolean
  readonly lanAccessEnabled: boolean
  readonly url: string | null
  readonly reason: string | null
}

type WebhookEventType = 'session.completed' | 'session.failed' | 'session.permission_requested' | 'session.question_asked'

interface WebhookDestination {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly enabled: boolean
  readonly workspaceIds: readonly string[] | null
  readonly eventTypes: readonly WebhookEventType[]
  readonly includeLastMessage: boolean
}

interface WebhookDelivery {
  readonly deliveryId: string
  readonly destinationId: string
  readonly status: 'pending' | 'sending' | 'delivered' | 'failed'
  readonly lastError: string | null
  readonly httpStatus?: number
  readonly createdAt: string
}

interface WebhookWorkspace { readonly id: string; readonly name: string }
interface WebhookEventAvailability { readonly available: boolean; readonly reason: string | null }
interface WebhookSnapshot {
  readonly destinations: readonly WebhookDestination[]
  readonly deliveries: readonly WebhookDelivery[]
  readonly workspaces: readonly WebhookWorkspace[]
  readonly events: Readonly<Record<WebhookEventType, WebhookEventAvailability>>
}

interface WebhookEditorDraft {
  readonly id?: string
  readonly name: string
  readonly url: string
  readonly workspaceIds: readonly string[] | null
  readonly eventTypes: readonly WebhookEventType[]
  readonly includeLastMessage: boolean
}

const WEBHOOK_EVENT_LABELS: Readonly<Record<WebhookEventType, string>> = {
  'session.completed': 'workspaceMcp.webhook.event.completed',
  'session.failed': 'workspaceMcp.webhook.event.failed',
  'session.permission_requested': 'workspaceMcp.webhook.event.permission',
  'session.question_asked': 'workspaceMcp.webhook.event.question',
}

interface WorkspaceMcpCapabilityDescription {
  readonly name: string
  readonly permissionKey: string
  readonly descriptionKey: string
  readonly parametersKey: string
  readonly remarksKey: string
}

const WORKSPACE_MCP_CAPABILITIES: readonly WorkspaceMcpCapabilityDescription[] = [
  { name: 'workspace_list', permissionKey: 'workspaceMcp.capability.workspaceList.permission', descriptionKey: 'workspaceMcp.capability.workspaceList.description', parametersKey: 'workspaceMcp.capability.workspaceList.parameters', remarksKey: 'workspaceMcp.capability.workspaceList.remarks' },
  { name: 'session_list', permissionKey: 'workspaceMcp.capability.sessionList.permission', descriptionKey: 'workspaceMcp.capability.sessionList.description', parametersKey: 'workspaceMcp.capability.sessionList.parameters', remarksKey: 'workspaceMcp.capability.sessionList.remarks' },
  { name: 'session_create', permissionKey: 'workspaceMcp.capability.sessionCreate.permission', descriptionKey: 'workspaceMcp.capability.sessionCreate.description', parametersKey: 'workspaceMcp.capability.sessionCreate.parameters', remarksKey: 'workspaceMcp.capability.sessionCreate.remarks' },
  { name: 'session_continue', permissionKey: 'workspaceMcp.capability.sessionContinue.permission', descriptionKey: 'workspaceMcp.capability.sessionContinue.description', parametersKey: 'workspaceMcp.capability.sessionContinue.parameters', remarksKey: 'workspaceMcp.capability.sessionContinue.remarks' },
  { name: 'session_questions', permissionKey: 'workspaceMcp.capability.sessionQuestions.permission', descriptionKey: 'workspaceMcp.capability.sessionQuestions.description', parametersKey: 'workspaceMcp.capability.sessionQuestions.parameters', remarksKey: 'workspaceMcp.capability.sessionQuestions.remarks' },
  { name: 'session_answer', permissionKey: 'workspaceMcp.capability.sessionAnswer.permission', descriptionKey: 'workspaceMcp.capability.sessionAnswer.description', parametersKey: 'workspaceMcp.capability.sessionAnswer.parameters', remarksKey: 'workspaceMcp.capability.sessionAnswer.remarks' },
  { name: 'session_request_permission', permissionKey: 'workspaceMcp.capability.sessionRequestPermission.permission', descriptionKey: 'workspaceMcp.capability.sessionRequestPermission.description', parametersKey: 'workspaceMcp.capability.sessionRequestPermission.parameters', remarksKey: 'workspaceMcp.capability.sessionRequestPermission.remarks' },
  { name: 'session_permission_status', permissionKey: 'workspaceMcp.capability.sessionPermissionStatus.permission', descriptionKey: 'workspaceMcp.capability.sessionPermissionStatus.description', parametersKey: 'workspaceMcp.capability.sessionPermissionStatus.parameters', remarksKey: 'workspaceMcp.capability.sessionPermissionStatus.remarks' },
  { name: 'terminal_list', permissionKey: 'workspaceMcp.capability.terminalList.permission', descriptionKey: 'workspaceMcp.capability.terminalList.description', parametersKey: 'workspaceMcp.capability.terminalList.parameters', remarksKey: 'workspaceMcp.capability.terminalList.remarks' },
  { name: 'terminal_read', permissionKey: 'workspaceMcp.capability.terminalRead.permission', descriptionKey: 'workspaceMcp.capability.terminalRead.description', parametersKey: 'workspaceMcp.capability.terminalRead.parameters', remarksKey: 'workspaceMcp.capability.terminalRead.remarks' },
  { name: 'terminal_write', permissionKey: 'workspaceMcp.capability.terminalWrite.permission', descriptionKey: 'workspaceMcp.capability.terminalWrite.description', parametersKey: 'workspaceMcp.capability.terminalWrite.parameters', remarksKey: 'workspaceMcp.capability.terminalWrite.remarks' },
]

const REASON_KEYS: Readonly<Record<string, string>> = {
  'api-key-missing': 'workspaceMcp.reason.keyMissing',
  'api-key-not-configured': 'workspaceMcp.reason.keyMissing',
  'key-store-failed': 'workspaceMcp.reason.keyStoreFailed',
  disabled: 'workspaceMcp.reason.disabled',
  'listen-failed': 'workspaceMcp.reason.listenFailed',
  'listener-error': 'workspaceMcp.reason.listenFailed',
  'startup-failed': 'workspaceMcp.reason.listenFailed',
}

function WorkspaceMcpPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [status, setStatus] = useState<WorkspaceMcpStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refreshCount, setRefreshCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [lanUrl, setLanUrl] = useState<string | null>(null)
  const [webhookState, setWebhookState] = useState<WebhookSnapshot | null>(null)
  const [webhookFailed, setWebhookFailed] = useState(false)
  const [webhookBusy, setWebhookBusy] = useState(false)
  const [webhookEditor, setWebhookEditor] = useState<WebhookEditorDraft | null>(null)
  const [webhookSecret, setWebhookSecret] = useState<{ readonly name: string; readonly secret: string } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const lanAccessEnabled = status?.lanAccessEnabled ?? snapshot.value?.modules.workspaceMcpLanAccess === true

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    void services.rpc.call(CODINGNS_RPC_CHANNEL, 'workspaceMcp/status', {}).then((result) => {
      if (!result.ok) throw new Error('Workspace MCP status request failed')
      const next = normalizeStatus(result.value)
      if (next === null) throw new Error('Invalid Workspace MCP status')
      if (active) setStatus(next)
    }).catch(() => {
      if (active) {
        setStatus(null)
        setFailed(true)
      }
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [services.rpc, enabled, refreshCount, snapshot.value?.modules.workspaceMcpLanAccess])

  useEffect(() => {
    let active = true
    void services.rpc.call(CODINGNS_RPC_CHANNEL, 'workspaceMcp/webhook-list', {}).then((result) => {
      if (!result.ok) throw new Error('Webhook status request failed')
      const next = normalizeWebhookSnapshot(result.value)
      if (next === null) throw new Error('Invalid webhook status')
      if (active) {
        setWebhookState(next)
        setWebhookFailed(false)
      }
    }).catch(() => {
      if (active) {
        setWebhookState(null)
        setWebhookFailed(true)
      }
    })
    return () => { active = false }
  }, [services.rpc, refreshCount])

  useEffect(() => {
    let active = true
    if (!lanAccessEnabled) {
      setLanUrl(null)
      return () => { active = false }
    }
    void Promise.all([
      services.rpc.call(CODINGNS_RPC_CHANNEL, 'lanAccessDsh/get', {}),
      services.rpc.call(CODINGNS_RPC_CHANNEL, 'lanAccessDsh/addresses', {}),
    ]).then(([snapshotResult, addressesResult]) => {
      if (!snapshotResult.ok || !addressesResult.ok) throw new Error('LAN access status request failed')
      const lanSnapshot = normalizeLanAccessSnapshot(snapshotResult.value)
      const addresses = Array.isArray(addressesResult.value)
        ? addressesResult.value.filter((value): value is string => typeof value === 'string')
        : []
      const accessUrl = buildLanAccessUrls(lanSnapshot, addresses)
        .map((value) => workspaceMcpUrl(value))
        .find((value): value is string => value !== null) ?? null
      if (active) setLanUrl(accessUrl)
    }).catch(() => {
      if (active) setLanUrl(null)
    })
    return () => { active = false }
  }, [services.rpc, lanAccessEnabled, refreshCount])

  useEffect(() => {
    if (!capabilitiesOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCapabilitiesOpen(false)
    }
    globalThis.addEventListener('keydown', closeOnEscape)
    return () => globalThis.removeEventListener('keydown', closeOnEscape)
  }, [capabilitiesOpen])

  const reasonKey = status?.reason === null || status?.reason === undefined
    ? null
    : Object.prototype.hasOwnProperty.call(REASON_KEYS, status.reason)
      ? REASON_KEYS[status.reason] ?? 'workspaceMcp.reason.other'
      : 'workspaceMcp.reason.other'
  const url = safeWorkspaceMcpUrl(status?.url)
  const endpoint = lanUrl ?? url

  const generateKey = async (): Promise<void> => {
    setBusy(true)
    setGeneratedKey(null)
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'workspaceMcp/generate-key', {})
      if (!result.ok || !isRecord(result.value) || typeof result.value.apiKey !== 'string') {
        throw new Error(result.ok ? 'Invalid Workspace MCP key response' : result.error.message)
      }
      setGeneratedKey(result.value.apiKey)
      setRefreshCount((count) => count + 1)
      notify({ kind: 'success', message: t('workspaceMcp.keyGenerated') })
    } catch (error) {
      notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const copyKey = async (): Promise<void> => {
    if (generatedKey === null) return
    try {
      await navigator.clipboard.writeText(generatedKey)
      notify({ kind: 'success', message: t('workspaceMcp.keyCopied') })
    } catch {
      notify({ kind: 'error', message: t('workspaceMcp.copyFailed') })
    }
  }

  const installPrompt = t('workspaceMcp.installPromptText')
  const copyInstallPrompt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(installPrompt)
      notify({ kind: 'success', message: t('workspaceMcp.installPromptCopied') })
    } catch {
      notify({ kind: 'error', message: t('workspaceMcp.copyFailed') })
    }
  }

  const updateLanAccess = (next: boolean): void => {
    void services.settings.mutate([{
      op: 'set',
      path: ['modules', 'workspaceMcpLanAccess'],
      value: next,
    }]).then((accepted) => {
      notify({
        kind: accepted ? 'success' : 'error',
        message: accepted ? t('workspaceMcp.lanAccessSaved') : t('settings.moduleWriteRejected'),
      })
      if (accepted) setRefreshCount((count) => count + 1)
    }).catch((cause: unknown) => {
      notify({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  const saveWebhook = async (): Promise<void> => {
    if (webhookEditor === null) return
    setWebhookBusy(true)
    try {
      const { id, url, ...settings } = webhookEditor
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, id === undefined ? 'workspaceMcp/webhook-create' : 'workspaceMcp/webhook-update', {
        ...(id === undefined ? {} : { id }),
        ...settings,
        ...(url.trim() === '' && id !== undefined ? {} : { url: url.trim() }),
      })
      if (!result.ok || !isRecord(result.value)) throw new Error(result.ok ? 'Invalid webhook response' : result.error.message)
      const secret = result.value.secret
      if (typeof secret === 'string') setWebhookSecret({ name: webhookEditor.name, secret })
      setWebhookEditor(null)
      setRefreshCount((count) => count + 1)
      notify({ kind: 'success', message: t(id === undefined ? 'workspaceMcp.webhook.created' : 'workspaceMcp.webhook.saved') })
    } catch (error) {
      notify({ kind: 'error', message: webhookErrorMessage(error, t) })
    } finally {
      setWebhookBusy(false)
    }
  }

  const updateWebhook = async (action: string, payload: Record<string, unknown>, successKey: string): Promise<unknown | null> => {
    setWebhookBusy(true)
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, `workspaceMcp/${action}`, payload)
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
      setRefreshCount((count) => count + 1)
      if (successKey !== '') notify({ kind: 'success', message: t(successKey) })
      return result.value
    } catch (error) {
      notify({ kind: 'error', message: webhookErrorMessage(error, t) })
      return null
    } finally {
      setWebhookBusy(false)
    }
  }

  const testWebhook = async (destination: WebhookDestination): Promise<void> => {
    const result = await updateWebhook('webhook-test', { id: destination.id }, '')
    if (result === null) return
    const ok = isRecord(result) && result.ok === true
    notify({ kind: ok ? 'success' : 'error', message: t(ok ? 'workspaceMcp.webhook.testPassed' : 'workspaceMcp.webhook.testFailed') })
  }

  const rotateWebhookSecret = async (destination: WebhookDestination): Promise<void> => {
    const result = await updateWebhook('webhook-rotate-secret', { id: destination.id }, '')
    if (!isRecord(result) || typeof result.secret !== 'string') return
    setWebhookSecret({ name: destination.name, secret: result.secret })
  }

  const copyWebhookSecret = async (): Promise<void> => {
    if (webhookSecret === null) return
    try {
      await navigator.clipboard.writeText(webhookSecret.secret)
      notify({ kind: 'success', message: t('workspaceMcp.webhook.secretCopied') })
    } catch {
      notify({ kind: 'error', message: t('workspaceMcp.copyFailed') })
    }
  }

  const eventTypes = Object.keys(WEBHOOK_EVENT_LABELS) as WebhookEventType[]

  const compactButtonStyle = {
    ...dshSettingsButtonStyle,
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 32,
    padding: '6px 9px',
    fontSize: uiFontSize(12),
    lineHeight: 1.25,
    whiteSpace: 'normal' as const,
  }

  return createElement('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12 },
  },
    createElement('div', { style: dshSettingsNoteStyle },
      createElement('strong', { style: { display: 'block', marginBottom: 4 } }, t('workspaceMcp.setupTitle')),
      createElement('span', undefined, t('workspaceMcp.setupInstruction')),
    ),
    createElement(SettingsToggleRow, {
      label: t('workspaceMcp.lanAccessLabel'),
      description: t('workspaceMcp.lanAccessDescription'),
      checked: lanAccessEnabled,
      disabled: !enabled || loading || !snapshot.writable || busy,
      onChange: updateLanAccess,
    }),
    createElement('div', { style: { display: 'flex', flexWrap: 'nowrap', gap: 8, minWidth: 0 } },
      createElement('button', {
        type: 'button',
        style: compactButtonStyle,
        onClick: () => setCapabilitiesOpen(true),
      }, t('workspaceMcp.capabilityDescription')),
      createElement('button', {
        type: 'button', disabled: busy || loading,
        onClick: () => void generateKey(), style: compactButtonStyle,
      }, busy ? t('workspaceMcp.generating') : t(status?.apiKeyConfigured ? 'workspaceMcp.rotateKey' : 'workspaceMcp.generateKey')),
      createElement('button', {
        type: 'button',
        disabled: loading || busy,
        onClick: () => setRefreshCount((count) => count + 1),
        style: compactButtonStyle,
      }, t('workspaceMcp.refresh')),
    ),
    generatedKey === null ? null : createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
      createElement('input', {
        type: 'text', readOnly: true, value: generatedKey, autoComplete: 'off', spellCheck: false,
        'aria-label': t('workspaceMcp.generatedKey'), style: { ...dshSettingsFieldStyle, flex: '1 1 260px', minWidth: 0 },
        onFocus: (event: { currentTarget: { select(): void } }) => event.currentTarget.select(),
      }),
      createElement('button', { type: 'button', onClick: () => void copyKey(), style: dshSettingsButtonStyle }, t('workspaceMcp.copyKey')),
      createElement('span', { style: { flexBasis: '100%', color: dshThemeColor.warning, fontSize: uiFontSize(12), lineHeight: 1.5 } }, t('workspaceMcp.keyShownOnce')),
    ),
    createElement('div', { 'aria-live': 'polite', style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: uiFontSize(12), lineHeight: 1.5, overflowWrap: 'anywhere' } },
      createElement('strong', undefined, t('workspaceMcp.statusTitle')),
      loading ? createElement('span', undefined, t('workspaceMcp.loading')) : null,
      failed ? createElement('span', { role: 'alert', style: { color: dshThemeColor.error } }, t('workspaceMcp.statusFailed')) : null,
      status !== null && !loading ? createElement('span', undefined, t('workspaceMcp.apiKeyStatus', { status: t(status.apiKeyConfigured ? 'workspaceMcp.configured' : 'workspaceMcp.notConfigured') })) : null,
      status !== null && !loading ? createElement('span', undefined, t('workspaceMcp.enabledStatus', { status: t(status.enabled ? 'workspaceMcp.on' : 'workspaceMcp.off') })) : null,
      status !== null && !loading ? createElement('span', undefined, t('workspaceMcp.listeningStatus', { status: t(status.listening ? 'workspaceMcp.on' : 'workspaceMcp.off') })) : null,
      status !== null && !loading ? createElement('span', undefined, t('workspaceMcp.lanAccessStatus', { status: t(status.lanAccessEnabled ? 'workspaceMcp.on' : 'workspaceMcp.off') })) : null,
      status !== null && !loading && endpoint !== null ? createElement('span', undefined,
        createElement('span', { style: { color: dshThemeColor.labelSecondary } }, `${t('workspaceMcp.url')}: `),
        createElement('code', undefined, endpoint),
      ) : null,
      reasonKey !== null && status !== null && !loading ? createElement('span', { style: { color: dshThemeColor.labelSecondary } }, t(reasonKey)) : null,
    ),
    createElement('section', {
      style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: `1px solid ${dshThemeColor.border}` },
      'data-workspace-mcp-webhooks': true,
    },
      createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
        createElement('strong', { style: { fontSize: uiFontSize(13) } }, t('workspaceMcp.webhook.title')),
        createElement('button', {
          type: 'button', disabled: webhookBusy || webhookState?.destinations.length === 20,
          onClick: () => setWebhookEditor({ name: '', url: '', workspaceIds: null, eventTypes: ['session.completed'], includeLastMessage: true }),
          style: { ...dshSettingsPrimaryButtonStyle, minHeight: 32, padding: '6px 10px', fontSize: uiFontSize(12) },
        }, t('workspaceMcp.webhook.add')),
      ),
      createElement('p', { style: { margin: 0, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), lineHeight: 1.5 } }, t('workspaceMcp.webhook.notice')),
      createElement('p', { style: { margin: 0, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), lineHeight: 1.5 } }, t('workspaceMcp.webhook.mcpHint')),
      webhookFailed ? createElement('span', { role: 'alert', style: { color: dshThemeColor.error, fontSize: uiFontSize(12) } }, t('workspaceMcp.webhook.loadFailed')) : null,
      webhookState?.destinations.length === 0 ? createElement('span', { style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12) } }, t('workspaceMcp.webhook.empty')) : null,
      webhookState === null && !webhookFailed ? createElement('span', { style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12) } }, t('workspaceMcp.loading')) : null,
      webhookState?.destinations.map((destination) => {
        const lastDelivery = webhookState.deliveries.find((delivery) => delivery.destinationId === destination.id)
        return createElement('div', {
          key: destination.id,
          style: { display: 'flex', flexDirection: 'column', gap: 7, padding: '10px 0', borderTop: `1px solid ${dshThemeColor.border}` },
        },
          createElement('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
            createElement('div', { style: { display: 'grid', gap: 3, minWidth: 0, overflowWrap: 'anywhere' } },
              createElement('strong', undefined, destination.name),
              createElement('code', { style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(11), overflowWrap: 'anywhere' } }, destination.url),
              createElement('span', { style: { color: destination.enabled ? dshThemeColor.success : dshThemeColor.labelSecondary, fontSize: uiFontSize(12) } }, t(destination.enabled ? 'workspaceMcp.webhook.enabled' : 'workspaceMcp.webhook.disabled')),
              createElement('span', { style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12) } }, lastDelivery === undefined
                ? t('workspaceMcp.webhook.noDelivery')
                : t('workspaceMcp.webhook.lastDelivery', {
                  status: t(`workspaceMcp.webhook.delivery.${lastDelivery.status}`),
                  ...(lastDelivery.httpStatus === undefined ? {} : { httpStatus: String(lastDelivery.httpStatus) }),
                  ...(lastDelivery.lastError === null ? {} : { error: lastDelivery.lastError }),
                })),
            ),
            createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              createElement('button', { type: 'button', disabled: webhookBusy, style: compactButtonStyle, onClick: () => void updateWebhook('webhook-update', { id: destination.id, enabled: !destination.enabled }, '') }, t(destination.enabled ? 'workspaceMcp.webhook.disable' : 'workspaceMcp.webhook.enable')),
              createElement('button', { type: 'button', disabled: webhookBusy, style: compactButtonStyle, onClick: () => setWebhookEditor({ id: destination.id, name: destination.name, url: '', workspaceIds: destination.workspaceIds, eventTypes: destination.eventTypes, includeLastMessage: destination.includeLastMessage }) }, t('workspaceMcp.webhook.edit')),
              createElement('button', { type: 'button', disabled: webhookBusy, style: compactButtonStyle, onClick: () => void testWebhook(destination) }, t('workspaceMcp.webhook.test')),
              createElement('button', { type: 'button', disabled: webhookBusy, style: compactButtonStyle, onClick: () => void rotateWebhookSecret(destination) }, t('workspaceMcp.webhook.rotateSecret')),
              createElement('button', { type: 'button', disabled: webhookBusy, style: { ...compactButtonStyle, color: dshThemeColor.error }, onClick: () => setConfirmDeleteId(destination.id) }, t('workspaceMcp.webhook.delete')),
            ),
          ),
          confirmDeleteId === destination.id ? createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } },
            createElement('span', { style: { marginRight: 'auto', color: dshThemeColor.warning, fontSize: uiFontSize(12) } }, t('workspaceMcp.webhook.deleteConfirm')),
            createElement('button', { type: 'button', disabled: webhookBusy, style: compactButtonStyle, onClick: () => setConfirmDeleteId(null) }, t('workspaceMcp.webhook.cancel')),
            createElement('button', { type: 'button', disabled: webhookBusy, style: { ...compactButtonStyle, color: dshThemeColor.error }, onClick: async () => { const result = await updateWebhook('webhook-delete', { id: destination.id }, ''); if (result !== null) setConfirmDeleteId(null) } }, t('workspaceMcp.webhook.confirmDelete')),
          ) : null,
        )
      }) ?? null,
      webhookState !== null ? createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8, borderTop: `1px solid ${dshThemeColor.border}` } },
        ...eventTypes.map((type) => createElement('span', { key: type, style: { color: webhookState.events[type]?.available ? dshThemeColor.labelSecondary : dshThemeColor.warning, fontSize: uiFontSize(11), lineHeight: 1.45 } },
          `${t(WEBHOOK_EVENT_LABELS[type])}: ${t(webhookState.events[type]?.available ? 'workspaceMcp.webhook.available' : 'workspaceMcp.webhook.unavailable')}`,
        )),
      ) : null,
    ),
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12, borderTop: `1px solid ${dshThemeColor.border}` } },
      createElement('strong', { style: { fontSize: uiFontSize(13) } }, t('workspaceMcp.installPromptTitle')),
      createElement('span', { style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), lineHeight: 1.5 } }, t('workspaceMcp.installPromptHint')),
      createElement('pre', {
        style: {
          margin: 0,
          padding: 10,
          maxHeight: 112,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          border: `1px solid ${dshThemeColor.border}`,
          borderRadius: 6,
          color: dshThemeColor.labelSecondary,
          background: dshThemeColor.pageBackground,
          fontSize: uiFontSize(11),
          lineHeight: 1.45,
        },
      }, installPrompt),
      createElement('button', {
        type: 'button',
        onClick: () => void copyInstallPrompt(),
        style: { ...dshSettingsButtonStyle, alignSelf: 'flex-end', minHeight: 32, padding: '6px 10px', fontSize: uiFontSize(12) },
      }, t('workspaceMcp.copyInstallPrompt')),
    ),
    webhookEditor === null || webhookState === null ? null : createWorkspaceMcpWebhookEditor(t, webhookEditor, webhookState, webhookBusy,
      (next) => setWebhookEditor(next), () => setWebhookEditor(null), () => void saveWebhook()),
    webhookSecret === null ? null : createWorkspaceMcpWebhookSecretModal(t, webhookSecret, copyWebhookSecret, () => setWebhookSecret(null)),
    capabilitiesOpen ? createWorkspaceMcpCapabilitiesModal(t, () => setCapabilitiesOpen(false)) : null,
  )
}

function createWorkspaceMcpCapabilitiesModal(
  t: ReturnType<typeof useCodingNsTranslator>,
  onClose: () => void,
): ReactElement {
  return createElement('div', {
    role: 'presentation',
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 2000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
      background: 'rgba(0, 0, 0, 0.62)',
      boxSizing: 'border-box',
    },
    'data-workspace-mcp-capabilities': true,
  },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'codingns-workspace-mcp-capability-title',
      onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: 'min(960px, 100%)',
        maxHeight: 'min(820px, calc(100dvh - 32px))',
        overflow: 'hidden',
        border: `1px solid ${dshThemeColor.border}`,
        borderRadius: 12,
        background: dshThemeColor.menuBackground,
        color: dshThemeColor.labelPrimary,
        boxShadow: '0 20px 70px rgba(0, 0, 0, 0.45)',
      },
    },
      createElement('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          padding: '18px 20px 14px',
          borderBottom: `1px solid ${dshThemeColor.border}`,
        },
      },
        createElement('div', { style: { minWidth: 0 } },
          createElement('h2', {
            id: 'codingns-workspace-mcp-capability-title',
            style: { margin: 0, fontSize: uiFontSize(18), lineHeight: 1.3 },
          }, t('workspaceMcp.capabilityTitle')),
          createElement('p', {
            style: { margin: '6px 0 0', color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), lineHeight: 1.5 },
          }, t('workspaceMcp.capabilitySubtitle')),
        ),
        createElement('button', {
          type: 'button',
          'aria-label': t('workspaceMcp.closeCapabilities'),
          onClick: onClose,
          style: { ...dshSettingsButtonStyle, minWidth: 36, padding: '8px 10px', fontSize: uiFontSize(18), lineHeight: 1 },
        }, '×'),
      ),
      createElement('div', {
        style: {
          padding: 14,
          overflowY: 'auto',
          overflowX: 'auto',
          overscrollBehavior: 'contain',
        },
      },
        createElement('table', {
          style: {
            width: '100%',
            minWidth: 900,
            borderCollapse: 'collapse',
            tableLayout: 'fixed',
            fontSize: uiFontSize(13),
            lineHeight: 1.5,
          },
        },
          createElement('colgroup', undefined,
            createElement('col', { style: { width: 170 } }),
            createElement('col', { style: { width: 190 } }),
            createElement('col', { style: { width: 230 } }),
            createElement('col', { style: { width: 185 } }),
            createElement('col', { style: { width: 235 } }),
          ),
          createElement('thead', undefined,
            createElement('tr', undefined,
              ...[
                'workspaceMcp.capabilityName',
                'workspaceMcp.capabilityPermission',
                'workspaceMcp.capabilityDescriptionField',
                'workspaceMcp.capabilityParameters',
                'workspaceMcp.capabilityRemarks',
              ].map((key) => createElement('th', {
                key,
                scope: 'col',
                style: {
                  padding: '10px 12px',
                  textAlign: 'left',
                  verticalAlign: 'top',
                  color: dshThemeColor.labelSecondary,
                  fontSize: uiFontSize(12),
                  fontWeight: 650,
                  borderBottom: `1px solid ${dshThemeColor.border}`,
                  background: dshThemeColor.pageBackground,
                },
              }, t(key))),
            ),
          ),
          createElement('tbody', undefined,
            ...WORKSPACE_MCP_CAPABILITIES.map((capability, index) => createElement('tr', {
              key: capability.name,
              style: { background: index % 2 === 0 ? 'rgba(255, 255, 255, 0.025)' : 'transparent' },
            },
              createElement('td', { style: capabilityCellStyle }, createElement('code', { style: { overflowWrap: 'anywhere' } }, capability.name)),
              createElement('td', { style: capabilityCellStyle }, t(capability.permissionKey)),
              createElement('td', { style: capabilityCellStyle }, t(capability.descriptionKey)),
              createElement('td', { style: capabilityCellStyle }, createElement('code', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, t(capability.parametersKey))),
              createElement('td', { style: capabilityCellStyle }, t(capability.remarksKey)),
            )),
          ),
        ),
      ),
      createElement('div', {
        style: { display: 'flex', justifyContent: 'flex-end', padding: '12px 20px 16px', borderTop: `1px solid ${dshThemeColor.border}` },
      },
        createElement('button', { type: 'button', onClick: onClose, style: dshSettingsPrimaryButtonStyle }, t('workspaceMcp.closeCapabilities')),
      ),
    ),
  )
}

function createWorkspaceMcpWebhookEditor(
  t: ReturnType<typeof useCodingNsTranslator>,
  draft: WebhookEditorDraft,
  snapshot: WebhookSnapshot,
  busy: boolean,
  onChange: (draft: WebhookEditorDraft) => void,
  onClose: () => void,
  onSave: () => void,
): ReactElement {
  const fieldStyle = { ...dshSettingsFieldStyle, boxSizing: 'border-box' as const, width: '100%', minWidth: 0 }
  const labelStyle = { display: 'grid', gap: 5, minWidth: 0, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12) }
  const update = (patch: Partial<WebhookEditorDraft>): void => onChange({ ...draft, ...patch })
  const eventTypes = Object.keys(WEBHOOK_EVENT_LABELS) as WebhookEventType[]
  return createElement('div', {
    role: 'presentation', onMouseDown: (event: { target: unknown; currentTarget: unknown }) => { if (event.target === event.currentTarget) onClose() },
    style: { position: 'fixed', inset: 0, zIndex: 2100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: dshThemeColor.overlay, boxSizing: 'border-box' },
  },
    createElement('form', {
      role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'codingns-workspace-mcp-webhook-title',
      onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); onSave() },
      style: { display: 'grid', gap: 12, width: 'min(560px, 100%)', maxHeight: 'min(760px, calc(100dvh - 32px))', overflowY: 'auto', padding: 18, border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, background: dshThemeColor.menuBackground, color: dshThemeColor.labelPrimary, boxSizing: 'border-box' },
    },
      createElement('h2', { id: 'codingns-workspace-mcp-webhook-title', style: { margin: 0, fontSize: uiFontSize(17) } }, t(draft.id === undefined ? 'workspaceMcp.webhook.addTitle' : 'workspaceMcp.webhook.editTitle')),
      createElement('label', { style: labelStyle }, t('workspaceMcp.webhook.name'), createElement('input', {
        required: true, maxLength: 80, value: draft.name, style: fieldStyle,
        onChange: (event: { currentTarget: { value: string } }) => update({ name: event.currentTarget.value }),
      })),
      createElement('label', { style: labelStyle }, t('workspaceMcp.webhook.url'), createElement('input', {
        required: draft.id === undefined, maxLength: 2048, type: 'url', placeholder: draft.id === undefined ? 'https://' : t('workspaceMcp.webhook.keepUrl'), value: draft.url, style: fieldStyle,
        onChange: (event: { currentTarget: { value: string } }) => update({ url: event.currentTarget.value }),
      })),
      createElement('fieldset', { style: { display: 'grid', gap: 6, margin: 0, padding: 0, border: 0 } },
        createElement('legend', { style: { marginBottom: 6, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12) } }, t('workspaceMcp.webhook.workspaces')),
        createElement('label', { style: checkboxLabelStyle }, createElement('input', {
          type: 'checkbox', checked: draft.workspaceIds === null,
          onChange: (event: { currentTarget: { checked: boolean } }) => update({ workspaceIds: event.currentTarget.checked ? null : [] }),
        }), t('workspaceMcp.webhook.allWorkspaces')),
        draft.workspaceIds === null ? null : snapshot.workspaces.map((workspace) => createElement('label', { key: workspace.id, style: checkboxLabelStyle }, createElement('input', {
          type: 'checkbox', checked: draft.workspaceIds?.includes(workspace.id) === true,
          onChange: (event: { currentTarget: { checked: boolean } }) => update({ workspaceIds: event.currentTarget.checked
            ? [...(draft.workspaceIds ?? []), workspace.id]
            : (draft.workspaceIds ?? []).filter((id) => id !== workspace.id) }),
        }), workspace.name)),
      ),
      createElement('fieldset', { style: { display: 'grid', gap: 6, margin: 0, padding: 0, border: 0 } },
        createElement('legend', { style: { marginBottom: 6, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12) } }, t('workspaceMcp.webhook.events')),
        ...eventTypes.map((type) => {
          const available = snapshot.events[type]?.available === true
          const checked = draft.eventTypes.includes(type)
          return createElement('label', { key: type, style: { ...checkboxLabelStyle, opacity: available ? 1 : 0.65 } }, createElement('input', {
            type: 'checkbox', checked, disabled: busy || (!available && !checked),
            onChange: (event: { currentTarget: { checked: boolean } }) => update({ eventTypes: event.currentTarget.checked
              ? [...draft.eventTypes, type]
              : draft.eventTypes.filter((item) => item !== type) }),
          }), t(WEBHOOK_EVENT_LABELS[type]), available ? null : t('workspaceMcp.webhook.unavailable'))
        }),
      ),
      createElement('label', { style: checkboxLabelStyle }, createElement('input', {
        type: 'checkbox', checked: draft.includeLastMessage,
        onChange: (event: { currentTarget: { checked: boolean } }) => update({ includeLastMessage: event.currentTarget.checked }),
      }), t('workspaceMcp.webhook.includeLastMessage')),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', paddingTop: 8, borderTop: `1px solid ${dshThemeColor.border}` } },
        createElement('button', { type: 'button', disabled: busy, style: dshSettingsButtonStyle, onClick: onClose }, t('workspaceMcp.webhook.cancel')),
        createElement('button', { type: 'submit', disabled: busy || draft.eventTypes.length === 0, style: dshSettingsPrimaryButtonStyle }, busy ? t('workspaceMcp.webhook.saving') : t('workspaceMcp.webhook.save')),
      ),
    ),
  )
}

function createWorkspaceMcpWebhookSecretModal(
  t: ReturnType<typeof useCodingNsTranslator>,
  secret: { readonly name: string; readonly secret: string },
  onCopy: () => void,
  onClose: () => void,
): ReactElement {
  return createElement('div', {
    role: 'presentation', onMouseDown: (event: { target: unknown; currentTarget: unknown }) => { if (event.target === event.currentTarget) onClose() },
    style: { position: 'fixed', inset: 0, zIndex: 2200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: dshThemeColor.overlay, boxSizing: 'border-box' },
  },
    createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'codingns-workspace-mcp-webhook-secret-title', style: { display: 'grid', gap: 12, width: 'min(500px, 100%)', padding: 18, border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, background: dshThemeColor.menuBackground, color: dshThemeColor.labelPrimary, boxSizing: 'border-box' } },
      createElement('h2', { id: 'codingns-workspace-mcp-webhook-secret-title', style: { margin: 0, fontSize: uiFontSize(17) } }, t('workspaceMcp.webhook.secretTitle', { name: secret.name })),
      createElement('input', { type: 'text', readOnly: true, value: secret.secret, 'aria-label': t('workspaceMcp.webhook.secretTitle', { name: secret.name }), style: { ...dshSettingsFieldStyle, boxSizing: 'border-box', width: '100%', minWidth: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }, onFocus: (event: { currentTarget: { select(): void } }) => event.currentTarget.select() }),
      createElement('span', { style: { color: dshThemeColor.warning, fontSize: uiFontSize(12), lineHeight: 1.5 } }, t('workspaceMcp.webhook.secretOnce')),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        createElement('button', { type: 'button', style: dshSettingsButtonStyle, onClick: onCopy }, t('workspaceMcp.copyKey')),
        createElement('button', { type: 'button', style: dshSettingsPrimaryButtonStyle, onClick: onClose }, t('workspaceMcp.webhook.closeSecret')),
      ),
    ),
  )
}

const checkboxLabelStyle = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: dshThemeColor.labelPrimary, fontSize: uiFontSize(12), lineHeight: 1.45, overflowWrap: 'anywhere' as const }

const capabilityCellStyle = {
  padding: '11px 12px',
  textAlign: 'left' as const,
  verticalAlign: 'top' as const,
  overflowWrap: 'anywhere' as const,
  borderBottom: `1px solid ${dshThemeColor.border}`,
}

function normalizeStatus(value: unknown): WorkspaceMcpStatus | null {
  if (!isRecord(value)
    || typeof value.apiKeyConfigured !== 'boolean'
    || typeof value.enabled !== 'boolean'
    || typeof value.listening !== 'boolean'
    || (value.url !== null && typeof value.url !== 'string')
    || (value.reason !== null && typeof value.reason !== 'string')) return null
  return {
    apiKeyConfigured: value.apiKeyConfigured,
    enabled: value.enabled,
    listening: value.listening,
    lanAccessEnabled: value.lanAccessEnabled === true,
    url: value.url,
    reason: value.reason,
  }
}

function webhookErrorMessage(error: unknown, t: ReturnType<typeof useCodingNsTranslator>): string {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  const key = code === 'WORKSPACE_MCP_WEBHOOK_INVALID_URL' ? 'workspaceMcp.webhook.error.invalidUrl'
    : code === 'WORKSPACE_MCP_WEBHOOK_LIMIT' ? 'workspaceMcp.webhook.error.limit'
      : code === 'WORKSPACE_MCP_WEBHOOK_NOT_FOUND' ? 'workspaceMcp.webhook.error.notFound'
        : code === 'CODINGNS_RPC_FORBIDDEN' ? 'workspaceMcp.webhook.error.forbidden'
          : 'workspaceMcp.webhook.error.generic'
  return t(key)
}

function normalizeWebhookSnapshot(value: unknown): WebhookSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.destinations) || !Array.isArray(value.deliveries)
    || !Array.isArray(value.workspaces) || !isRecord(value.events)) return null
  const eventTypes = Object.keys(WEBHOOK_EVENT_LABELS) as WebhookEventType[]
  const destinations = value.destinations.flatMap((raw): WebhookDestination[] => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.url !== 'string'
      || typeof raw.enabled !== 'boolean' || (raw.workspaceIds !== null && (!Array.isArray(raw.workspaceIds) || !raw.workspaceIds.every((id) => typeof id === 'string')))
      || !Array.isArray(raw.eventTypes) || !raw.eventTypes.every((type) => eventTypes.includes(type as WebhookEventType))
      || typeof raw.includeLastMessage !== 'boolean') return []
    return [{
      id: raw.id,
      name: raw.name,
      url: raw.url,
      enabled: raw.enabled,
      workspaceIds: raw.workspaceIds as readonly string[] | null,
      eventTypes: raw.eventTypes as WebhookEventType[],
      includeLastMessage: raw.includeLastMessage,
    }]
  })
  const deliveries = value.deliveries.flatMap((raw): WebhookDelivery[] => {
    if (!isRecord(raw) || typeof raw.deliveryId !== 'string' || typeof raw.destinationId !== 'string'
      || (raw.status !== 'pending' && raw.status !== 'sending' && raw.status !== 'delivered' && raw.status !== 'failed')
      || (raw.lastError !== null && typeof raw.lastError !== 'string') || typeof raw.createdAt !== 'string'
      || (raw.httpStatus !== undefined && typeof raw.httpStatus !== 'number')) return []
    return [{ deliveryId: raw.deliveryId, destinationId: raw.destinationId, status: raw.status,
      lastError: raw.lastError, ...(typeof raw.httpStatus === 'number' ? { httpStatus: raw.httpStatus } : {}), createdAt: raw.createdAt }]
  })
  const workspaces = value.workspaces.flatMap((raw): WebhookWorkspace[] => isRecord(raw) && typeof raw.id === 'string' && typeof raw.name === 'string'
    ? [{ id: raw.id, name: raw.name }]
    : [])
  const availability = value.events
  const events = Object.fromEntries(eventTypes.map((type) => {
    const raw = availability[type]
    return [type, isRecord(raw) && typeof raw.available === 'boolean'
      ? { available: raw.available, reason: typeof raw.reason === 'string' ? raw.reason : null }
      : { available: false, reason: null }]
  })) as Record<WebhookEventType, WebhookEventAvailability>
  return { destinations, deliveries, workspaces, events }
}

function safeWorkspaceMcpUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.search !== '' || url.hash !== '' || url.pathname !== '/mcp'
      || value !== `${url.origin}/mcp`) return null
    return url.toString()
  } catch {
    return null
  }
}

function normalizeLanAccessSnapshot(value: unknown): LanAccessDshSnapshot | null {
  if (!isRecord(value)
    || typeof value.listenHost !== 'string'
    || typeof value.listenPort !== 'number'
    || typeof value.dshPort !== 'number'
    || (value.actualListenPort !== null && typeof value.actualListenPort !== 'number')
    || (value.state !== 'starting' && value.state !== 'listening' && value.state !== 'stopped' && value.state !== 'error')
    || !Array.isArray(value.detectedDshPorts)
    || value.detectedDshPorts.some((port) => typeof port !== 'number')
    || (value.error !== null && typeof value.error !== 'string')
    || typeof value.loginEnabled !== 'boolean') return null
  return value as unknown as LanAccessDshSnapshot
}

function workspaceMcpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
    if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '[::]') return null
    return `${url.origin}/mcp`
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
