import { ASSISTANT_NOTIFICATION_TAIL_HEIGHT, ASSISTANT_NOTIFICATION_TAIL_WIDTH } from '../../shared/assistant-notifications.js'
import type { AssistantNotificationTailSide } from '../../shared/assistant-notifications.js'

/** 面板与尾巴共用一个闭合轮廓；所有点都属于面板坐标系，没有旋转原点或拼接遮盖。 */
export function notificationSurfaceGeometry(width: number, height: number, side: AssistantNotificationTailSide,
  target?: number, length = ASSISTANT_NOTIFICATION_TAIL_HEIGHT): { path: string; tip: { x: number; y: number }; root: { x: number; y: number } } {
  const radius = Math.min(18, width / 2, height / 2)
  const horizontal = side === 'top' || side === 'bottom'
  const size = horizontal ? width : height
  const half = Math.min(ASSISTANT_NOTIFICATION_TAIL_WIDTH / 2, Math.max(0, (size - 2 * radius - 4) / 2))
  const tipAlong = Math.max(1, Math.min(size - 1, target ?? size / 2))
  // 根部略向面板中心收，尖端保持对准形象，形成自然斜向；正中位置也保留轻微弯曲。
  const bias = tipAlong < size / 2 ? 24 : -24
  const rootAlong = Math.max(radius + half + 2, Math.min(size - radius - half - 2, tipAlong + bias))
  const reverse = side === 'bottom' || side === 'left'
  const root = reverse ? size - rootAlong : rootAlong
  const tip = reverse ? size - tipAlong : tipAlong
  const point = (along: number, outward: number): { x: number; y: number } => {
    if (side === 'top') return { x: along, y: -outward }
    if (side === 'right') return { x: width + outward, y: along }
    if (side === 'bottom') return { x: width - along, y: height + outward }
    return { x: -outward, y: height - along }
  }
  const xy = (along: number, outward: number): string => {
    const p = point(along, outward)
    return `${p.x} ${p.y}`
  }
  const tail = `L${xy(root - half, 0)} C${xy(root - half + half * .6, 0)} ${xy(tip - 5, length * .66)} ${xy(tip, length)}`
    + ` C${xy(tip + 3, length * .58)} ${xy(root + half - half * .6, 0)} ${xy(root + half, 0)}`
  const path = `M${radius} 0 ${side === 'top' ? tail : ''} H${width - radius} Q${width} 0 ${width} ${radius}`
    + ` ${side === 'right' ? tail : ''} V${height - radius} Q${width} ${height} ${width - radius} ${height}`
    + ` ${side === 'bottom' ? tail : ''} H${radius} Q0 ${height} 0 ${height - radius}`
    + ` ${side === 'left' ? tail : ''} V${radius} Q0 0 ${radius} 0 Z`
  return { path, tip: point(tip, length), root: point(root, 0) }
}

/** 直接测量实际面板，内容、字体和滚动区变化只更新背景轮廓，不反过来改变布局。 */
export function observeNotificationSurface(node: HTMLElement, side: AssistantNotificationTailSide, target?: number,
  length = ASSISTANT_NOTIFICATION_TAIL_HEIGHT): () => void {
  const draw = (): void => {
    const width = node.clientWidth, height = node.clientHeight
    if (width <= 0 || height <= 0) return
    const geometry = notificationSurfaceGeometry(width, height, side, target, length)
    node.querySelector('[data-codingns-notification-outline]')?.setAttribute('d', geometry.path)
    node.querySelector('[data-codingns-notification-fallback]')?.setAttribute('visibility', 'hidden')
    // 保留实际尖端坐标供渲染回归检查；不依赖 SVG 包围盒推测方向。
    node.dataset.tailTipX = String(geometry.tip.x); node.dataset.tailTipY = String(geometry.tip.y)
  }
  draw()
  if (typeof ResizeObserver === 'undefined') return () => {}
  const observer = new ResizeObserver(draw)
  observer.observe(node)
  return () => observer.disconnect()
}
