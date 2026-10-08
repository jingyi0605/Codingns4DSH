import { Component, createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, PointerEvent } from 'react'
import type { DesktopAssistantFrame } from '../../shared/desktop-assistant.js'
import { resolveAssistantAvatarAsset } from '../../shared/assistant-avatar.js'
import { BuiltinAssistantAvatar } from './builtin.js'
import { ImageAssistantAvatar } from './image.js'
import { SpriteSheetAssistantAvatar } from './spritesheet.js'
import { Live2dAssistantAvatar } from './live2d.js'
import type { AssistantAvatarLoadProgress } from './loading.js'

interface NativeBridge {
  readonly webkit?: { readonly messageHandlers?: { readonly assistant?: { postMessage(value: string): void } } }
  readonly chrome?: { readonly webview?: { postMessage(value: unknown): void } }
}
/** 页面只能发送有限交互事件；没有任意代码、文件或 Host RPC 桥接。 */
export function sendDesktopAssistantEvent(type: 'ready' | 'error' | 'open' | 'drag-start' | 'drag-end', message?: string): void {
  const globals = globalThis as NativeBridge
  const event = { type, ...(message ? { message } : {}) }
  if (globals.webkit?.messageHandlers?.assistant) globals.webkit.messageHandlers.assistant.postMessage(JSON.stringify(event))
  else globals.chrome?.webview?.postMessage(event)
}

const renderers = { builtin: BuiltinAssistantAvatar, image: ImageAssistantAvatar, spritesheet: SpriteSheetAssistantAvatar, live2d: Live2dAssistantAvatar }

export function DesktopAssistantAvatar({ frame }: { readonly frame: DesktopAssistantFrame }): ReactNode {
  const model = resolveAssistantAvatarAsset(frame.model, 'floating')
  const renderer = renderers[model.renderer as keyof typeof renderers]
  const drag = useRef<{ x: number; y: number; moved: boolean }>()
  const [loaded, setLoaded] = useState(false)
  const onError = useCallback((message: string) => sendDesktopAssistantEvent('error', message), [])
  const onLoadProgress = useCallback((progress: AssistantAvatarLoadProgress) => {
    setLoaded(progress.phase === 'ready')
  }, [])
  // 原生窗口先保持隐藏；DOM 与加载占位准备好后才允许显示。
  // Live2D 在页面可见后才创建 WebGL，不能反过来等它加载完再显示窗口。
  useEffect(() => { sendDesktopAssistantEvent('ready') }, [])
  const down = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.screenX, y: event.screenY, moved: false }
  }
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current && !current.moved && Math.hypot(event.screenX - current.x, event.screenY - current.y) >= 6) {
      current.moved = true; sendDesktopAssistantEvent('drag-start')
    }
  }
  const end = (event: PointerEvent<HTMLDivElement>, cancelled = false): void => {
    const current = drag.current; drag.current = undefined; sendDesktopAssistantEvent('drag-end')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (current && !cancelled && !current.moved && Math.hypot(event.screenX - current.x, event.screenY - current.y) < 6) sendDesktopAssistantEvent('open')
  }
  useEffect(() => { if (!renderer) sendDesktopAssistantEvent('error', 'avatar_renderer_unavailable') }, [renderer])
  return createElement('div', { style: { width: frame.size, background: 'transparent' } },
    createElement('div', { role: 'button', tabIndex: 0, 'aria-label': frame.label, title: frame.label,
      onPointerDown: down, onPointerMove: move, onPointerUp: (event: PointerEvent<HTMLDivElement>) => end(event),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => end(event, true),
      onLostPointerCapture: () => { drag.current = undefined; sendDesktopAssistantEvent('drag-end') },
      onKeyDown: (event: { key: string; preventDefault(): void }) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sendDesktopAssistantEvent('open') } },
      style: { position: 'relative', minHeight: frame.size * 208 / 192, cursor: 'grab', touchAction: 'none', userSelect: 'none' } },
      renderer ? createElement(renderer, { model, state: frame.state, surface: 'floating', size: frame.size, onError, onLoadProgress }) : null,
      loaded ? null : createElement('div', { role: 'progressbar', 'aria-label': frame.label,
        style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' } },
        createElement('style', null, '@keyframes companion-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){[data-companion-spinner]{animation:none!important}}'),
        createElement('span', { 'data-companion-spinner': true, style: { width: 28, height: 28, borderRadius: '50%', border: '3px solid #dbe7fa', borderTopColor: '#6d9cdd', animation: 'companion-spin 1s linear infinite' } }))),
    frame.caption ? createElement('div', { 'aria-live': 'polite', style: { maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      boxSizing: 'border-box', marginTop: 4, padding: 8, borderRadius: 10, color: '#242424', background: 'rgba(255,255,255,.94)', fontSize: 12, lineHeight: 1.5 } }, frame.caption) : null)
}

export class DesktopAssistantBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(): void { sendDesktopAssistantEvent('error', 'avatar_render_failed') }
  override render(): ReactNode { return this.state.failed ? null : this.props.children }
}
