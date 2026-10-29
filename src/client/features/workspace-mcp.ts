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
