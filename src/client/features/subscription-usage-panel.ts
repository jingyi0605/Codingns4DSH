import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_SUBSCRIPTION_USAGE_FIELD,
  SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS,
  SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS,
  normalizeSubscriptionUsageSettings,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import {
  dshFieldStyle,
  dshPopupSurfaceStyle,
  dshSettingsButtonStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
  dshSettingsPrimaryButtonStyle,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'
import { uiFontSize } from '../font-scale.js'

/**
 * 用量查询设置对话框：单次查询超时与自动查询间隔。
 *
 * 两项设置由 Host 统一下发给所有适配器读取器；Client 侧所有 Agent 共用同一个
 * 自动刷新定时器与同一份结果缓存，不区分具体适配器。
 */
export function SubscriptionUsageSettingsDialog({ services, snapshot, notify, onClose }: {
  readonly services: FeaturePanelProps['services']
  readonly snapshot: FeaturePanelProps['snapshot']
  readonly notify: FeaturePanelProps['notify']
  readonly onClose: () => void
}): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = normalizeSubscriptionUsageSettings(snapshot.value?.subscriptionUsage)
  const disabled = snapshot.status === 'loading' || !snapshot.writable
  const [timeoutText, setTimeoutText] = useState(() => String(value.timeoutSecs))
  const [intervalText, setIntervalText] = useState(() => String(value.refreshIntervalMins))

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const save = (): void => {
    const next = normalizeSubscriptionUsageSettings({
      timeoutSecs: Number(timeoutText),
      refreshIntervalMins: Number(intervalText),
    })
    void services.settings.mutate([
      { op: 'set', path: [CODINGNS_SUBSCRIPTION_USAGE_FIELD, 'timeoutSecs'], value: next.timeoutSecs },
      { op: 'set', path: [CODINGNS_SUBSCRIPTION_USAGE_FIELD, 'refreshIntervalMins'], value: next.refreshIntervalMins },
    ]).then((accepted) => {
      if (!accepted) {
        notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
        return
      }
      notify({ kind: 'success', message: t('subscriptionUsage.saved') })
      onClose()
    }).catch((cause: unknown) => {
      notify({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  return createElement('div', {
    className: 'codingns4dsh-usage-settings-overlay',
    role: 'presentation',
    onPointerDown: onClose,
    style: usageSettingsOverlayStyle,
  },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-label': t('subscriptionUsage.dialogTitle'),
      onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      style: usageSettingsDialogStyle,
    },
      createElement('div', { style: { display: 'grid', gap: 4 } },
        createElement('strong', { style: { fontSize: uiFontSize(14), lineHeight: 1.4 } }, t('subscriptionUsage.dialogTitle')),
        createElement('span', { style: dshSettingsHelpStyle }, t('subscriptionUsage.dialogHint')),
      ),
      createElement(UsageQueryNumberField, {
        label: t('subscriptionUsage.timeoutSecs'),
        value: timeoutText,
        min: SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS.min,
        max: SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS.max,
        disabled,
        onChange: setTimeoutText,
      }),
      createElement(UsageQueryNumberField, {
        label: t('subscriptionUsage.refreshInterval'),
        help: t('subscriptionUsage.refreshIntervalHint'),
        value: intervalText,
        min: SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS.min,
        max: SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS.max,
        disabled,
        onChange: setIntervalText,
      }),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 } },
        createElement('button', {
          type: 'button',
          onClick: onClose,
          style: dshSettingsButtonStyle,
        }, t('subscriptionUsage.cancel')),
        createElement('button', {
          type: 'button',
          disabled,
          onClick: save,
          style: dshSettingsPrimaryButtonStyle,
        }, t('subscriptionUsage.save')),
      ),
    ),
  )
}

/** 整数输入行：文本受控，保存时统一夹取到合法区间。 */
function UsageQueryNumberField({ label, help, value, min, max, disabled, onChange }: {
  readonly label: string
  readonly help?: string
  readonly value: string
  readonly min: number
  readonly max: number
  readonly disabled: boolean
  readonly onChange: (value: string) => void
}): ReactElement {
  return createElement('div', { style: usageQueryNumberRowStyle },
    createElement('span', { style: { minWidth: 0 } },
      createElement('strong', { style: { display: 'block', fontSize: uiFontSize(13), lineHeight: 1.4 } }, label),
      help === undefined ? null : createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, help),
    ),
    createElement('input', {
      type: 'number',
      min,
      max,
      step: 1,
      'aria-label': label,
      value,
      disabled,
      onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value),
      style: usageQueryNumberInputStyle,
    }),
  )
}

const usageSettingsOverlayStyle = {
  position: 'fixed' as const,
  inset: 0,
  zIndex: 1400,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  boxSizing: 'border-box' as const,
  background: 'rgba(0, 0, 0, 0.35)',
}
const usageSettingsDialogStyle = {
  ...dshPopupSurfaceStyle,
  width: 'min(100%, 420px)',
  boxSizing: 'border-box' as const,
  padding: 16,
  borderRadius: 12,
  display: 'grid',
  gap: 12,
}
const usageQueryNumberRowStyle = { ...dshSettingsListRowStyle, justifyContent: 'space-between' as const }
const usageQueryNumberInputStyle = { ...dshFieldStyle, flex: '0 0 auto', width: 110, minHeight: 32, boxSizing: 'border-box' as const, padding: '5px 8px', borderRadius: 6, fontSize: uiFontSize(13) }
