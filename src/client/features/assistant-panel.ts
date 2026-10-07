import { createElement } from 'react'
import type { ReactElement } from 'react'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/contracts/config.js'
import { readAssistantProfile } from '../../shared/assistant-lifecycle.js'
import { useCodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsHelpStyle } from '../theme.js'
import { openAssistantWorkbench } from './assistant-workbench-entry.js'
import type { FeaturePanelProps } from './types.js'

/** 插件设置只提供统一入口；不重复维护范围、音色或形象表单。 */
export function AssistantPanel({ services, enabled, snapshot }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const profile = readAssistantProfile(snapshot.value?.assistant ?? DEFAULT_ASSISTANT_SETTINGS)
  return createElement('div', { style: { display: 'grid', gap: 10 } },
    createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, enabled ? profile.initialized ? profile.name : t('awb.initial') : t('awb.disabled')),
    createElement('button', { type: 'button', disabled: !enabled || snapshot.status !== 'ready', style: { ...dshSettingsButtonStyle, justifySelf: 'start' },
      onClick: () => openAssistantWorkbench(true) }, t(profile.initialized ? 'awb.open' : 'awb.create')))
}
