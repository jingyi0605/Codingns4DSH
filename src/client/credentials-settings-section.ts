import { createElement, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'
import type { CodingNsSettings } from '../shared/contracts/config.js'
import type { CredentialFieldMutation, CredentialMetadata, CredentialMutation } from '../shared/contracts/credentials.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { isFeatureEnabled } from '../shared/contracts/config.js'
import type { CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'
import type { CodingNsClientServices, SettingsNotice } from './features/types.js'
import { useCodingNsTranslator } from './locale.js'
import {
  dshPopupSurfaceStyle,
  dshSettingsButtonStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsHeaderStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
  dshSettingsNoteStyle,
  dshSettingsPrimaryButtonStyle,
  dshSettingsSectionHeaderStyle,
  dshSettingsSubtitleStyle,
  dshSettingsTitleStyle,
  dshSettingsPageStyle,
  dshThemeColor,
} from './theme.js'
import { uiFontSize } from './font-scale.js'

export interface CredentialsSettingsSectionProps {
  readonly settings: CodingNsSettingsStore<CodingNsSettings>
  readonly services: CodingNsClientServices
}

interface CredentialFieldDraft {
  readonly name: string
  readonly value: string
  readonly mode: 'keep' | 'replace' | 'clear'
}

interface CredentialEditorState {
  readonly id: string
  readonly label: string
  readonly fields: readonly CredentialFieldDraft[]
}

export function CredentialsSettingsSection({ settings, services }: CredentialsSettingsSectionProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [items, setItems] = useState<readonly CredentialMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<CredentialEditorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<SettingsNotice | null>(null)
  const [enabled, setEnabled] = useState(() => isFeatureEnabled({ name: 'credentials', enabledByDefault: true, version: '0.1.0', dependencies: [], runtime: 'client' }, settings.getSnapshot().value))

  useEffect(() => {
    const sync = (): void => setEnabled(isFeatureEnabled({ name: 'credentials', enabledByDefault: true, version: '0.1.0', dependencies: [], runtime: 'client' }, settings.getSnapshot().value))
    sync()
    return settings.subscribe(sync)
  }, [settings])

  const load = (): void => {
    setLoading(true)
    void services.rpc.call(CODINGNS_RPC_CHANNEL, 'credentials/list', {}).then((result) => {
      if (!result.ok || !Array.isArray(result.value)) throw new Error(result.ok ? 'Invalid credential metadata' : result.error.message)
      setItems(result.value.filter(isMetadata))
    }).catch((error: unknown) => {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('credentials.failed') })
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (enabled) load()
    else {
      setItems([])
      setLoading(false)
    }
  }, [enabled])

  const save = async (): Promise<void> => {
    if (editing === null) return
    const fields: Record<string, CredentialFieldMutation> = {}
    for (const field of editing.fields) {
      if (field.mode === 'replace') fields[field.name] = field.value
      else if (field.mode === 'clear') fields[field.name] = { clear: true }
      else fields[field.name] = { keepExisting: true }
    }
    const mutation: CredentialMutation = { id: editing.id, label: editing.label, fields }
    setBusy(true)
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'credentials/save', mutation)
      if (!result.ok) throw new Error(result.error.message)
      setEditing(null)
      setNotice({ kind: 'success', message: t('credentials.saved') })
      load()
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('credentials.failed') })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!globalThis.confirm(t('credentials.deleteConfirm'))) return
    setBusy(true)
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'credentials/delete', { id })
      if (!result.ok) throw new Error(result.error.message)
      setNotice({ kind: 'success', message: t('credentials.deleted') })
      load()
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('credentials.failed') })
    } finally {
      setBusy(false)
    }
  }

  return createElement('section', { style: pageStyle },
    notice === null ? null : createElement('div', {
      role: notice.kind === 'error' ? 'alert' : 'status',
      style: { ...noticeStyle, borderColor: notice.kind === 'error' ? dshThemeColor.error : dshThemeColor.success },
    }, notice.message),
    createElement('header', { style: headerStyle },
      createElement('div', { style: dshSettingsSectionHeaderStyle },
        createElement('div', { style: { minWidth: 0 } },
          createElement('h1', { style: dshSettingsTitleStyle }, t('credentials.title')),
          createElement('p', { style: dshSettingsSubtitleStyle }, t('credentials.security')),
        ),
        createElement('button', {
          type: 'button',
          style: addButtonStyle,
          disabled: busy || !enabled,
          onClick: () => setEditing({ id: `credential-${Date.now()}`, label: '', fields: [{ name: 'apiKey', value: '', mode: 'replace' }] }),
        }, t('credentials.add')),
      ),
    ),
    !enabled
      ? createElement('div', { role: 'status', style: emptyStyle }, t('credentials.disabledHint'))
      : loading
        ? createElement('div', { role: 'status', style: emptyStyle }, t('credentials.loading'))
        : items.length === 0
          ? createElement('div', { style: emptyStateStyle },
            createElement('div', { style: emptyStateIconStyle, 'aria-hidden': true }, '•'),
            createElement('strong', { style: emptyStateTitleStyle }, t('credentials.empty')),
            createElement('span', { style: dshSettingsHelpStyle }, t('credentials.security')),
          )
          : createElement('div', { style: listStyle },
            ...items.map((item) => createElement('div', { key: item.id, style: credentialRowStyle },
              createElement('div', { style: credentialIconStyle, 'aria-hidden': true }, '•'),
              createElement('div', { style: { minWidth: 0, flex: '1 1 auto', display: 'grid', gap: 4 } },
                createElement('strong', { style: credentialLabelStyle }, item.label),
                createElement('div', { style: metadataStyle },
                  createElement('span', { style: credentialIdStyle }, item.id),
                  createElement('span', { style: fieldListStyle },
                    ...item.fields.map((field) => createElement('span', { key: field.name, style: fieldPillStyle }, `${field.name} · ${t('credentials.masked')}`)),
                  ),
                ),
              ),
              createElement('div', { style: actionStyle },
                createElement('button', {
                  type: 'button',
                  style: compactButtonStyle,
                  disabled: busy,
                  onClick: () => setEditing({ id: item.id, label: item.label, fields: item.fields.map((field) => ({ name: field.name, value: '', mode: 'keep' })) }),
                }, t('credentials.edit')),
                createElement('button', {
                  type: 'button',
                  style: { ...compactButtonStyle, color: dshThemeColor.error },
                  disabled: busy,
                  onClick: () => { void remove(item.id) },
                }, t('credentials.delete')),
              ),
            )),
          ),
    editing === null ? null : renderEditorModal(editing, busy, setEditing, () => setEditing(null), () => { void save() }, t),
  )
}

function CredentialEditorModal(props: {
  readonly editor: CredentialEditorState
  readonly busy: boolean
  readonly onChange: (next: CredentialEditorState) => void
  readonly onCancel: () => void
  readonly onSave: () => void
  readonly t: ReturnType<typeof useCodingNsTranslator>
}): ReactElement {
  const { editor, busy, onChange, onCancel, onSave, t } = props
  return createElement('div', { role: 'presentation', style: modalOverlayStyle, onMouseDown: onCancel },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'codingns-credential-editor-title',
      style: modalStyle,
      onMouseDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    },
      createElement('h2', { id: 'codingns-credential-editor-title', style: { margin: 0, fontSize: uiFontSize(18) } }, editor.id.startsWith('credential-') ? t('credentials.add') : t('credentials.edit')),
      createElement('div', { style: { display: 'grid', gap: 10 } },
        createElement('label', { style: fieldGroupStyle },
          createElement('span', { style: dshSettingsFieldLabelStyle }, t('credentials.label')),
          createElement('input', {
            value: editor.label,
            onChange: (event: { currentTarget: { value: string } }) => onChange({ ...editor, label: event.currentTarget.value }),
            style: inputStyle,
            autoComplete: 'off',
          }),
        ),
        createElement('div', { style: { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12) } }, `${t('credentials.id')}: ${editor.id}`),
      ),
      createElement('div', { style: { display: 'grid', gap: 10, maxHeight: 'min(48vh, 420px)', overflowY: 'auto' } },
        ...editor.fields.map((field, index) => createElement('div', { key: `${field.name}-${index}`, style: fieldRowStyle },
          createElement('label', { style: { ...fieldGroupStyle, flex: '1 1 140px' } },
            createElement('span', { style: dshSettingsFieldLabelStyle }, t('credentials.field')),
            createElement('select', {
              value: field.name,
              onChange: (event: { currentTarget: { value: string } }) => changeFieldName(editor, index, event.currentTarget.value, onChange),
              style: inputStyle,
            },
              ...fieldOptions(editor.fields, field.name).map((option) => createElement('option', { key: option, value: option }, option)),
            ),
          ),
          createElement('label', { style: { ...fieldGroupStyle, flex: '2 1 220px' } },
            createElement('span', { style: dshSettingsFieldLabelStyle }, t('credentials.value')),
            createElement('input', {
              type: 'password',
              value: field.value,
              placeholder: field.mode === 'keep' ? t('credentials.keepExisting') : '',
              onChange: (event: { currentTarget: { value: string } }) => updateField(editor, index, { value: event.currentTarget.value, mode: 'replace' }, onChange),
              style: inputStyle,
              autoComplete: 'new-password',
            }),
          ),
          createElement('button', { type: 'button', style: dshSettingsButtonStyle, onClick: () => updateField(editor, index, { mode: field.mode === 'clear' ? 'keep' : 'clear', value: '' }, onChange) }, field.mode === 'clear' ? t('credentials.keepExisting') : t('credentials.clearValue')),
          createElement('button', { type: 'button', style: { ...dshSettingsButtonStyle, color: dshThemeColor.error }, disabled: editor.fields.length <= 1, onClick: () => onChange({ ...editor, fields: editor.fields.filter((_, itemIndex) => itemIndex !== index) }) }, t('credentials.removeField')),
        )),
        createElement('button', {
          type: 'button',
          style: dshSettingsButtonStyle,
          disabled: fieldOptions(editor.fields, '').length === 0,
          onClick: () => {
            const name = fieldOptions(editor.fields, '')[0]
            if (name !== undefined) onChange({ ...editor, fields: [...editor.fields, { name, value: '', mode: 'replace' }] })
          },
        }, t('credentials.addField')),
      ),
      createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
        createElement('button', { type: 'button', style: dshSettingsButtonStyle, disabled: busy, onClick: onCancel }, t('credentials.cancel')),
        createElement('button', { type: 'button', style: dshSettingsPrimaryButtonStyle, disabled: busy, onClick: onSave }, t('credentials.save')),
      ),
    ),
  )
}

function updateField(editor: CredentialEditorState, index: number, patch: Partial<CredentialFieldDraft>, onChange: (next: CredentialEditorState) => void): void {
  onChange({ ...editor, fields: editor.fields.map((field, itemIndex) => itemIndex === index ? { ...field, ...patch } : field) })
}

function changeFieldName(editor: CredentialEditorState, index: number, name: string, onChange: (next: CredentialEditorState) => void): void {
  const current = editor.fields[index]
  if (current === undefined || current.name === name) return
  const fields = [...editor.fields.map((field, itemIndex) => itemIndex === index ? { name, value: '', mode: 'replace' as const } : field)]
  if (current.mode !== 'replace') fields.push({ name: current.name, value: '', mode: 'clear' })
  onChange({ ...editor, fields })
}

const COMMON_FIELD_NAMES = ['username', 'password', 'apiKey', 'token', 'secret', 'clientId', 'clientSecret', 'endpoint']

function fieldOptions(fields: readonly CredentialFieldDraft[], currentName: string): string[] {
  const used = new Set(fields.filter((field) => field.name !== currentName).map((field) => field.name))
  return [...new Set([...COMMON_FIELD_NAMES, ...fields.map((field) => field.name), currentName])]
    .filter((name) => name !== '' && (!used.has(name) || name === currentName))
}

function isMetadata(value: unknown): value is CredentialMetadata {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && Array.isArray(value.fields)
    && value.fields.every((field) => isRecord(field) && typeof field.name === 'string' && typeof field.hasValue === 'boolean')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const pageStyle = { ...dshSettingsPageStyle, width: '100%', maxWidth: 960, gap: 20, padding: '24px 28px 32px', margin: '0 auto' }
const headerStyle = { ...dshSettingsHeaderStyle, paddingBottom: 14 }
const noticeStyle = { ...dshSettingsNoteStyle, padding: '9px 12px' }
const listStyle = { display: 'flex', flexDirection: 'column' as const }
const emptyStyle = { ...dshSettingsNoteStyle, padding: '14px 16px', borderStyle: 'dashed' as const, background: 'transparent' }
const emptyStateStyle = { ...emptyStyle, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 8, padding: '34px 20px', textAlign: 'center' as const }
const emptyStateIconStyle = { display: 'grid', placeItems: 'center', width: 28, height: 28, border: `1px solid ${dshThemeColor.border}`, borderRadius: 14, color: dshThemeColor.labelTertiary, fontSize: uiFontSize(18), lineHeight: 1 }
const emptyStateTitleStyle = { color: dshThemeColor.labelPrimary, fontSize: uiFontSize(14), fontWeight: 650 }
const credentialRowStyle = { ...dshSettingsListRowStyle, minHeight: 68, padding: '12px 0' }
const credentialIconStyle = { display: 'grid', placeItems: 'center', width: 32, height: 32, flex: '0 0 32px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, color: dshThemeColor.accent, background: dshThemeColor.surfaceSubtle, fontSize: uiFontSize(18), lineHeight: 1 }
const credentialLabelStyle = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, color: dshThemeColor.labelPrimary, fontSize: uiFontSize(14), lineHeight: 1.35, fontWeight: 650 }
const metadataStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: 7, minWidth: 0 }
const credentialIdStyle = { ...dshSettingsHelpStyle, fontFamily: dshThemeColor.codeFont, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
const fieldListStyle = { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: 5 }
const fieldPillStyle = { padding: '2px 7px', border: `1px solid ${dshThemeColor.fieldBorder}`, borderRadius: 999, color: dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle, fontSize: uiFontSize(11), lineHeight: 1.35 }
const actionStyle = { display: 'flex', alignItems: 'center', gap: 5, flex: '0 0 auto' }
const compactButtonStyle = { ...dshSettingsButtonStyle, minHeight: 30, padding: '6px 10px', fontSize: uiFontSize(12) }
const addButtonStyle = { ...dshSettingsPrimaryButtonStyle, minWidth: 96, whiteSpace: 'nowrap' as const }
const fieldGroupStyle = { display: 'flex', flexDirection: 'column' as const, gap: 5 }
const fieldRowStyle = { display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' as const }
const inputStyle = { width: '100%', boxSizing: 'border-box' as const, minHeight: 36, border: `1px solid ${dshThemeColor.fieldBorder}`, borderRadius: 6, padding: '8px 10px', color: dshThemeColor.labelPrimary, background: dshThemeColor.inputBackground, fontSize: uiFontSize(13) }
const modalOverlayStyle = { position: 'fixed' as const, inset: 0, zIndex: 2147483000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: dshThemeColor.overlay }
const modalStyle = { ...dshPopupSurfaceStyle, width: 'min(680px, 100%)', maxHeight: 'min(80vh, 720px)', overflowY: 'auto' as const, boxSizing: 'border-box' as const, display: 'grid', gap: 16, padding: 20, border: `1px solid ${dshThemeColor.menuBorder}`, borderRadius: 12 }

function renderEditorModal(
  editor: CredentialEditorState,
  busy: boolean,
  onChange: (next: CredentialEditorState) => void,
  onCancel: () => void,
  onSave: () => void,
  t: ReturnType<typeof useCodingNsTranslator>,
): ReactElement {
  const modal = createElement(CredentialEditorModal, { editor, busy, onChange, onCancel, onSave, t })
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body)
}
