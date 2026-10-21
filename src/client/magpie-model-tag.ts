import { createElement, type ReactElement } from 'react'

export const MAGPIE_MODEL_TAG_ATTRIBUTE = 'data-codingns-magpie-model-tag'

const tagStyle = {
  display: 'inline-flex',
  flex: 'none',
  alignItems: 'center',
  gap: 4,
  padding: '1px 7px',
  border: '1px solid rgba(179, 140, 68, .42)',
  borderRadius: 999,
  background: 'linear-gradient(125deg, rgba(242, 196, 108, .22), rgba(82, 164, 154, .16))',
  color: 'var(--dsw-alias-label-secondary, #84652c)',
  fontSize: 10,
  fontWeight: 650,
  letterSpacing: '.015em',
  lineHeight: '15px',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
} as const

const tagMarkStyle = {
  width: 6,
  height: 6,
  flex: '0 0 6px',
  borderRadius: '50%',
  background: 'linear-gradient(135deg, #edb94e, #51a79b)',
  boxShadow: '0 0 5px rgba(81, 167, 155, .35)',
} as const

/** Compact visual source marker shared by every model-list surface. */
export function MagpieModelTag(): ReactElement {
  return createElement('span', {
    [MAGPIE_MODEL_TAG_ATTRIBUTE]: '',
    role: 'note',
    'aria-label': 'Provided by Magpie',
    title: 'Provided by Magpie',
    style: tagStyle,
  }, createElement('span', { 'aria-hidden': true, style: tagMarkStyle }), 'Magpie')
}

/** Native DSH owns its menu DOM, so its option rows receive the same badge imperatively. */
export function createMagpieModelTagNode(document: Document, modelId?: string): HTMLSpanElement {
  const tag = document.createElement('span')
  tag.setAttribute(MAGPIE_MODEL_TAG_ATTRIBUTE, '')
  if (modelId !== undefined) tag.dataset.modelId = modelId
  tag.setAttribute('role', 'note')
  tag.setAttribute('aria-label', 'Provided by Magpie')
  tag.title = 'Provided by Magpie'
  Object.assign(tag.style, tagStyle)

  const mark = document.createElement('span')
  mark.setAttribute('aria-hidden', 'true')
  Object.assign(mark.style, tagMarkStyle)
  tag.append(mark, document.createTextNode('Magpie'))
  return tag
}
