import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { FeaturePanelProps, CodingNsClientFeatureModule } from './types.js'
import { resolveCodingNsTranslator, useCodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsNoteStyle, dshThemeColor } from '../theme.js'
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
  disabled: 'workspaceMcp.reason.disabled',
  'listen-failed': 'workspaceMcp.reason.listenFailed',
  'listener-error': 'workspaceMcp.reason.listenFailed',
  'startup-failed': 'workspaceMcp.reason.listenFailed',
}

function WorkspaceMcpPanel({ services, enabled }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [status, setStatus] = useState<WorkspaceMcpStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    void services.rpc.call('codingns', 'workspaceMcp/status', {}).then((result) => {
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

  return createElement('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12 },
  },
    createElement('div', { style: dshSettingsNoteStyle },
      createElement('strong', { style: { display: 'block', marginBottom: 4 } }, t('workspaceMcp.setupTitle')),
      createElement('span', undefined, t('workspaceMcp.setupInstruction')),
      createElement('code', { style: { display: 'block', marginTop: 6, overflowWrap: 'anywhere' } }, 'CODINGNS_WORKSPACE_MCP_API_KEY'),
      createElement('span', { style: { display: 'block', marginTop: 6 } }, t('workspaceMcp.restartHost')),
      createElement('span', { style: { display: 'block', marginTop: 6, color: dshThemeColor.labelSecondary } }, t('workspaceMcp.noKeyUi')),
    ),
    status?.apiKeyConfigured === false
      ? createElement('p', { role: 'status', style: { margin: 0, color: dshThemeColor.warning, fontSize: uiFontSize(12), lineHeight: 1.5 } }, t('workspaceMcp.keyRequired'))
      : null,
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
