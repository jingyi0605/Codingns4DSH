import { createElement, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD,
  DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import { SubscriptionUsageSettingsDialog } from './subscription-usage-panel.js'
import {
  dshFormRootStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'
import { SettingsToggleRow, settingsControlClass, settingsIconButtonStyle } from '../settings-controls.js'

type WorkspaceToggleField = 'showAdapterLogo' | 'showArchivedSessions' | 'showWorkspaceHiding' | 'showSubscriptionUsage' | 'showQuickPhrases' | 'showSkillQuickReference' | 'optimizeSessionTitles' | 'rememberConversationRightbarRatio'

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
    // 所有选项共用同一行结构，文案长度不会影响右侧操作的位置。
    createElement(SettingsToggleRow, {
      label: t('workspace.optimizeSessionTitles'), description: t('workspace.optimizeSessionTitlesDescription'),
      checked: value.optimizeSessionTitles ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.optimizeSessionTitles, disabled,
      onChange: (checked) => updateSetting('optimizeSessionTitles', checked),
    }),
    createElement(SettingsToggleRow, {
      label: t('workspace.showLogo'), description: t('workspace.logoDescription'),
      checked: value.showAdapterLogo, disabled,
      onChange: (checked) => updateSetting('showAdapterLogo', checked),
    }),
    createElement(SettingsToggleRow, {
      label: t('workspace.showSkillQuickReference'), description: t('workspace.skillQuickReferenceDescription'),
      checked: value.showSkillQuickReference, disabled,
      onChange: (checked) => updateSetting('showSkillQuickReference', checked),
    }),
    createElement(SettingsToggleRow, {
      label: t('workspace.showWorkspaceHiding'), description: t('workspace.workspaceHidingDescription'),
      checked: value.showWorkspaceHiding, disabled,
      onChange: (checked) => updateSetting('showWorkspaceHiding', checked),
    }),
    createElement(SettingsToggleRow, {
      label: t('workspace.showSubscriptionUsage'), description: t('workspace.subscriptionUsageDescription'),
      checked: value.showSubscriptionUsage, disabled,
      onChange: (checked) => updateSetting('showSubscriptionUsage', checked),
      actions: createElement('button', {
        type: 'button', className: settingsControlClass.iconButton,
        'aria-haspopup': 'dialog', 'aria-expanded': usageSettingsOpen,
        'aria-label': t('workspace.subscriptionUsageSettings'),
        title: t('workspace.subscriptionUsageSettings'), disabled,
        onClick: () => setUsageSettingsOpen(true), style: settingsIconButtonStyle,
      }, createUsageSettingsGearIcon()),
    }),
    createElement(SettingsToggleRow, {
      label: t('workspace.showArchivedSessions'), description: t('workspace.archivedSessionsDescription'),
      checked: value.showArchivedSessions, disabled,
      onChange: (checked) => updateSetting('showArchivedSessions', checked),
    }),
    createElement(SettingsToggleRow, {
      label: t('workspace.showQuickPhrases'), description: t('workspace.quickPhrasesDescription'),
      checked: value.showQuickPhrases, disabled,
      onChange: (checked) => updateSetting('showQuickPhrases', checked),
    }),
    createElement(SettingsToggleRow, {
      label: t('workspace.rememberConversationRightbarRatio'), description: t('workspace.rememberConversationRightbarRatioDescription'),
      checked: value.rememberConversationRightbarRatio, disabled,
      onChange: (checked) => updateSetting('rememberConversationRightbarRatio', checked),
    }),
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
