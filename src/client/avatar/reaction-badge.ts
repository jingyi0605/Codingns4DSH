import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { AssistantAvatarReaction } from '../../shared/assistant-avatar.js'
import { resolveCodingNsTranslator } from '../locale.js'

/** 角标独立于模型能力，旧包与缺失表情接口仍可提供文字反馈。 */
export function AssistantAvatarReactionBadge({ reaction }: { readonly reaction: AssistantAvatarReaction }): ReactElement {
  const t = resolveCodingNsTranslator()
  const labels = { success: t('awb.notifications.completed'), concerned: t('awb.notifications.error'), question: t('awb.notifications.question'), approval: t('awb.notifications.approval') }
  const icons = { success: '✓', concerned: '!', question: '?', approval: '…' }
  return createElement('span', { role: 'status', 'aria-label': labels[reaction], title: labels[reaction], 'data-codingns-avatar-reaction': reaction,
    style: { position: 'absolute', right: 0, top: 0, padding: '2px 7px', borderRadius: 12, background: '#fff', color: '#242424', border: '1px solid #b8c3d3', pointerEvents: 'none' } }, icons[reaction])
}
