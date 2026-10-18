import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AssistantChatCatalog } from '../shared/contracts/assistant.js'
import { CODINGNS_GIT_MANAGEMENT_FIELD } from '../shared/contracts/config.js'
import { normalizeGitManagementSettings, type GitManagementSettings } from '../shared/contracts/git.js'
import type { FeaturePanelProps } from './features/types.js'
import { useCodingNsTranslator } from './locale.js'
import { ModelPriorityPool } from './model-priority-pool.js'
import { SettingsToggleRow } from './settings-controls.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { dshFormRootStyle, dshSettingsFieldLabelStyle, dshSettingsFieldStyle, dshSettingsListRowStyle } from './theme.js'

export function GitManagementSettingsPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = normalizeGitManagementSettings(snapshot.value?.gitManagement)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [catalog, setCatalog] = useState<AssistantChatCatalog | null>(null)
  const disabled = !enabled || snapshot.status !== 'ready' || !snapshot.writable || saving
  const generationDisabled = disabled || !value.commitMessageEnabled

  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    void services.rpc.call(CODINGNS_RPC_CHANNEL, 'git/models', {}, AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]))
      .then((result) => { if (!abort.signal.aborted && result.ok) setCatalog(result.value as AssistantChatCatalog) })
      .catch(() => undefined)
    return () => abort.abort()
  }, [services.rpc, enabled])

  const save = async (patch: Partial<GitManagementSettings>): Promise<boolean> => {
    if (disabled || savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    try {
      const next = { ...normalizeGitManagementSettings(services.settings.getSnapshot().value?.gitManagement), ...patch }
      const accepted = await services.settings.set(CODINGNS_GIT_MANAGEMENT_FIELD, next)
      if (!accepted) throw new Error(t('settings.moduleWriteRejected'))
      notify({ kind: 'success', message: t('git.settingsSaved') })
      return true
    } catch (error) {
      notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      return false
    } finally { savingRef.current = false; setSaving(false) }
  }

  return createElement('div', { style: { ...dshFormRootStyle, opacity: disabled ? 0.55 : 1, pointerEvents: disabled ? 'none' : 'auto' }, 'aria-disabled': disabled },
    createElement(SettingsToggleRow, {
      label: t('git.generationEnabled'), description: t('git.generationEnabledHelp'), checked: value.commitMessageEnabled, disabled,
      onChange: (checked) => { void save({ commitMessageEnabled: checked }) },
    }),
    createElement('div', { 'aria-disabled': generationDisabled, style: { opacity: generationDisabled ? 0.55 : 1, pointerEvents: generationDisabled ? 'none' : 'auto' } },
      createElement('label', { style: { ...dshSettingsListRowStyle, flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
        createElement('span', { style: dshSettingsFieldLabelStyle }, t('git.messageDetail')),
        createElement('select', { value: value.commitMessageDetail, disabled: generationDisabled, style: dshSettingsFieldStyle,
          onChange: (event: { currentTarget: { value: string } }) => { void save({ commitMessageDetail: event.currentTarget.value === 'detailed' ? 'detailed' : 'concise' }) },
        }, createElement('option', { value: 'concise' }, t('git.messageConcise')), createElement('option', { value: 'detailed' }, t('git.messageDetailed'))),
      ),
      createElement('div', { style: { ...dshSettingsFieldLabelStyle, margin: '12px 0 8px' } }, t('git.messageModels')),
      createElement(ModelPriorityPool, { models: value.commitMessageModels, catalog, disabled: generationDisabled, pending: saving, t,
        titleKey: 'git.messageModels', pickerTitleKey: 'git.messageModelsPicker', helpKey: 'git.messageModelsHelp',
        saveRejectedKey: 'settings.moduleWriteRejected',
        onChange: (models) => save({ commitMessageModels: models }),
      }),
    ),
  )
}
