import { createElement, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD,
  DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import { dshThemeColor } from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

/** 工作区会话增强的单列设置面板。 */
export function WorkspaceSessionEnhancementPanel({ services, enabled, snapshot }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [writeError, setWriteError] = useState<string | null>(null)
  const value = snapshot.value?.workspaceSessionEnhancement
    ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable

  const updateLogo = (showAdapterLogo: boolean): void => {
    setWriteError(null)
    void services.settings.mutate([{
      op: 'set',
      path: [CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD, 'showAdapterLogo'],
      value: showAdapterLogo,
    }]).catch((cause: unknown) => {
      setWriteError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return createElement('div', {
    'aria-disabled': !enabled,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      opacity: enabled ? 1 : 0.5,
      pointerEvents: enabled ? 'auto' : 'none',
    },
  },
    createElement('label', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 14 } }, t('workspace.showLogo')),
        createElement('span', { style: { display: 'block', marginTop: 3, color: dshThemeColor.labelTertiary, fontSize: 12 } }, t('workspace.logoDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showLogo'),
        checked: value.showAdapterLogo,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateLogo(event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    writeError === null
      ? null
      : createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 12 } }, writeError),
  )
}
