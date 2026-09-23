import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AuthDeviceManagementSnapshotDto,
  CodingNsAuthSessionSnapshot,
  TunnelBindingSummary,
} from '../../shared/contracts/auth.js'
import {
  CODINGNS_CONTROL_BASE_URL_FIELD,
  CODINGNS_CONTROL_BASE_URLS_FIELD,
  DEFAULT_CODINGNS_CONTROL_BASE_URLS,
} from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { FeaturePanelProps, CodingNsRpcClient } from './types.js'
import { dshButtonStyle, dshFieldStyle, dshFormRootStyle, dshPopupSurfaceStyle, dshThemeColor } from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

/**
 * 「中转访问服务」卡片的设置面板：Control API 地址、登录、设备和 Host 绑定。
 *
 * 密码只在单次 RPC 中经过 Host，表单不保存它；refresh token 只存在于 Host。
 */
export function ReverseProxyPanel({ services, enabled, snapshot }: FeaturePanelProps): ReactElement {
  const { settings, rpc } = services
  const t = useCodingNsTranslator(services.locale)
  const disabled = !enabled

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [controlBaseUrl, setControlBaseUrl] = useState(resolveControlBaseUrl(snapshot.value?.controlBaseUrl))
  const [controlBaseUrls, setControlBaseUrls] = useState(() => uniqueControlBaseUrls(snapshot.value?.controlBaseUrls, snapshot.value?.controlBaseUrl))
  const [newControlBaseUrl, setNewControlBaseUrl] = useState('')
  const [addAddressOpen, setAddAddressOpen] = useState(false)
  const [addressError, setAddressError] = useState('')
  const [hostLabel, setHostLabel] = useState('')
  const [hostPublicKey, setHostPublicKey] = useState('')
  const [hostFingerprint, setHostFingerprint] = useState('')
  const [auth, setAuth] = useState<CodingNsAuthSessionSnapshot>(loggedOutSnapshot())
  const [devices, setDevices] = useState<AuthDeviceManagementSnapshotDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const saved = snapshot.value?.controlBaseUrl
    const resolved = resolveControlBaseUrl(saved)
    setControlBaseUrls(uniqueControlBaseUrls(snapshot.value?.controlBaseUrls, resolved))
    setControlBaseUrl(resolved)
    if (snapshot.status === 'ready' && snapshot.writable && saved !== resolved) {
      void settings.set(CODINGNS_CONTROL_BASE_URL_FIELD, resolved).catch(() => undefined)
    }
  }, [settings, snapshot.status, snapshot.writable, snapshot.value?.controlBaseUrl, snapshot.value?.controlBaseUrls])

  useEffect(() => {
    void callCodingNsRpc<CodingNsAuthSessionSnapshot>(rpc, 'auth/snapshot', {})
      .then(setAuth)
      .catch(() => setAuth(loggedOutSnapshot()))
  }, [rpc])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      await operation()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const login = (): Promise<void> => run(async () => {
    const selectedUrl = normalizeControlBaseUrl(controlBaseUrl)
    const nextUrls = uniqueControlBaseUrls(controlBaseUrls, selectedUrl)
    await settings.set(CODINGNS_CONTROL_BASE_URLS_FIELD, nextUrls)
    await settings.set(CODINGNS_CONTROL_BASE_URL_FIELD, selectedUrl)
    const next = await callCodingNsRpc<CodingNsAuthSessionSnapshot>(rpc, 'auth/login', {
      controlBaseUrl: selectedUrl,
      email,
      password,
    })
    setPassword('')
    setAuth(next)
    setMessage(t('relay.loginSuccess'))
  })

  const logout = (): Promise<void> => run(async () => {
    await callCodingNsRpc(rpc, 'auth/logout', {})
    setAuth(loggedOutSnapshot())
    setDevices(null)
    setMessage(t('relay.loggedOut'))
  })

  const loadDevices = (): Promise<void> => run(async () => {
    setDevices(await callCodingNsRpc<AuthDeviceManagementSnapshotDto>(rpc, 'auth/devices', {}))
  })

  const bindHost = (): Promise<void> => run(async () => {
    const binding = await callCodingNsRpc<TunnelBindingSummary>(rpc, 'auth/bind', {
      hostLabel,
      hostPublicKey,
      hostFingerprint,
    })
    setAuth((current) => ({ ...current, binding }))
    setMessage(t('relay.bindSuccess'))
  })

  const unbindHost = (): Promise<void> => run(async () => {
    if (!auth.binding) return
    await callCodingNsRpc(rpc, 'auth/unbind', { bindingId: auth.binding.bindingId })
    setAuth((current) => ({ ...current, binding: null }))
    setMessage(t('relay.unbindSuccess'))
  })

  const addControlBaseUrl = async (): Promise<void> => {
    setBusy(true)
    setAddressError('')
    try {
      const addedUrl = normalizeControlBaseUrl(newControlBaseUrl)
      const nextUrls = uniqueControlBaseUrls(controlBaseUrls, addedUrl)
      await settings.set(CODINGNS_CONTROL_BASE_URLS_FIELD, nextUrls)
      await settings.set(CODINGNS_CONTROL_BASE_URL_FIELD, addedUrl)
      setControlBaseUrls(nextUrls)
      setControlBaseUrl(addedUrl)
      setNewControlBaseUrl('')
      setAddAddressOpen(false)
      setMessage(t('relay.add'))
    } catch (error) {
      setAddressError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const chooseControlBaseUrl = (value: string): void => {
    setControlBaseUrl(value)
    void settings.set(CODINGNS_CONTROL_BASE_URL_FIELD, value).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error))
    })
  }

  const fieldStyle = { ...dshFieldStyle, width: '100%', boxSizing: 'border-box' as const, padding: '8px 10px', borderRadius: 6 }
  const buttonStyle = { ...dshButtonStyle, padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }
  const authenticated = auth.status === 'authenticated'

  return createElement(
    'div',
    { 'aria-disabled': disabled, style: { ...dshFormRootStyle, display: 'flex', flexDirection: 'column', gap: 16, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' } },
    createElement('div', undefined,
      createElement('h3', { style: { margin: 0, fontSize: 17 } }, t('relay.settings')),
      createElement('p', { style: { margin: '8px 0 0', opacity: 0.65 } }, t('relay.loginHint')),
    ),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', undefined, t('relay.controlApi')),
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement('select', { value: controlBaseUrl, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => chooseControlBaseUrl(event.currentTarget.value), style: { ...fieldStyle, flex: 1, minWidth: 0 } },
          ...controlBaseUrls.map((url) => createElement('option', { key: url, value: url }, url)),
        ),
        createElement('button', { type: 'button', 'aria-haspopup': 'dialog', disabled: disabled || busy, onClick: () => { setAddressError(''); setAddAddressOpen(true) }, style: { ...buttonStyle, flex: '0 0 auto' } }, t('relay.add')),
      ),
    ),
    addAddressOpen && createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'codingns-add-address-title', style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: dshThemeColor.overlay } },
      createElement('div', { style: { ...dshPopupSurfaceStyle, width: 'min(100%, 480px)', boxSizing: 'border-box', padding: 24, borderRadius: 8 } },
        createElement('h3', { id: 'codingns-add-address-title', style: { margin: 0, fontSize: 18 } }, t('relay.addServer')),
        createElement('p', { style: { margin: '8px 0 16px', opacity: 0.7 } }, t('relay.addServerHint')),
        createElement('input', { type: 'url', autoFocus: true, value: newControlBaseUrl, placeholder: 'https://example.com:1443', disabled: busy, onChange: (event: { currentTarget: { value: string } }) => setNewControlBaseUrl(event.currentTarget.value), style: fieldStyle }),
        addressError && createElement('div', { role: 'alert', style: { marginTop: 8, color: dshThemeColor.error } }, addressError),
        createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 } },
          createElement('button', { type: 'button', disabled: busy, onClick: () => { setAddAddressOpen(false); setAddressError('') }, style: buttonStyle }, t('relay.cancel')),
          createElement('button', { type: 'button', disabled: busy || !newControlBaseUrl.trim(), onClick: () => void addControlBaseUrl(), style: buttonStyle }, busy ? t('relay.adding') : t('relay.add')),
        ),
      ),
    ),
    !authenticated && createElement('form', { onSubmit: (event: { preventDefault: () => void }) => { event.preventDefault(); void login() }, style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', undefined, t('relay.email')),
        createElement('input', { type: 'email', autoComplete: 'username', value: email, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setEmail(event.currentTarget.value), style: fieldStyle }),
      ),
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', undefined, t('relay.password')),
        createElement('input', { type: 'password', autoComplete: 'current-password', value: password, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setPassword(event.currentTarget.value), style: fieldStyle }),
      ),
      createElement('button', { type: 'submit', disabled: disabled || busy || !controlBaseUrl || !email || !password, style: buttonStyle }, busy ? t('relay.loggingIn') : t('relay.login')),
    ),
    authenticated && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      createElement('div', { style: { padding: 12, border: `1px solid ${dshThemeColor.border}`, borderRadius: 6 } },
        createElement('strong', undefined, auth.account?.email ?? t('relay.loggedIn')),
        createElement('div', { style: { marginTop: 6, opacity: 0.7 } }, t('relay.device', { value: auth.currentDevice?.displayName ?? auth.currentDevice?.deviceId ?? t('relay.unrecognized') })),
        createElement('div', { style: { marginTop: 4, opacity: 0.7 } }, t('relay.host', { value: auth.binding?.tunnelDomain ?? t('relay.unbound') })),
      ),
      createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        createElement('button', { type: 'button', disabled: disabled || busy, onClick: () => void loadDevices(), style: buttonStyle }, t('relay.refreshDevices')),
        createElement('button', { type: 'button', disabled: disabled || busy, onClick: () => void logout(), style: buttonStyle }, t('relay.logout')),
      ),
      devices && createElement('div', { style: { fontSize: 13, opacity: 0.75 } }, t('relay.devicesSummary', { current: devices.currentDevice?.deviceId ?? t('relay.unknown'), count: devices.otherActiveDevices.length })),
      auth.binding
        ? createElement('button', { type: 'button', disabled: disabled || busy, onClick: () => void unbindHost(), style: buttonStyle }, t('relay.unbindHost'))
        : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          createElement('strong', undefined, t('relay.bindHost')),
          createElement('input', { placeholder: t('relay.hostLabel'), value: hostLabel, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setHostLabel(event.currentTarget.value), style: fieldStyle }),
          createElement('input', { placeholder: t('relay.hostPublicKey'), value: hostPublicKey, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setHostPublicKey(event.currentTarget.value), style: fieldStyle }),
          createElement('input', { placeholder: t('relay.hostFingerprint'), value: hostFingerprint, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setHostFingerprint(event.currentTarget.value), style: fieldStyle }),
          createElement('button', { type: 'button', disabled: disabled || busy || !hostLabel || !hostPublicKey || !hostFingerprint, onClick: () => void bindHost(), style: buttonStyle }, t('relay.bindHost')),
        ),
    ),
    message && createElement('div', { role: 'status', style: { color: message.includes('成功') ? dshThemeColor.success : dshThemeColor.error } }, message),
  )
}

async function callCodingNsRpc<T>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> {
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

function loggedOutSnapshot(): CodingNsAuthSessionSnapshot {
  return { status: 'logged_out', account: null, currentDevice: null, binding: null, expiresAt: null, errorCode: null }
}

function uniqueControlBaseUrls(saved: readonly string[] | undefined, selected: string | undefined): string[] {
  const values = [...(saved ?? DEFAULT_CODINGNS_CONTROL_BASE_URLS), selected ?? '']
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

function resolveControlBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed || DEFAULT_CODINGNS_CONTROL_BASE_URLS[0] || ''
}

function normalizeControlBaseUrl(value: string): string {
  const trimmed = value.trim()
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError('Control API 地址必须使用 HTTP(S)')
  return parsed.toString().replace(/\/+$/u, '')
}
