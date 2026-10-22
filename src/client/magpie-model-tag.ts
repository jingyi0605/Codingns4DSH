import { createElement, type ReactElement } from 'react'

export const MAGPIE_MODEL_TAG_ATTRIBUTE = 'data-codingns-magpie-model-tag'
export const MAGPIE_MODEL_LOGO_URL = 'https://github.com/yetone/magpie/raw/main/site/public/img/icon-256.png'

const tagStyle = {
  display: 'inline-flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  width: '18px',
  height: '18px',
  marginInlineStart: 'auto',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
} as const

const tagLogoStyle = {
  display: 'block',
  width: '16px',
  height: '16px',
  flex: '0 0 16px',
  objectFit: 'contain',
  borderRadius: '4px',
} as const

/** Compact visual source marker shared by every model-list surface. */
export function MagpieModelTag(): ReactElement {
  return createElement('span', {
    [MAGPIE_MODEL_TAG_ATTRIBUTE]: '',
    role: 'note',
    'aria-label': 'Provided by Magpie',
    title: 'Provided by Magpie',
    style: tagStyle,
  }, createElement('img', { src: MAGPIE_MODEL_LOGO_URL, alt: 'Provided by Magpie', style: tagLogoStyle }))
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

  const logo = document.createElement('img')
  logo.setAttribute('src', MAGPIE_MODEL_LOGO_URL)
  logo.setAttribute('alt', 'Provided by Magpie')
  Object.assign(logo.style, tagLogoStyle)
  tag.append(logo)
  return tag
}
