import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { LanAccessDshSnapshot } from '../../shared/contracts/lan-access-dsh.js'
import type { LanAccessDshSettings } from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { FeaturePanelProps, CodingNsRpcClient } from './types.js'

/** “局域网访问DSH”设置卡片：只配置一条监听并转发到当前 DSH Web。 */
export function LanAccessPanel({ services, enabled }: FeaturePanelProps): ReactElement {
  const { rpc, settings } = services
  const [savedSettings, setSavedSettings] = useState<LanAccessDshSettings | undefined>()
  const disabled = !enabled
  const [listenHosts, setListenHosts] = useState<string[]>(['0.0.0.0'])
  const [listenHost, setListenHost] = useState('0.0.0.0')
  const [listenPort, setListenPort] = useState('13080')
  const [dshPort, setDshPort] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [detectedDshPorts, setDetectedDshPorts] = useState<number[]>([])
  const [snapshot, setSnapshot] = useState<LanAccessDshSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (disabled) return
    void callRpc<string[]>(rpc, 'lanAccessDsh/addresses', {})
      .then((addresses) => {
        setListenHosts(addresses)
        if (!addresses.includes(listenHost)) setListenHost(addresses[0] ?? '0.0.0.0')
      })
      .catch(() => undefined)
    void callRpc<LanAccessDshSnapshot | null>(rpc, 'lanAccessDsh/get', {})
      .then((current) => {
        if (!current) return
        setSnapshot(current)
      })
      .catch(() => undefined)
    void callRpc<LanAccessDshSettings>(rpc, 'lanAccessDsh/settings/get', {})
      .then(setSavedSettings)
      .catch(() => {
        const fallback = settings.getSnapshot().value?.lanAccessDsh
        if (fallback !== undefined) setSavedSettings(fallback)
      })
  }, [disabled, rpc, settings])

  useEffect(() => {
    if (savedSettings === undefined) return
    setAutoStart(savedSettings.autoStart)
    setListenHost(savedSettings.listenHost)
    setListenPort(String(savedSettings.listenPort))
    setDshPort(savedSettings.dshPort > 0 ? String(savedSettings.dshPort) : '')
  }, [savedSettings])

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

  const detect = (): Promise<void> => run(async () => {
    const result = await callRpc<{ ports: number[] }>(rpc, 'lanAccessDsh/detect', {})
    setDetectedDshPorts(result.ports)
    if (result.ports.length === 1) setDshPort(String(result.ports[0]))
    setMessage(result.ports.length === 0 ? '未探测到 DSH Web 端口，请手动填写' : `已探测到 DSH Web 端口：${result.ports.join('、')}`)
  })

  const saveMapping = async (nextAutoStart = autoStart): Promise<void> => {
    const saved = await callRpc<LanAccessDshSettings>(rpc, 'lanAccessDsh/settings/set', readMapping(listenHost, listenPort, dshPort, nextAutoStart))
    setSavedSettings(saved)
  }

  const saveMappingOnBlur = (): void => {
    if (!autoStart) return
    void saveMapping().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error))
    })
  }

  const start = (): Promise<void> => run(async () => {
    const saved = readMapping(listenHost, listenPort, dshPort, autoStart)
    await saveMapping()
    const payload = {
      listenHost: saved.listenHost,
      listenPort: saved.listenPort,
      ...(saved.dshPort > 0 ? { dshPort: saved.dshPort } : {}),
    }
    const current = await callRpc<LanAccessDshSnapshot>(rpc, 'lanAccessDsh/start', payload)
    setSnapshot(current)
    setDshPort(String(current.dshPort))
    setListenPort(String(current.listenPort))
    setMessage(`局域网访问DSH已启动：${current.listenHost}:${current.actualListenPort ?? current.listenPort} → 127.0.0.1:${current.dshPort}`)
  })

  const stop = (): Promise<void> => run(async () => {
    await callRpc(rpc, 'lanAccessDsh/stop', {})
    setSnapshot(null)
    setMessage('局域网访问DSH已停止')
  })

  const toggleAutoStart = (): Promise<void> => run(async () => {
    const next = !autoStart
    await saveMapping(next)
    setAutoStart(next)
    setMessage(next ? '已开启自动启动，下一次启动 DSH 时将自动恢复映射' : '已关闭自动启动')
  })

  const fieldStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-primary, #d9d9d9)', borderRadius: 6 }
  const buttonStyle = { padding: '8px 14px', border: '1px solid var(--dsw-alias-border-primary, #d9d9d9)', borderRadius: 6, background: 'var(--dsw-alias-bg-secondary, transparent)', cursor: 'pointer' }

  return createElement(
    'div',
    { 'aria-disabled': disabled, style: { display: 'flex', flexDirection: 'column', gap: 12, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' } },
    createElement('p', { style: { margin: 0, opacity: 0.7 } }, '在本机增加一个监听端口，将访问重定向到当前 DSH Web。此功能属于局域网访问，不经过跨 NAT 中转服务。'),
    createElement('select', { value: listenHost, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setListenHost(event.currentTarget.value), onBlur: saveMappingOnBlur, style: fieldStyle },
      ...listenHosts.map((host) => createElement('option', { key: host, value: host }, host === '0.0.0.0' ? '所有网卡（0.0.0.0）' : host)),
    ),
    createElement('input', { type: 'number', min: 0, max: 65535, placeholder: '监听端口', value: listenPort, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setListenPort(event.currentTarget.value), onBlur: saveMappingOnBlur, style: fieldStyle }),
    createElement('div', { style: { display: 'flex', gap: 8 } },
      createElement('input', { type: 'number', min: 1, max: 65535, placeholder: 'DSH 本地端口（自动探测，也可手动填写）', value: dshPort, disabled: disabled || busy, onChange: (event: { currentTarget: { value: string } }) => setDshPort(event.currentTarget.value), onBlur: saveMappingOnBlur, style: { ...fieldStyle, flex: 1 } }),
      createElement('button', { type: 'button', disabled: disabled || busy, onClick: () => void detect(), style: buttonStyle }, '自动探测'),
    ),
    detectedDshPorts.length > 1 && createElement('div', { style: { fontSize: 13, opacity: 0.7 } }, `检测到多个 DSH 实例端口：${detectedDshPorts.join('、')}，请手动选择。`),
    createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: disabled || busy ? 'not-allowed' : 'pointer' } },
      createElement('input', { type: 'checkbox', checked: autoStart, disabled: disabled || busy, onChange: () => void toggleAutoStart() }),
      createElement('span', undefined, '自动启动（启动 DSH 时自动恢复当前映射）'),
    ),
    createElement('div', { style: { display: 'flex', gap: 8 } },
      createElement('button', { type: 'button', disabled: disabled || busy || !listenPort, onClick: () => void start(), style: { ...buttonStyle, flex: 1 } }, busy ? '处理中…' : snapshot ? '更新局域网访问DSH' : '启动局域网访问DSH'),
      snapshot && createElement('button', { type: 'button', disabled: disabled || busy, onClick: () => void stop(), style: buttonStyle }, '停止'),
    ),
    snapshot && createElement('div', { role: 'status', style: { fontSize: 13 } }, `当前转发：${snapshot.listenHost}:${snapshot.actualListenPort ?? snapshot.listenPort} → DSH Web 127.0.0.1:${snapshot.dshPort}`),
    message && createElement('div', { role: 'status', style: { color: message.includes('已') ? '#16803c' : '#b42318' } }, message),
  )
}

function readMapping(listenHost: string, listenPort: string, dshPort: string, autoStart: boolean): LanAccessDshSettings {
  return {
    autoStart,
    listenHost,
    listenPort: parsePort(listenPort, '监听端口', true),
    dshPort: dshPort.trim() === '' ? 0 : parsePort(dshPort, 'DSH 本地端口', false),
  }
}

function parsePort(value: string, field: string, allowZero: boolean): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${field} 必须是数字`)
  const port = Number(value)
  const minimum = allowZero ? 0 : 1
  if (!Number.isInteger(port) || port < minimum || port > 65535) throw new Error(`${field} 必须是 ${minimum} 到 65535 的整数`)
  return port
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
