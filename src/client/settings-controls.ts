import { createElement, useEffect, useId } from 'react'
import type { CSSProperties, InputHTMLAttributes, ReactElement, ReactNode } from 'react'
import { dshSettingsHelpStyle, dshSettingsListRowStyle, dshThemeColor } from './theme.js'

export const settingsControlClass = {
  switch: 'codingns4dsh-settings-switch',
  track: 'codingns4dsh-settings-switch-track',
  thumb: 'codingns4dsh-settings-switch-thumb',
  iconButton: 'codingns4dsh-settings-icon-button',
} as const

/** 模块使用主开关，子设置使用更小、更轻的开关；保留 checkbox 的标签与键盘语义。 */
export function SettingsSwitch(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role' | 'style'> & {
  readonly 'data-codingns-third-party-enabled'?: boolean
  readonly variant?: 'module' | 'setting'
}): ReactElement {
  useEffect(() => retainSettingsControlStyles(), [])
  // 默认使用子设置规格，只有模块标题栏显式提升视觉层级。
  const { variant = 'setting', ...inputProps } = props
  const width = variant === 'module' ? 36 : 28
  return createElement('span', {
    className: settingsControlClass.switch,
    'data-variant': variant,
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', flex: `0 0 ${width}px`, width, height: 28, marginLeft: 'auto' },
  },
    createElement('input', {
      type: 'checkbox', role: 'switch', ...inputProps,
      style: { position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, opacity: 0, cursor: props.disabled ? 'not-allowed' : 'pointer', zIndex: 1 },
    }),
    createElement('span', { className: settingsControlClass.track, 'aria-hidden': true },
      createElement('span', { className: settingsControlClass.thumb })),
  )
}

interface SettingsToggleRowProps {
  readonly label: string
  readonly description?: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (checked: boolean) => void
  /** 设置图标等辅助操作固定排在开关左边，不放进 label，避免误切换。 */
  readonly actions?: ReactNode
  readonly style?: CSSProperties
}

/** 文案占据剩余宽度；右侧操作不收缩，长说明和窄屏都不会移动开关。 */
export function SettingsToggleRow({ label, description, checked, disabled, onChange, actions, style }: SettingsToggleRowProps): ReactElement {
  const id = useId()
  return createElement('div', { style: { ...dshSettingsListRowStyle, ...style } },
    createElement('label', { htmlFor: id, style: { flex: '1 1 auto', minWidth: 0, cursor: disabled ? 'not-allowed' : 'pointer', overflowWrap: 'anywhere' } },
      createElement('span', { style: { display: 'block', fontSize: 13, fontWeight: 500, lineHeight: 1.4 } }, label),
      description === undefined ? null : createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, description)),
    createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 10, flex: '0 0 auto', marginLeft: 'auto' } },
      actions,
      createElement(SettingsSwitch, { id, 'aria-label': label, checked, disabled,
        onChange: (event) => onChange(event.currentTarget.checked) })),
  )
}

/** 图标按钮采用 DSH 的紧凑中性表面，交互态由共享样式表提供。 */
export const settingsIconButtonStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 32px',
  width: 32, height: 32, padding: 0, boxSizing: 'border-box', border: 0,
  borderRadius: 'var(--dsw-radius-sm, 6px)', color: dshThemeColor.labelSecondary,
  background: 'transparent', cursor: 'pointer',
}

/** 各独立面板共享一份样式，最后一个开关卸载时释放，兼容 React 严格模式的重复挂载。 */
const retainedStyles = new WeakMap<Document, { element: HTMLStyleElement; users: number }>()
function retainSettingsControlStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const dom = document
  let state = retainedStyles.get(dom)
  if (state === undefined) {
    const element = dom.createElement('style')
    element.dataset.plugin = 'codingns4dsh'
    element.dataset.pluginCss = 'codingns4dsh-settings-controls'
    element.textContent = settingsControlCss
    dom.head.appendChild(element)
    state = { element, users: 0 }
    retainedStyles.set(dom, state)
  }
  const retained = state
  retained.users += 1
  return () => {
    retained.users -= 1
    if (retained.users > 0) return
    retained.element.remove()
    retainedStyles.delete(dom)
  }
}

export const settingsControlCss = `
.${settingsControlClass.switch}{--codingns-switch-height:16px;--codingns-switch-thumb:12px;--codingns-switch-travel:12px;--codingns-switch-active:var(--dsw-alias-button-info-fill);--codingns-switch-active-thumb:var(--dsw-static-neutral-00)}
.${settingsControlClass.switch}[data-variant="module"]{--codingns-switch-height:20px;--codingns-switch-thumb:16px;--codingns-switch-travel:16px;--codingns-switch-active:var(--dsw-alias-brand-primary);--codingns-switch-active-thumb:var(--dsw-alias-label-primary-foreground)}
.${settingsControlClass.track}{box-sizing:border-box;display:block;width:100%;height:var(--codingns-switch-height);padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);pointer-events:none;transition:background 120ms ease}
.${settingsControlClass.thumb}{display:block;width:var(--codingns-switch-thumb);height:var(--codingns-switch-thumb);border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);transition:transform 120ms ease,background 120ms ease}
.${settingsControlClass.switch}>input:checked+.${settingsControlClass.track}{background:var(--codingns-switch-active)}
.${settingsControlClass.switch}>input:checked+.${settingsControlClass.track}>.${settingsControlClass.thumb}{background:var(--codingns-switch-active-thumb);transform:translateX(var(--codingns-switch-travel))}
.${settingsControlClass.switch}>input:disabled+.${settingsControlClass.track}{opacity:.5}
.${settingsControlClass.switch}>input:disabled{cursor:not-allowed!important}
.${settingsControlClass.switch}>input:focus-visible+.${settingsControlClass.track}{outline:${dshThemeColor.focusRing};outline-offset:3px}
.${settingsControlClass.iconButton}:hover:not(:disabled){color:${dshThemeColor.labelPrimary};background:${dshThemeColor.hoverBackground}}
.${settingsControlClass.iconButton}:active:not(:disabled){background:${dshThemeColor.activeBackground}}
.${settingsControlClass.iconButton}:focus-visible{outline:${dshThemeColor.focusRing};outline-offset:2px}
.${settingsControlClass.iconButton}:disabled{opacity:.5;cursor:not-allowed}
@media (prefers-reduced-motion:reduce){.${settingsControlClass.track},.${settingsControlClass.thumb}{transition:none}}
`
