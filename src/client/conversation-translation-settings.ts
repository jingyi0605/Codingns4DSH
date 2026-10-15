import { createElement, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientServices } from './features/types.js'
import type { CodingNsTranslator } from './locale.js'
import { DshModal } from '../dsh-capabilities/client/primitives-adapter.js'
import { SettingsToggleRow } from './settings-controls.js'
import { dshThemeColor } from './theme.js'
import { resolveSessionTranslationOptions } from '../shared/contracts/session-translation.js'

const messageSettings = [
  ['inputEnabled', 'cli.translationUserMessages'],
  ['reasoningEnabled', 'cli.translationThinkingMessages'],
  ['assistantEnabled', 'cli.translationAssistantMessages'],
] as const

/** Per-adapter message preferences, independent of each conversation's master switch. */
export function ConversationTranslationSettings(props: {
  readonly settings: CodingNsClientServices['settings']
  readonly adapterId: string
  readonly t: CodingNsTranslator
  readonly onClose: () => void
}): ReactElement {
  const { settings, adapterId, t } = props
  const snapshot = useSyncExternalStore(settings.subscribe.bind(settings), settings.getSnapshot.bind(settings), settings.getSnapshot.bind(settings))
  const options = resolveSessionTranslationOptions(snapshot.value?.sessionTranslation, adapterId)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const disabled = snapshot.status !== 'ready' || !snapshot.writable || saving
  const save = async (field: typeof messageSettings[number][0], checked: boolean): Promise<void> => {
    if (disabled || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      // Write only the selected field so concurrent model/language edits survive.
      if (!await settings.mutate([{ op: 'set', path: ['sessionTranslation', 'adapterOptions', adapterId, field], value: checked }])) {
        throw new Error(t('translation.saveRejected'))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  return createElement(DshModal, {
    open: true,
    title: t('cli.translationSettings'),
    description: t('cli.translationSettingsDescription', { agent: adapterId }),
    closeLabel: t('cli.translationSettingsClose'),
    onClose: props.onClose,
  },
  ...messageSettings.map(([field, label]) => createElement(SettingsToggleRow, {
    key: field,
    label: t(label),
    checked: options[field],
    disabled,
    onChange: (checked) => { void save(field, checked) },
  })),
  error === null ? null : createElement('div', { role: 'alert', style: { color: dshThemeColor.error, marginTop: 8 } }, error),
  )
}
