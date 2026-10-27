import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { FeaturePanelProps, CodingNsClientFeatureModule } from './types.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { resolveCodingNsTranslator, useCodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsFieldStyle, dshSettingsNoteStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import { uiFontSize } from '../font-scale.js'

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
  readonly url: string | null
  readonly reason: string | null
}

const REASON_KEYS: Readonly<Record<string, string>> = {
  'api-key-missing': 'workspaceMcp.reason.keyMissing',
  'api-key-not-configured': 'workspaceMcp.reason.keyMissing',
  'key-store-failed': 'workspaceMcp.reason.keyStoreFailed',
  disabled: 'workspaceMcp.reason.disabled',
  'listen-failed': 'workspaceMcp.reason.listenFailed',
  'listener-error': 'workspaceMcp.reason.listenFailed',
  'startup-failed': 'workspaceMcp.reason.listenFailed',
}

function WorkspaceMcpPanel({ services, enabled, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [status, setStatus] = useState<WorkspaceMcpStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refreshCount, setRefreshCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)

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
  }, [services.rpc, enabled, refreshCount])

  const reasonKey = status?.reason === null || status?.reason === undefined
    ? null
    : Object.prototype.hasOwnProperty.call(REASON_KEYS, status.reason)
      ? REASON_KEYS[status.reason] ?? 'workspaceMcp.reason.other'
      : 'workspaceMcp.reason.other'
  const url = safeWorkspaceMcpUrl(status?.url)

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

  return createElement('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12 },
  },
    createElement('div', { style: dshSettingsNoteStyle },
      createElement('strong', { style: { display: 'block', marginBottom: 4 } }, t('workspaceMcp.setupTitle')),
      createElement('span', undefined, t('workspaceMcp.setupInstruction')),
    ),
    createElement('button', {
      type: 'button', disabled: busy || loading,
      onClick: () => void generateKey(), style: dshSettingsPrimaryButtonStyle,
    }, busy ? t('workspaceMcp.generating') : t(status?.apiKeyConfigured ? 'workspaceMcp.rotateKey' : 'workspaceMcp.generateKey')),
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
      status !== null && !loading && url !== null ? createElement('span', undefined,
        createElement('span', { style: { color: dshThemeColor.labelSecondary } }, `${t('workspaceMcp.url')}: `),
        createElement('code', undefined, url),
      ) : null,
      reasonKey !== null && status !== null && !loading ? createElement('span', { style: { color: dshThemeColor.labelSecondary } }, t(reasonKey)) : null,
    ),
    createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
      createElement('button', {
        type: 'button',
        disabled: loading,
        onClick: () => setRefreshCount((count) => count + 1),
        style: dshSettingsButtonStyle,
      }, t('workspaceMcp.refresh')),
    ),
  )
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
