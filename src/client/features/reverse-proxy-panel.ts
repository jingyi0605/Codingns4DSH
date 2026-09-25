import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsAuthSessionSnapshot } from '../../shared/contracts/auth.js'
import type { DshDeviceListResponse } from '../../shared/contracts/dsh-device.js'
import {
  CODINGNS_CONTROL_STATION_URL,
  CODINGNS_CONTROL_BASE_URL_FIELD,
  CODINGNS_CONTROL_BASE_URLS_FIELD,
  CODINGNS_H5_LOGIN_URL,
  DEFAULT_CODINGNS_CONTROL_BASE_URLS,
} from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { FeaturePanelProps, CodingNsRpcClient } from './types.js'
import {
  dshFormRootStyle,
  dshPopupSurfaceStyle,
  dshSettingsButtonStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsNoteStyle,
  dshSettingsPrimaryButtonStyle,
  dshSettingsRowStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

/**
 * 「中转访问服务」卡片的设置面板：Control API 地址、登录和 DSH 独立设备。
 *
 * 密码只在单次 RPC 中经过 Host，表单不保存它；refresh token 只存在于 Host。
 */
export function ReverseProxyPanel({ services, enabled, snapshot }: FeaturePanelProps): ReactElement {
  const { settings, rpc } = services
  const t = useCodingNsTranslator(services.locale)
  const disabled = !enabled
  const controlsDisabled = disabled || snapshot.status === 'loading' || !snapshot.writable

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [controlBaseUrl, setControlBaseUrl] = useState(resolveControlBaseUrl(snapshot.value?.controlBaseUrl))
  const [controlBaseUrls, setControlBaseUrls] = useState(() => uniqueControlBaseUrls(snapshot.value?.controlBaseUrls, snapshot.value?.controlBaseUrl))
  const [newControlBaseUrl, setNewControlBaseUrl] = useState('')
  const [addAddressOpen, setAddAddressOpen] = useState(false)
  const [addressError, setAddressError] = useState('')
  const [auth, setAuth] = useState<CodingNsAuthSessionSnapshot>(loggedOutSnapshot())
  const [devices, setDevices] = useState<DshDeviceListResponse | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [h5UrlCopied, setH5UrlCopied] = useState(false)

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

  // 设置页打开时 Host 可能正在恢复登录会话；认证快照变为 authenticated
  // 后立即刷新设备列表，避免用户必须再点一次“刷新设备”。
  useEffect(() => {
    if (!enabled || auth.status !== 'authenticated') return
    void loadDevicesInternal().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error))
    })
  }, [auth.status, enabled, rpc])

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
    setH5UrlCopied(false)
    setMessage(t('relay.loginSuccess'))
  })

  const logout = (): Promise<void> => run(async () => {
    await callCodingNsRpc(rpc, 'auth/logout', {})
    setAuth(loggedOutSnapshot())
    setDevices(null)
    setSelectedDeviceId('')
    setH5UrlCopied(false)
    setMessage(t('relay.loggedOut'))
  })

  const copyH5LoginUrl = async (): Promise<void> => {
    try {
      await copyText(CODINGNS_H5_LOGIN_URL)
      setH5UrlCopied(true)
      setMessage(t('relay.copySuccess'))
    } catch (error) {
      setH5UrlCopied(false)
      setMessage(error instanceof Error ? error.message : t('relay.copyFailed'))
    }
  }

  const handleH5AddressKeyDown = (event: { key: string; preventDefault: () => void }): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void copyH5LoginUrl()
  }

  const loadDevices = (): Promise<void> => run(async () => {
    await loadDevicesInternal()
  })

  async function loadDevicesInternal(): Promise<void> {
    const next = await callCodingNsRpc<DshDeviceListResponse>(rpc, 'auth/dsh/device/list', {})
    setDevices(next)
    const preferred = next.devices.find((device) => device.online && device.status === 'active')?.dshDeviceId ?? ''
    setSelectedDeviceId(preferred)
  }

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

  const fieldStyle = dshSettingsFieldStyle
  const buttonStyle = dshSettingsButtonStyle
  const authenticated = auth.status === 'authenticated'
  const selectedDevice = devices?.devices.find((device) => device.dshDeviceId === selectedDeviceId)
  const deviceStatus = selectedDevice === undefined
    ? { label: t('relay.unknown'), color: dshThemeColor.labelTertiary }
    : selectedDevice.online && selectedDevice.status === 'active'
      ? { label: t('relay.online'), color: dshThemeColor.success }
      : { label: t('relay.offline'), color: dshThemeColor.error }

  return createElement(
    'div',
    { 'aria-disabled': controlsDisabled, style: { ...dshFormRootStyle, display: 'flex', flexDirection: 'column', gap: 16, opacity: controlsDisabled ? 0.5 : 1, pointerEvents: controlsDisabled ? 'none' : 'auto' } },
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', { style: dshSettingsFieldLabelStyle }, t('relay.controlApi')),
      createElement('div', { style: dshSettingsRowStyle },
        createElement('select', { value: controlBaseUrl, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { value: string } }) => chooseControlBaseUrl(event.currentTarget.value), style: { ...fieldStyle, flex: 1, minWidth: 0 } },
          ...controlBaseUrls.map((url) => createElement('option', { key: url, value: url }, url)),
        ),
        createElement('button', { type: 'button', 'aria-haspopup': 'dialog', disabled: controlsDisabled || busy, onClick: () => { setAddressError(''); setAddAddressOpen(true) }, style: { ...buttonStyle, flex: '0 0 auto' } }, t('relay.add')),
      ),
    ),
    addAddressOpen && createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'codingns-add-address-title', style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: dshThemeColor.overlay } },
        createElement('div', { style: { ...dshPopupSurfaceStyle, width: 'min(100%, 480px)', boxSizing: 'border-box', padding: 24, borderRadius: 8 } },
        createElement('h3', { id: 'codingns-add-address-title', style: { margin: 0, fontSize: 18 } }, t('relay.addServer')),
        createElement('p', { style: { margin: '8px 0 16px', opacity: 0.7 } }, t('relay.addServerHint')),
        createElement('input', { type: 'url', autoFocus: true, value: newControlBaseUrl, placeholder: 'https://example.com:1443', disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setNewControlBaseUrl(event.currentTarget.value), style: fieldStyle }),
        addressError && createElement('div', { role: 'alert', style: { marginTop: 8, color: dshThemeColor.error } }, addressError),
        createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 } },
          createElement('button', { type: 'button', disabled: busy, onClick: () => { setAddAddressOpen(false); setAddressError('') }, style: buttonStyle }, t('relay.cancel')),
          createElement('button', { type: 'button', disabled: busy || !newControlBaseUrl.trim(), onClick: () => void addControlBaseUrl(), style: buttonStyle }, busy ? t('relay.adding') : t('relay.add')),
        ),
      ),
    ),
    !authenticated && createElement('form', { onSubmit: (event: { preventDefault: () => void }) => { event.preventDefault(); void login() }, style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', { style: dshSettingsFieldLabelStyle }, t('relay.email')),
        createElement('input', { type: 'email', autoComplete: 'username', value: email, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { value: string } }) => setEmail(event.currentTarget.value), style: fieldStyle }),
      ),
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', { style: dshSettingsFieldLabelStyle }, t('relay.password')),
        createElement('input', { type: 'password', autoComplete: 'current-password', value: password, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { value: string } }) => setPassword(event.currentTarget.value), style: fieldStyle }),
      ),
      createElement('button', { type: 'submit', disabled: controlsDisabled || busy || !controlBaseUrl || !email || !password, style: dshSettingsPrimaryButtonStyle }, busy ? t('relay.loggingIn') : t('relay.login')),
      createElement('p', { style: { margin: 0, color: dshThemeColor.labelSecondary, fontSize: 13, lineHeight: 1.5 } },
        t('relay.noAccountPrefix'),
        createElement('a', { href: CODINGNS_CONTROL_STATION_URL, target: '_blank', rel: 'noreferrer', style: { color: dshThemeColor.accent } }, t('relay.register')),
        t('relay.noAccountSuffix'),
      ),
    ),
    authenticated && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      createElement('div', { style: dshSettingsNoteStyle },
        createElement('strong', undefined, auth.account?.email ?? t('relay.loggedIn')),
        createElement('div', { style: { marginTop: 6, opacity: 0.7 } }, t('relay.device', { value: devices?.devices.find((device) => device.dshDeviceId === selectedDeviceId)?.displayName ?? t('relay.unrecognized') })),
        createElement('div', { style: { marginTop: 4, opacity: 0.7 } }, t('relay.host', { value: selectedDeviceId || t('relay.unbound') })),
      ),
      createElement('div', { style: dshSettingsNoteStyle },
        createElement('strong', undefined, t('relay.h5LoginAddress')),
        createElement('div', {
          role: 'button',
          tabIndex: controlsDisabled || busy ? -1 : 0,
          'aria-disabled': controlsDisabled || busy,
          'aria-label': t('relay.copyAddressHint'),
          title: t('relay.copyAddressHint'),
          onClick: () => { if (!controlsDisabled && !busy) void copyH5LoginUrl() },
          onKeyDown: (event: { key: string; preventDefault: () => void }) => { if (!controlsDisabled && !busy) handleH5AddressKeyDown(event) },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 8,
            minWidth: 0,
            padding: '10px 12px',
            border: `1px solid ${h5UrlCopied ? dshThemeColor.success : dshThemeColor.border}`,
            borderRadius: 8,
            color: dshThemeColor.accent,
            background: dshThemeColor.pageBackground,
            cursor: controlsDisabled || busy ? 'default' : 'copy',
            transition: 'border-color 160ms ease, background 160ms ease',
          },
        },
          createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, fontWeight: 600 } }, CODINGNS_H5_LOGIN_URL),
        ),
      ),
      createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void loadDevices(), style: buttonStyle }, t('relay.refreshDevices')),
        createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void logout(), style: buttonStyle }, t('relay.logout')),
      ),
      devices && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 } },
          createElement('strong', { style: dshSettingsFieldLabelStyle }, t('relay.dshDevices')),
          createElement('span', {
            role: 'status',
            'aria-label': t('relay.deviceStatus', { value: deviceStatus.label }),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flex: '0 0 auto',
              padding: '4px 9px',
              border: `1px solid ${deviceStatus.color}`,
              borderRadius: 999,
              color: deviceStatus.color,
              background: dshThemeColor.surfaceSubtle,
              fontSize: 12,
              lineHeight: 1.2,
              fontWeight: 600,
            },
          },
            createElement('span', { 'aria-hidden': true, style: { width: 7, height: 7, flex: '0 0 auto', borderRadius: '50%', background: deviceStatus.color } }),
            deviceStatus.label,
          ),
        ),
        createElement('select', { value: selectedDeviceId, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { value: string } }) => setSelectedDeviceId(event.currentTarget.value), style: fieldStyle },
          createElement('option', { value: '' }, t('relay.selectDevice')),
          ...devices.devices.map((device) => createElement('option', { key: device.dshDeviceId, value: device.dshDeviceId, disabled: !device.online || device.status !== 'active' }, `${device.displayName} · ${device.online ? t('relay.online') : t('relay.offline')}`)),
        ),
        createElement('div', { style: { fontSize: 13, opacity: 0.75 } }, t('relay.devicesSummary', { current: selectedDeviceId || t('relay.unknown'), count: devices.devices.length })),
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

/** 复制 H5 地址；非安全上下文下回退到传统 DOM 复制接口。 */
async function copyText(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  if (typeof document === 'undefined') throw new Error('当前环境不支持复制')
  const input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  try {
    if (!document.execCommand('copy')) throw new Error('当前环境不支持复制')
  } finally {
    input.remove()
  }
}
