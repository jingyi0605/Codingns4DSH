import { createElement, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { AssistantNotification, AssistantNotificationAutoCloseSeconds, AssistantNotificationSnapshot } from '../../shared/assistant-notifications.js'
import type { DesktopAssistantNotification } from '../../shared/desktop-assistant.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshThemeColor } from '../theme.js'

/** 只接受 Host 安全展示快照，网页和伴随页都不能从组件取得 RPC 或会话控制入口。 */
export type AssistantNotificationDisplaySnapshot = Pick<AssistantNotificationSnapshot,
  'generation' | 'revision' | 'serverNow' | 'primary' | 'items' | 'unreadCount' | 'pendingCount' | 'cursor'>
  & Partial<Pick<AssistantNotificationSnapshot, 'capabilities' | 'reset'>>
export interface AssistantNotificationBubbleProps {
  readonly frame: AssistantNotificationDisplaySnapshot | DesktopAssistantNotification
  readonly t: CodingNsTranslator
  readonly error?: string | undefined
  readonly onOpen: (noticeId: string, generation: number, connectionGeneration?: number) => void
  readonly onDismiss: (noticeId: string, generation: number, connectionGeneration?: number) => void
  readonly onPresented: (noticeId: string, generation: number, kind?: AssistantNotification['kind']) => void
  readonly autoClose?: boolean
  readonly autoCloseSeconds?: AssistantNotificationAutoCloseSeconds
  readonly onPage?: ((cursor?: string) => void) | undefined
  readonly onExpandedChange?: ((expanded: boolean) => void) | undefined
}

export function AssistantNotificationBubble({ frame, t, error, onOpen, onDismiss, onPresented, autoClose = false, autoCloseSeconds = 30, onPage, onExpandedChange }: AssistantNotificationBubbleProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const bubble = useRef<HTMLDivElement>(null)
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const snapshot = 'items' in frame ? frame : undefined
  const primary = snapshot === undefined ? frame as DesktopAssistantNotification : snapshot.primary
  const items = snapshot?.items.filter((notice) => !notice.read || ((notice.kind === 'question' || notice.kind === 'approval') && notice.lifecycle === 'active')) ?? []
  // 主气泡直接呈现当前需要用户关注的通知；分页列表仍保留完整快照，避免首屏只剩统计数字。
  const attentionItems = snapshot === undefined
    ? primary === undefined || primary === null ? [] : [primary]
    : [...(snapshot.primary === null || snapshot.primary.presentation === 'collapsed' ? [] : [snapshot.primary]), ...items.filter((notice) =>
      notice.presentation !== 'collapsed' && (!notice.read || ((notice.kind === 'question' || notice.kind === 'approval') && notice.lifecycle === 'active'))
      && notice.noticeId !== snapshot.primary?.noticeId)]
  const multiple = attentionItems.length > 1 || (snapshot !== undefined && Math.max(snapshot.unreadCount, snapshot.pendingCount) > 1)
  const mainNotice = attentionItems[0] ?? (snapshot === undefined ? primary ?? undefined : undefined)
  const presented = attentionItems[0] ?? (snapshot === undefined ? primary ?? undefined : undefined)
  const createdAt = presented && 'createdAt' in presented ? presented.createdAt : undefined
  useEffect(() => { onExpandedChange?.(expanded) }, [expanded, onExpandedChange])
  useEffect(() => { setCursors([undefined]) }, [frame.generation, snapshot?.reset])
  useEffect(() => {
    if (presented === undefined || presented === null) return
    const node = bubble.current
    const dom = node?.ownerDocument
    if (node === null || dom === undefined) return
    let finished = false
    const scheduleAutoClose = (): void => {
      if (!autoClose) return
      const connectionGeneration = 'connectionGeneration' in presented ? presented.connectionGeneration : undefined
      autoCloseTimer.current = setTimeout(() => {
        autoCloseTimer.current = undefined
        onDismiss(presented.noticeId, frame.generation, connectionGeneration)
      }, autoCloseSeconds * 1000)
    }
    const confirm = (): void => {
      // 主页面后台挂载不算实际展示；伴随页独立确认自己的可见渲染。
      if (finished || !assistantNotificationIsVisible(node)) return
      finished = true; onPresented(presented.noticeId, frame.generation, presented.kind); scheduleAutoClose()
    }
    const timer = setTimeout(confirm, 0)
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(confirm)
    observer?.observe(node)
    dom.addEventListener('visibilitychange', confirm)
    dom.addEventListener('scroll', confirm, true)
    dom.addEventListener('transitionend', confirm, true)
    dom.addEventListener('animationend', confirm, true)
    dom.defaultView?.addEventListener('resize', confirm)
    dom.defaultView?.addEventListener('pointerup', confirm)
    return () => {
      observer?.disconnect()
      clearTimeout(timer); clearTimeout(autoCloseTimer.current); autoCloseTimer.current = undefined; dom.removeEventListener('visibilitychange', confirm)
      dom.removeEventListener('scroll', confirm, true)
      dom.removeEventListener('transitionend', confirm, true)
      dom.removeEventListener('animationend', confirm, true)
      dom.defaultView?.removeEventListener('resize', confirm); dom.defaultView?.removeEventListener('pointerup', confirm)
    }
  }, [presented?.noticeId, presented?.kind, presented?.connectionGeneration, createdAt, frame.generation, autoClose, autoCloseSeconds, onPresented, onDismiss])
  const page = (next: boolean): void => {
    const updated = next ? [...cursors, snapshot!.cursor!] : cursors.slice(0, -1)
    setCursors(updated); onPage?.(updated.at(-1))
  }
  const row = (notice: AssistantNotification | DesktopAssistantNotification, variant: 'primary' | 'compact' | 'list' = 'list'): ReactElement => createElement('section', {
    key: notice.noticeId, 'data-codingns-notice-id': notice.noticeId, 'data-codingns-notice-kind': notice.kind,
    style: variant === 'primary' ? primaryCard : variant === 'compact' ? compactCard : listRow },
    createElement('div', { style: cardHeading },
      createElement('span', { 'aria-hidden': true, style: { ...kindMark, background: noticeKindColor[notice.kind] } }, icons[notice.kind]),
      createElement('div', { style: { minWidth: 0, flex: '1 1 auto' }, title: `${notice.hostLabel} · ${notice.workspaceLabel} · ${notice.sessionTitle}` },
        createElement('div', { style: cardMeta }, `${notice.hostLabel} · ${notice.workspaceLabel}`),
        createElement('div', { style: cardTitle }, notice.sessionTitle))),
    variant === 'compact' ? createElement('span', { style: notice.kind === 'question' || notice.kind === 'approval' ? requestTag : compactStatus },
      notice.kind === 'question' ? t('awb.notifications.questionTag') : notice.kind === 'approval' ? t('awb.notifications.approvalTag') : notificationStatus(notice, t)) : null,
    variant !== 'compact' ? createElement('div', { style: messageText },
      createElement('span', { 'aria-hidden': true }, icons[notice.kind] + ' '),
      notice.kind === 'question' || notice.kind === 'approval' ? createElement('span', { style: requestInlineTag },
        notice.kind === 'question' ? t('awb.notifications.questionTag') : t('awb.notifications.approvalTag')) : null,
      notice.text,
      'errorExcerpt' in notice && notice.errorExcerpt ? createElement('div', null, notice.errorExcerpt) : null) : null,
    notice.availability !== 'ready' ? createElement('span', { role: 'status' }, t(notice.availability === 'disconnected' ? 'awb.notifications.disconnected' : 'awb.notifications.expired')) : null,
    createElement('div', { style: actionRow },
      createElement('button', { type: 'button', style: variant === 'compact' ? compactButton : button, disabled: notice.availability !== 'ready',
        'aria-label': [t('awb.notifications.open'), notice.hostLabel, notice.workspaceLabel, notice.sessionTitle].join(' · '),
        onClick: () => onOpen(notice.noticeId, frame.generation, 'connectionGeneration' in notice ? notice.connectionGeneration : undefined) }, t('awb.notifications.open')),
      createElement('button', { type: 'button', style: variant === 'compact' ? compactButton : button,
        'aria-label': [t('awb.notifications.dismiss'), notice.hostLabel, notice.workspaceLabel, notice.sessionTitle].join(' · '),
        onClick: () => {
          clearTimeout(autoCloseTimer.current); autoCloseTimer.current = undefined
          onDismiss(notice.noticeId, frame.generation, 'connectionGeneration' in notice ? notice.connectionGeneration : undefined)
        } }, t('awb.notifications.dismiss'))))
  return createElement('div', { 'data-codingns-assistant-notifications': true, style: shell,
    // 操作和文本选择不进入形象拖动区，不抢焦点；组件本身无弹跳动画。
    onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
    onClick: (event: { stopPropagation(): void }) => event.stopPropagation() },
    snapshot && multiple ? createElement('button', { type: 'button', style: summaryButton,
      'aria-expanded': expanded, 'aria-label': [t('awb.notifications.list'), t('awb.notifications.unread', { count: snapshot.unreadCount }), t('awb.notifications.pending', { count: snapshot.pendingCount })].join(' · '), onClick: () => {
        setExpanded(!expanded)
        if (!expanded) { setCursors([undefined]); onPage?.() }
      } }, `${t('awb.notifications.unread', { count: snapshot.unreadCount })} · ${t('awb.notifications.pending', { count: snapshot.pendingCount })}`) : null,
    (!expanded || snapshot === undefined) && mainNotice !== undefined ? createElement('div', { ref: bubble, role: 'status', 'aria-live': 'polite', style: bubblePanel },
      createElement('span', { 'aria-hidden': true, style: bubbleTail }, createElement('svg', { width: 36, height: 22, viewBox: '0 0 36 22', fill: dshThemeColor.menuBackground, stroke: dshThemeColor.accent, strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block' } },
        createElement('path', { d: 'M2 1 C7 2 12 8 18 19 C19 21 21 21 22 19 C27 9 31 3 34 1' }))),
      createElement('div', { style: bubbleContent },
        multiple ? attentionItems.map((notice) => row(notice, 'compact')) : row(mainNotice, 'primary'))) : null,
    expanded && snapshot ? createElement('div', { role: 'region', 'aria-label': t('awb.notifications.list'), style: panel },
      createElement('button', { type: 'button', style: button, onClick: () => setExpanded(false) }, t('awb.notifications.closeList')),
      createElement('div', { style: { maxHeight: 180, overflowY: 'auto', overscrollBehavior: 'contain' } },
        ...items.map((notice) => row(notice, 'list'))),
      items.length === 0 ? createElement('p', null, t('awb.notifications.empty')) : null,
      onPage ? createElement('div', { style: { display: 'flex', gap: 6 } },
        createElement('button', { type: 'button', style: button, disabled: cursors.length <= 1, onClick: () => page(false) }, t('awb.notifications.previous')),
        createElement('button', { type: 'button', style: button, disabled: !snapshot.cursor, onClick: () => page(true) }, t('awb.notifications.next'))) : null) : null,
    error ? createElement('div', { role: 'alert', style: panel }, error) : null,
    // 启动恢复边界属于来源说明，不应让正常空闲的角色常驻技术诊断气泡。
    ...(snapshot?.capabilities?.filter((capability) => capability.reason && (!capability.completed || !capability.error || !capability.requests || !capability.resolve || !capability.navigation)).map((capability) =>
      createElement('div', { key: capability.hostId, role: 'status', style: panel }, capability.reason)) ?? []))
}

/** 可见 DOM 与视口相交后才确认首展；后台挂载和零面积节点不消耗提醒时长。 */
export function assistantNotificationIsVisible(node: HTMLElement): boolean {
  const dom = node.ownerDocument
  if (!node.isConnected || dom.visibilityState === 'hidden' || node.getClientRects().length === 0) return false
  const viewport = dom.defaultView
  if (viewport === null) return true
  const rect = node.getBoundingClientRect()
  const bounds = { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
    right: Math.min(viewport.innerWidth, rect.right), bottom: Math.min(viewport.innerHeight, rect.bottom) }
  if (viewport.getComputedStyle(node).visibility !== 'visible') return false
  for (let current: HTMLElement | null = node; current !== null; current = current.parentElement) {
    const style = viewport.getComputedStyle(current)
    if (style.display === 'none' || style.opacity === '0') return false
    if (current === node) continue
    // 内容与视口相交仍可能完全落在父容器的滚动裁切区外；零高度区域不能消耗首展时间。
    const clip = current.getBoundingClientRect()
    if (/^(?:auto|scroll|hidden|clip)$/u.test(style.overflowX || style.overflow)) {
      bounds.left = Math.max(bounds.left, clip.left); bounds.right = Math.min(bounds.right, clip.right)
    }
    if (/^(?:auto|scroll|hidden|clip)$/u.test(style.overflowY || style.overflow)) {
      bounds.top = Math.max(bounds.top, clip.top); bounds.bottom = Math.min(bounds.bottom, clip.bottom)
    }
  }
  return bounds.right > bounds.left && bounds.bottom > bounds.top
}

/** 网页气泡作为形象的兄弟区域定位；字幕优先保留原侧，通知避让到另一侧或形象旁。 */
export function floatingAssistantNotificationLayout(x: number, y: number, width: number, height: number,
  viewportWidth: number, viewportHeight: number, captionAbove?: boolean): CSSProperties {
  const bubbleWidth = Math.max(0, Math.min(320, viewportWidth - 24))
  const aboveSpace = Math.max(0, y - 22), belowSpace = Math.max(0, viewportHeight - y - height - 22)
  const above = captionAbove === undefined ? aboveSpace >= belowSpace : !captionAbove
  const space = above ? aboveSpace : belowSpace
  const left = Math.max(12 - x, Math.min((width - bubbleWidth) / 2, viewportWidth - x - bubbleWidth - 12))
  if (captionAbove !== undefined && space < 72) {
    const leftSpace = Math.max(0, x - 22), rightSpace = Math.max(0, viewportWidth - x - width - 22)
    const sideWidth = Math.min(320, Math.max(leftSpace, rightSpace))
    if (sideWidth >= 150) return { left: leftSpace >= rightSpace ? -sideWidth - 10 : width + 10, top: 0,
      width: sideWidth, maxHeight: Math.min(276, height, Math.max(0, viewportHeight - y - 12)) }
    // 手机横向空间不足时向字幕外侧叠放，保留字幕的最大180像素与独立滚动。
    const stackedAbove = captionAbove
    const stackedSpace = (stackedAbove ? aboveSpace : belowSpace) - 190
    if (stackedSpace >= 36) return { left, width: bubbleWidth, maxHeight: Math.min(276, stackedSpace),
      ...(stackedAbove ? { bottom: height + 200 } : { top: height + 200 }) }
  }
  return { left, width: bubbleWidth, maxHeight: Math.min(276, space), ...(above ? { bottom: height + 10 } : { top: height + 10 }) }
}

/** 将气泡尾巴指向头像中心；侧置气泡也不能固定在自己的左边角。 */
export function assistantNotificationTailStyle(avatarCenter: number, regionLeft: number, regionWidth: number): CSSProperties {
  const min = 20, max = Math.max(min, regionWidth - 20)
  const center = Math.max(min, Math.min(max, avatarCenter - regionLeft))
  return { '--codingns-assistant-tail-left': `${Math.round(center)}px` } as CSSProperties
}

const icons = { completed: '✓', error: '!', question: '?', approval: '◇' }
const noticeKindColor: Record<AssistantNotification['kind'], string> = {
  completed: dshThemeColor.success, error: dshThemeColor.error, question: dshThemeColor.accent, approval: dshThemeColor.accent,
}
function notificationStatus(notice: AssistantNotification | DesktopAssistantNotification, t: CodingNsTranslator): string {
  if (notice.kind === 'completed') return t('awb.notifications.completed')
  if (notice.kind === 'error') return t('awb.notifications.error')
  if (notice.kind === 'question') return t('awb.notifications.question')
  return t('awb.notifications.approval')
}
const button: CSSProperties = { ...dshSettingsButtonStyle, minHeight: 36, touchAction: 'manipulation', whiteSpace: 'normal', borderRadius: 999, fontWeight: 650 }
const shell: CSSProperties = { width: 'min(320px, calc(100vw - 24px))', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'auto', color: dshThemeColor.labelPrimary, fontSize: 13 }
const panel: CSSProperties = { padding: 12, background: dshThemeColor.menuBackground, border: `1px solid ${dshThemeColor.border}`, borderRadius: 18, boxShadow: dshThemeColor.prominentShadow,
  minWidth: 0, boxSizing: 'border-box', maxHeight: 'min(276px, calc(100vh - 24px))', overflowY: 'auto' }
const bubblePanel: CSSProperties = { ...panel, position: 'relative', padding: 10, overflow: 'visible', borderRadius: '24px 24px 24px 8px', borderColor: dshThemeColor.accent,
  background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.prominentShadow }
const bubbleContent: CSSProperties = { position: 'relative', zIndex: 1, display: 'grid', gap: 8, maxHeight: 'min(252px, calc(100vh - 48px))', overflowY: 'auto', overscrollBehavior: 'contain', padding: '2px 2px 4px' }
const bubbleTail: CSSProperties = { position: 'absolute', left: 'var(--codingns-assistant-tail-left, 50%)', bottom: -21, width: 36, height: 22, marginLeft: -18,
  zIndex: 0, pointerEvents: 'none' }
const primaryCard: CSSProperties = { display: 'grid', gap: 9, padding: 5, minWidth: 0 }
const compactCard: CSSProperties = { display: 'grid', gap: 7, padding: '10px 11px', minWidth: 0, background: dshThemeColor.cardBackground,
  border: `1px solid ${dshThemeColor.border}`, borderRadius: 15, boxShadow: dshThemeColor.subtleShadow }
const listRow: CSSProperties = { display: 'grid', gap: 7, padding: '10px 0', minWidth: 0, borderBottom: `1px solid ${dshThemeColor.border}` }
const cardHeading: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const cardMeta: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: 11, lineHeight: 1.3, overflowWrap: 'anywhere' }
const cardTitle: CSSProperties = { fontWeight: 750, fontSize: 15, lineHeight: 1.35, overflowWrap: 'anywhere' }
const kindMark: CSSProperties = { display: 'inline-grid', placeItems: 'center', flex: '0 0 auto', width: 24, height: 24, borderRadius: '50%', color: dshThemeColor.primaryForeground,
  fontSize: 13, fontWeight: 800, boxShadow: dshThemeColor.subtleShadow }
const messageText: CSSProperties = { color: dshThemeColor.labelPrimary, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5, maxHeight: 120, overflowY: 'auto' }
const summaryButton: CSSProperties = { ...button, alignSelf: 'end', padding: '8px 14px', background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.subtleShadow }
const requestTag: CSSProperties = { justifySelf: 'start', padding: '4px 9px', borderRadius: 999, color: dshThemeColor.primaryForeground,
  background: dshThemeColor.accent, fontSize: 11, lineHeight: 1.2, fontWeight: 750, letterSpacing: '0.02em', boxShadow: dshThemeColor.subtleShadow }
const requestInlineTag: CSSProperties = { display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', margin: '0 6px 2px 2px', padding: '3px 8px', borderRadius: 999,
  color: dshThemeColor.primaryForeground, background: dshThemeColor.accent, fontSize: 11, lineHeight: 1.2, fontWeight: 750, letterSpacing: '0.02em', boxShadow: dshThemeColor.subtleShadow }
const compactStatus: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: 11, lineHeight: 1.3, paddingLeft: 32 }
const actionRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 7 }
const compactButton: CSSProperties = { ...button, minHeight: 30, padding: '6px 10px', fontSize: 12 }
