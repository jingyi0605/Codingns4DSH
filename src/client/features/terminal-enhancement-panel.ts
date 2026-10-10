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
  dshSettingsGridStyle,
  dshSettingsHelpStyle,
  dshSettingsNoteStyle,
  dshSettingsRowStyle,
  dshSettingsSectionHeaderStyle,
  dshThemeColor,
} from '../theme.js'
import type { CodingNsRpcClient, FeaturePanelProps } from './types.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'
import { SettingsSwitch } from '../settings-controls.js'
import { uiFontSize } from '../font-scale.js'

const profileLabels: Readonly<Record<TerminalProfileId, string>> = {
  system: 'terminal.systemRecommended',
  zsh: 'zsh',
  bash: 'bash',
  powershell: 'PowerShell',
  cmd: 'cmd',
  'git-bash': 'Git Bash',
}

/** 终端默认行为与外观设置；终端 UI 由独立 Sidebar 模块负责。 */
export function TerminalEnhancementPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = snapshot.value?.terminalEnhancement ?? DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS
  const appearance = resolveAppearance(value.appearance)
  const [hostStatus, setHostStatus] = useState<CodingNsTerminalStatus | null>(null)
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable

  useEffect(() => {
    let active = true
    void callTerminalStatus(services.rpc)
      .then((status) => { if (active) setHostStatus(status) })
      .catch((error: unknown) => {
        if (active) notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { active = false }
  }, [services.rpc])

  const save = (next: TerminalEnhancementSettings): void => {
    debugInfo('codingns4dsh: client terminal settings write begin', {
      field: CODINGNS_TERMINAL_ENHANCEMENT_FIELD,
      bindingScope: next.bindingScope ?? 'workspace',
    })
    void services.settings.set(CODINGNS_TERMINAL_ENHANCEMENT_FIELD, next)
      .then((written) => {
        if (!written) {
          debugWarn('codingns4dsh: client terminal settings write rejected')
          throw new Error(t('terminal.saveRejected'))
        }
        debugInfo('codingns4dsh: client terminal settings write success', {
          bindingScope: next.bindingScope ?? 'workspace',
        })
        notify({ kind: 'success', message: t('terminal.saved') })
      })
      .catch((error: unknown) => notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }
  const updateAppearance = (patch: Partial<TerminalAppearanceSettings>): void => {
    save({ ...value, appearance: { ...value.appearance, theme: 'custom', ...patch } })
  }
  const resetAppearance = (): void => {
    save({ ...value, appearance: { ...DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS.appearance, theme: 'custom' } })
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
    createElement(Field, { label: t('terminal.newDefault'), help: t('terminal.defaultProfileHelp') },
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
      hostStatus?.fallbackReason === undefined ? null : createElement('small', { style: helpStyle }, hostStatus.fallbackReason),
    ),
    createElement(Field, { label: t('terminal.bindingScope'), help: t('terminal.workspaceBindingHelp') },
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
    ),
    createElement('div', { style: dshSettingsSectionHeaderStyle },
      createElement('h3', { style: { margin: 0, color: dshThemeColor.labelPrimary, fontSize: uiFontSize(14), lineHeight: 1.35 } }, t('terminal.appearanceTitle')),
      createElement('button', { type: 'button', disabled, onClick: resetAppearance, style: { ...buttonStyle, minWidth: 132 } }, t('terminal.resetAppearance')),
    ),
    createElement('div', { style: dshSettingsGridStyle },
      createElement(ColorField, { label: t('terminal.background'), value: appearance.background, disabled, onChange: (background) => updateAppearance({ background }) }),
      createElement(ColorField, { label: t('terminal.foreground'), value: appearance.foreground, disabled, onChange: (foreground) => updateAppearance({ foreground }) }),
      createElement(ColorField, { label: t('terminal.cursorColor'), value: appearance.cursorColor, disabled, onChange: (cursorColor) => updateAppearance({ cursorColor }) }),
      createElement(Field, { label: t('terminal.cursorBlink') },
        createElement('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 36, width: '100%' } },
          createElement('span', { style: dshSettingsHelpStyle }, appearance.cursorBlink ? t('terminal.cursorOn') : t('terminal.cursorOff')),
          createElement(SettingsSwitch, {
            'aria-label': t('terminal.cursorBlink'),
            checked: appearance.cursorBlink, disabled,
            onChange: (event: { currentTarget: { checked: boolean } }) => updateAppearance({ cursorBlink: event.currentTarget.checked }),
          }),
        ),
      ),
      createElement(NumberField, { label: t('terminal.fontSize'), value: appearance.fontSize, min: 10, max: 32, step: 1, disabled, onChange: (fontSize) => updateAppearance({ fontSize }) }),
      createElement(NumberField, { label: t('terminal.lineHeight'), value: appearance.lineHeight, min: 1, max: 2, step: 0.1, disabled, onChange: (lineHeight) => updateAppearance({ lineHeight }) }),
      createElement(Field, { label: t('terminal.cursorShape') },
        createElement('select', {
          value: appearance.cursorStyle, disabled,
          onChange: (event: { currentTarget: { value: string } }) => updateAppearance({ cursorStyle: parseCursorStyle(event.currentTarget.value) }),
          style: fieldStyle,
        },
        createElement('option', { value: 'block' }, t('terminal.cursorBlock')),
        createElement('option', { value: 'bar' }, t('terminal.cursorBar')),
        createElement('option', { value: 'underline' }, t('terminal.cursorUnderline'))),
      ),
      createElement(NumberField, { label: t('terminal.scrollback'), value: appearance.scrollback, min: 1000, max: 100000, step: 1000, disabled, onChange: (scrollback) => updateAppearance({ scrollback }) }),
    ),
  )
}

function Field({ label, help, children }: { readonly label: string; readonly help?: string; readonly children?: ReactNode }): ReactElement {
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    createElement('div', { style: fieldHeadingStyle },
      createElement('span', { style: dshSettingsFieldLabelStyle }, label),
      help === undefined ? null : createElement(InfoButton, { label: help }),
    ),
    children,
  )
}

function InfoButton({ label }: { readonly label: string }): ReactElement {
  return createElement('button', {
    type: 'button',
    title: label,
    'aria-label': label,
    style: infoButtonStyle,
  }, 'ⓘ')
}

function ColorField({ label, value, disabled, onChange }: { readonly label: string; readonly value: string; readonly disabled: boolean; readonly onChange: (value: string | null) => void }): ReactElement {
  return createElement(Field, { label }, createElement('div', { style: rowStyle },
    createElement('input', { type: 'color', value, disabled, 'aria-label': label, onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value), style: { width: 48, height: 34 } }),
    createElement('code', { style: { flex: 1 } }, value),
  ))
}

function NumberField({ label, value, min, max, step, disabled, onChange }: { readonly label: string; readonly value: number; readonly min: number; readonly max: number; readonly step: number; readonly disabled: boolean; readonly onChange: (value: number | null) => void }): ReactElement {
  return createElement(Field, { label }, createElement('div', { style: rowStyle },
    createElement('input', {
      type: 'number', value, min, max, step, disabled,
      onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value === '' ? null : Number(event.currentTarget.value)),
      style: { ...fieldStyle, flex: 1, minWidth: 0 },
    }),
  ))
}

interface ResolvedTerminalAppearance {
  readonly background: string
  readonly foreground: string
  readonly cursorColor: string
  readonly fontSize: number
  readonly lineHeight: number
  readonly cursorStyle: NonNullable<TerminalAppearanceSettings['cursorStyle']>
  readonly cursorBlink: boolean
  readonly scrollback: number
}

/** 将旧配置中的 null 映射为 xterm 当前实际使用的默认值，设置页始终显示可编辑值。 */
function resolveAppearance(appearance: TerminalAppearanceSettings): ResolvedTerminalAppearance {
  const foreground = appearance.foreground ?? '#f3f3f3'
  return {
    background: appearance.background ?? '#111111',
    foreground,
    cursorColor: appearance.cursorColor ?? foreground,
    fontSize: appearance.fontSize ?? 13,
    lineHeight: appearance.lineHeight ?? 1,
    cursorStyle: appearance.cursorStyle ?? 'block',
    cursorBlink: appearance.cursorBlink ?? true,
    scrollback: appearance.scrollback ?? 1000,
  }
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

function parseCursorStyle(value: string): TerminalAppearanceSettings['cursorStyle'] {
  return value === 'block' || value === 'bar' || value === 'underline' ? value : null
}

const fieldStyle: CSSProperties = dshSettingsFieldStyle
const buttonStyle: CSSProperties = { ...dshSettingsButtonStyle, flex: '0 0 auto', minWidth: 92 }
const rowStyle: CSSProperties = dshSettingsRowStyle
const helpStyle: CSSProperties = dshSettingsHelpStyle
const noteStyle: CSSProperties = dshSettingsNoteStyle
const fieldHeadingStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const infoButtonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flex: '0 0 20px', padding: 0, border: `1px solid ${dshThemeColor.border}`, borderRadius: '50%', color: dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle, cursor: 'help', fontSize: uiFontSize(12), lineHeight: 1 }
