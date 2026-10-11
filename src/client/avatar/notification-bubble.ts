import { createElement, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { AssistantNotification, AssistantNotificationAutoCloseSeconds, AssistantNotificationSnapshot } from '../../shared/assistant-notifications.js'
import {
  ASSISTANT_NOTIFICATION_TAIL_CLEARANCE, ASSISTANT_NOTIFICATION_TAIL_GAP, ASSISTANT_NOTIFICATION_TAIL_HEIGHT,
  ASSISTANT_NOTIFICATION_TAIL_WIDTH, type AssistantNotificationTailSide,
} from '../../shared/assistant-notifications.js'
import type { DesktopAssistantNotification } from '../../shared/desktop-assistant.js'
import { IconTrashOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshThemeColor } from '../theme.js'
import { uiFontSize } from '../font-scale.js'

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
  /** 一键清理只提交当前代次的气泡清理；未接入的主机不渲染该按钮。 */
  readonly onClearAll?: ((generation: number) => void | Promise<void>) | undefined
  /** 尾巴贴的气泡边；由布局方按气泡相对形象的位置给出，缺省贴在底边。 */
  readonly tailSide?: AssistantNotificationTailSide | undefined
  /** 形象中心在面板边缘上的投影，和面板使用同一坐标系。 */
  readonly tailTarget?: number | undefined
  readonly tailStyle?: CSSProperties | undefined
}

/** 返回形象中心在通知面板坐标系中的投影；仅供旧调用方和布局测试使用。 */
export function assistantNotificationTailStyle(avatarCenter: number, regionStart: number, regionSize: number,
  side: AssistantNotificationTailSide = 'bottom'): CSSProperties {
  if (side === 'left' || side === 'right') return {}
  const margin = ASSISTANT_NOTIFICATION_TAIL_WIDTH / 2 + 8
  const target = avatarCenter - regionStart
  const direction = Math.sign(target - regionSize / 2)
  // 根部保留 10px 的横向回收，尾巴才会有自然斜度；尖端仍通过角度回到助理中心。
  const rootTarget = target - direction * 10
  const center = Math.max(margin, Math.min(Math.max(margin, regionSize - margin), rootTarget))
  const bottomAngle = Math.max(-26, Math.min(26, -Math.atan2(target - center, ASSISTANT_NOTIFICATION_TAIL_HEIGHT + ASSISTANT_NOTIFICATION_TAIL_GAP) * 180 / Math.PI))
  // 顶部尾巴先翻转 180°，水平分量也随之翻转，所以要使用相反符号保持尖端仍指向助理。
  const angle = side === 'top' ? -bottomAngle : bottomAngle
  return { '--codingns-assistant-tail-offset': `${Math.round(center)}px`, '--codingns-assistant-tail-target': `${Math.round(target)}px`,
    '--codingns-assistant-tail-angle': `${Math.round(angle * 10) / 10}deg` } as CSSProperties
}

/** 实际面板边缘使用的目标投影，允许目标落在圆角外侧后由轮廓算法自然收敛。 */
export function assistantNotificationTailTarget(avatarCenter: number, regionStart: number): number {
  return avatarCenter - regionStart
}

type NotificationListFilter = 'all' | 'unread' | 'pending'

function isPendingNotice(notice: Pick<AssistantNotification, 'kind' | 'lifecycle'>): boolean {
  return (notice.kind === 'question' || notice.kind === 'approval') && notice.lifecycle === 'active'
}

export function AssistantNotificationBubble({ frame, t, error, onOpen, onDismiss, onPresented, autoClose = false, autoCloseSeconds = 30, onPage, onExpandedChange, onClearAll, tailSide = 'bottom', tailTarget, tailStyle }: AssistantNotificationBubbleProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [listFilter, setListFilter] = useState<NotificationListFilter>('all')
  const [processing, setProcessing] = useState(false)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const bubble = useRef<HTMLDivElement>(null)
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const snapshot = 'items' in frame ? frame : undefined
  const primary = snapshot === undefined ? frame as DesktopAssistantNotification : snapshot.primary
  const items = snapshot?.items.filter((notice) => !notice.read || isPendingNotice(notice)) ?? []
  // 主气泡直接呈现当前需要用户关注的通知；分页列表仍保留完整快照，避免首屏只剩统计数字。
  const attentionItems = snapshot === undefined
    ? primary === undefined || primary === null ? [] : [primary]
    : [...(snapshot.primary === null || snapshot.primary.presentation === 'collapsed' ? [] : [snapshot.primary]), ...items.filter((notice) =>
      notice.presentation !== 'collapsed' && (!notice.read || isPendingNotice(notice))
      && notice.noticeId !== snapshot.primary?.noticeId)]
  const multiple = attentionItems.length > 1 || (snapshot !== undefined && Math.max(snapshot.unreadCount, snapshot.pendingCount) > 1)
  const mainNotice = attentionItems[0] ?? (snapshot === undefined ? primary ?? undefined : undefined)
  const presented = attentionItems[0] ?? (snapshot === undefined ? primary ?? undefined : undefined)
  const createdAt = presented && 'createdAt' in presented ? presented.createdAt : undefined
  useEffect(() => { onExpandedChange?.(expanded) }, [expanded, onExpandedChange])
  useEffect(() => { setCollapsed(false) }, [frame.generation])
  useEffect(() => { setCursors([undefined]); setListFilter('all') }, [frame.generation, snapshot?.reset])
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
  }, [presented?.noticeId, presented?.kind, presented?.connectionGeneration, createdAt, frame.generation, expanded, collapsed, autoClose, autoCloseSeconds, onPresented, onDismiss])
  // 只有还存在可清理的会话通知（未读且非待处理）时才渲染按钮；待处理提醒不在清理范围内。
  const clearableCount = snapshot === undefined ? 0
    : [...snapshot.items, ...(snapshot.primary === null ? [] : [snapshot.primary])].filter((notice) => !notice.read && !isPendingNotice(notice)).length
  const showClearAll = snapshot !== undefined && clearableCount > 0 && onClearAll !== undefined
  const hasNotificationCounts = snapshot !== undefined && (snapshot.unreadCount > 0 || snapshot.pendingCount > 0)
  const showCollapseButton = !collapsed && (mainNotice !== undefined || hasNotificationCounts)
  const showExpandButton = collapsed && (mainNotice !== undefined || hasNotificationCounts)
  const showTopRow = showCollapseButton || showExpandButton || showClearAll || hasNotificationCounts
  const showBubble = !collapsed && (!expanded || snapshot === undefined) && mainNotice !== undefined
  const showFilterTags = snapshot !== undefined && (multiple || collapsed)
  const listItems = listFilter === 'unread'
    ? items.filter((notice) => !notice.read && !isPendingNotice(notice))
    : listFilter === 'pending'
      ? items.filter((notice) => isPendingNotice(notice))
      : items
  const showTail = showBubble || (expanded && snapshot !== undefined)
  const tail = showTail ? createElement('span', { 'aria-hidden': true, 'data-codingns-notification-tail': tailSide, style: { ...tailBox(tailSide), ...tailStyle } },
    createElement('svg', { width: ASSISTANT_NOTIFICATION_TAIL_WIDTH, height: ASSISTANT_NOTIFICATION_TAIL_HEIGHT,
      viewBox: `0 0 ${ASSISTANT_NOTIFICATION_TAIL_WIDTH} ${ASSISTANT_NOTIFICATION_TAIL_HEIGHT}`, 'aria-hidden': true, style: tailSvg(tailSide) },
      createElement('path', { d: `${notificationTailCurve} Z`, fill: dshThemeColor.menuBackground }),
      createElement('path', { d: notificationTailCurve, fill: 'none', stroke: dshThemeColor.border, strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }))) : null
  const page = (next: boolean): void => {
    const updated = next ? [...cursors, snapshot!.cursor!] : cursors.slice(0, -1)
    setCursors(updated); onPage?.(updated.at(-1))
  }
  const openFilteredList = (filter: NotificationListFilter): void => {
    setCollapsed(false); setListFilter(filter); setExpanded(true); setCursors([undefined]); onPage?.()
  }
  // 提问与权限申请统一为「有 [标签] 需要你来处理」；权限申请用黄色标签，与卡片图标保持一致。
  const requestLine = (notice: AssistantNotification | DesktopAssistantNotification, compact = false): ReactElement => {
    const approval = notice.kind === 'approval'
    const tagStyle = compact ? (approval ? compactApprovalTag : compactRequestTag) : (approval ? approvalInlineTag : requestInlineTag)
    return createElement('span', { style: requestPrompt },
      t('awb.notifications.requestPrefix'),
      createElement('span', { style: tagStyle }, approval ? t('awb.notifications.approvalTag') : t('awb.notifications.questionTag')),
      t('awb.notifications.requestSuffix'))
  }
  const row = (notice: AssistantNotification | DesktopAssistantNotification, variant: 'primary' | 'compact' | 'list' = 'list'): ReactElement => createElement('section', {
    key: notice.noticeId, 'data-codingns-notice-id': notice.noticeId, 'data-codingns-notice-kind': notice.kind,
    style: variant === 'primary' ? primaryCard : variant === 'compact' ? compactCard : listRow },
    createElement('div', { style: cardBody },
      createElement('div', { style: cardHeading },
        createElement('span', { 'aria-hidden': true, style: { ...kindMark, background: noticeKindColor[notice.kind],
          ...(noticeKindForeground[notice.kind] === undefined ? {} : { color: noticeKindForeground[notice.kind]! }) } }, icons[notice.kind]),
        createElement('div', { style: { minWidth: 0, flex: '1 1 auto' }, title: `${notice.hostLabel} · ${notice.workspaceLabel} · ${notice.sessionTitle}` },
          createElement('div', { style: cardMeta }, `${notice.hostLabel} · ${notice.workspaceLabel}`),
          createElement('div', { style: cardTitle }, notice.sessionTitle))),
      variant === 'compact'
        ? notice.kind === 'question' || notice.kind === 'approval'
          ? createElement('div', { style: compactPrompt }, requestLine(notice, true))
          : createElement('span', { style: compactStatus }, notificationStatus(notice, t))
        : null,
      variant !== 'compact' ? createElement('div', { style: messageText },
        notice.kind === 'question' || notice.kind === 'approval'
          ? requestLine(notice)
          : createElement('span', null, createElement('span', { 'aria-hidden': true }, icons[notice.kind] + ' '), notice.text),
        'errorExcerpt' in notice && notice.errorExcerpt ? createElement('div', null, notice.errorExcerpt) : null) : null,
      notice.availability !== 'ready' ? createElement('span', { role: 'status' }, t(notice.availability === 'disconnected' ? 'awb.notifications.disconnected' : 'awb.notifications.expired')) : null),
    createElement('div', { style: actionRow },
      createElement('button', { type: 'button', style: notificationActionButton, disabled: notice.availability !== 'ready',
        'aria-label': [t('awb.notifications.open'), notice.hostLabel, notice.workspaceLabel, notice.sessionTitle].join(' · '),
        title: t('awb.notifications.open'), 'data-codingns-notification-action': 'open',
        onClick: () => onOpen(notice.noticeId, frame.generation, 'connectionGeneration' in notice ? notice.connectionGeneration : undefined) }, notificationActionIcon('open')),
      createElement('button', { type: 'button', style: notificationActionButton,
        'aria-label': [t('awb.notifications.dismiss'), notice.hostLabel, notice.workspaceLabel, notice.sessionTitle].join(' · '),
        title: t('awb.notifications.dismiss'), 'data-codingns-notification-action': 'dismiss',
        onClick: () => {
          clearTimeout(autoCloseTimer.current); autoCloseTimer.current = undefined
          onDismiss(notice.noticeId, frame.generation, 'connectionGeneration' in notice ? notice.connectionGeneration : undefined)
        } }, notificationActionIcon('dismiss'))))
  const capabilityNotices = collapsed
    ? []
    : (snapshot?.capabilities?.filter((capability) => capability.reason && (!capability.completed || !capability.error || !capability.requests || !capability.resolve || !capability.navigation)).map((capability) =>
      createElement('div', { key: capability.hostId, role: 'status', style: panel }, capability.reason)) ?? [])
  return createElement('div', { 'data-codingns-assistant-notifications': true, style: shell,
    // 操作和文本选择不进入形象拖动区，不抢焦点；组件本身无弹跳动画。
    onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
    onClick: (event: { stopPropagation(): void }) => event.stopPropagation() },
    createElement('style', null, notificationBubbleCss),
    tail,
    showTopRow ? createElement('div', { 'data-codingns-notification-toolbar': true, style: topRow },
      showCollapseButton || showExpandButton ? createElement('button', { type: 'button', style: toolbarIconButton,
        'aria-expanded': !collapsed, 'aria-label': t(collapsed ? 'awb.notifications.expand' : 'awb.notifications.collapse'),
        title: t(collapsed ? 'awb.notifications.expand' : 'awb.notifications.collapse'), onClick: () => {
          setExpanded(false); setCollapsed((value) => !value)
        } }, notificationToolbarIcon(collapsed ? 'expand' : 'collapse')) : null,
      !collapsed && showClearAll ? createElement('button', { type: 'button', style: processing ? clearAllButtonBusy : clearAllButton,
        disabled: processing, 'aria-label': t('awb.notifications.clearAllLabel'), title: t('awb.notifications.clearAllLabel'), onClick: () => {
          if (processing || snapshot === undefined || onClearAll === undefined) return
          setProcessing(true)
          // 清理成功后 Host 修订变化会让按钮随计数归零消失；失败只复位按钮，错误交给外部气泡。
          void Promise.resolve(onClearAll(snapshot.generation)).catch(() => undefined).finally(() => setProcessing(false))
        } }, notificationToolbarIcon('clear')) : null,
      showFilterTags ? [
        snapshot.unreadCount > 0 ? createElement('button', { key: 'unread-filter', type: 'button', style: listFilter === 'unread' ? filterButtonActive : filterButton,
          'aria-expanded': expanded, 'aria-pressed': listFilter === 'unread', 'aria-label': t('awb.notifications.unreadFilterLabel', { count: snapshot.unreadCount }), title: t('awb.notifications.unreadFilterLabel', { count: snapshot.unreadCount }), onClick: () => openFilteredList('unread') },
          notificationToolbarIcon('unread'), createElement('span', { style: notificationCountBadge }, formatNotificationCount(snapshot.unreadCount))) : null,
        snapshot.pendingCount > 0 ? createElement('button', { key: 'pending-filter', type: 'button', style: listFilter === 'pending' ? filterButtonActive : filterButton,
          'aria-expanded': expanded, 'aria-pressed': listFilter === 'pending', 'aria-label': t('awb.notifications.pendingFilterLabel', { count: snapshot.pendingCount }), title: t('awb.notifications.pendingFilterLabel', { count: snapshot.pendingCount }), onClick: () => openFilteredList('pending') },
          notificationToolbarIcon('pending'), createElement('span', { style: notificationPendingBadge }, formatNotificationCount(snapshot.pendingCount))) : null,
      ] : null) : null,
      showBubble ? createElement('div', { ref: bubble, role: 'status', 'aria-live': 'polite', style: bubblePanel },
        createElement('div', { 'data-codingns-notification-scroll': true, style: bubbleContent },
         multiple ? attentionItems.map((notice) => row(notice, 'compact')) : row(mainNotice, 'primary'))) : null,
    !collapsed && expanded && snapshot ? createElement('div', { ref: bubble, role: 'region', 'aria-label': t('awb.notifications.list'), 'data-codingns-notification-scroll': true, style: panel },
      createElement('button', { type: 'button', style: button, onClick: () => setExpanded(false) }, t('awb.notifications.closeList')),
      createElement('div', { 'data-codingns-notification-scroll': true, style: { maxHeight: 180, overflowY: 'auto', overscrollBehavior: 'contain' } },
        ...listItems.map((notice) => row(notice, 'list'))),
      listItems.length === 0 ? createElement('p', null, t('awb.notifications.empty')) : null,
      onPage ? createElement('div', { style: { display: 'flex', gap: 6 } },
        createElement('button', { type: 'button', style: button, disabled: cursors.length <= 1, onClick: () => page(false) }, t('awb.notifications.previous')),
        createElement('button', { type: 'button', style: button, disabled: !snapshot.cursor, onClick: () => page(true) }, t('awb.notifications.next'))) : null) : null,
    !collapsed && error ? createElement('div', { role: 'alert', style: panel }, error) : null,
    // 启动恢复边界属于来源说明，不应让正常空闲的角色常驻技术诊断气泡。
    ...capabilityNotices
  )
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

export interface FloatingAssistantNotificationLayout {
  readonly style: CSSProperties
  readonly tail: AssistantNotificationTailSide
}

/** 网页气泡作为形象的兄弟区域定位；字幕优先保留原侧，通知避让到另一侧或形象旁。 */
export function floatingAssistantNotificationLayout(x: number, y: number, width: number, height: number,
  viewportWidth: number, viewportHeight: number, captionAbove?: boolean): FloatingAssistantNotificationLayout {
  const bubbleWidth = Math.max(0, Math.min(320, viewportWidth - 24))
  // 气泡边缘与形象之间始终保留尾巴长度加尖端间隙，尾巴伸出后也不会压住形象。
  const clearance = ASSISTANT_NOTIFICATION_TAIL_CLEARANCE
  const aboveSpace = Math.max(0, y - 22 - clearance), belowSpace = Math.max(0, viewportHeight - y - height - 22 - clearance)
  const above = captionAbove === undefined ? aboveSpace >= belowSpace : !captionAbove
  const space = above ? aboveSpace : belowSpace
  const left = Math.max(12 - x, Math.min((width - bubbleWidth) / 2, viewportWidth - x - bubbleWidth - 12))
  if (captionAbove !== undefined && space < 72) {
    const leftSpace = Math.max(0, x - 22), rightSpace = Math.max(0, viewportWidth - x - width - 22)
    const sideWidth = Math.min(320, Math.max(leftSpace, rightSpace))
    // 气泡在形象左侧时尾巴贴右边，反之贴左边，尖端始终朝向形象。
    if (sideWidth >= 150) {
      const onLeft = leftSpace >= rightSpace
      return { style: { left: onLeft ? -sideWidth - 10 : width + 10, top: 0,
        width: sideWidth, maxHeight: Math.min(276, height, Math.max(0, viewportHeight - y - 12)) }, tail: onLeft ? 'right' : 'left' }
    }
    // 手机横向空间不足时向字幕外侧叠放，保留字幕的最大180像素与独立滚动。
    const stackedAbove = captionAbove
    const stackedSpace = (stackedAbove ? aboveSpace : belowSpace) - 190
    if (stackedSpace >= 36) return { style: { left, width: bubbleWidth, maxHeight: Math.min(276, stackedSpace),
      ...(stackedAbove ? { bottom: height + 200 } : { top: height + 200 }) }, tail: stackedAbove ? 'bottom' : 'top' }
  }
  return { style: { left, width: bubbleWidth, maxHeight: Math.min(276, space), ...(above ? { bottom: height + clearance } : { top: height + clearance }) },
    tail: above ? 'bottom' : 'top' }
}

const icons = { completed: '✓', error: '!', question: '?', approval: '!' }
const noticeKindColor: Record<AssistantNotification['kind'], string> = {
  completed: dshThemeColor.success, error: dshThemeColor.error, question: dshThemeColor.accent, approval: dshThemeColor.warning,
}
/** 黄色填充上的图标与标签改用深色前景，避免白字对比度不足。 */
const noticeKindForeground: Partial<Record<AssistantNotification['kind'], string>> = { approval: dshThemeColor.warningForeground }
function notificationStatus(notice: AssistantNotification | DesktopAssistantNotification, t: CodingNsTranslator): string {
  if (notice.kind === 'completed') return t('awb.notifications.completed')
  if (notice.kind === 'error') return t('awb.notifications.error')
  if (notice.kind === 'question') return t('awb.notifications.question')
  return t('awb.notifications.approval')
}
const button: CSSProperties = { ...dshSettingsButtonStyle, minHeight: 36, touchAction: 'manipulation', whiteSpace: 'normal', borderRadius: 999, fontWeight: 650 }
const shell: CSSProperties = { position: 'relative', width: '100%', maxWidth: 320, height: '100%', maxHeight: 'var(--codingns-notification-max-height, min(276px, calc(100vh - 24px)))', minHeight: 0,
  display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'auto', color: dshThemeColor.labelPrimary, fontSize: uiFontSize(13) }
const panel: CSSProperties = { position: 'relative', zIndex: 1, padding: 10, background: dshThemeColor.menuBackground, border: `1px solid ${dshThemeColor.border}`, borderRadius: 18, boxShadow: dshThemeColor.prominentShadow,
  minWidth: 0, boxSizing: 'border-box', maxHeight: 'min(276px, calc(100vh - 24px))', overflowY: 'auto' }
const bubblePanel: CSSProperties = { ...panel, position: 'relative', display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0, minHeight: 0,
  padding: 10, overflow: 'visible', borderRadius: '24px 24px 24px 8px', borderColor: dshThemeColor.border,
  maxHeight: '100%', background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.prominentShadow }
const bubbleContent: CSSProperties = { position: 'relative', zIndex: 1, display: 'grid', gap: 8, minHeight: 0, flex: '1 1 auto',
  overflowY: 'auto', overscrollBehavior: 'contain', boxSizing: 'border-box', padding: 0 }
const notificationTailCurve = 'M1 0 C8 0.4 13 7 16 18 C17 23 19 28 20 31 C21 28 23 23 24 18 C27 7 32 0.4 39 0'
function tailBox(side: AssistantNotificationTailSide): CSSProperties {
  const base: CSSProperties = { position: 'absolute', zIndex: 0, pointerEvents: 'none' }
  if (side === 'top') return { ...base, top: -ASSISTANT_NOTIFICATION_TAIL_HEIGHT, left: 'var(--codingns-assistant-tail-offset, 50%)',
    width: ASSISTANT_NOTIFICATION_TAIL_WIDTH, height: ASSISTANT_NOTIFICATION_TAIL_HEIGHT, marginLeft: -ASSISTANT_NOTIFICATION_TAIL_WIDTH / 2 }
  if (side === 'left') return { ...base, left: -ASSISTANT_NOTIFICATION_TAIL_HEIGHT, top: 'var(--codingns-assistant-tail-offset, 50%)',
    width: ASSISTANT_NOTIFICATION_TAIL_HEIGHT, height: ASSISTANT_NOTIFICATION_TAIL_WIDTH, marginTop: -ASSISTANT_NOTIFICATION_TAIL_WIDTH / 2 }
  if (side === 'right') return { ...base, right: -ASSISTANT_NOTIFICATION_TAIL_HEIGHT, top: 'var(--codingns-assistant-tail-offset, 50%)',
    width: ASSISTANT_NOTIFICATION_TAIL_HEIGHT, height: ASSISTANT_NOTIFICATION_TAIL_WIDTH, marginTop: -ASSISTANT_NOTIFICATION_TAIL_WIDTH / 2 }
  return { ...base, bottom: -ASSISTANT_NOTIFICATION_TAIL_HEIGHT, left: 'var(--codingns-assistant-tail-offset, 50%)',
    width: ASSISTANT_NOTIFICATION_TAIL_WIDTH, height: ASSISTANT_NOTIFICATION_TAIL_HEIGHT, marginLeft: -ASSISTANT_NOTIFICATION_TAIL_WIDTH / 2 }
}
function tailSvg(side: AssistantNotificationTailSide): CSSProperties {
  const angle = 'var(--codingns-assistant-tail-angle, 0deg)'
  if (side === 'bottom') return { display: 'block', transformOrigin: '50% 0%', transform: `rotate(${angle})` }
  if (side === 'top') return { display: 'block', transformOrigin: '50% 50%', transform: `rotate(180deg) rotate(${angle})` }
  return { display: 'block', position: 'absolute', left: '50%', top: '50%',
    transform: `translate(-50%, -50%) rotate(${side === 'left' ? 90 : -90}deg)` }
}
// 保留滚动操作，但不显示通知气泡右侧滚动条；内外层只由外层统一提供 10px 留白。
const notificationBubbleCss = '[data-codingns-notification-scroll]{scrollbar-width:none;-ms-overflow-style:none}[data-codingns-notification-scroll]::-webkit-scrollbar{display:none;width:0;height:0}'
const primaryCard: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 9, padding: 5, minWidth: 0 }
const compactCard: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 7, padding: '10px 11px', minWidth: 0, background: dshThemeColor.cardBackground,
  border: `1px solid ${dshThemeColor.border}`, borderRadius: 15, boxShadow: dshThemeColor.subtleShadow }
const listRow: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 7, padding: '10px 0', minWidth: 0, borderBottom: `1px solid ${dshThemeColor.border}` }
const cardBody: CSSProperties = { display: 'grid', gap: 8, minWidth: 0, minInlineSize: 0 }
const cardHeading: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const cardMeta: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(11), lineHeight: 1.3, overflowWrap: 'anywhere' }
const cardTitle: CSSProperties = { fontWeight: 750, fontSize: uiFontSize(15), lineHeight: 1.35, overflowWrap: 'anywhere' }
const kindMark: CSSProperties = { display: 'inline-grid', placeItems: 'center', flex: '0 0 auto', width: 24, height: 24, borderRadius: '50%', color: dshThemeColor.primaryForeground,
  fontSize: uiFontSize(13), fontWeight: 800, boxShadow: dshThemeColor.subtleShadow }
const messageText: CSSProperties = { color: dshThemeColor.labelPrimary, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5, maxHeight: 120, overflowY: 'auto' }
// 顶部统计按钮统一使用 28px 高度，给图标和数量徽标留出稳定的点击区域。
const topRowButton: CSSProperties = { ...button, height: 28, minHeight: 28, padding: '2px 10px', fontSize: uiFontSize(12) }
const toolbarIconButton: CSSProperties = { ...topRowButton, width: 28, minWidth: 28, padding: 4, display: 'inline-grid', placeItems: 'center' }
const filterButton: CSSProperties = { ...topRowButton, alignSelf: 'end', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 46, padding: '2px 7px', background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.subtleShadow }
const filterButtonActive: CSSProperties = { ...filterButton, background: dshThemeColor.accent, borderColor: dshThemeColor.accent, color: dshThemeColor.primaryForeground }
const notificationCountBadge: CSSProperties = { display: 'inline-grid', placeItems: 'center', minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box', borderRadius: 8,
  color: dshThemeColor.labelPrimary, background: dshThemeColor.cardBackground, fontSize: uiFontSize(10), lineHeight: 1, fontWeight: 750 }
const notificationPendingBadge: CSSProperties = { ...notificationCountBadge, color: dshThemeColor.warningForeground, background: dshThemeColor.warning }
// 顶部行按「收起、清理、未读、待处理」排列，图标只保留动作语义，数量由徽标承载。
const topRow: CSSProperties = { display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 6 }
// 清理通知与卡片内的查看/收起动作使用同一套中性灰色按钮，避免把清理误读为主流程操作。
const clearAllButton: CSSProperties = { ...toolbarIconButton, alignSelf: 'end', background: dshThemeColor.buttonBackground,
  borderColor: dshThemeColor.border, color: dshThemeColor.labelPrimary, borderRadius: 10, boxShadow: 'none' }
const clearAllButtonBusy: CSSProperties = { ...clearAllButton, opacity: 0.6, cursor: 'default' }
// 「有 [标签] 需要你来处理」整行：标签胶囊夹在文字中间，间距由这一层控制，窄屏允许换行。
const requestPrompt: CSSProperties = { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, lineHeight: 1.5 }
const requestInlineTag: CSSProperties = { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999,
  color: dshThemeColor.primaryForeground, background: dshThemeColor.accent, fontSize: uiFontSize(11), lineHeight: 1.2, fontWeight: 750, letterSpacing: '0.02em', boxShadow: dshThemeColor.subtleShadow }
// 多条堆叠的紧凑卡片：提示行字号略小，标签同步收紧，语义与主卡片一致。
const compactPrompt: CSSProperties = { fontSize: uiFontSize(12), lineHeight: 1.4, color: dshThemeColor.labelPrimary }
const compactRequestTag: CSSProperties = { ...requestInlineTag, padding: '2px 7px', fontSize: uiFontSize(10) }
// 权限申请标签改用黄色警示底与深色文字，与卡片图标一致。
const approvalInlineTag: CSSProperties = { ...requestInlineTag, background: dshThemeColor.warning, color: dshThemeColor.warningForeground }
const compactApprovalTag: CSSProperties = { ...compactRequestTag, background: dshThemeColor.warning, color: dshThemeColor.warningForeground }
const compactStatus: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(11), lineHeight: 1.3, paddingLeft: 32 }
const actionRow: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 6, flex: '0 0 auto' }
const notificationActionButton: CSSProperties = { ...button, width: 28, height: 28, minHeight: 28, padding: 0, display: 'inline-grid', placeItems: 'center', borderRadius: 10, fontSize: uiFontSize(12) }

/** 操作按钮只保留图标，文字语义通过 aria-label 和 title 传达，避免气泡底部堆叠长文案。 */
function notificationActionIcon(action: 'open' | 'dismiss'): ReactElement {
  if (action === 'dismiss') return createElement(IconTrashOutlineMedium, { size: 16 })
  // 查看会话沿用已确认的眼睛图标；清理通知复用 DSH 原生垃圾桶图标。
  return createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    createElement('path', { d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z' }),
    createElement('circle', { cx: 12, cy: 12, r: 2.5 }))
}

type NotificationToolbarIcon = 'collapse' | 'expand' | 'clear' | 'unread' | 'pending'
function notificationToolbarIcon(icon: NotificationToolbarIcon): ReactElement {
  if (icon === 'clear') return createElement(IconTrashOutlineMedium, { size: 16 })
  if (icon === 'pending') return createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, [
    // 参考食指点击手势：保留完整手形、弯曲的其余手指和指尖点击圆弧，确保小尺寸下仍可辨认。
    createElement('path', { key: 'hand', d: 'M9 14V6.5a1.5 1.5 0 0 1 3 0v4a1.5 1.5 0 0 1 3 0v1a1.5 1.5 0 0 1 3 0v1a1.5 1.5 0 0 1 3 0v4c0 4-2.5 6-6.5 6h-1c-2.2 0-3.6-.8-5.1-2.3L4.2 15a1.7 1.7 0 0 1 2.4-2.4L9 15Z' }),
    createElement('path', { key: 'fingers', d: 'M12 10.5v3M15 11.5v3M18 12.5V15' }),
    createElement('path', { key: 'tap', d: 'M6.7 8.9a4.5 4.5 0 1 1 8.2-1.6' }),
  ])
  const path = icon === 'collapse' ? 'M6 9l6 6 6-6' : icon === 'expand' ? 'M6 15l6-6 6 6'
    : icon === 'unread' ? 'M6 10a6 6 0 0 1 12 0c0 5 2 5 2 7H4c0-2 2-2 2-7Zm3 10h6'
      : ''
  return createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, createElement('path', { d: path }))
}
function formatNotificationCount(count: number): string { return count > 99 ? '99+' : String(count) }
