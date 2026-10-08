import { createElement, useEffect, useId, useRef } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { resolveAssistantControlIcon, type AssistantControlIcon } from '../../dsh-capabilities/client/primitives-adapter.js'
import type { AssistantDebugSnapshot } from '../../shared/contracts/assistant.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import { resizeAssistantComposerTextarea, isAssistantClearCommandSuggestion } from './assistant-composer-input.js'

export type AssistantWorkbenchStatus = 'thinking' | 'updating' | 'idle' | 'working'
export type AssistantMaintenanceConfirmation = 'clear' | 'reset-first' | 'reset-final'

/** 活动状态优先；只有正在构建索引才显示认知更新，等待或缺少结果不代表正在执行。 */
export function resolveAssistantWorkbenchStatus({ running, working, voiceActive, voiceState, hasProjects, indexState }: {
  readonly running: boolean; readonly working: boolean; readonly voiceActive: boolean; readonly voiceState?: string | undefined
  readonly hasProjects: boolean; readonly indexState: AssistantDebugSnapshot['indexState'] | undefined
}): AssistantWorkbenchStatus {
  if (running || voiceActive && voiceState === 'thinking') return 'thinking'
  if (working || voiceActive) return 'working'
  if (hasProjects && indexState === 'building') return 'updating'
  return 'idle'
}

export function AssistantStatusBadge({ status, t }: { readonly status: AssistantWorkbenchStatus; readonly t: CodingNsTranslator }): ReactElement {
  return createElement('span', { role: 'status', 'aria-live': 'polite', 'data-codingns-assistant-status': status,
    style: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 999,
      fontSize: 11, lineHeight: 1.4, whiteSpace: 'nowrap', color: status === 'idle' ? dshThemeColor.labelSecondary : dshThemeColor.accent,
      background: dshThemeColor.surfaceSubtle, border: `1px solid ${dshThemeColor.border}`, flexShrink: 0 } },
    createElement('span', { 'aria-hidden': true, style: { width: 5, height: 5, borderRadius: '50%', background: 'currentColor' } }), t(`awb.state.${status}`))
}

/** 一行圆角输入栏；长消息有限度增长，停止、语音和发送均有可访问的按钮名称。 */
interface AssistantComposerProps {
  readonly t: CodingNsTranslator; readonly value: string; readonly disabled: boolean
  readonly onChange: (value: string) => void; readonly onSend: () => void; readonly label?: 'awb.send'
  readonly running?: boolean; readonly stopping?: boolean; readonly onStop?: () => void
  readonly voiceActive?: boolean; readonly voiceDisabled?: boolean; readonly onVoice?: () => void
  readonly files?: readonly File[]; readonly onFiles?: (files: readonly File[]) => void; readonly onRemoveFile?: (index: number) => void
}
export function AssistantComposer(props: AssistantComposerProps): ReactElement {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => { if (textarea.current !== null) resizeAssistantComposerTextarea(textarea.current) }, [props.value, props.disabled])
  useEffect(() => {
    const input = textarea.current
    if (input === null) return undefined
    const resize = (): void => resizeAssistantComposerTextarea(input)
    let width = input.clientWidth
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize() }
    })
    observer?.observe(input)
    window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize)
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize) }
  }, [])
  return createElement('div', null,
    createElement(AssistantControlsStyle),
    createElement('input', { ref: picker, type: 'file', multiple: true, hidden: true, 'aria-label': props.t('awb.attachments.add'),
      onChange: (event: { currentTarget: HTMLInputElement }) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!props.disabled) props.onFiles?.(files) } }),
    createElement(AssistantComposerView, { ...props, textareaRef: textarea,
      onAttach: props.onFiles === undefined ? undefined : () => picker.current?.click() }))
}

/** 事件与布局保持独立，自动高度和文件选择器只由外层绑定浏览器生命周期。 */
export function AssistantComposerView({ t, value, disabled, onChange, onSend, label = 'awb.send', running = false, stopping = false, onStop,
  voiceActive = false, voiceDisabled = true, onVoice, files = [], onRemoveFile, onFiles, onAttach, textareaRef }: AssistantComposerProps & {
    readonly onAttach?: (() => void) | undefined; readonly textareaRef?: React.RefObject<HTMLTextAreaElement>
  }): ReactElement {
  const send = (): void => { if (!disabled && !running && (value.trim() || files.length > 0)) onSend() }
  const voiceLabel = t(voiceActive ? 'voice.dialog.stop' : 'voice.dialog.start')
  const sendDisabled = running ? stopping || onStop === undefined : disabled || !value.trim() && files.length === 0
  return createElement('form', { 'data-codingns-assistant-composer': true,
    style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 30,
      border: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.surfaceSubtle, minWidth: 0, outline: 'none', boxShadow: 'none' },
    onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); send() } },
    files.length === 0 ? null : createElement('div', { 'data-codingns-assistant-attachments': true, style: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 8px', maxHeight: 100, overflowY: 'auto' } },
      ...files.map((file, index) => createElement('span', { key: `${index}:${file.name}`, style: { display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', padding: '3px 8px', borderRadius: 10, background: dshThemeColor.buttonBackground, border: `1px solid ${dshThemeColor.border}`, fontSize: 12 } },
        createElement('span', { title: file.name, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.name),
        createElement(AssistantIconButton, { icon: 'close', label: t('awb.attachments.remove', { name: file.name }), disabled,
          size: 24, onClick: () => onRemoveFile?.(index) })))),
    createElement('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 8, minWidth: 0 } },
    onAttach === undefined ? null : createElement(AssistantIconButton, { icon: 'add', label: t('awb.attachments.add'), disabled, size: 38, onClick: onAttach }),
    createElement('textarea', { ref: textareaRef, value, disabled, maxLength: 8000, rows: 1, 'aria-label': t('awb.placeholder'), placeholder: t('awb.placeholder'),
      style: { flex: '1 1 auto', width: '100%', minWidth: 0, minHeight: 38, maxHeight: 'min(120px, 20dvh)', padding: '9px 0', boxSizing: 'border-box',
        resize: 'none', overflowY: 'hidden', border: 0, outline: 'none', boxShadow: 'none', borderRadius: 0, background: 'transparent', color: dshThemeColor.labelPrimary, font: 'inherit', fontSize: 14, lineHeight: '20px' },
      onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value),
      onInput: (event: { currentTarget: HTMLTextAreaElement }) => resizeAssistantComposerTextarea(event.currentTarget),
      onPaste: (event: { clipboardData: DataTransfer; preventDefault(): void }) => {
        if (!disabled && onFiles !== undefined && event.clipboardData.files.length > 0) { event.preventDefault(); onFiles(Array.from(event.clipboardData.files)) }
      },
      onKeyDown: (event: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean }; preventDefault(): void }) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
      } }),
    onVoice === undefined ? null : createElement('button', { type: 'button', disabled: voiceDisabled, 'aria-label': voiceLabel, className: 'codingns-assistant-icon-button',
      'aria-pressed': voiceActive, title: voiceDisabled && !voiceActive ? t('awb.voiceUnavailable') : voiceLabel,
      style: { ...iconButtonStyle, color: voiceActive ? dshThemeColor.accent : dshThemeColor.labelPrimary,
        opacity: voiceDisabled ? 0.4 : 1, cursor: voiceDisabled ? 'default' : 'pointer' },
      onClick: () => { if (!voiceDisabled) onVoice() } }, createElement(resolveAssistantControlIcon('phone'), { size: 20 })),
    createElement('button', { type: running ? 'button' : 'submit', 'aria-label': t(running ? 'awb.stop' : label), title: t(running ? 'awb.stop' : label),
      disabled: sendDisabled,
      onClick: running ? () => { if (!stopping) onStop?.() } : undefined,
      style: { ...iconButtonStyle, color: dshThemeColor.switchThumb, background: dshThemeColor.accent,
        opacity: sendDisabled ? 0.4 : 1, cursor: sendDisabled ? 'default' : 'pointer' } }, createElement(resolveAssistantControlIcon(running ? 'stop' : 'send'), { size: 20 }))),
    !isAssistantClearCommandSuggestion(value) ? null : createElement('button', { type: 'button', disabled,
      'data-codingns-assistant-command': 'clear', style: { ...dshSettingsButtonStyle, textAlign: 'left', margin: '0 6px 2px', border: 0, borderRadius: 10 },
      onClick: () => { if (!disabled) onChange('/clear') } }, createElement('strong', { style: { marginRight: 8 } }, '/clear'), t('awb.command.clear')))
}

export function AssistantIconButton({ icon, label, disabled = false, size = 32, onClick }: {
  readonly icon: AssistantControlIcon; readonly label: string; readonly disabled?: boolean; readonly size?: number; readonly onClick: () => void
}): ReactElement {
  return createElement('button', { type: 'button', disabled, title: label, 'aria-label': label, className: 'codingns-assistant-icon-button',
    style: { ...iconButtonStyle, width: size, height: size, borderRadius: size === 38 ? '50%' : 8, color: dshThemeColor.labelSecondary,
      opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' },
    onClick: () => { if (!disabled) onClick() } }, createElement(resolveAssistantControlIcon(icon), { size: size < 30 ? 14 : 20 }))
}

/** 第一轮重置确认只推进阶段，第二轮才允许执行，清理仍只需一次确认。 */
export function confirmAssistantMaintenance(stage: AssistantMaintenanceConfirmation, next: (stage: AssistantMaintenanceConfirmation) => void,
  execute: (action: 'clear' | 'reset') => void): void {
  if (stage === 'reset-first') next('reset-final')
  else execute(stage === 'clear' ? 'clear' : 'reset')
}

export function AssistantMaintenanceDialog(props: {
  readonly stage: AssistantMaintenanceConfirmation; readonly t: CodingNsTranslator; readonly disabled: boolean; readonly error?: string
  readonly onConfirm: () => void; readonly onCancel: () => void
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    return () => { if (dialog?.open) dialog.close(); if (opener?.isConnected) opener.focus() }
  }, [])
  return createElement('dialog', { ref, 'aria-labelledby': id, 'data-codingns-assistant-confirmation': props.stage,
    onCancel: (event: { preventDefault(): void }) => { event.preventDefault(); if (!props.disabled) props.onCancel() },
    onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!props.disabled) props.onCancel() }
    }, style: { padding: 24, borderRadius: 16, maxWidth: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)',
      margin: 'auto', boxSizing: 'border-box', overflowY: 'auto', background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary,
      border: `1px solid ${dshThemeColor.border}`, boxShadow: dshThemeColor.prominentShadow } },
    createElement('strong', { id, style: { fontSize: 17 } }, props.t(props.stage === 'clear' ? 'awb.clear' : props.stage === 'reset-first' ? 'awb.reset' : 'awb.resetFinalTitle')),
    createElement(AssistantMaintenanceConfirmationView, props))
}

export function AssistantMaintenanceConfirmationView({ stage, t, disabled, error, onConfirm, onCancel }: {
  readonly stage: AssistantMaintenanceConfirmation; readonly t: CodingNsTranslator; readonly disabled: boolean; readonly error?: string
  readonly onConfirm: () => void; readonly onCancel: () => void
}): ReactElement {
  return createElement('div', { style: { display: 'grid', gap: 16, marginTop: 14, fontSize: 13, lineHeight: 1.6 } },
    createElement('p', { style: { margin: 0, color: dshThemeColor.labelSecondary } }, t(stage === 'clear' ? 'awb.clearConfirm' : stage === 'reset-first' ? 'awb.resetConfirm' : 'awb.resetFinalConfirm')),
    !error ? null : createElement('p', { role: 'alert', style: { margin: 0, color: dshThemeColor.error, overflowWrap: 'anywhere' } }, error),
    createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      createElement('button', { type: 'button', autoFocus: true, disabled, style: dshSettingsButtonStyle,
        onClick: () => { if (!disabled) onCancel() } }, t('awb.cancel')),
      createElement('button', { type: 'button', disabled, style: dshSettingsPrimaryButtonStyle,
        onClick: () => { if (!disabled) onConfirm() } }, t(stage === 'reset-first' ? 'awb.resetContinue' : stage === 'reset-final' ? 'awb.resetFinalAction' : 'awb.confirm'))))
}

const iconButtonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  width: 38, height: 38, padding: 0, border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer' }

/** 创建与配置页也复用标题按钮的悬停样式，不依赖对话输入栏挂载。 */
export function AssistantControlsStyle(): ReactElement { return createElement('style', null, assistantComposerCss) }

// 移动端顶部和底部统一使用 11px 内边距，正文与设置区域左右对齐，保留按钮尺寸。
// 仅覆盖助理输入框的焦点样式；按钮仍保留宿主键盘焦点提示。
const assistantComposerCss = `
@media (max-width:768px){
[data-codingns-assistant-workbench]>header,[data-codingns-assistant-workbench]>footer{padding:11px!important}
[data-codingns-assistant-workbench]>[data-codingns-assistant-scroll]{padding-left:11px!important;padding-right:11px!important}
}
[data-codingns-assistant-composer] textarea,[data-codingns-assistant-composer] textarea:focus,[data-codingns-assistant-composer] textarea:focus-visible{outline:none!important;box-shadow:none!important;border:0!important;resize:none!important}
.codingns-assistant-icon-button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)!important}
.codingns-assistant-icon-button:not(:disabled):active{background:var(--dsw-alias-interactive-bg-active)!important}
`
