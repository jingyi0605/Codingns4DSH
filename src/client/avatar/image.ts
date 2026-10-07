import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { assistantAvatarImageSource } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarRendererProps } from './registry.js'

/** 图片差分也消费相同的状态接口；某张差分缺失时先回落该角色默认图片。 */
export function ImageAssistantAvatar({ model, state, size, onError, onLoadProgress }: AssistantAvatarRendererProps): ReactElement {
  const requested = assistantAvatarImageSource(model, state)
  const [failed, setFailed] = useState('')
  const image = useRef<HTMLImageElement | null>(null)
  useEffect(() => setFailed(''), [requested])
  const source = failed === requested ? model.source : requested
  useEffect(() => {
    // 热缓存图片可能在 effect 前触发 load，不能随后又把已就绪形象遮住。
    onLoadProgress?.({ phase: image.current?.complete && image.current.naturalWidth > 0 ? 'ready' : 'resources' })
  }, [source, onLoadProgress])
  return createElement('img', { key: source, ref: image, src: source, alt: '', draggable: false,
    onLoad: () => onLoadProgress?.({ phase: 'ready' }),
    onError: () => { if (source !== model.source) setFailed(requested); else onError('avatar_image_load_failed') },
    style: { display: 'block', width: size, maxWidth: '100%', height: size * 208 / 192, objectFit: 'contain' } })
}
