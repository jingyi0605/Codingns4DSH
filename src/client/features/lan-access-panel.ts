import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { LanAccessDshSnapshot } from '../../shared/contracts/lan-access-dsh.js'
import type { LanAccessDshPwaSettings, LanAccessDshSettings } from '../../shared/contracts/config.js'
import { DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS, normalizeLanAccessDshPwaSettings } from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { FeaturePanelProps, CodingNsRpcClient } from './types.js'
import {
  dshFormRootStyle,
  dshSettingsButtonStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsNoteStyle,
  dshSettingsPrimaryButtonStyle,
  dshSettingsRowStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'
import type { PwaNotificationClient, PwaNotificationStatus } from '../pwa-notifications.js'

/** “局域网访问DSH”设置卡片：只配置一条监听并转发到当前 DSH Web。 */
export function LanAccessPanel({ services, enabled, snapshot: settingsSnapshot, notify }: FeaturePanelProps): ReactElement {
  const { rpc, settings } = services
  const t = useCodingNsTranslator(services.locale)
  const [savedSettings, setSavedSettings] = useState<LanAccessDshSettings | undefined>()
  const disabled = !enabled
  const controlsDisabled = disabled || settingsSnapshot.status === 'loading' || !settingsSnapshot.writable
  const [listenHosts, setListenHosts] = useState<string[]>(['0.0.0.0'])
  const [listenHost, setListenHost] = useState('0.0.0.0')
  const [listenPort, setListenPort] = useState('13080')
  const [dshPort, setDshPort] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [pwa, setPwa] = useState<LanAccessDshPwaSettings>(DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS)
  const [detectedDshPorts, setDetectedDshPorts] = useState<number[]>([])
  const [snapshot, setSnapshot] = useState<LanAccessDshSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [notificationStatus, setNotificationStatus] = useState<PwaNotificationStatus | undefined>()
  const [pushEndpoint, setPushEndpoint] = useState<string | null>(null)
  const [pushSubscriptions, setPushSubscriptions] = useState<number | undefined>()

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
    setPwa(normalizeLanAccessDshPwaSettings(savedSettings.pwa))
  }, [savedSettings])

  // 通知/推送状态只在卡片打开时读取一次；所有写入都由用户手势触发。
  useEffect(() => {
    if (disabled) return
    const client = services.notifications
    if (client === undefined) return
    void client.status().then(setNotificationStatus).catch(() => undefined)
    void client.currentSubscription().then((subscription) => setPushEndpoint(subscription?.endpoint ?? null)).catch(() => undefined)
    void callRpc<{ available: boolean; subscriptions: number }>(rpc, 'lanAccessDsh/pwa/push/status', {})
      .then((status) => setPushSubscriptions(status.available ? status.subscriptions : undefined))
      .catch(() => undefined)
  }, [disabled, rpc, services.notifications])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await operation()
    } catch (error) {
      notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const detect = (): Promise<void> => run(async () => {
    const result = await callRpc<{ ports: number[] }>(rpc, 'lanAccessDsh/detect', {})
    setDetectedDshPorts(result.ports)
    if (result.ports.length === 1) setDshPort(String(result.ports[0]))
    notify({ kind: 'info', message: result.ports.length === 0 ? t('lan.detectNone') : t('lan.detected', { ports: result.ports.join('、') }) })
  })

  const saveMapping = async (nextAutoStart = autoStart): Promise<void> => {
    const saved = await callRpc<LanAccessDshSettings>(rpc, 'lanAccessDsh/settings/set', readMapping(listenHost, listenPort, dshPort, nextAutoStart, pwa))
    setSavedSettings(saved)
  }

  const updatePwa = (patch: Partial<LanAccessDshPwaSettings>): void => {
    const next = normalizeLanAccessDshPwaSettings({ ...pwa, ...patch })
    setPwa(next)
    void run(async () => {
      const saved = await callRpc<LanAccessDshSettings>(rpc, 'lanAccessDsh/settings/set', readMapping(listenHost, listenPort, dshPort, autoStart, next))
      setSavedSettings(saved)
      notify({ kind: 'success', message: t('lan.pwa.saved') })
    })
  }

  const saveMappingOnBlur = (): void => {
    if (!autoStart) return
    void saveMapping().catch((error: unknown) => {
      notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  const start = (): Promise<void> => run(async () => {
    const saved = readMapping(listenHost, listenPort, dshPort, autoStart, pwa)
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
    notify({ kind: 'success', message: t('lan.started', { host: current.listenHost, port: current.actualListenPort ?? current.listenPort, dshPort: current.dshPort }) })
  })

  const stop = (): Promise<void> => run(async () => {
    await callRpc(rpc, 'lanAccessDsh/stop', {})
    setSnapshot(null)
    notify({ kind: 'success', message: t('lan.stopped') })
  })

  const toggleAutoStart = (): Promise<void> => run(async () => {
    const next = !autoStart
    await saveMapping(next)
    setAutoStart(next)
    notify({ kind: 'success', message: next ? t('lan.autoStartOn') : t('lan.autoStartOff') })
  })

  const requireNotifications = (): PwaNotificationClient => {
    const client = services.notifications
    if (client === undefined) throw new Error(t('lan.pwa.pushUnavailable'))
    return client
  }

  const requestPermission = (): Promise<void> => run(async () => {
    const status = await requireNotifications().requestPermission()
    setNotificationStatus(status)
    notify({ kind: status.permission === 'granted' ? 'success' : 'info', message: status.permission === 'granted' ? t('lan.pwa.permissionGranted') : t('lan.pwa.permissionNotGranted') })
  })

  const sendTestNotification = (): Promise<void> => run(async () => {
    const sent = await requireNotifications().notify({ title: 'DSH', body: t('lan.pwa.testBody'), tag: 'codingns4dsh-test' })
    notify({ kind: sent ? 'success' : 'error', message: sent ? t('lan.pwa.testSent') : t('lan.pwa.testFailed') })
  })

  const subscribePush = (): Promise<void> => run(async () => {
    const client = requireNotifications()
    const vapid = await callRpc<{ available: boolean; publicKey?: string }>(rpc, 'lanAccessDsh/pwa/vapid', {})
    if (vapid.publicKey === undefined) throw new Error(t('lan.pwa.pushUnavailable'))
    let status = await client.status()
    if (status.permission !== 'granted') {
      status = await client.requestPermission()
    }
    setNotificationStatus(status)
    if (status.permission !== 'granted') throw new Error(t('lan.pwa.pushNeedsPermission'))
    const subscription = await client.subscribe(vapid.publicKey)
    const label = typeof navigator === 'undefined' ? '' : navigator.userAgent
    const result = await callRpc<{ subscriptions: number }>(rpc, 'lanAccessDsh/pwa/push/subscribe', { endpoint: subscription.endpoint, keys: subscription.keys, label })
    setPushEndpoint(subscription.endpoint)
    setPushSubscriptions(result.subscriptions)
    notify({ kind: 'success', message: t('lan.pwa.pushSubscribed', { count: String(result.subscriptions) }) })
  })

  const unsubscribePush = (): Promise<void> => run(async () => {
    const client = requireNotifications()
    const endpoint = pushEndpoint ?? (await client.currentSubscription())?.endpoint
    await client.unsubscribe()
    if (endpoint !== undefined && endpoint !== null) {
      await callRpc(rpc, 'lanAccessDsh/pwa/push/unsubscribe', { endpoint })
    }
    setPushEndpoint(null)
    setPushSubscriptions(undefined)
    notify({ kind: 'success', message: t('lan.pwa.pushUnsubscribed') })
  })

  const sendTestPush = (): Promise<void> => run(async () => {
    const summary = await callRpc<{ sent: number; failed: number; removed: number }>(rpc, 'lanAccessDsh/pwa/push/test', {})
    notify({ kind: summary.sent > 0 ? 'success' : 'info', message: t('lan.pwa.pushTestSummary', { sent: String(summary.sent), failed: String(summary.failed), removed: String(summary.removed) }) })
  })

  const unregisterServiceWorker = (): Promise<void> => run(async () => {
    const done = await requireNotifications().unregisterServiceWorker()
    notify({ kind: done ? 'success' : 'error', message: done ? t('lan.pwa.unregisterSwDone') : t('lan.pwa.unregisterSwFailed') })
  })

  const fieldStyle = dshSettingsFieldStyle
  const buttonStyle = dshSettingsButtonStyle

  return createElement(
    'div',
    { 'aria-disabled': controlsDisabled, style: { ...dshFormRootStyle, display: 'flex', flexDirection: 'column', gap: 14, opacity: controlsDisabled ? 0.5 : 1, pointerEvents: controlsDisabled ? 'none' : 'auto' } },
    createElement('p', { style: { margin: 0, color: dshThemeColor.labelSecondary, fontSize: 13, lineHeight: 1.5 } }, t('lan.description')),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', { style: dshSettingsFieldLabelStyle }, t('lan.listenHost')),
      createElement('select', { value: listenHost, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { value: string } }) => setListenHost(event.currentTarget.value), onBlur: saveMappingOnBlur, style: fieldStyle },
        ...listenHosts.map((host) => createElement('option', { key: host, value: host }, host === '0.0.0.0' ? t('lan.allInterfaces') : host)),
      ),
    ),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', { style: dshSettingsFieldLabelStyle }, t('lan.listenPort')),
      createElement('input', { type: 'number', min: 0, max: 65535, placeholder: t('lan.listenPort'), value: listenPort, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { value: string } }) => setListenPort(event.currentTarget.value), onBlur: saveMappingOnBlur, style: fieldStyle }),
    ),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      createElement('span', { style: dshSettingsFieldLabelStyle }, t('lan.dshPort')),
      createElement('div', { style: dshSettingsRowStyle },
        createElement('input', { type: 'number', min: 1, max: 65535, placeholder: t('lan.dshPort'), value: dshPort, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { value: string } }) => setDshPort(event.currentTarget.value), onBlur: saveMappingOnBlur, style: { ...fieldStyle, flex: 1, minWidth: 0 } }),
        createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void detect(), style: buttonStyle }, t('lan.detect')),
      ),
    ),
    detectedDshPorts.length > 1 && createElement('div', { style: dshSettingsNoteStyle }, t('lan.detectMultiple', { ports: detectedDshPorts.join('、') })),
    createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: controlsDisabled || busy ? 'not-allowed' : 'pointer', color: dshThemeColor.labelSecondary, fontSize: 13 } },
      createElement('input', { type: 'checkbox', checked: autoStart, disabled: controlsDisabled || busy, onChange: () => void toggleAutoStart(), style: { accentColor: dshThemeColor.accent } }),
      createElement('span', undefined, t('lan.autoStart')),
    ),
    createElement('div', { style: dshSettingsRowStyle },
      createElement('button', { type: 'button', disabled: controlsDisabled || busy || !listenPort, onClick: () => void start(), style: { ...dshSettingsPrimaryButtonStyle, flex: 1 } }, busy ? t('lan.processing') : snapshot ? t('lan.update') : t('lan.start')),
      snapshot && createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void stop(), style: buttonStyle }, t('lan.stop')),
    ),
    snapshot && createElement('div', { role: 'status', style: dshSettingsNoteStyle }, t('lan.forwarding', { host: snapshot.listenHost, port: snapshot.actualListenPort ?? snapshot.listenPort, dshPort: snapshot.dshPort })),
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4, paddingTop: 12, borderTop: `1px solid ${dshThemeColor.border}` } },
      createElement('strong', { style: { fontSize: 13 } }, t('lan.pwa.title')),
      createElement('p', { style: { margin: 0, color: dshThemeColor.labelSecondary, fontSize: 12, lineHeight: 1.6 } }, t('lan.pwa.description')),
      createElement('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: controlsDisabled || busy ? 'not-allowed' : 'pointer', color: dshThemeColor.labelSecondary, fontSize: 13 } },
        createElement('input', { type: 'checkbox', checked: pwa.enabled, disabled: controlsDisabled || busy, onChange: (event: { currentTarget: { checked: boolean } }) => updatePwa({ enabled: event.currentTarget.checked }), style: { marginTop: 2, accentColor: dshThemeColor.accent } }),
        createElement('span', undefined,
          createElement('span', { style: { display: 'block' } }, t('lan.pwa.enabled')),
          createElement('span', { style: { display: 'block', marginTop: 3, fontSize: 11, lineHeight: 1.5 } }, t('lan.pwa.enabledHelp')),
        ),
      ),
      createElement('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: controlsDisabled || busy || !pwa.enabled ? 'not-allowed' : 'pointer', color: dshThemeColor.labelSecondary, fontSize: 13, opacity: pwa.enabled ? 1 : 0.55 } },
        createElement('input', { type: 'checkbox', checked: pwa.serviceWorker, disabled: controlsDisabled || busy || !pwa.enabled, onChange: (event: { currentTarget: { checked: boolean } }) => updatePwa({ serviceWorker: event.currentTarget.checked }), style: { marginTop: 2, accentColor: dshThemeColor.accent } }),
        createElement('span', undefined,
          createElement('span', { style: { display: 'block' } }, t('lan.pwa.serviceWorker')),
          createElement('span', { style: { display: 'block', marginTop: 3, fontSize: 11, lineHeight: 1.5 } }, t('lan.pwa.serviceWorkerHelp')),
        ),
      ),
      createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: controlsDisabled || busy || !pwa.enabled ? 'not-allowed' : 'pointer', color: dshThemeColor.labelSecondary, fontSize: 13, opacity: pwa.enabled ? 1 : 0.55 } },
        createElement('input', { type: 'checkbox', checked: pwa.installPrompt, disabled: controlsDisabled || busy || !pwa.enabled, onChange: (event: { currentTarget: { checked: boolean } }) => updatePwa({ installPrompt: event.currentTarget.checked }), style: { accentColor: dshThemeColor.accent } }),
        createElement('span', undefined, t('lan.pwa.installPrompt')),
      ),
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6, opacity: pwa.enabled ? 1 : 0.55 } },
        createElement('span', { style: dshSettingsFieldLabelStyle }, t('lan.pwa.notifications')),
        createElement('select', {
          value: pwa.notifications,
          disabled: controlsDisabled || busy || !pwa.enabled,
          onChange: (event: { currentTarget: { value: string } }) => updatePwa({ notifications: event.currentTarget.value === 'local' ? 'local' : event.currentTarget.value === 'push' ? 'push' : 'off' }),
          style: fieldStyle,
        },
          createElement('option', { value: 'off' }, t('lan.pwa.notificationsOff')),
          createElement('option', { value: 'local' }, t('lan.pwa.notificationsLocal')),
          createElement('option', { value: 'push' }, t('lan.pwa.notificationsPush')),
        ),
      ),
      pwa.enabled && pwa.notifications !== 'off' && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, opacity: pwa.enabled ? 1 : 0.55 } },
        notificationStatus !== undefined && createElement('div', { style: dshSettingsNoteStyle }, t('lan.pwa.notificationState', {
          permission: notificationStatus.permission,
          sw: notificationStatus.serviceWorker ? t('lan.pwa.swActive') : t('lan.pwa.swMissing'),
        })),
        pwa.notifications === 'push' && !pwa.serviceWorker && createElement('div', { style: dshSettingsNoteStyle }, t('lan.pwa.swNeeded')),
        createElement('div', { style: dshSettingsRowStyle },
          notificationStatus?.permission !== 'granted' && createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void requestPermission(), style: buttonStyle }, t('lan.pwa.requestPermission')),
          pwa.notifications === 'local' && notificationStatus?.permission === 'granted' && createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void sendTestNotification(), style: buttonStyle }, t('lan.pwa.sendTest')),
          pwa.notifications === 'push' && pushEndpoint === null && createElement('button', { type: 'button', disabled: controlsDisabled || busy || !pwa.serviceWorker, onClick: () => void subscribePush(), style: buttonStyle }, t('lan.pwa.subscribe')),
          pwa.notifications === 'push' && pushEndpoint !== null && createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void unsubscribePush(), style: buttonStyle }, t('lan.pwa.unsubscribe')),
          pwa.notifications === 'push' && createElement('button', { type: 'button', disabled: controlsDisabled || busy || pushSubscriptions === undefined, onClick: () => void sendTestPush(), style: buttonStyle }, t('lan.pwa.pushTest')),
        ),
        pwa.notifications === 'push' && pushSubscriptions !== undefined && createElement('div', { style: dshSettingsNoteStyle }, t('lan.pwa.pushDevices', { count: String(pushSubscriptions) })),
        createElement('div', { style: dshSettingsRowStyle },
          createElement('button', { type: 'button', disabled: controlsDisabled || busy, onClick: () => void unregisterServiceWorker(), style: buttonStyle }, t('lan.pwa.unregisterSw')),
        ),
      ),
      createElement('div', { style: dshSettingsNoteStyle }, t('lan.pwa.loopbackWarning')),
    ),
  )
}

function readMapping(listenHost: string, listenPort: string, dshPort: string, autoStart: boolean, pwa: LanAccessDshPwaSettings): LanAccessDshSettings {
  return {
    autoStart,
    listenHost,
    listenPort: parsePort(listenPort, '监听端口', true),
    dshPort: dshPort.trim() === '' ? 0 : parsePort(dshPort, 'DSH 本地端口', false),
    pwa: normalizeLanAccessDshPwaSettings(pwa),
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
