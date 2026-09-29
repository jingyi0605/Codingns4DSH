import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD,
  DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
  normalizeSidebarGestureSettings,
  SIDEBAR_GESTURE_THRESHOLD_PX_LIMITS,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import { SubscriptionUsageSettingsDialog } from './subscription-usage-panel.js'
import {
  dshFormRootStyle,
  dshSettingsButtonStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

type WorkspaceToggleField = 'showAdapterLogo' | 'showArchivedSessions' | 'showWorkspaceHiding' | 'showSubscriptionUsage' | 'showQuickPhrases' | 'rememberConversationRightbarRatio' | 'sidebarGestures'

/** 工作区会话增强的单列设置面板。 */
export function WorkspaceSessionEnhancementPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [usageSettingsOpen, setUsageSettingsOpen] = useState(false)
  const value = snapshot.value?.workspaceSessionEnhancement
    ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS
  const gestures = normalizeSidebarGestureSettings(value)
  const [thresholdDraft, setThresholdDraft] = useState(String(gestures.sidebarGestureThresholdPx))
  // 设置可能在面板打开后才加载完成；只在数值真的变化时覆盖输入框草稿。
  useEffect(() => {
    setThresholdDraft(String(gestures.sidebarGestureThresholdPx))
  }, [gestures.sidebarGestureThresholdPx])
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable
  const updateField = (field: string, nextValue: unknown, successMessage: string): void => {
    void services.settings.mutate([{
      op: 'set',
      path: [CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD, field],
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
  const updateSetting = (field: WorkspaceToggleField, nextValue: boolean): void => {
    updateField(field, nextValue, '工作区会话设置已保存')
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
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showLogo')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.logoDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showLogo'),
        checked: value.showAdapterLogo,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showAdapterLogo', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showWorkspaceHiding')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.workspaceHidingDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showWorkspaceHiding'),
        checked: value.showWorkspaceHiding,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showWorkspaceHiding', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('div', {
      style: dshSettingsListRowStyle,
    },
      createElement('label', {
        style: { display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 auto', minWidth: 0, cursor: 'pointer' },
      },
        createElement('span', { style: { minWidth: 0 } },
          createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showSubscriptionUsage')),
          createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.subscriptionUsageDescription')),
        ),
        createElement('input', {
          type: 'checkbox',
          role: 'switch',
          'aria-label': t('workspace.showSubscriptionUsage'),
          checked: value.showSubscriptionUsage,
          disabled,
          onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showSubscriptionUsage', event.currentTarget.checked),
          style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
        }),
      ),
      createElement('button', {
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': usageSettingsOpen,
        'aria-label': t('workspace.subscriptionUsageSettings'),
        disabled,
        onClick: () => setUsageSettingsOpen(true),
        style: dshSettingsButtonStyle,
      }, t('workspace.subscriptionUsageSettings')),
    ),
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showArchivedSessions')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.archivedSessionsDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showArchivedSessions'),
        checked: value.showArchivedSessions,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showArchivedSessions', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showQuickPhrases')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.quickPhrasesDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showQuickPhrases'),
        checked: value.showQuickPhrases,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showQuickPhrases', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.rememberConversationRightbarRatio')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.rememberConversationRightbarRatioDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.rememberConversationRightbarRatio'),
        checked: value.rememberConversationRightbarRatio,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('rememberConversationRightbarRatio', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.sidebarGestures')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.sidebarGesturesDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.sidebarGestures'),
        checked: gestures.sidebarGestures,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('sidebarGestures', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    gestures.sidebarGestures && createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingInlineStart: 12 } },
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', { style: dshSettingsFieldLabelStyle }, t('workspace.sidebarGestureMapping')),
        createElement('select', {
          value: gestures.sidebarGestureMapping,
          disabled,
          onChange: (event: { currentTarget: { value: string } }) => updateField('sidebarGestureMapping', event.currentTarget.value, t('workspace.sidebarGestureSaved')),
          style: dshSettingsFieldStyle,
        },
          createElement('option', { value: 'swipe-inward' }, t('workspace.sidebarGestureMappingInward')),
          createElement('option', { value: 'swap' }, t('workspace.sidebarGestureMappingSwap')),
        ),
      ),
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', { style: dshSettingsFieldLabelStyle }, t('workspace.sidebarGestureEdge')),
        createElement('select', {
          value: gestures.sidebarGestureEdge,
          disabled,
          onChange: (event: { currentTarget: { value: string } }) => updateField('sidebarGestureEdge', event.currentTarget.value, t('workspace.sidebarGestureSaved')),
          style: dshSettingsFieldStyle,
        },
          createElement('option', { value: 'avoid' }, t('workspace.sidebarGestureEdgeAvoid')),
          createElement('option', { value: 'edge' }, t('workspace.sidebarGestureEdgeEdge')),
        ),
      ),
      createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('span', { style: dshSettingsFieldLabelStyle }, t('workspace.sidebarGestureThreshold')),
        createElement('input', {
          type: 'number',
          min: SIDEBAR_GESTURE_THRESHOLD_PX_LIMITS.min,
          max: SIDEBAR_GESTURE_THRESHOLD_PX_LIMITS.max,
          value: thresholdDraft,
          disabled,
          onChange: (event: { currentTarget: { value: string } }) => setThresholdDraft(event.currentTarget.value),
          onBlur: () => {
            const next = Number(thresholdDraft)
            if (!Number.isFinite(next)) {
              setThresholdDraft(String(gestures.sidebarGestureThresholdPx))
              return
            }
            const clamped = Math.min(SIDEBAR_GESTURE_THRESHOLD_PX_LIMITS.max, Math.max(SIDEBAR_GESTURE_THRESHOLD_PX_LIMITS.min, Math.round(next)))
            setThresholdDraft(String(clamped))
            if (clamped !== gestures.sidebarGestureThresholdPx) updateField('sidebarGestureThresholdPx', clamped, t('workspace.sidebarGestureSaved'))
          },
          style: dshSettingsFieldStyle,
        }),
        createElement('span', { style: dshSettingsHelpStyle }, t('workspace.sidebarGestureThresholdHelp')),
      ),
    ),
    usageSettingsOpen && createElement(SubscriptionUsageSettingsDialog, {
      services,
      snapshot,
      notify,
      onClose: () => setUsageSettingsOpen(false),
    }),
  )
}
