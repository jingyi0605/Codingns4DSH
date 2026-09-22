import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AuthDeviceManagementSnapshotDto,
  CodingNsAuthSessionSnapshot,
  TunnelBindingSummary,
} from '../../shared/contracts/auth.js'
import { CODINGNS_CONTROL_BASE_URL_FIELD } from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { FeaturePanelProps, CodingNsRpcClient } from './types.js'

/**
 * 「中转访问服务」卡片的设置面板：Control API 地址、登录、设备和 Host 绑定。
 *
 * 密码只在单次 RPC 中经过 Host，表单不保存它；refresh token 只存在于 Host。
 */
export function ReverseProxyPanel({ services, enabled, snapshot }: FeaturePanelProps): ReactElement {
  const { settings, rpc } = services
  const disabled = !enabled

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [controlBaseUrl, setControlBaseUrl] = useState(snapshot.value?.controlBaseUrl ?? '')
  const [hostLabel, setHostLabel] = useState('')
  const [hostPublicKey, setHostPublicKey] = useState('')
  const [hostFingerprint, setHostFingerprint] = useState('')
  const [auth, setAuth] = useState<CodingNsAuthSessionSnapshot>(loggedOutSnapshot())
  const [devices, setDevices] = useState<AuthDeviceManagementSnapshotDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const saved = snapshot.value?.controlBaseUrl
    if (saved !== undefined) setControlBaseUrl(saved)
  }, [snapshot.value?.controlBaseUrl])

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
    await settings.set(CODINGNS_CONTROL_BASE_URL_FIELD, controlBaseUrl.trim())
    const next = await callCodingNsRpc<CodingNsAuthSessionSnapshot>(rpc, 'auth/login', {
      controlBaseUrl,
      email,
      password,
    })
    setPassword('')
    setAuth(next)
    setMessage('登录成功')
  })

  const logout = (): Promise<void> => run(async () => {
    await callCodingNsRpc(rpc, 'auth/logout', {})
    setAuth(loggedOutSnapshot())
    setDevices(null)
    setMessage('已退出登录')
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
    setMessage('Host 绑定成功')
  })

  const unbindHost = (): Promise<void> => run(async () => {
    if (!auth.binding) return
    await callCodingNsRpc(rpc, 'auth/unbind', { bindingId: auth.binding.bindingId })
    setAuth((current) => ({ ...current, binding: null }))
    setMessage('Host 已解绑')
  })

  const fieldStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-primary, #d9d9d9)', borderRadius: 6 }
  const buttonStyle = { padding: '8px 14px', border: '1px solid var(--dsw-alias-border-primary, #d9d9d9)', borderRadius: 6, background: 'var(--dsw-alias-bg-secondary, transparent)', cursor: 'pointer' }
  const authenticated = auth.status === 'authenticated'

  return createElement(
    'div',
    { 'aria-disabled': disabled, style: { display: 'flex', flexDirection: 'column', gap: 16, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' } },
    createElement('div', undefined,
      createElement('h3', { style: { margin: 0, fontSize: 17 } }, '服务设置'),
      createElement('p', { style: { margin: '8px 0 0', opacity: 0.65 } }, '登录 CodingNS，管理设备和当前 Host。'),
    ),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', undefined, 'Control API 地址'),
      createElement('input', { type: 'url', value: controlBaseUrl, placeholder: 'https://codingns.example.com', disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setControlBaseUrl(event.currentTarget.value), style: fieldStyle }),
    ),
    !authenticated && createElement('form', { onSubmit: (event: { preventDefault: () => void }) => { event.preventDefault(); void login() }, style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', undefined, '邮箱'),
        createElement('input', { type: 'email', autoComplete: 'username', value: email, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setEmail(event.currentTarget.value), style: fieldStyle }),
      ),
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', undefined, '密码'),
        createElement('input', { type: 'password', autoComplete: 'current-password', value: password, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setPassword(event.currentTarget.value), style: fieldStyle }),
      ),
      createElement('button', { type: 'submit', disabled: disabled || busy || !controlBaseUrl || !email || !password, style: buttonStyle }, busy ? '登录中…' : '登录'),
    ),
    authenticated && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      createElement('div', { style: { padding: 12, border: '1px solid var(--dsw-alias-border-primary, #d9d9d9)', borderRadius: 6 } },
        createElement('strong', undefined, auth.account?.email ?? '已登录'),
        createElement('div', { style: { marginTop: 6, opacity: 0.7 } }, `设备：${auth.currentDevice?.displayName ?? auth.currentDevice?.deviceId ?? '未识别'}`),
        createElement('div', { style: { marginTop: 4, opacity: 0.7 } }, `Host：${auth.binding?.tunnelDomain ?? '未绑定'}`),
      ),
      createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        createElement('button', { type: 'button', disabled: disabled || busy, onClick: () => void loadDevices(), style: buttonStyle }, '刷新设备'),
        createElement('button', { type: 'button', disabled: disabled || busy, onClick: () => void logout(), style: buttonStyle }, '退出登录'),
      ),
      devices && createElement('div', { style: { fontSize: 13, opacity: 0.75 } }, `当前设备 ${devices.currentDevice?.deviceId ?? '未知'}，其他活动设备 ${devices.otherActiveDevices.length} 台`),
      auth.binding
        ? createElement('button', { type: 'button', disabled: disabled || busy, onClick: () => void unbindHost(), style: buttonStyle }, '解绑当前 Host')
        : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          createElement('strong', undefined, '绑定当前 Host'),
          createElement('input', { placeholder: 'Host 标签', value: hostLabel, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setHostLabel(event.currentTarget.value), style: fieldStyle }),
          createElement('input', { placeholder: 'Host 公钥', value: hostPublicKey, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setHostPublicKey(event.currentTarget.value), style: fieldStyle }),
          createElement('input', { placeholder: 'Host 指纹', value: hostFingerprint, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setHostFingerprint(event.currentTarget.value), style: fieldStyle }),
          createElement('button', { type: 'button', disabled: disabled || busy || !hostLabel || !hostPublicKey || !hostFingerprint, onClick: () => void bindHost(), style: buttonStyle }, '绑定 Host'),
        ),
    ),
    message && createElement('div', { role: 'status', style: { color: message.includes('成功') ? '#16803c' : '#b42318' } }, message),
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
