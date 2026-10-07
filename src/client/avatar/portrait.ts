import { createElement, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { BUILTIN_ASSISTANT_AVATAR, BUILTIN_ASSISTANT_AVATAR_SOURCES, resolveAssistantAvatarAsset } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices } from '../features/types.js'
import { getAssistantAvatarRegistry } from './registry.js'
import { assistantAvatarPortraitKey, getAssistantAvatarPortraitService } from './portrait-service.js'

/** 只订阅当前形象，切换时立即回到对应占位，不显示上一角色的迟到头像。 */
export function useAssistantAvatarPortrait(services: CodingNsClientServices, model: AssistantAvatarModel) {
  const registry = getAssistantAvatarRegistry(services)
  const rendererId = resolveAssistantAvatarAsset(model, 'dialog').renderer
  const readRenderer = useCallback(() => registry.get(rendererId), [registry, rendererId])
  const renderer = useSyncExternalStore(registry.subscribe, readRenderer, readRenderer)
  const service = getAssistantAvatarPortraitService(services)
  const key = assistantAvatarPortraitKey(model, renderer)
  // 规范化会复制清单，只有资源键变化时才切换订阅和生成任务。
  const read = useCallback(() => service.getSnapshot(model, renderer), [service, key, renderer])
  const subscribe = useCallback((listener: () => void) => service.subscribe(model, renderer, listener), [service, key, renderer])
  const portrait = useSyncExternalStore(subscribe, read, read)
  useEffect(() => service.retain(model, renderer), [service, key, renderer])
  return { url: portrait.url ?? BUILTIN_ASSISTANT_AVATAR_SOURCES[model.id] ?? BUILTIN_ASSISTANT_AVATAR_SOURCES[BUILTIN_ASSISTANT_AVATAR.id]!, generated: portrait.url !== undefined }
}

/** 消息头像仅显示静态 PNG；名字和按钮本身提供无障碍说明。 */
export function AssistantAvatarPortrait({ services, model, size = 28 }: {
  readonly services: CodingNsClientServices; readonly model: AssistantAvatarModel; readonly size?: number
}): ReactElement {
  const portrait = useAssistantAvatarPortrait(services, model)
  return createElement('span', { 'data-codingns-avatar-portrait': model.id, 'aria-hidden': true,
    style: { display: 'inline-flex', width: size, height: size, flex: `0 0 ${size}px`, borderRadius: '50%', overflow: 'hidden' } },
    createElement('img', { src: portrait.url, alt: '', draggable: false, style: assistantAvatarPortraitImageStyle(portrait.generated),
      onError: (event: { currentTarget: HTMLImageElement }) => fallbackPortraitImage(event.currentTarget) }))
}

export function assistantAvatarPortraitImageStyle(generated: boolean) {
  return { display: 'block', width: '100%', height: '100%', objectFit: 'contain' as const, pointerEvents: 'none' as const,
    ...(generated ? {} : { transform: 'translateY(26%) scale(1.7)' }) }
}

/** 更新填充而不重建原生按钮，保留点击、焦点和无障碍属性。 */
export function fillAssistantAvatarButton(button: HTMLButtonElement, portrait: { readonly url: string; readonly generated: boolean }): void {
  let image = button.querySelector<HTMLImageElement>('img[data-codingns-avatar-button-portrait]')
  if (image === null) {
    image = button.ownerDocument.createElement('img')
    image.alt = ''; image.draggable = false; image.setAttribute('aria-hidden', 'true')
    image.setAttribute('data-codingns-avatar-button-portrait', 'true')
    button.replaceChildren(image)
  }
  image.style.transform = ''
  Object.assign(image.style, assistantAvatarPortraitImageStyle(portrait.generated))
  image.onerror = () => fallbackPortraitImage(image!)
  if (image.getAttribute('src') !== portrait.url) image.src = portrait.url
  button.style.overflow = 'hidden'
}
function fallbackPortraitImage(image: HTMLImageElement): void {
  const source = BUILTIN_ASSISTANT_AVATAR_SOURCES[BUILTIN_ASSISTANT_AVATAR.id]!
  if (image.getAttribute('src') === source) return
  Object.assign(image.style, assistantAvatarPortraitImageStyle(false))
  image.src = source
}
