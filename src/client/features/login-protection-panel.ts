import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { LanAccessDshLoginSettings, LoginProtectionScopes } from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { FeaturePanelProps, CodingNsRpcClient } from './types.js'
import {
  dshFormRootStyle,
  dshSettingsButtonStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsPrimaryButtonStyle,
  dshThemeColor,
} from '../theme.js'
import { writeLoginProtectionSession } from './login-protection-session.js'
import { useCodingNsTranslator } from '../locale.js'

const DEFAULT_SCOPES: LoginProtectionScopes = { lan: true, relay: true }

/** 独立的登录保护设置卡片，凭据实际由 Host 保存和校验。 */
export function LoginProtectionPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const { rpc } = services
  const t = useCodingNsTranslator(services.locale)
  const controlsDisabled = !enabled || snapshot.status === 'loading' || !snapshot.writable
  const [saved, setSaved] = useState<LanAccessDshLoginSettings>({ enabled: false, username: '', passwordConfigured: false, timeoutSeconds: 1800, scopes: DEFAULT_SCOPES })
  const [active, setActive] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [timeoutSeconds, setTimeoutSeconds] = useState('1800')
  const [scopes, setScopes] = useState<LoginProtectionScopes>(DEFAULT_SCOPES)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!enabled) return
    void callRpc<LanAccessDshLoginSettings>(rpc, 'lanAccessDsh/login/get', {})
      .then((value) => {
        setSaved(value)
        setActive(value.enabled)
        setUsername(value.username)
        setTimeoutSeconds(String(value.timeoutSeconds))
        setScopes(value.scopes ?? DEFAULT_SCOPES)
      })
      .catch((error: unknown) => notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }, [enabled, rpc])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const parsedTimeout = Number(timeoutSeconds)
      if (!Number.isInteger(parsedTimeout) || parsedTimeout < 60 || parsedTimeout > 604800) throw new Error(t('loginProtection.errorTimeoutRange'))
      if (active && !Object.values(scopes).some(Boolean)) throw new Error(t('loginProtection.errorScopesRequired'))
      const value = await callRpc<LanAccessDshLoginSettings & { relaySession?: { token: string; expiresAt: string } }>(rpc, 'lanAccessDsh/login/set', {
        enabled: active,
        username,
        password,
        timeoutSeconds: parsedTimeout,
        scopes,
      })
      setSaved(value)
      setActive(value.enabled)
      if (value.relaySession?.token !== undefined) {
        writeLoginProtectionSession(value.relaySession.token)
      } else if (!value.enabled || !value.scopes.relay) {
        writeLoginProtectionSession(undefined)
      }
      setPassword('')
      notify({ kind: 'success', message: value.enabled && value.scopes.relay && password === '' ? t('loginProtection.savedRelaySession') : t('loginProtection.saved') })
    } catch (error) {
      notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const toggleScope = (scope: keyof LoginProtectionScopes): void => setScopes((current) => ({ ...current, [scope]: !current[scope] }))
  const field = dshSettingsFieldStyle
  const button = dshSettingsButtonStyle

  return createElement('div', {
    style: { ...dshFormRootStyle, display: 'flex', flexDirection: 'column', gap: 14, opacity: controlsDisabled ? 0.5 : 1 },
    'aria-disabled': controlsDisabled,
  },
    createElement('p', { style: { margin: 0, color: dshThemeColor.labelSecondary, fontSize: 13, lineHeight: 1.5 } }, t('loginProtection.panelHint')),
    createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: dshThemeColor.labelSecondary, fontSize: 13 } },
      createElement('input', { type: 'checkbox', checked: active, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { checked: boolean } }) => setActive(event.currentTarget.checked), style: { accentColor: dshThemeColor.accent } }),
      createElement('span', undefined, t('loginProtection.enable')),
    ),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', { style: dshSettingsFieldLabelStyle }, t('loginProtection.username')),
      createElement('input', { value: username, disabled: controlsDisabled || busy || !active, autoComplete: 'username', onChange: (event: { currentTarget: { value: string } }) => setUsername(event.currentTarget.value), style: field }),
    ),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', { style: dshSettingsFieldLabelStyle }, saved.passwordConfigured ? t('loginProtection.newPassword') : t('loginProtection.password')),
      createElement('input', { type: 'password', value: password, disabled: controlsDisabled || busy || !active, autoComplete: 'new-password', onChange: (event: { currentTarget: { value: string } }) => setPassword(event.currentTarget.value), style: field }),
    ),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', { style: dshSettingsFieldLabelStyle }, t('loginProtection.timeoutSeconds')),
      createElement('input', { type: 'number', min: 60, max: 604800, value: timeoutSeconds, disabled: controlsDisabled || busy || !active, onChange: (event: { currentTarget: { value: string } }) => setTimeoutSeconds(event.currentTarget.value), style: field }),
    ),
    createElement('fieldset', { disabled: controlsDisabled || busy || !active, style: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 12, border: `1px solid ${dshThemeColor.border}`, borderRadius: 6 } },
      createElement('legend', { style: dshSettingsFieldLabelStyle }, t('loginProtection.scopes')),
      ...([
        ['lan', t('loginProtection.scopeLan'), t('loginProtection.scopeLanHint')],
        ['relay', t('loginProtection.scopeRelay'), t('loginProtection.scopeRelayHint')],
      ] as const).map(([key, label, hint]) => createElement('label', { key, style: { display: 'flex', alignItems: 'center', gap: 8, color: dshThemeColor.labelSecondary, fontSize: 13 } },
        createElement('input', { type: 'checkbox', checked: scopes[key], onChange: () => toggleScope(key), style: { accentColor: dshThemeColor.accent } }),
        createElement('span', undefined, t('loginProtection.scopeOption', { label, hint })),
      )),
    ),
    createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void save(), style: dshSettingsPrimaryButtonStyle }, busy ? t('loginProtection.saving') : t('loginProtection.save')),
  )
}

async function callRpc<T>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> {
  let response
  try {
    response = await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/HTTP (?:404|405)\b/u.test(message)) throw error
    response = await rpc.call('/api', `codingns/${endpoint}`, payload)
  }
  if (!response.ok) throw new Error(response.error.message)
  return response.value as T
}
