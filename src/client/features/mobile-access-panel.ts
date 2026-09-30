import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_MOBILE_ACCESS_FIELD,
  DEFAULT_MOBILE_ACCESS_SETTINGS,
  MOBILE_VIEWPORT_MAX_PX_LIMITS,
  normalizeMobileAccessSettings,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import {
  dshFormRootStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

/** 移动端访问增强的单列设置面板。 */
export function MobileAccessPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = normalizeMobileAccessSettings(
    snapshot.value?.mobileAccess ?? DEFAULT_MOBILE_ACCESS_SETTINGS,
  )
  const [widthDraft, setWidthDraft] = useState(String(value.mobileViewportMaxPx))
  // 设置可能在面板打开后才加载完成；只在数值真的变化时覆盖输入框草稿。
  useEffect(() => {
    setWidthDraft(String(value.mobileViewportMaxPx))
  }, [value.mobileViewportMaxPx])
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable
  const updateField = (field: string, nextValue: unknown, successMessage: string): void => {
    void services.settings.mutate([{
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
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateField(
          'hideSidebarOnMobile',
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
        disabled,
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
  )
}
