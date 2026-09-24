import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import {
  CODINGNS_TERMINAL_ENHANCEMENT_FIELD,
  DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
  type TerminalAppearanceSettings,
  type TerminalEnhancementSettings,
  type TerminalProfileId,
} from '../../shared/contracts/config.js'
import type { CodingNsTerminalStatus } from '../../shared/contracts/terminal.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import {
  dshFormRootStyle,
  dshSettingsButtonStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsHelpStyle,
  dshSettingsNoteStyle,
  dshSettingsRowStyle,
  dshThemeColor,
} from '../theme.js'
import type { CodingNsRpcClient, FeaturePanelProps } from './types.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'

const profileLabels: Readonly<Record<TerminalProfileId, string>> = {
  system: 'terminal.systemRecommended',
  zsh: 'zsh',
  bash: 'bash',
  powershell: 'PowerShell',
  cmd: 'cmd',
  'git-bash': 'Git Bash',
}

/** 终端默认行为与外观设置；终端 UI 由独立 Sidebar 模块负责。 */
export function TerminalEnhancementPanel({ services, enabled, snapshot }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = snapshot.value?.terminalEnhancement ?? DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS
  const [fontFamily, setFontFamily] = useState(value.appearance.fontFamily ?? '')
  const [message, setMessage] = useState('')
  const [hostStatus, setHostStatus] = useState<CodingNsTerminalStatus | null>(null)
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable
  const customDisabled = disabled || value.appearance.theme !== 'custom'

  useEffect(() => setFontFamily(value.appearance.fontFamily ?? ''), [value.appearance.fontFamily])
  useEffect(() => {
    let active = true
    void callTerminalStatus(services.rpc)
      .then((status) => { if (active) setHostStatus(status) })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [services.rpc])

  const save = (next: TerminalEnhancementSettings): void => {
    setMessage('')
    void services.settings.set(CODINGNS_TERMINAL_ENHANCEMENT_FIELD, next)
      .then(() => setMessage(t('terminal.saved')))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))
  }
  const updateAppearance = (patch: Partial<TerminalAppearanceSettings>): void => {
    save({ ...value, appearance: { ...value.appearance, ...patch } })
  }
  const saveFontFamily = (): void => {
    try {
      updateAppearance({ fontFamily: normalizeFontFamily(fontFamily) })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  return createElement(
    'div',
    {
      'aria-disabled': disabled,
      style: { ...dshFormRootStyle, display: 'flex', flexDirection: 'column', gap: 16, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' },
    },
    createElement('div', { role: 'note', style: noteStyle },
      t('terminal.restartNote'),
    ),
    createElement('div', { role: 'status', style: noteStyle },
      hostStatus === null
        ? t('terminal.readingStatus')
        : t('terminal.currentStatus', { status: hostStatus.effectiveEnabled ? t('terminal.enhanced') : t('terminal.basic'), platform: platformLabel(hostStatus.platform, t) }),
    ),
    createElement(Field, { label: t('terminal.newDefault') },
      createElement('select', {
        value: value.defaultProfile,
        disabled,
        onChange: (event: { currentTarget: { value: string } }) => save({ ...value, defaultProfile: event.currentTarget.value as TerminalProfileId }),
        style: fieldStyle,
      }, ...profileOptions(value.defaultProfile, hostStatus, t).map((profile) => createElement(
        'option',
        { key: profile.profileId, value: profile.profileId, disabled: !profile.available },
        profile.label,
      ))),
      createElement('small', { style: helpStyle }, t('terminal.defaultProfileHelp')),
      hostStatus?.fallbackReason === undefined ? null : createElement('small', { style: helpStyle }, hostStatus.fallbackReason),
    ),
    createElement(Field, { label: t('terminal.bindingScope') },
      createElement('select', {
        value: value.bindingScope ?? 'workspace',
        disabled,
        onChange: (event: { currentTarget: { value: string } }) => save({
          ...value,
          bindingScope: event.currentTarget.value === 'session' ? 'session' : 'workspace',
        }),
        style: fieldStyle,
      },
      createElement('option', { value: 'workspace' }, t('terminal.workspaceBinding')),
      createElement('option', { value: 'session' }, t('terminal.sessionBinding'))),
      createElement('small', { style: helpStyle }, t('terminal.workspaceBindingHelp')),
    ),
    createElement(Field, { label: t('terminal.theme') },
      createElement('select', {
        value: value.appearance.theme,
        disabled,
        onChange: (event: { currentTarget: { value: string } }) => updateAppearance({ theme: event.currentTarget.value === 'custom' ? 'custom' : 'inherit' }),
        style: fieldStyle,
      },
      createElement('option', { value: 'inherit' }, t('terminal.inheritDshTheme')),
      createElement('option', { value: 'custom' }, t('terminal.custom'))),
    ),
    createElement(ColorField, { label: t('terminal.background'), value: value.appearance.background, disabled: customDisabled, onChange: (background) => updateAppearance({ background }), inheritLabel: t('terminal.inherit'), resetLabel: t('terminal.resetInherit') }),
    createElement(ColorField, { label: t('terminal.foreground'), value: value.appearance.foreground, disabled: customDisabled, onChange: (foreground) => updateAppearance({ foreground }), inheritLabel: t('terminal.inherit'), resetLabel: t('terminal.resetInherit') }),
    createElement(ColorField, { label: t('terminal.cursorColor'), value: value.appearance.cursorColor, disabled: customDisabled, onChange: (cursorColor) => updateAppearance({ cursorColor }), inheritLabel: t('terminal.inherit'), resetLabel: t('terminal.resetInherit') }),
    createElement(Field, { label: t('terminal.font') },
      createElement('div', { style: rowStyle },
        createElement('input', {
          type: 'text', value: fontFamily, maxLength: 128, disabled: customDisabled,
          placeholder: t('terminal.inheritFont'),
          onChange: (event: { currentTarget: { value: string } }) => setFontFamily(event.currentTarget.value),
          onBlur: saveFontFamily,
          style: { ...fieldStyle, flex: 1, minWidth: 0 },
        }),
        createElement(ResetButton, { disabled: customDisabled || value.appearance.fontFamily === null, onClick: () => { setFontFamily(''); updateAppearance({ fontFamily: null }) }, label: t('terminal.resetInherit') }),
      ),
    ),
    createElement(NumberField, { label: t('terminal.fontSize'), value: value.appearance.fontSize, min: 10, max: 32, step: 1, disabled: customDisabled, onChange: (fontSize) => updateAppearance({ fontSize }), inheritLabel: t('terminal.inherit'), resetLabel: t('terminal.resetInherit') }),
    createElement(NumberField, { label: t('terminal.lineHeight'), value: value.appearance.lineHeight, min: 1, max: 2, step: 0.1, disabled: customDisabled, onChange: (lineHeight) => updateAppearance({ lineHeight }), inheritLabel: t('terminal.inherit'), resetLabel: t('terminal.resetInherit') }),
    createElement(Field, { label: t('terminal.cursorShape') },
      createElement('select', {
        value: value.appearance.cursorStyle ?? '', disabled: customDisabled,
        onChange: (event: { currentTarget: { value: string } }) => updateAppearance({ cursorStyle: parseCursorStyle(event.currentTarget.value) }),
        style: fieldStyle,
      },
      createElement('option', { value: '' }, t('terminal.cursorInherit')),
      createElement('option', { value: 'block' }, t('terminal.cursorBlock')),
      createElement('option', { value: 'bar' }, t('terminal.cursorBar')),
      createElement('option', { value: 'underline' }, t('terminal.cursorUnderline'))),
    ),
    createElement(Field, { label: t('terminal.cursorBlink') },
      createElement('div', { style: rowStyle },
        createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
          createElement('input', {
            type: 'checkbox', role: 'switch', 'aria-label': t('terminal.cursorBlink'),
            checked: value.appearance.cursorBlink ?? false, disabled: customDisabled,
            onChange: (event: { currentTarget: { checked: boolean } }) => updateAppearance({ cursorBlink: event.currentTarget.checked }),
          }),
          value.appearance.cursorBlink === null ? t('terminal.inherit') : (value.appearance.cursorBlink ? t('terminal.cursorOn') : t('terminal.cursorOff')),
        ),
        createElement(ResetButton, { disabled: customDisabled || value.appearance.cursorBlink === null, onClick: () => updateAppearance({ cursorBlink: null }), label: t('terminal.resetInherit') }),
      ),
    ),
    createElement(NumberField, { label: t('terminal.scrollback'), value: value.appearance.scrollback, min: 1000, max: 100000, step: 1000, disabled, onChange: (scrollback) => updateAppearance({ scrollback }), inheritLabel: t('terminal.inherit'), resetLabel: t('terminal.resetInherit') }),
    message && createElement('div', { role: 'status', style: { color: message.includes('已保存') ? dshThemeColor.success : dshThemeColor.error } }, message),
  )
}

function Field({ label, children }: { readonly label: string; readonly children?: ReactNode }): ReactElement {
  return createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, createElement('span', { style: dshSettingsFieldLabelStyle }, label), children)
}

function ColorField({ label, value, disabled, onChange, inheritLabel, resetLabel }: { readonly label: string; readonly value: string | null; readonly disabled: boolean; readonly onChange: (value: string | null) => void; readonly inheritLabel: string; readonly resetLabel: string }): ReactElement {
  return createElement(Field, { label }, createElement('div', { style: rowStyle },
    createElement('input', { type: 'color', value: value ?? '#000000', disabled, 'aria-label': label, onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value), style: { width: 48, height: 34 } }),
    createElement('code', { style: { flex: 1 } }, value ?? inheritLabel),
    createElement(ResetButton, { disabled: disabled || value === null, onClick: () => onChange(null), label: resetLabel }),
  ))
}

function NumberField({ label, value, min, max, step, disabled, onChange, inheritLabel, resetLabel }: { readonly label: string; readonly value: number | null; readonly min: number; readonly max: number; readonly step: number; readonly disabled: boolean; readonly onChange: (value: number | null) => void; readonly inheritLabel: string; readonly resetLabel: string }): ReactElement {
  return createElement(Field, { label }, createElement('div', { style: rowStyle },
    createElement('input', {
      type: 'number', value: value ?? '', min, max, step, disabled, placeholder: inheritLabel,
      onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value === '' ? null : Number(event.currentTarget.value)),
      style: { ...fieldStyle, flex: 1, minWidth: 0 },
    }),
    createElement(ResetButton, { disabled: disabled || value === null, onClick: () => onChange(null), label: resetLabel }),
  ))
}

function ResetButton({ disabled, onClick, label }: { readonly disabled: boolean; readonly onClick: () => void; readonly label: string }): ReactElement {
  return createElement('button', { type: 'button', disabled, onClick, style: buttonStyle }, label)
}

function profileOptions(
  selected: TerminalProfileId,
  status: CodingNsTerminalStatus | null,
  t: CodingNsTranslator,
): readonly { profileId: TerminalProfileId; label: string; available: boolean }[] {
  if (status === null) return [{ profileId: 'system', label: t(profileLabels.system), available: true }]
  const profiles = status.profiles.map((profile) => ({
    profileId: profile.profileId,
    label: profile.name,
    available: true,
  }))
  const options = [{ profileId: 'system' as const, label: t(profileLabels.system), available: profiles.length > 0 }, ...profiles]
  if (options.some((profile) => profile.profileId === selected)) return options
  return [...options, { profileId: selected, label: t('terminal.profileUnavailable', { profile: t(profileLabels[selected]) }), available: false }]
}

function platformLabel(platform: CodingNsTerminalStatus['platform'], t: CodingNsTranslator): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return t('terminal.unsupportedPlatform')
}

async function callTerminalStatus(rpc: CodingNsRpcClient): Promise<CodingNsTerminalStatus> {
  let response
  try {
    response = await rpc.call(CODINGNS_RPC_CHANNEL, 'terminal/status', {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/HTTP (?:404|405)\b/u.test(message)) throw error
    response = await rpc.call('/api', 'codingns/terminal/status', {})
  }
  if (!response.ok) throw new Error(response.error.message)
  return response.value as CodingNsTerminalStatus
}

function normalizeFontFamily(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > 128 || /[\u0000-\u001F\u007F]/u.test(trimmed)) throw new TypeError('字体名称格式无效')
  return trimmed
}

function parseCursorStyle(value: string): TerminalAppearanceSettings['cursorStyle'] {
  return value === 'block' || value === 'bar' || value === 'underline' ? value : null
}

const fieldStyle: CSSProperties = dshSettingsFieldStyle
const buttonStyle: CSSProperties = { ...dshSettingsButtonStyle, flex: '0 0 auto', minWidth: 92 }
const rowStyle: CSSProperties = dshSettingsRowStyle
const helpStyle: CSSProperties = dshSettingsHelpStyle
const noteStyle: CSSProperties = dshSettingsNoteStyle
