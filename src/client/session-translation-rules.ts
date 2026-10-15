import { createElement, Fragment, useEffect, useState, type ReactElement } from 'react'
import { DshButton, DshModal } from '../dsh-capabilities/client/primitives-adapter.js'
import type { CodingNsTranslator } from './locale.js'
import { dshSettingsFieldStyle, dshSettingsHelpStyle, dshSettingsListRowStyle, dshThemeColor } from './theme.js'

interface TranslationRulesProps {
  readonly rules: readonly string[]
  readonly disabled: boolean
  readonly pending: boolean
  readonly t: CodingNsTranslator
  readonly onChange: (rules: readonly string[]) => Promise<boolean>
}

/** Only saved entries enter translation prompts; cancelled or failed edits stay local. */
export function SessionTranslationRules({ rules, disabled, pending, t, onChange }: TranslationRulesProps): ReactElement {
  const [draft, setDraft] = useState<{ index: number; text: string } | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const identity = JSON.stringify(rules)
  useEffect(() => { setDraft(null) }, [identity])
  useEffect(() => { if (disabled && !pending) setDraft(null) }, [disabled, pending])

  const close = (): void => { if (!pending) setDraft(null) }
  const edit = (index: number): void => {
    if (disabled || draft !== null) return
    setSaveFailed(false)
    setDraft({ index, text: rules[index] ?? '' })
  }
  const save = async (): Promise<void> => {
    if (disabled || draft === null || draft.text.trim() === '') return
    const next = [...rules]
    next[draft.index] = draft.text.trim()
    if (JSON.stringify(next) === identity) { close(); return }
    setSaveFailed(false)
    if (await onChange(next)) setDraft(null)
    else setSaveFailed(true)
  }

  return createElement('div', { 'aria-busy': pending, style: { display: 'grid', gap: 10, minWidth: 0 } },
    createElement('div', { style: dshSettingsHelpStyle }, t('translation.rulesHelp')),
    rules.length === 0
      ? createElement('div', { style: dshSettingsHelpStyle }, t('translation.rulesEmpty'))
      : createElement('ol', { 'aria-label': t('translation.rulesTitle'), style: { margin: 0, padding: 0, listStyle: 'none' } },
        ...rules.map((rule, index) => createElement('li', { key: index, style: { ...dshSettingsListRowStyle, flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
          createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, rule),
          createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            createElement(DshButton, { type: 'button', size: 'sm', variant: 'outline', disabled: disabled || draft !== null,
              onClick: () => edit(index),
            }, t('translation.ruleEdit', { number: index + 1 })),
            createElement(DshButton, { type: 'button', size: 'sm', disabled: disabled || draft !== null,
              onClick: () => { if (!disabled && draft === null) void onChange(rules.filter((_, position) => position !== index)) },
            }, t('translation.ruleRemove', { number: index + 1 })),
          ),
        )),
      ),
    createElement(DshButton, { type: 'button', size: 'sm', variant: 'outline', disabled: disabled || draft !== null,
      style: { justifySelf: 'start' }, onClick: () => edit(rules.length),
    }, t('translation.ruleAdd')),
    createElement(DshModal, {
      open: draft !== null, onClose: close,
      title: t(draft?.index === rules.length ? 'translation.ruleAdd' : 'translation.ruleEdit', { number: (draft?.index ?? 0) + 1 }),
      closeLabel: t('translation.ruleCancel'),
      footer: createElement(Fragment, null,
        createElement(DshButton, { type: 'button', variant: 'outline', disabled: pending, onClick: close }, t('translation.ruleCancel')),
        createElement(DshButton, { type: 'button', variant: 'primary', disabled: disabled || !draft?.text.trim(),
          onClick: () => { void save() },
        }, t(pending ? 'translation.ruleSaving' : 'translation.ruleSave')),
      ),
    },
    createElement('label', { style: { display: 'grid', gap: 6 } },
      createElement('span', null, t('translation.ruleText')),
      createElement('textarea', { rows: 5, value: draft?.text ?? '', disabled,
        'aria-label': t('translation.ruleText'), 'data-modal-autofocus': true,
        placeholder: t('translation.rulePlaceholder'), style: { ...dshSettingsFieldStyle, resize: 'vertical' },
        onChange: (event: { currentTarget: { value: string } }) => { if (!disabled && draft !== null) setDraft({ ...draft, text: event.currentTarget.value }) },
      }),
    ),
    saveFailed && createElement('div', { role: 'alert', style: { ...dshSettingsHelpStyle, color: dshThemeColor.error } }, t('translation.saveRejected')),
    ),
  )
}
