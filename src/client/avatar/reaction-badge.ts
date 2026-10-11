import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { AssistantAvatarReaction } from '../../shared/assistant-avatar.js'
import { resolveCodingNsTranslator } from '../locale.js'

/** 角标独立于模型能力，旧包与缺失表情接口仍可提供文字反馈。 */
export function AssistantAvatarReactionBadge({ reaction }: { readonly reaction: AssistantAvatarReaction }): ReactElement {
  const t = resolveCodingNsTranslator()
  const labels = { success: t('awb.notifications.completed'), concerned: t('awb.notifications.error'), question: t('awb.notifications.question'), approval: t('awb.notifications.approval') }
  const icons = { success: '✓', concerned: '!', approval: '…' }
  const icon = reaction === 'question'
    ? createElement('span', { 'data-codingns-avatar-reaction-glyph': 'speech', style: { display: 'inline-flex' } }, speechIcon())
    : icons[reaction]
  return createElement('span', { role: 'status', 'aria-label': labels[reaction], title: labels[reaction], 'data-codingns-avatar-reaction': reaction,
    style: { position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)', width: 30, height: 26, boxSizing: 'border-box', display: 'grid', placeItems: 'center', padding: 0, borderRadius: 11,
      background: '#fff', color: '#242424', border: '1px solid #b8c3d3', lineHeight: 1, pointerEvents: 'none' } }, icon)
}

/** 提问状态使用发言气泡：圆角轮廓、右下尾巴和三个空心圆点。 */
function speechIcon(): ReactElement {
  return createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
  createElement('path', { d: 'M12 3H9a7 7 0 0 0-7 7v2a7 7 0 0 0 7 7h5.5l3.5 2.5.8-4.45A7 7 0 0 0 21 12v-2a7 7 0 0 0-7-7h-2Z' }),
  createElement('circle', { cx: 7.5, cy: 11, r: 1.45 }),
  createElement('circle', { cx: 12, cy: 11, r: 1.45 }),
  createElement('circle', { cx: 16.5, cy: 11, r: 1.45 }))
}
