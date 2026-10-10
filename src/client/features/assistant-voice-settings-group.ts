import { createElement, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { CodingNsTranslator } from '../locale.js'
import { dshThemeColor } from '../theme.js'
import { uiFontSize } from '../font-scale.js'

interface VoiceSettingsGroupProps {
  readonly kind: 'input' | 'output'; readonly hint: string; readonly active: boolean; readonly disabled: boolean
  readonly t: CodingNsTranslator; readonly renderContent: (active: boolean) => ReactNode
}

/** 两组独立收起，保留子组件实例，避免关闭卡片丢失草稿或中断下载。 */
export function AssistantVoiceSettingsGroup(props: VoiceSettingsGroupProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  return createElement(AssistantVoiceSettingsGroupView, { ...props, expanded, onToggle: setExpanded })
}

/** 原生折叠语义支持键盘操作；内容保留，隐藏后通过 active 停止试听和闲置查询。 */
export function AssistantVoiceSettingsGroupView({ kind, hint, active, disabled, expanded, t, renderContent, onToggle }: VoiceSettingsGroupProps & {
  readonly expanded: boolean; readonly onToggle: (expanded: boolean) => void
}): ReactElement {
  return createElement('details', { open: expanded, 'data-codingns-voice-settings-group': kind,
    onToggle: (event: { currentTarget: { open: boolean } }) => onToggle(event.currentTarget.open),
    style: { minWidth: 0, border: `1px solid ${dshThemeColor.border}`, borderRadius: 14,
      color: dshThemeColor.labelPrimary, background: dshThemeColor.cardBackground } },
    createElement('summary', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', minWidth: 0,
      cursor: 'pointer', listStyle: 'none', borderRadius: expanded ? '14px 14px 0 0' : 14 } },
      createElement('span', { 'aria-hidden': true, style: { width: 36, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', borderRadius: 10, color: dshThemeColor.accent, background: dshThemeColor.surfaceSubtle } }, groupIcon(kind)),
      createElement('span', { style: { display: 'grid', gap: 4, flex: '1 1 auto', minWidth: 0 } },
        createElement('strong', { style: { fontSize: uiFontSize(14), fontWeight: 600, lineHeight: 1.4 } }, t(`voice.settings.${kind}`)),
        createElement('span', { title: hint, style: { fontSize: uiFontSize(12), lineHeight: 1.5, color: dshThemeColor.labelSecondary,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, hint)),
      createElement('svg', { 'aria-hidden': true, width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        style: { flexShrink: 0, color: dshThemeColor.labelSecondary, transform: expanded ? 'rotate(180deg)' : 'none' } },
      createElement('path', { d: 'm6 9 6 6 6-6', strokeLinecap: 'round', strokeLinejoin: 'round' }))),
    createElement('fieldset', { disabled, style: { display: 'grid', gap: 18, margin: 0, padding: 18, minWidth: 0,
      border: 0, borderTop: `1px solid ${dshThemeColor.border}` } }, createElement('style', null, groupCss), renderContent(active && expanded)))
}

function groupIcon(kind: 'input' | 'output'): ReactElement {
  return createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round', strokeLinejoin: 'round' }, kind === 'input'
    ? [createElement('rect', { key: 'mic', x: 9, y: 2, width: 6, height: 12, rx: 3 }),
      createElement('path', { key: 'stand', d: 'M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8' })]
    : [createElement('path', { key: 'speaker', d: 'm11 4-6 5H2v6h3l6 5V4Z' }),
      createElement('path', { key: 'sound', d: 'M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14' })])
}

// 只覆盖这两张卡片：原生三角由统一箭头替代，悬停和键盘焦点沿用宿主主题。
const groupCss = `
[data-codingns-voice-settings-group]>summary::-webkit-details-marker{display:none}
[data-codingns-voice-settings-group]>summary:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))}
[data-codingns-voice-settings-group]>summary:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#1677ff);outline-offset:2px}
`
