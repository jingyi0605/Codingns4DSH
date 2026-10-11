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

// 仅在原生弹窗打开时启用纵向布局，保留关闭状态下浏览器默认的隐藏行为。
const recordCss = `
.codingns-assistant-tool-summary{list-style:none;cursor:pointer}
.codingns-assistant-tool-summary::-webkit-details-marker{display:none}
.codingns-assistant-tool-summary:hover,.codingns-assistant-record-button:hover{color:${dshThemeColor.labelPrimary}!important}
.codingns-assistant-tool-summary:active,.codingns-assistant-record-button:active{color:${dshThemeColor.labelPrimary}!important}
.codingns-assistant-tool-summary:focus-visible,.codingns-assistant-record-button:focus-visible{outline:2px solid ${dshThemeColor.accent};outline-offset:2px}
.codingns-assistant-tool-details[open] .codingns-assistant-tool-name{white-space:normal!important;overflow-wrap:anywhere}
.codingns-assistant-tool-details[open]>.codingns-assistant-tool-summary .codingns-assistant-record-chevron{transform:rotate(90deg)}
.codingns-assistant-tool-step-summary{list-style:none;cursor:pointer}
.codingns-assistant-tool-step-summary::-webkit-details-marker{display:none}
.codingns-assistant-tool-step-summary:hover{color:${dshThemeColor.labelPrimary}!important}
.codingns-assistant-tool-step-summary:active{color:${dshThemeColor.labelPrimary}!important}
.codingns-assistant-tool-step-summary:focus-visible{outline:2px solid ${dshThemeColor.accent};outline-offset:2px}
.codingns-assistant-tool-step-details[open]>.codingns-assistant-tool-step-summary .codingns-assistant-step-chevron{transform:rotate(180deg)}
.codingns-assistant-tool-step-details[open] .codingns-assistant-tool-step-body{padding-inline:4px}
.codingns-assistant-tool-step-details[open] .codingns-assistant-tool-step-preview{white-space:normal;overflow-wrap:anywhere}
.codingns-assistant-voice-dialog[open]{display:flex;flex-direction:column}
.codingns-assistant-voice-dialog::backdrop{background:${dshThemeColor.overlay}}
`
