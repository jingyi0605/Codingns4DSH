import { createElement } from 'react'
import type { ReactElement } from 'react'
import { dshThemeColor } from '../theme.js'

/** 工具记录和通话记录共享交互反馈，选择器只作用于这两类组件。 */
export function AssistantRecordStyle(): ReactElement {
  return createElement('style', null, recordCss)
}

export function AssistantRecordChevron(): ReactElement {
  return createElement('svg', { className: 'codingns-assistant-record-chevron', width: 14, height: 14, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    style: { flexShrink: 0, color: dshThemeColor.labelTertiary } }, createElement('path', { d: 'm9 5 7 7-7 7' }))
}

const recordCss = `
.codingns-assistant-tool-summary{list-style:none;cursor:pointer;border-radius:9px}
.codingns-assistant-tool-summary::-webkit-details-marker{display:none}
.codingns-assistant-tool-summary:hover,.codingns-assistant-record-button:hover{background:${dshThemeColor.hoverBackground}!important}
.codingns-assistant-tool-summary:active,.codingns-assistant-record-button:active{background:${dshThemeColor.activeBackground}!important}
.codingns-assistant-tool-summary:focus-visible,.codingns-assistant-record-button:focus-visible{outline:2px solid ${dshThemeColor.accent};outline-offset:2px}
.codingns-assistant-tool-details[open]>.codingns-assistant-tool-summary{border-radius:9px 9px 0 0}
.codingns-assistant-tool-details[open]>.codingns-assistant-tool-summary .codingns-assistant-record-chevron{transform:rotate(90deg)}
.codingns-assistant-voice-dialog::backdrop{background:${dshThemeColor.overlay}}
`
