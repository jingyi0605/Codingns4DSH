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
  }, createElement('img', { src: magpieModelLogoUrl(), alt: 'Provided by Magpie', style: tagLogoStyle }))
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
  logo.setAttribute('src', magpieModelLogoUrl())
  logo.setAttribute('alt', 'Provided by Magpie')
  Object.assign(logo.style, tagLogoStyle)
  tag.append(logo)
  return tag
}
