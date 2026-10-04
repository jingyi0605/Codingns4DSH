import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_LAN_ACCESS_DSH_FIELD,
  CODINGNS_MOBILE_ACCESS_FIELD,
  DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS,
  DEFAULT_MOBILE_ACCESS_SETTINGS,
  MOBILE_VIEWPORT_MAX_PX_LIMITS,
  normalizeLanAccessDshPwaSettings,
  normalizeMobileAccessSettings,
  SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS,
} from '../../shared/contracts/config.js'
import type { LanAccessDshPwaSettings } from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { CodingNsRpcClient, FeaturePanelProps } from './types.js'
import {
  dshFormRootStyle,
  dshSettingsButtonStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
  dshSettingsNoteStyle,
  dshSettingsRowStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'
import type { PwaNotificationClient, PwaNotificationStatus } from '../pwa-notifications.js'

/**
 * 移动端访问增强的单列设置面板。
 *
 * 除了窄屏侧栏行为，卡片还承载局域网入口的移动端 PWA 资产配置（manifest、图标、
 * 安装引导与通知）。这些资产仍然只在「局域网访问DSH」的监听端口上可达，存储字段也
 * 仍然是 `lanAccessDsh.pwa`，因此这里用 `CODINGNS_LAN_ACCESS_DSH_FIELD` 路径写入，
 * 与局域网卡片共用同一份设置；局域网卡片只保留监听映射与回环告警。
 */
export function MobileAccessPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const { rpc, settings } = services
  const t = useCodingNsTranslator(services.locale)
  const value = normalizeMobileAccessSettings(
    snapshot.value?.mobileAccess ?? DEFAULT_MOBILE_ACCESS_SETTINGS,
  )
  const pwa = normalizeLanAccessDshPwaSettings(
    snapshot.value?.lanAccessDsh?.pwa ?? DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS,
  )
  const gestures = normalizeMobileAccessSettings(
    snapshot.value?.mobileAccess,
    snapshot.value?.workspaceSessionEnhancement,
  )
  const [widthDraft, setWidthDraft] = useState(String(value.mobileViewportMaxPx))
  const [busy, setBusy] = useState(false)
  const [notificationStatus, setNotificationStatus] = useState<PwaNotificationStatus | undefined>()
  const [pushEndpoint, setPushEndpoint] = useState<string | null>(null)
  const [pushSubscriptions, setPushSubscriptions] = useState<number | undefined>()
  // 设置可能在面板打开后才加载完成；只在数值真的变化时覆盖输入框草稿。
  useEffect(() => {
    setWidthDraft(String(value.mobileViewportMaxPx))
  }, [value.mobileViewportMaxPx])
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable
  const controlsDisabled = disabled || busy

  // 通知与推送状态只在卡片打开时读取一次；所有写入都由用户手势触发。
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

  const updateField = (field: string, nextValue: unknown, successMessage: string): void => {
    void settings.mutate([{
      op: 'set',
      path: [CODINGNS_MOBILE_ACCESS_FIELD, field],
      value: nextValue,
    }]).then((accepted) => {
      if (!accepted) {
        notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
        return
      }
      notify({ kind: 'success', message: successMessage })
    }).catch((cause: unknown) => {
      notify({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  const updatePwa = (patch: Partial<LanAccessDshPwaSettings>): void => {
    const next = normalizeLanAccessDshPwaSettings({ ...pwa, ...patch })
    void settings.mutate([{
      op: 'set',
      path: [CODINGNS_LAN_ACCESS_DSH_FIELD, 'pwa'],
      value: next,
    }]).then((accepted) => {
      if (!accepted) {
        notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
        return
      }
      notify({ kind: 'success', message: t('lan.pwa.saved') })
    }).catch((cause: unknown) => {
      notify({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  const updateGestureField = (field: string, nextValue: unknown): void => {
    void settings.mutate([{
      op: 'set',
      path: [CODINGNS_MOBILE_ACCESS_FIELD, field],
      value: nextValue,
    }]).then((accepted) => {
      notify({
        kind: accepted ? 'success' : 'error',
        message: accepted ? t('mobile.sidebarGestureSaved') : t('settings.moduleWriteRejected'),
      })
    }).catch((cause: unknown) => {
      notify({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })
  }

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

  return createElement('div', {
    'aria-disabled': disabled,
    style: {
      ...dshFormRootStyle,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      opacity: disabled ? 0.5 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
    },
  },
    createElement('label', { style: dshSettingsListRowStyle },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('mobile.hideSidebarOnMobile')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('mobile.hideSidebarOnMobileDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('mobile.hideSidebarOnMobile'),
        checked: value.hideSidebarOnMobile,
        disabled: controlsDisabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateField(
          'hideSidebarOnMobile',
          event.currentTarget.checked,
          t('mobile.saved'),
        ),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', { style: dshSettingsListRowStyle },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('mobile.optimizeSettingsOnMobile')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('mobile.optimizeSettingsOnMobileDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('mobile.optimizeSettingsOnMobile'),
        checked: value.optimizeSettingsOnMobile,
        disabled: controlsDisabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateField(
          'optimizeSettingsOnMobile',
          event.currentTarget.checked,
          t('mobile.saved'),
        ),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingInlineStart: 12 } },
      createElement('span', { style: dshSettingsFieldLabelStyle }, t('mobile.viewportMax')),
      createElement('input', {
        type: 'number',
        min: MOBILE_VIEWPORT_MAX_PX_LIMITS.min,
        max: MOBILE_VIEWPORT_MAX_PX_LIMITS.max,
        value: widthDraft,
        disabled: controlsDisabled,
        onChange: (event: { currentTarget: { value: string } }) => setWidthDraft(event.currentTarget.value),
        onBlur: () => {
          const next = Number(widthDraft)
          if (!Number.isFinite(next)) {
            setWidthDraft(String(value.mobileViewportMaxPx))
            return
          }
          const clamped = Math.min(
            MOBILE_VIEWPORT_MAX_PX_LIMITS.max,
            Math.max(MOBILE_VIEWPORT_MAX_PX_LIMITS.min, Math.round(next)),
          )
          setWidthDraft(String(clamped))
          if (clamped !== value.mobileViewportMaxPx) updateField('mobileViewportMaxPx', clamped, t('mobile.saved'))
        },
        style: dshSettingsFieldStyle,
      }),
      createElement('span', { style: dshSettingsHelpStyle }, t('mobile.viewportMaxHelp')),
    ),
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: `1px solid ${dshThemeColor.border}` } },
      createElement('label', { style: dshSettingsListRowStyle },
        createElement('span', { style: { minWidth: 0 } },
          createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('mobile.sidebarGestures')),
          createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('mobile.sidebarGesturesDescription')),
        ),
        createElement('input', {
          type: 'checkbox',
          role: 'switch',
          'aria-label': t('mobile.sidebarGestures'),
          checked: gestures.sidebarGestures,
          disabled: controlsDisabled,
          onChange: (event: { currentTarget: { checked: boolean } }) => updateGestureField('sidebarGestures', event.currentTarget.checked),
          style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
        }),
      ),
      gestures.sidebarGestures && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingInlineStart: 12 } },
        createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          createElement('span', { style: dshSettingsFieldLabelStyle }, t('mobile.sidebarGestureMapping')),
          createElement('select', {
            value: gestures.sidebarGestureMapping,
            disabled: controlsDisabled,
            onChange: (event: { currentTarget: { value: string } }) => updateGestureField('sidebarGestureMapping', event.currentTarget.value === 'swap' ? 'swap' : 'swipe-inward'),
            style: fieldStyle,
          },
            createElement('option', { value: 'swipe-inward' }, t('mobile.sidebarGestureMappingInward')),
            createElement('option', { value: 'swap' }, t('mobile.sidebarGestureMappingSwap')),
          ),
        ),
        createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          createElement('span', { style: dshSettingsFieldLabelStyle }, t('mobile.sidebarGestureEdge')),
          createElement('select', {
            value: gestures.sidebarGestureEdge,
            disabled: controlsDisabled,
            onChange: (event: { currentTarget: { value: string } }) => updateGestureField('sidebarGestureEdge', event.currentTarget.value === 'edge' ? 'edge' : 'avoid'),
            style: fieldStyle,
          },
            createElement('option', { value: 'avoid' }, t('mobile.sidebarGestureEdgeAvoid')),
            createElement('option', { value: 'edge' }, t('mobile.sidebarGestureEdgeEdge')),
          ),
        ),
        createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          createElement('span', { style: dshSettingsFieldLabelStyle }, t('mobile.sidebarGestureDistance')),
          createElement('input', {
            type: 'number',
            min: SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.min,
            max: SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.max,
            step: 5,
            value: gestures.sidebarGestureDistancePercent,
            disabled: controlsDisabled,
            onChange: (event: { currentTarget: { value: string } }) => {
              const next = Number(event.currentTarget.value)
              if (!Number.isFinite(next)) return
              updateGestureField('sidebarGestureDistancePercent', Math.min(
                SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.max,
                Math.max(SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.min, Math.round(next)),
              ))
            },
            style: fieldStyle,
          }),
          createElement('span', { style: dshSettingsHelpStyle }, t('mobile.sidebarGestureDistanceHelp')),
        ),
      ),
    ),
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4, paddingTop: 12, borderTop: `1px solid ${dshThemeColor.border}` } },
      createElement('strong', { style: { fontSize: 13 } }, t('lan.pwa.title')),
      createElement('p', { style: { margin: 0, color: dshThemeColor.labelSecondary, fontSize: 12, lineHeight: 1.6 } }, t('lan.pwa.description')),
      createElement('p', { style: { margin: 0, ...dshSettingsHelpStyle } }, t('mobile.pwaRequiresListener')),
      createElement('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: controlsDisabled ? 'not-allowed' : 'pointer', color: dshThemeColor.labelSecondary, fontSize: 13 } },
        createElement('input', { type: 'checkbox', checked: pwa.enabled, disabled: controlsDisabled, onChange: (event: { currentTarget: { checked: boolean } }) => updatePwa({ enabled: event.currentTarget.checked }), style: { marginTop: 2, accentColor: dshThemeColor.accent } }),
        createElement('span', undefined,
          createElement('span', { style: { display: 'block' } }, t('lan.pwa.enabled')),
          createElement('span', { style: { display: 'block', marginTop: 3, fontSize: 11, lineHeight: 1.5 } }, t('lan.pwa.enabledHelp')),
        ),
      ),
      createElement('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: controlsDisabled || !pwa.enabled ? 'not-allowed' : 'pointer', color: dshThemeColor.labelSecondary, fontSize: 13, opacity: pwa.enabled ? 1 : 0.55 } },
        createElement('input', { type: 'checkbox', checked: pwa.serviceWorker, disabled: controlsDisabled || !pwa.enabled, onChange: (event: { currentTarget: { checked: boolean } }) => updatePwa({ serviceWorker: event.currentTarget.checked }), style: { marginTop: 2, accentColor: dshThemeColor.accent } }),
        createElement('span', undefined,
          createElement('span', { style: { display: 'block' } }, t('lan.pwa.serviceWorker')),
          createElement('span', { style: { display: 'block', marginTop: 3, fontSize: 11, lineHeight: 1.5 } }, t('lan.pwa.serviceWorkerHelp')),
        ),
      ),
      createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: controlsDisabled || !pwa.enabled ? 'not-allowed' : 'pointer', color: dshThemeColor.labelSecondary, fontSize: 13, opacity: pwa.enabled ? 1 : 0.55 } },
        createElement('input', { type: 'checkbox', checked: pwa.installPrompt, disabled: controlsDisabled || !pwa.enabled, onChange: (event: { currentTarget: { checked: boolean } }) => updatePwa({ installPrompt: event.currentTarget.checked }), style: { accentColor: dshThemeColor.accent } }),
        createElement('span', undefined, t('lan.pwa.installPrompt')),
      ),
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6, opacity: pwa.enabled ? 1 : 0.55 } },
        createElement('span', { style: dshSettingsFieldLabelStyle }, t('lan.pwa.notifications')),
        createElement('select', {
          value: pwa.notifications,
          disabled: controlsDisabled || !pwa.enabled,
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
          supported: notificationStatus.supported ? t('lan.pwa.yes') : t('lan.pwa.no'),
          secure: notificationStatus.secure ? t('lan.pwa.yes') : t('lan.pwa.no'),
        })),
        pwa.notifications === 'push' && !pwa.serviceWorker && createElement('div', { style: dshSettingsNoteStyle }, t('lan.pwa.swNeeded')),
        createElement('div', { style: dshSettingsRowStyle },
          notificationStatus?.permission !== 'granted' && createElement('button', { type: 'button', disabled: controlsDisabled, onClick: () => void requestPermission(), style: buttonStyle }, t('lan.pwa.requestPermission')),
          pwa.notifications === 'local' && notificationStatus?.permission === 'granted' && createElement('button', { type: 'button', disabled: controlsDisabled, onClick: () => void sendTestNotification(), style: buttonStyle }, t('lan.pwa.sendTest')),
          pwa.notifications === 'push' && pushEndpoint === null && createElement('button', { type: 'button', disabled: controlsDisabled || !pwa.serviceWorker, onClick: () => void subscribePush(), style: buttonStyle }, t('lan.pwa.subscribe')),
          pwa.notifications === 'push' && pushEndpoint !== null && createElement('button', { type: 'button', disabled: controlsDisabled, onClick: () => void unsubscribePush(), style: buttonStyle }, t('lan.pwa.unsubscribe')),
          pwa.notifications === 'push' && createElement('button', { type: 'button', disabled: controlsDisabled || pushSubscriptions === undefined, onClick: () => void sendTestPush(), style: buttonStyle }, t('lan.pwa.pushTest')),
        ),
        pwa.notifications === 'push' && pushSubscriptions !== undefined && createElement('div', { style: dshSettingsNoteStyle }, t('lan.pwa.pushDevices', { count: String(pushSubscriptions) })),
        createElement('div', { style: dshSettingsRowStyle },
          createElement('button', { type: 'button', disabled: controlsDisabled, onClick: () => void unregisterServiceWorker(), style: buttonStyle }, t('lan.pwa.unregisterSw')),
        ),
      ),
    ),
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
