import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { AssistantVoiceSettings } from '../../shared/contracts/config.js'
import { ASSISTANT_VOICE_MODEL_CATALOG, findAssistantVoiceModel } from '../../shared/voice-models.js'
import type { CodingNsClientServices } from './types.js'
import {
  dshFieldStyle,
  dshSettingsButtonStyle,
  dshSettingsHelpStyle,
  dshSettingsPrimaryButtonStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

/** 全局语音助理初始化页；用户只选择模型，路径和下载由 Host 自动处理。 */
export function VoiceInitializationDialog({
  services,
  value,
  onClose,
}: {
  readonly services: CodingNsClientServices
  readonly value: AssistantVoiceSettings
  readonly onClose: () => void
}): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const defaultModelId = ASSISTANT_VOICE_MODEL_CATALOG[0]?.id ?? ''
  const configuredModelId = value.modelId?.trim() ?? ''
  const [modelId, setModelId] = useState(() => (
    configuredModelId !== '' && findAssistantVoiceModel(configuredModelId) !== undefined ? configuredModelId : defaultModelId
  ))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const settingsSnapshot = services.settings.getSnapshot()
  const disabled = saving || settingsSnapshot.status === 'loading' || !settingsSnapshot.writable
  const selectedModel = findAssistantVoiceModel(modelId)

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, saving])

  const save = async (): Promise<void> => {
    if (selectedModel === undefined) {
      setError(t('voice.setup.modelRequired'))
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/setup', { modelId })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      onClose()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return createElement('div', {
    role: 'presentation',
    onPointerDown: () => { if (!saving) onClose() },
    style: {
      position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: dshThemeColor.overlay, boxSizing: 'border-box',
    },
  },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-label': t('voice.setup.title'),
      onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      style: {
        display: 'flex', flexDirection: 'column', gap: 16, width: 'min(560px, 100%)', maxHeight: 'min(620px, 100%)',
        overflowY: 'auto', padding: 24, color: dshThemeColor.labelPrimary, background: dshThemeColor.menuBackground,
        border: `1px solid ${dshThemeColor.border}`, borderRadius: 12, boxShadow: dshThemeColor.prominentShadow,
        boxSizing: 'border-box',
      },
    },
      createElement('div', { style: { display: 'grid', gap: 7 } },
        createElement('strong', { style: { fontSize: 18, lineHeight: 1.4 } }, t('voice.setup.title')),
        createElement('span', { style: dshSettingsHelpStyle }, t('voice.setup.description')),
      ),
      createElement('div', { style: { padding: '11px 13px', borderRadius: 8, background: dshThemeColor.inputBackground, color: dshThemeColor.labelSecondary, fontSize: 13, lineHeight: 1.55 } },
        t('voice.setup.onlyRealtime'),
      ),
      createElement('label', { style: fieldLabelStyle },
        createElement('span', null, t('voice.setup.model')),
        createElement('select', {
          value: modelId,
          disabled,
          onChange: (event: { currentTarget: { value: string } }) => setModelId(event.currentTarget.value),
          style: fieldStyle,
        },
          ...ASSISTANT_VOICE_MODEL_CATALOG.map((model) => createElement('option', { key: model.id, value: model.id }, model.label)),
        ),
      ),
      selectedModel === undefined ? null : createElement('div', { style: { display: 'grid', gap: 5, color: dshThemeColor.labelSecondary, fontSize: 13, lineHeight: 1.5 } },
        createElement('strong', { style: { color: dshThemeColor.labelPrimary, fontSize: 14 } }, selectedModel.label),
        createElement('span', null, selectedModel.description),
        createElement('span', null, t('voice.setup.downloadHint')),
      ),
      saving ? createElement('div', { role: 'status', style: { color: dshThemeColor.labelSecondary, fontSize: 13 } }, t('voice.setup.downloading')) : null,
      error === undefined ? null : createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 13, lineHeight: 1.5 } }, error),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 3 } },
        createElement('button', { type: 'button', disabled: saving, onClick: onClose, style: dshSettingsButtonStyle }, t('voice.setup.cancel')),
        createElement('button', { type: 'button', disabled, onClick: () => void save(), style: dshSettingsPrimaryButtonStyle }, t('voice.setup.save')),
      ),
    ),
  )
}

const fieldLabelStyle = {
  display: 'grid',
  gap: 7,
  color: dshThemeColor.labelSecondary,
  fontSize: 12,
  lineHeight: 1.4,
  fontWeight: 600,
}

const fieldStyle = {
  ...dshFieldStyle,
  width: '100%',
  minHeight: 40,
  padding: '9px 11px',
  borderRadius: 7,
  boxSizing: 'border-box' as const,
  fontSize: 14,
}
