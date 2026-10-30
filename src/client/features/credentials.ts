import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { FeaturePanelProps, CodingNsClientFeatureModule } from './types.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { resolveCodingNsTranslator, useCodingNsTranslator } from '../locale.js'
import { dshSettingsFieldStyle, dshSettingsNoteStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import { uiFontSize } from '../font-scale.js'
import { registerCredentialCommand, registerCredentialReferenceSource, registerCredentialUserTextRule } from '../credential-reference.js'
import { startCredentialUiDom } from '../credential-ui-dom.js'

const fallbackT = resolveCodingNsTranslator()

export const credentialsFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'credentials',
    version: '0.1.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: fallbackT('feature.credentials.label'),
      description: fallbackT('feature.credentials.description'),
      labelKey: 'feature.credentials.label',
      descriptionKey: 'feature.credentials.description',
      order: 55,
      defaultOpen: false,
    },
  },
  start(context) {
    if (context.services.uiContext !== undefined) {
      context.resources.add(registerCredentialReferenceSource(context.services.uiContext, context.services.rpc, context.services.locale))
      context.resources.add(registerCredentialCommand(context.services.uiContext, context.services.rpc, context.services.locale))
      context.resources.add(registerCredentialUserTextRule(context.services.uiContext))
      const translate = context.services.locale.bind('codingns')
      context.resources.add(startCredentialUiDom({ menuLabel: () => translate('credentials.commandLabel') }))
    }
  },
  settingsPanel: CredentialsModuleSettingsPanel,
}

function CredentialsModuleSettingsPanel({ services, enabled, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [configured, setConfigured] = useState(false)
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void services.rpc.call(CODINGNS_RPC_CHANNEL, 'credentials/master-password/status', {})
      .then((result) => {
        if (result.ok && isRecord(result.value) && result.value.configured === true) setConfigured(true)
      })
      .catch(() => undefined)
  }, [services.rpc])

  const save = async (): Promise<void> => {
    if (password.trim() === '') return
    setBusy(true)
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'credentials/master-password/set', {
        ...(configured ? { currentPassword } : {}),
        password,
      })
      if (!result.ok) throw new Error(result.error.message)
      setConfigured(true)
      setPassword('')
      setCurrentPassword('')
      notify({ kind: 'success', message: t('credentials.masterPasswordSaved') })
    } catch (error) {
      notify({ kind: 'error', message: error instanceof Error ? error.message : t('credentials.failed') })
    } finally {
      setBusy(false)
    }
  }

  return createElement('div', { style: { display: 'grid', gap: 12 } },
    createElement('p', { style: dshSettingsNoteStyle }, t('credentials.masterPasswordHint')),
    configured && createElement('label', { style: dshSettingsFieldStyle }, t('credentials.currentMasterPassword'),
      createElement('input', {
        type: 'password',
        value: currentPassword,
        disabled: !enabled || busy,
        onChange: (event: { currentTarget: { value: string } }) => setCurrentPassword(event.currentTarget.value),
        style: inputStyle,
        autoComplete: 'current-password',
      }),
    ),
    createElement('label', { style: dshSettingsFieldStyle }, configured ? t('credentials.newMasterPassword') : t('credentials.masterPassword'),
      createElement('input', {
        type: 'password',
        value: password,
        disabled: !enabled || busy,
        onChange: (event: { currentTarget: { value: string } }) => setPassword(event.currentTarget.value),
        style: inputStyle,
        autoComplete: configured ? 'new-password' : 'new-password',
      }),
    ),
    createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
      createElement('button', { type: 'button', style: dshSettingsPrimaryButtonStyle, disabled: !enabled || busy || password.trim() === '', onClick: () => { void save() } }, t('credentials.saveMasterPassword')),
    ),
  )
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const inputStyle = { width: '100%', boxSizing: 'border-box' as const, border: `1px solid ${dshThemeColor.border}`, borderRadius: 6, padding: '7px 8px', color: dshThemeColor.labelPrimary, background: dshThemeColor.surfaceSubtle, fontSize: uiFontSize(13) }
