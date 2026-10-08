import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { ASSISTANT_PROMPT_MAX_CHARS, DEFAULT_ASSISTANT_PROMPTS } from '../../shared/assistant-prompts.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshFieldStyle, dshSettingsButtonStyle, dshSettingsHelpStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import { assistantSettingTextStyle } from '../assistant-settings-styles.js'

/** 草稿只在明确保存时写入；保存单个字段，不覆盖另一阶段的提示词。 */
export function AssistantPromptEditor({ kind, value, disabled, onSave, onChange, t }: { readonly kind: 'index' | 'chat'; readonly value: string; readonly disabled: boolean; readonly onSave: (kind: 'index' | 'chat', value: string) => Promise<void>; readonly onChange?: (kind: 'index' | 'chat', value: string) => Promise<void>; readonly t: CodingNsTranslator }): ReactElement {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const change = (text: string): void => { setDraft(text); void onChange?.(kind, text).catch(() => undefined) }
  return createElement('details', { style: sectionStyle },
    createElement('summary', { style: { ...assistantSettingTextStyle, cursor: 'pointer' } }, t(`assistant.debug.prompt.${kind}`)),
    createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.promptHelp')),
    createElement('textarea', { 'aria-label': t(`assistant.debug.prompt.${kind}`), value: draft, disabled, maxLength: ASSISTANT_PROMPT_MAX_CHARS, rows: 5, onChange: (event: { currentTarget: { value: string } }) => change(event.currentTarget.value), style: { ...dshFieldStyle, ...assistantSettingTextStyle, width: '100%', padding: 10, boxSizing: 'border-box', resize: 'vertical' } }),
    createElement('div', { style: actionsStyle },
      onChange === undefined ? createElement('button', { type: 'button', disabled: disabled || draft === value, style: dshSettingsPrimaryButtonStyle, onClick: () => { void onSave(kind, draft.trim() || DEFAULT_ASSISTANT_PROMPTS[kind]).catch(() => undefined) } }, t('assistant.debug.promptSave')) : null,
      createElement('button', { type: 'button', disabled, style: dshSettingsButtonStyle, onClick: () => change(DEFAULT_ASSISTANT_PROMPTS[kind]) }, t('assistant.debug.promptDefault')),
    ),
  )
}

const actionsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const sectionStyle: CSSProperties = { display: 'grid', gap: 10, minWidth: 0, padding: 14, borderRadius: 8, border: `1px solid ${dshThemeColor.border}` }
