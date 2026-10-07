import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { AssistantConversationMessage } from '../../shared/contracts/assistant.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { AssistantAvatarPortrait } from '../avatar/portrait.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshThemeColor } from '../theme.js'
import type { CodingNsClientServices } from './types.js'

/** 聊天和语音详情共用消息样式与静态头像，方向只由所在视图指定。 */
export function AssistantConversationMessageView({ message, name, t, services, model, side, streaming = false }: {
  readonly message: Pick<AssistantConversationMessage, 'role' | 'text' | 'attachments' | 'interrupted'>
  readonly name: string; readonly t: CodingNsTranslator
  readonly services?: CodingNsClientServices | undefined; readonly model?: AssistantAvatarModel | undefined
  readonly side?: 'left' | 'right'; readonly streaming?: boolean
}): ReactElement {
  return createElement('article', { 'data-codingns-assistant-message': message.role,
    ...(side === undefined ? {} : { 'data-codingns-message-side': side }), ...(streaming ? { role: 'status' } : {}),
    style: { padding: '11px 14px', borderRadius: 10, background: message.role === 'user' ? dshThemeColor.surfaceSubtle : 'transparent',
      justifySelf: side === 'left' ? 'start' : side === 'right' || message.role === 'user' ? 'end' : 'stretch',
      maxWidth: side === undefined ? '100%' : '88%', minWidth: 0, boxSizing: 'border-box', fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: side === 'right' ? 'flex-end' : 'flex-start', gap: 7, marginBottom: 5 } },
      message.role !== 'assistant' || services === undefined || model === undefined ? null : createElement(AssistantAvatarPortrait, { services, model }),
      createElement('small', { style: { color: dshThemeColor.labelSecondary } }, message.role === 'user' ? t('voice.dialog.user') : name,
        message.interrupted ? ' · ' + t('awb.call.interrupted') : '')),
    message.text,
    message.attachments?.length ? createElement('div', { 'data-codingns-assistant-message-attachments': true, style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
      ...message.attachments.map((item) => createElement('span', { key: item.attachment.attachmentId, title: item.attachment.name,
        style: { fontSize: 12, padding: '3px 8px', borderRadius: 8, border: `1px solid ${dshThemeColor.border}` } }, item.attachment.name || t('awb.attachments.unnamed')))) : null)
}
