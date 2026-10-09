import { Component, createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, PointerEvent } from 'react'
import type { DesktopAssistantFrame } from '../../shared/desktop-assistant.js'
import { desktopAssistantNotificationHeight, desktopAssistantLayout, desktopAssistantNotice } from '../../shared/desktop-assistant.js'
import type { AssistantNotification } from '../../shared/assistant-notifications.js'
import { resolveAssistantAvatarAsset } from '../../shared/assistant-avatar.js'
import { AssistantAvatarReactionBadge } from './reaction-badge.js'
import { AssistantNotificationBubble, assistantNotificationTailStyle } from './notification-bubble.js'
import { resolveCodingNsTranslator } from '../locale.js'
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
  postDesktopAssistantEvent({ type, ...(message ? { message } : {}) })
}
function postDesktopAssistantEvent(event: Readonly<Record<string, unknown>>): void {
  const globals = globalThis as NativeBridge
  if (globals.webkit?.messageHandlers?.assistant) globals.webkit.messageHandlers.assistant.postMessage(JSON.stringify(event))
  else globals.chrome?.webview?.postMessage(event)
}

/** 回传只有不透明身份与两个固定动作，伴随页无法指定会话或调用 DSH RPC。 */
export function sendDesktopAssistantNotice(frame: DesktopAssistantFrame, type: 'notice-presented' | 'notice-action', action?: 'open' | 'dismiss', noticeId?: string): void {
  const notice = desktopAssistantNotice(frame, type === 'notice-presented' ? undefined : noticeId), identity = frame.identity
  if (!notice || !identity || (type === 'notice-presented' && !frame.nativeVisible)) return
  postDesktopAssistantEvent({ type, ...identity, noticeId: notice.noticeId, noticeGeneration: notice.generation,
    noticeKind: notice.kind, ...(notice.connectionGeneration === undefined ? {} : { connectionGeneration: notice.connectionGeneration }),
    ...(type === 'notice-action' && action !== undefined ? { action } : {}) })
}
/** 分页只传有界不透明游标，经同一原生管道读 Host 缓存，不持有 DSH 认证票据。 */
export function sendDesktopAssistantNoticePage(frame: DesktopAssistantFrame, cursor?: string): void {
  if (!frame.identity || !frame.notificationSnapshot || cursor !== undefined && cursor.length > 2048) return
  postDesktopAssistantEvent({ type: 'notice-page', ...frame.identity, ...(cursor === undefined ? {} : { cursor }) })
}

const renderers = { builtin: BuiltinAssistantAvatar, image: ImageAssistantAvatar, spritesheet: SpriteSheetAssistantAvatar, live2d: Live2dAssistantAvatar }

export function DesktopAssistantAvatar({ frame }: { readonly frame: DesktopAssistantFrame }): ReactNode {
  const model = resolveAssistantAvatarAsset(frame.model, 'floating')
  const renderer = renderers[model.renderer as keyof typeof renderers]
  const drag = useRef<{ x: number; y: number; moved: boolean }>()
  const [loaded, setLoaded] = useState(false)
  const [noticeError, setNoticeError] = useState<string>()
  const latestFrame = useRef(frame)
  latestFrame.current = frame
  const identityKey = JSON.stringify(frame.identity)
  useEffect(() => { setNoticeError(undefined) }, [identityKey])
  const sendNotice = useCallback((type: 'notice-presented' | 'notice-action', noticeId: string, generation: number, action?: 'open' | 'dismiss', kind?: AssistantNotification['kind'], connectionGeneration?: number): void => {
    const current = latestFrame.current
    const notice = desktopAssistantNotice(current, type === 'notice-presented' ? undefined : noticeId)
    // 旧 DOM 回调不能把旧气泡点击改写为新通知，真实身份来自被点击组件的 props。
    if (notice?.noticeId !== noticeId || notice.generation !== generation
      || kind !== undefined && kind !== notice.kind || connectionGeneration !== notice.connectionGeneration
      || JSON.stringify(current.identity) !== identityKey) return
    sendDesktopAssistantNotice(current, type, action, noticeId)
  }, [identityKey])
  const presented = useCallback((noticeId: string, generation: number, kind?: AssistantNotification['kind']) =>
    sendNotice('notice-presented', noticeId, generation, undefined, kind, desktopAssistantNotice(latestFrame.current)?.connectionGeneration), [sendNotice])
  const openNotice = useCallback((noticeId: string, generation: number, connectionGeneration?: number) => sendNotice('notice-action', noticeId, generation, 'open', undefined, connectionGeneration), [sendNotice])
  const dismissNotice = useCallback((noticeId: string, generation: number, connectionGeneration?: number) => sendNotice('notice-action', noticeId, generation, 'dismiss', undefined, connectionGeneration), [sendNotice])
  const pageNotices = useCallback((cursor?: string): void => {
    const current = latestFrame.current
    if (JSON.stringify(current.identity) === identityKey) sendDesktopAssistantNoticePage(current, cursor)
  }, [identityKey])
  const expandedNotices = useCallback((expanded: boolean): void => {
    const current = latestFrame.current
    if (current.notificationSnapshot && JSON.stringify(current.identity) === identityKey) {
      postDesktopAssistantEvent({ type: 'notice-expansion', ...current.identity, expanded })
    }
  }, [identityKey])
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined
    const result = (event: Event): void => {
      const value = (event as CustomEvent<{ accepted: boolean; message?: string }>).detail
      setNoticeError(value?.accepted === false ? value.message ?? resolveCodingNsTranslator()('awb.notifications.actionUnavailable') : undefined)
      clearTimeout(retry)
      const notice = desktopAssistantNotice(latestFrame.current)
      if (value?.accepted === false && notice) retry = setTimeout(() => presented(notice.noticeId, notice.generation), 1000)
    }
    globalThis.addEventListener?.('codingns-notice-result', result)
    return () => { clearTimeout(retry); globalThis.removeEventListener?.('codingns-notice-result', result) }
  }, [presented])
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
  const layout = frame.layout ?? desktopAssistantLayout({ x: 0, y: 280 }, frame.size, desktopAssistantNotificationHeight(frame), Boolean(frame.caption), [{ x: 0, y: 0, width: 1024, height: 768 }])
  const regionStyle = (region: { x: number; y: number; width: number; height: number }) => ({ position: 'absolute' as const, left: region.x, top: region.y, width: region.width, height: region.height, overflowY: 'auto' as const })
  const notificationStyle = layout.notification === undefined ? undefined : {
    ...regionStyle(layout.notification),
    overflow: 'visible' as const,
    ...assistantNotificationTailStyle(layout.avatar.x + layout.avatar.width / 2, layout.notification.x, layout.notification.width),
  }
  const notification = frame.notificationSnapshot ?? frame.notification
  return createElement('div', { style: { width: layout.bounds.width, height: layout.bounds.height, position: 'relative', background: 'transparent' } },
    createElement('div', { role: 'button', tabIndex: 0, 'aria-label': frame.label, title: frame.label,
      onPointerDown: down, onPointerMove: move, onPointerUp: (event: PointerEvent<HTMLDivElement>) => end(event),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => end(event, true),
      onLostPointerCapture: () => { drag.current = undefined; sendDesktopAssistantEvent('drag-end') },
      onKeyDown: (event: { key: string; preventDefault(): void }) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sendDesktopAssistantEvent('open') } },
      style: { ...regionStyle(layout.avatar), cursor: 'grab', touchAction: 'none', userSelect: 'none' } },
      renderer ? createElement(renderer, { model, state: frame.state, ...(frame.reaction === undefined ? {} : { reaction: frame.reaction }), surface: 'floating', size: layout.avatar.width, onError, onLoadProgress }) : null,
      frame.reaction === undefined ? null : createElement(AssistantAvatarReactionBadge, { reaction: frame.reaction }),
      loaded ? null : createElement('div', { role: 'progressbar', 'aria-label': frame.label,
        style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' } },
        createElement('style', null, '@keyframes companion-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){[data-companion-spinner]{animation:none!important}}'),
        createElement('span', { 'data-companion-spinner': true, style: { width: 28, height: 28, borderRadius: '50%', border: '3px solid #dbe7fa', borderTopColor: '#6d9cdd', animation: 'companion-spin 1s linear infinite' } }))),
    notification && notificationStyle ? createElement('div', { style: notificationStyle, 'data-codingns-native-notice': true },
      createElement(AssistantNotificationBubble, { frame: notification, t: resolveCodingNsTranslator(), error: noticeError ?? frame.noticeError,
        ...(frame.autoClose === undefined || !frame.nativeVisible ? {} : { autoClose: frame.autoClose }),
        ...(frame.autoCloseSeconds === undefined || !frame.nativeVisible ? {} : { autoCloseSeconds: frame.autoCloseSeconds }),
        onOpen: openNotice, onDismiss: dismissNotice, onPresented: frame.nativeVisible ? presented : () => undefined,
        ...(frame.notificationSnapshot === undefined ? {} : { onPage: pageNotices, onExpandedChange: expandedNotices }) })) : null,
    frame.caption && layout.caption ? createElement('div', { 'aria-live': 'polite', 'data-codingns-native-caption': true,
      style: { ...regionStyle(layout.caption), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        boxSizing: 'border-box', padding: 8, borderRadius: 10, color: '#242424', background: 'rgba(255,255,255,.94)', fontSize: 12, lineHeight: 1.5 } }, frame.caption) : null)
}

export class DesktopAssistantBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(): void { sendDesktopAssistantEvent('error', 'avatar_render_failed') }
  override render(): ReactNode { return this.state.failed ? null : this.props.children }
}
