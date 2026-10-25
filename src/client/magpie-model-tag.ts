import { createElement, type ReactElement } from 'react'
import { providerIconUrl } from './provider-icons.js'
import { PROVIDER_ICON_PATH } from '../shared/provider-icon-resources.js'

export const MAGPIE_MODEL_TAG_ATTRIBUTE = 'data-codingns-magpie-model-tag'

/**
 * Magpie 模型来源标签使用的喜鹊图标。
 *
 * 图标必须走本机 Host 的固定资源路由：此前指向 GitHub 上的 `icon-256.png`，
 * 而在离线、Host 无外网出口，或页面策略只允许 `img-src 'self'` 时该外链会被
 * 浏览器拦截，标签容器虽然渲染出来却不显示任何图像。本地路由随插件一起安装，
 * 无网络依赖，也不会被同源策略挡住。
 */
export function magpieModelLogoUrl(): string {
  return providerIconUrl('magpie') ?? `${PROVIDER_ICON_PATH}magpie.png`
}

const tagStyle = {
  display: 'inline-flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '18px',
  maxWidth: '45%',
  gap: '4px',
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

const providerStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontSize: '12px',
  color: 'var(--dsw-alias-label-secondary)',
} as const

/** Compact visual source marker shared by every model-list surface. */
export function MagpieModelTag(props: { readonly providerId?: string | undefined }): ReactElement {
  return createElement('span', {
    [MAGPIE_MODEL_TAG_ATTRIBUTE]: '',
    role: 'note',
    'aria-label': props.providerId ?? 'Provided by Magpie',
    title: props.providerId ?? 'Provided by Magpie',
    style: tagStyle,
  }, props.providerId === undefined ? null : createElement('span', { style: providerStyle }, props.providerId),
  createElement('img', { src: magpieModelLogoUrl(), alt: 'Provided by Magpie', style: tagLogoStyle }))
}

/** Native DSH owns its menu DOM, so its option rows receive the same badge imperatively. */
export function createMagpieModelTagNode(document: Document, modelId?: string, providerId?: string): HTMLSpanElement {
  const tag = document.createElement('span')
  tag.setAttribute(MAGPIE_MODEL_TAG_ATTRIBUTE, '')
  if (modelId !== undefined) tag.dataset.modelId = modelId
  if (providerId !== undefined) tag.dataset.providerId = providerId
  tag.setAttribute('role', 'note')
  tag.setAttribute('aria-label', providerId ?? 'Provided by Magpie')
  tag.title = providerId ?? 'Provided by Magpie'
  Object.assign(tag.style, tagStyle)

  if (providerId !== undefined) {
    const provider = document.createElement('span')
    provider.textContent = providerId
    Object.assign(provider.style, providerStyle)
    tag.append(provider)
  }
  const logo = document.createElement('img')
  logo.setAttribute('src', magpieModelLogoUrl())
  logo.setAttribute('alt', 'Provided by Magpie')
  Object.assign(logo.style, tagLogoStyle)
  tag.append(logo)
  return tag
}
