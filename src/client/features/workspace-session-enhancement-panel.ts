import { createElement, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD,
  DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import { SubscriptionUsageSettingsDialog } from './subscription-usage-panel.js'
import {
  dshFormRootStyle,
  dshSettingsButtonStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

type WorkspaceToggleField = 'showAdapterLogo' | 'showArchivedSessions' | 'showWorkspaceHiding' | 'showSubscriptionUsage' | 'showQuickPhrases' | 'showSkillQuickReference' | 'rememberConversationRightbarRatio'

/** 用量查询设置入口的图标按钮：沿用共享按钮表面，只收成方形并居中图标。 */
const usageSettingsIconButtonStyle: CSSProperties = {
  ...dshSettingsButtonStyle,
  flex: '0 0 auto',
  width: 36,
  height: 36,
  minHeight: 36,
  padding: 0,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}

/** 工作区会话增强的单列设置面板。 */
export function WorkspaceSessionEnhancementPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [usageSettingsOpen, setUsageSettingsOpen] = useState(false)
  const value = snapshot.value?.workspaceSessionEnhancement
    ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS
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
    updateField(field, nextValue, t('workspace.sessionSettingsSaved'))
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
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showSkillQuickReference')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.skillQuickReferenceDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showSkillQuickReference'),
        checked: value.showSkillQuickReference,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showSkillQuickReference', event.currentTarget.checked),
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
        title: t('workspace.subscriptionUsageSettings'),
        disabled,
        onClick: () => setUsageSettingsOpen(true),
        style: usageSettingsIconButtonStyle,
      }, createUsageSettingsGearIcon()),
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
    usageSettingsOpen && createElement(SubscriptionUsageSettingsDialog, {
      services,
      snapshot,
      notify,
      onClose: () => setUsageSettingsOpen(false),
    }),
  )
}

/**
 * 用量查询设置入口的齿轮图标。
 *
 * 文字收成图形后，可访问名称由按钮自身的 aria-label/title 保留；图标只做装饰，
 * 对读屏和指针都隐藏，避免重复朗读和吞掉点击。
 */
function createUsageSettingsGearIcon(): ReactElement {
  return createElement('svg', {
    width: 17,
    height: 17,
    viewBox: '0 0 24 24',
    fill: 'none',
    focusable: false,
    'aria-hidden': true,
    style: { display: 'block', pointerEvents: 'none' },
  },
    createElement('path', {
      d: 'M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.4 7.4 0 0 0-1.7-.98L14.5 2.42A.49.49 0 0 0 14.01 2h-4a.49.49 0 0 0-.49.42L9.14 5.07c-.61.25-1.18.58-1.7.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.21.37.3.61.22l2.49-1c.52.4 1.09.73 1.7.98l.38 2.65c.04.24.25.42.49.42h4c.24 0 .45-.18.49-.42l.38-2.65c.61-.25 1.18-.58 1.7-.98l2.49 1c.24.09.49-.01.61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z',
      fill: 'currentColor',
      fillOpacity: 0.22,
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinejoin: 'round',
    }),
    createElement('circle', {
      cx: 12,
      cy: 12,
      r: 3.1,
      fill: dshThemeColor.accent,
      stroke: 'currentColor',
      strokeWidth: 1.15,
    }),
  )
}
