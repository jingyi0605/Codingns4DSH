import { createElement, Fragment } from 'react'
import type { ReactElement } from 'react'
import type { AssistantConversationMessage, AssistantToolCall } from '../../shared/contracts/assistant.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { AssistantAvatarPortrait } from '../avatar/portrait.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshThemeColor } from '../theme.js'
import type { CodingNsClientServices } from './types.js'
import { assistantMessageStepTimeline } from '../../shared/assistant-message-timeline.js'
import { AssistantRecordChevron, AssistantRecordStyle } from './assistant-record-style.js'
import { uiFontSize } from '../font-scale.js'

/** 聊天和语音详情共用消息样式与静态头像，方向只由所在视图指定。 */
export function AssistantConversationMessageView({ message, name, t, services, model, side, streaming = false }: {
  readonly message: Pick<AssistantConversationMessage, 'role' | 'text' | 'attachments' | 'interrupted' | 'toolCalls'>
  readonly name: string; readonly t: CodingNsTranslator
  readonly services?: CodingNsClientServices | undefined; readonly model?: AssistantAvatarModel | undefined
  readonly side?: 'left' | 'right'; readonly streaming?: boolean
}): ReactElement {
  return createElement('article', { 'data-codingns-assistant-message': message.role,
    ...(side === undefined ? {} : { 'data-codingns-message-side': side }), ...(streaming ? { role: 'status' } : {}),
    style: { padding: '11px 14px', borderRadius: 10, background: message.role === 'user' ? dshThemeColor.surfaceSubtle : 'transparent',
      justifySelf: side === 'left' ? 'start' : side === 'right' || message.role === 'user' ? 'end' : 'stretch',
      maxWidth: side === undefined ? '100%' : '88%', minWidth: 0, boxSizing: 'border-box', fontSize: uiFontSize(14), lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: side === 'right' ? 'flex-end' : 'flex-start', gap: 7, marginBottom: 5 } },
      message.role !== 'assistant' || services === undefined || model === undefined ? null : createElement(AssistantAvatarPortrait, { services, model }),
      createElement('small', { style: { color: dshThemeColor.labelSecondary } }, message.role === 'user' ? t('voice.dialog.user') : name,
        message.interrupted ? ' · ' + t('awb.call.interrupted') : '')),
    createElement(AssistantMessageContentView, { text: message.text, calls: message.role === 'assistant' ? message.toolCalls : undefined, t }),
    message.attachments?.length ? createElement('div', { 'data-codingns-assistant-message-attachments': true, style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
      ...message.attachments.map((item) => createElement('span', { key: item.attachment.attachmentId, title: item.attachment.name,
        style: { fontSize: uiFontSize(12), padding: '3px 8px', borderRadius: 8, border: `1px solid ${dshThemeColor.border}` } }, item.attachment.name || t('awb.attachments.unnamed')))) : null)
}

/** 文字聊天、实时字幕与通话历史共用同一时间线，不额外生成工具汇总区。 */
export function AssistantMessageContentView({ text, calls, t }: {
  readonly text: string; readonly calls?: readonly AssistantToolCall[] | undefined; readonly t: CodingNsTranslator
}): ReactElement {
  return createElement(Fragment, null, ...assistantMessageStepTimeline(text, calls).map((part) => part.kind === 'tool-step'
    ? createElement(AssistantToolStepView, { key: part.key, calls: part.calls, t })
    : createElement('div', { key: part.key, 'data-codingns-assistant-text': true,
      style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, part.text)))
}

/** 工具信息单独展示，不拼入消息正文，字幕与语音合成都只使用原始 text。 */
export function AssistantToolCallsView({ calls, t, compact = false }: {
  readonly calls?: readonly AssistantToolCall[] | undefined; readonly t: CodingNsTranslator; readonly compact?: boolean
}): ReactElement | null {
  if (!calls?.length) return null
  return createElement('div', { 'data-codingns-assistant-tools': true,
    'data-codingns-assistant-tools-compact': compact,
    style: { display: 'grid', gap: compact ? 2 : 6, marginBlock: compact ? 0 : 6, textAlign: 'left', whiteSpace: 'normal', minWidth: 0 } },
    createElement(AssistantRecordStyle), ...calls.map((call) => createElement(AssistantToolCallView, { key: call.id, call, t, compact })))
}

/** 一个 step 只显示摘要；展开后才加载其中的工具调用明细。 */
function AssistantToolStepView({ calls, t }: { readonly calls: readonly AssistantToolCall[]; readonly t: CodingNsTranslator }): ReactElement | null {
  if (calls.length === 0) return null
  const running = calls.some((call) => call.state === 'running')
  const failed = calls.some((call) => call.state === 'failed')
  const status = running ? 'running' : failed ? 'failed' : calls.every((call) => call.state === 'cancelled') ? 'cancelled' : 'completed'
  const latestCall = calls[calls.length - 1]!
  const latestArguments = assistantToolArgumentPreview(latestCall, t)
  const summary = calls.map((call) => assistantToolStepPreview(call, t)).filter((value, index, all) => all.indexOf(value) === index).join(t('awb.call.separator'))
  return createElement('div', { 'data-codingns-assistant-tool-step': true,
    style: { marginBlock: 6, textAlign: 'left', whiteSpace: 'normal', minWidth: 0, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(14), lineHeight: 1.65 } },
    createElement(AssistantRecordStyle),
    createElement('details', { className: 'codingns-assistant-tool-step-details' },
      createElement('summary', { className: 'codingns-assistant-tool-step-summary', title: t('awb.call.stepDetails'),
        'aria-label': `${t('awb.call.step')} · ${summary} · ${t(`awb.call.tool.${status}`)}`,
        style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, padding: '2px 0', color: dshThemeColor.labelSecondary } },
        createElement(AssistantStepChevron), createElement('span', { className: 'codingns-assistant-tool-step-preview', 'data-latest-tool': latestCall.name,
          title: latestCall.name, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        summary, ' · ', createElement('code', { style: { color: dshThemeColor.labelPrimary, fontFamily: dshThemeColor.codeFont, fontSize: '0.92em' } }, latestCall.name),
        latestArguments ? ` · ${latestArguments}` : '')),
      createElement('div', { className: 'codingns-assistant-tool-step-body', style: { display: 'grid', gap: 2, padding: '5px 0 5px 22px' } },
        createElement(AssistantToolCallsView, { calls, t, compact: true }))))
}

function assistantToolStepPreview(call: AssistantToolCall, t: CodingNsTranslator): string {
  if (call.name.includes('read') || call.kind === 'attachment') return t('awb.call.stepRead')
  if (call.name.includes('search') || call.kind === 'web-search') return t('awb.call.stepSearch')
  if (call.name.includes('workspace') || call.kind === 'workspace') return t('awb.call.stepWorkspace')
  return t('awb.call.stepTool')
}

function assistantToolArgumentPreview(call: AssistantToolCall, t: CodingNsTranslator): string {
  try {
    const args: unknown = JSON.parse(call.arguments)
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return ''
    const record = args as Record<string, unknown>
    for (const key of ['query', 'queries', 'text', 'url', 'fileName', 'filename', 'file', 'title', 'message']) {
      const value = record[key]
      const preview = typeof value === 'string' ? value : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(t('awb.call.separator')) : ''
      if (preview.trim()) return preview.trim().slice(0, 120)
    }
  } catch { /* 非 JSON 参数不生成摘要，明细仍可在工具记录中查看。 */ }
  return ''
}

/** 整个标题栏就是展开入口；实时状态更新不替换 details，保留用户的展开状态。 */
function AssistantToolCallView({ call, t, compact = false }: { readonly call: AssistantToolCall; readonly t: CodingNsTranslator; readonly compact?: boolean }): ReactElement {
  const label = t(call.kind === 'web-search' ? 'awb.call.webSearch' : call.kind === 'attachment' ? 'awb.call.attachment' : 'awb.call.workspace')
  const status = t(`awb.call.tool.${call.state}`)
  const color = call.state === 'failed' ? dshThemeColor.error : call.state === 'completed' ? dshThemeColor.success
    : call.state === 'running' ? dshThemeColor.accent : dshThemeColor.labelSecondary
  const startedAt = new Date(call.startedAt)
  const argumentPreview = compact ? assistantToolArgumentPreview(call, t) : ''
  if (compact) return createElement('div', { 'data-codingns-assistant-tool-row': call.name, 'data-codingns-assistant-tool': call.name, 'data-state': call.state,
    style: { minWidth: 0, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(13), lineHeight: 1.65 } },
    createElement('details', { className: 'codingns-assistant-tool-details' },
      createElement('summary', { className: 'codingns-assistant-tool-summary', title: t('awb.call.toolDetails'),
        'aria-label': `${label} · ${call.name} · ${status} · ${t('awb.call.toolDetails')}`,
        style: { display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, padding: '2px 0' } },
        createElement(AssistantRecordChevron), createElement('span', { style: { flexShrink: 0 } }, label),
        createElement('span', { style: { color: dshThemeColor.labelTertiary, flexShrink: 0 } }, '·'),
        createElement('span', { title: call.name, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: dshThemeColor.codeFont } },
          call.name, argumentPreview ? ` · ${argumentPreview}` : '')),
      createElement('div', { style: { display: 'grid', gap: 8, padding: '6px 10px 8px 23px', borderLeft: `1px solid ${dshThemeColor.border}`, minWidth: 0 } },
        ...[[t('awb.call.arguments'), call.arguments], [t('awb.call.result'), call.result]].map(([heading, value]) => createElement('div', { key: heading, style: { minWidth: 0 } },
          createElement('small', { style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(11), fontWeight: 500 } }, heading),
          createElement('pre', { tabIndex: 0, 'aria-label': heading, style: { margin: '4px 0 0', padding: '6px 8px', borderRadius: 6,
            background: dshThemeColor.cardBackground, maxHeight: 160, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin',
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: dshThemeColor.codeFont, fontSize: uiFontSize(11), lineHeight: 1.5 } }, value || '—'))))))
  return createElement('article', { 'data-codingns-assistant-tool': call.name, 'data-state': call.state,
    style: { borderRadius: 10, border: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.surfaceSubtle,
      color: dshThemeColor.labelPrimary, fontSize: uiFontSize(12), lineHeight: 1.4, minWidth: 0 } },
    createElement('details', { className: 'codingns-assistant-tool-details' },
      createElement('summary', { className: 'codingns-assistant-tool-summary', title: t('awb.call.toolDetails'),
        'aria-label': `${label} · ${call.name} · ${status} · ${t('awb.call.toolDetails')}`,
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', minWidth: 0 } },
        createElement('span', { style: { display: 'grid', placeItems: 'center', flexShrink: 0, width: 28, height: 28, borderRadius: 8,
          color, background: `color-mix(in srgb, ${color} 9%, transparent)` } }, createElement(AssistantToolIcon, { kind: call.kind })),
        createElement('span', { style: { flex: '1 1 auto', minWidth: 0, display: 'grid', gap: 1 } },
          createElement('strong', { style: { fontSize: uiFontSize(12), fontWeight: 600 } }, label),
          createElement('span', { className: 'codingns-assistant-tool-name', title: call.name, style: { color: dshThemeColor.labelSecondary, fontFamily: dshThemeColor.codeFont,
            fontSize: uiFontSize(11), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, call.name)),
        createElement('span', { style: { display: 'grid', justifyItems: 'end', gap: 3, flexShrink: 0 } },
          createElement('span', { role: 'status', style: { display: 'inline-flex', alignItems: 'center', gap: 4, color,
            padding: '1px 6px', borderRadius: 5, background: `color-mix(in srgb, ${color} 9%, transparent)`, fontSize: uiFontSize(11), whiteSpace: 'nowrap' } },
            createElement('span', { 'aria-hidden': true, style: { width: 4, height: 4, borderRadius: '50%', background: 'currentColor' } }), status),
          createElement('time', { dateTime: Number.isNaN(startedAt.valueOf()) ? undefined : startedAt.toISOString(), title: startedAt.toLocaleString(),
            style: { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(10), fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
            startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))),
        createElement(AssistantRecordChevron)),
      createElement('div', { style: { display: 'grid', gap: 8, padding: '9px 10px 10px', borderTop: `1px solid ${dshThemeColor.border}`, minWidth: 0 } },
        ...[[t('awb.call.arguments'), call.arguments], [t('awb.call.result'), call.result]].map(([heading, value]) => createElement('div', { key: heading, style: { minWidth: 0 } },
          createElement('small', { style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(11), fontWeight: 500 } }, heading),
          createElement('pre', { tabIndex: 0, 'aria-label': heading, style: { margin: '4px 0 0', padding: '6px 8px', borderRadius: 6,
            background: dshThemeColor.cardBackground, maxHeight: 160, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin',
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: dshThemeColor.codeFont, fontSize: uiFontSize(11), lineHeight: 1.5 } }, value || '—'))))))
}

function AssistantToolIcon({ kind }: { readonly kind: AssistantToolCall['kind'] }): ReactElement {
  const path = kind === 'web-search' ? 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z'
    : kind === 'attachment' ? 'M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6'
    : 'M3 6h7l2 2h9v12H3V6Zm0 4h18'
  return createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, createElement('path', { d: path }))
}

function AssistantStepChevron(): ReactElement {
  return createElement('svg', { className: 'codingns-assistant-step-chevron', width: 14, height: 14, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    style: { flexShrink: 0, color: dshThemeColor.labelTertiary } }, createElement('path', { d: 'm6 9 6 6 6-6' }))
}
