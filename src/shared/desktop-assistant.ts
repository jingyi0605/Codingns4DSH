import { ASSISTANT_AVATAR_STATES, ASSISTANT_AVATAR_REACTIONS, type AssistantAvatarModel, type AssistantAvatarReaction, type AssistantAvatarState } from './assistant-avatar.js'
import type { AssistantNotification, AssistantNotificationSnapshot } from './assistant-notifications.js'

/** 只复用共享通知的安全展示字段；目标、工具参数和凭证不能进入伴随页。 */
export type DesktopAssistantNotification = Pick<AssistantNotification, 'noticeId' | 'kind' | 'hostLabel' | 'workspaceLabel' | 'sessionTitle' | 'text' | 'availability' | 'connectionGeneration'> & { readonly generation: number }
export interface DesktopAssistantNoticeEvent {
  readonly sequence: number
  readonly ownerId: string
  readonly generation: number
  readonly noticeId: string
  readonly noticeGeneration: number
  /** 同一提醒从完成升级为错误时，主页面可拒绝迟到的旧首展确认；旧 Host 可省略。 */
  readonly noticeKind?: AssistantNotification['kind']
  /** 主页面必须使用点击当时的远端连接代次，不能改用重连后的同名通知。 */
  readonly connectionGeneration?: AssistantNotification['connectionGeneration']
  readonly type: 'notice-presented' | 'notice-action'
  readonly action?: 'open' | 'dismiss'
}
export interface DesktopAssistantNoticeIdentity {
  readonly ownerId: string
  readonly generation: number
  readonly sequence: number
}
/** 主页面只反馈已接收动作的安全失败文本，不能借此指定新目标或创建通知。 */
export interface DesktopAssistantNoticeFeedback {
  readonly generation: number
  readonly sequence: number
  readonly noticeId: string
  readonly noticeGeneration: number
  readonly message: string
}
export function readDesktopAssistantNoticeFeedback(value: unknown): DesktopAssistantNoticeFeedback {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('通知反馈无效')
  const record = value as Record<string, unknown>
  if (!['generation', 'sequence', 'noticeGeneration'].every((key) => Number.isSafeInteger(record[key]) && Number(record[key]) >= 0)
    || typeof record.noticeId !== 'string' || record.noticeId.length === 0 || record.noticeId.length > 160
    || typeof record.message !== 'string' || record.message.length === 0 || record.message.length > 240) throw new TypeError('通知反馈无效')
  return { generation: Number(record.generation), sequence: Number(record.sequence), noticeId: record.noticeId,
    noticeGeneration: Number(record.noticeGeneration), message: record.message.replace(/[\u0000-\u001f\u007f]/gu, ' ') }
}

export const DESKTOP_ASSISTANT_CHANNEL = '/codingns-desktop-assistant'
/** 伴随页面只有展示数据，不能携带 DSH 令牌、工作区或会话控制句柄。 */
export interface DesktopAssistantPresentation {
  readonly visible: boolean
  readonly state: AssistantAvatarState
  readonly caption: string
  readonly label: string
  readonly notification?: DesktopAssistantNotification
  /** 共享契约本身只含安全展示字段；白名单复制后供原生未读入口和分页复用。 */
  readonly notificationSnapshot?: AssistantNotificationSnapshot
  readonly reaction?: AssistantAvatarReaction
}
export interface DesktopAssistantFrame extends DesktopAssistantPresentation {
  readonly model: AssistantAvatarModel
  readonly size: number
  readonly identity?: DesktopAssistantNoticeIdentity
  readonly layout?: DesktopAssistantLayout
  readonly nativeVisible?: boolean
  /** 认证主页面处理当前通知失败时显示，不参与模型或通知呈现版本。 */
  readonly noticeError?: string
}
export interface DesktopAssistantStatus {
  readonly available: boolean
  readonly visible: boolean
  readonly owned: boolean
  /** 是否已有页面持有窗口；可选字段兼容旧 Host 的答复。 */
  readonly attached?: boolean
  readonly openSequence: number
  readonly error?: string | undefined
  readonly generation?: number
  readonly noticeEvents?: readonly DesktopAssistantNoticeEvent[]
  readonly noticeError?: string
}

/** 不将渲染器提供的任意对象直接转发到原生进程。 */
export function readDesktopAssistantPresentation(value: unknown): DesktopAssistantPresentation {
  if (!value || typeof value !== 'object') throw new TypeError('悬浮状态无效')
  const record = value as Record<string, unknown>
  if (typeof record.visible !== 'boolean' || !ASSISTANT_AVATAR_STATES.includes(record.state as AssistantAvatarState)
    || typeof record.caption !== 'string' || record.caption.length > 8000
    || typeof record.label !== 'string' || record.label.length > 160) throw new TypeError('悬浮状态无效')
  const notification = readDesktopAssistantNotification(record.notification)
  const notificationSnapshot = readDesktopAssistantNotificationSnapshot(record.notificationSnapshot)
  return { visible: record.visible, state: record.state as AssistantAvatarState, caption: record.caption, label: record.label,
    ...(notification === undefined ? {} : { notification }),
    ...(notificationSnapshot === undefined ? {} : { notificationSnapshot }),
    ...(ASSISTANT_AVATAR_REACTIONS.includes(record.reaction as AssistantAvatarReaction) ? { reaction: record.reaction as AssistantAvatarReaction } : {}) }
}

/** 非法可选字段回落为无通知，原形象和字幕仍可继续显示。 */
export function readDesktopAssistantNotification(value: unknown): DesktopAssistantNotification | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 0
    || input.connectionGeneration !== undefined && (!Number.isSafeInteger(input.connectionGeneration) || Number(input.connectionGeneration) < 0)
    || typeof input.noticeId !== 'string' || input.noticeId.length === 0 || input.noticeId.length > 160
    || !['completed', 'error', 'question', 'approval'].includes(String(input.kind))
    || !['ready', 'disconnected', 'expired'].includes(String(input.availability))) return undefined
  const limits = { hostLabel: 160, workspaceLabel: 160, sessionTitle: 240, text: 240 }
  for (const [key, limit] of Object.entries(limits)) if (typeof input[key] !== 'string' || (input[key] as string).length > limit) return undefined
  return { noticeId: input.noticeId, generation: Number(input.generation), kind: input.kind as DesktopAssistantNotification['kind'],
    availability: input.availability as DesktopAssistantNotification['availability'], ...(input.connectionGeneration === undefined ? {} : { connectionGeneration: Number(input.connectionGeneration) }), hostLabel: input.hostLabel as string,
    workspaceLabel: input.workspaceLabel as string, sessionTitle: input.sessionTitle as string, text: input.text as string }
}

/** 不直接转发 Host 对象，条目、能力和分页均有界；非法可选快照保持旧展示兼容。 */
export function readDesktopAssistantNotificationSnapshot(value: unknown): AssistantNotificationSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const integer = (item: unknown): item is number => Number.isSafeInteger(item) && Number(item) >= 0
  if (!['generation', 'revision', 'unreadCount', 'pendingCount'].every((key) => integer(record[key]))
    || typeof record.serverNow !== 'number' || !Number.isFinite(record.serverNow) || record.serverNow < 0
    || !(record.cursor === null || typeof record.cursor === 'string' && record.cursor.length <= 2048)
    || !Array.isArray(record.items) || record.items.length > 50 || !Array.isArray(record.capabilities) || record.capabilities.length > 100) return undefined
  const notice = (item: unknown): AssistantNotification | undefined => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const input = item as Record<string, unknown>
    const safe = readDesktopAssistantNotification({ ...input, generation: record.generation })
    if (!safe || typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt) || input.createdAt < 0
      || typeof input.read !== 'boolean' || !['queued', 'shown', 'collapsed'].includes(String(input.presentation))
      || !['active', 'resolved', 'invalidated'].includes(String(input.lifecycle))) return undefined
    if (['presentedAt', 'deadline'].some((key) => input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || Number(input[key]) < 0))
      || input.errorExcerpt !== undefined && (typeof input.errorExcerpt !== 'string' || input.errorExcerpt.length > 240)
      || input.connectionGeneration !== undefined && !integer(input.connectionGeneration)) return undefined
    const { generation, ...base } = safe
    return { ...base, createdAt: input.createdAt, read: input.read, presentation: input.presentation as AssistantNotification['presentation'], lifecycle: input.lifecycle as AssistantNotification['lifecycle'],
      ...(input.presentedAt === undefined ? {} : { presentedAt: input.presentedAt as number }), ...(input.deadline === undefined ? {} : { deadline: input.deadline as number }),
      ...(input.errorExcerpt === undefined ? {} : { errorExcerpt: input.errorExcerpt as string }), ...(input.connectionGeneration === undefined ? {} : { connectionGeneration: input.connectionGeneration as number }) }
  }
  const primary = record.primary === null ? null : notice(record.primary), items = record.items.map(notice)
  if (primary === undefined || items.some((item) => item === undefined)) return undefined
  const capabilities: AssistantNotificationSnapshot['capabilities'][number][] = []
  for (const item of record.capabilities) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const input = item as Record<string, unknown>
    if (typeof input.hostId !== 'string' || input.hostId.length === 0 || input.hostId.length > 160
      || !['completed', 'error', 'requests', 'resolve', 'navigation', 'recovery'].every((key) => typeof input[key] === 'boolean')
      || input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 400)) return undefined
    capabilities.push({ hostId: input.hostId, completed: input.completed as boolean, error: input.error as boolean, requests: input.requests as boolean,
      resolve: input.resolve as boolean, navigation: input.navigation as boolean, recovery: input.recovery as boolean, ...(input.reason === undefined ? {} : { reason: input.reason as string }) })
  }
  if (['reset', 'unchanged'].some((key) => record[key] !== undefined && typeof record[key] !== 'boolean')) return undefined
  return { generation: Number(record.generation), revision: Number(record.revision), serverNow: record.serverNow, primary, items: items as AssistantNotification[],
    unreadCount: Number(record.unreadCount), pendingCount: Number(record.pendingCount), cursor: record.cursor as string | null, capabilities,
    ...(record.reset === undefined ? {} : { reset: record.reset as boolean }), ...(record.unchanged === undefined ? {} : { unchanged: record.unchanged as boolean }) }
}
export function desktopAssistantHasNotifications(frame: DesktopAssistantPresentation): boolean {
  const snapshot = frame.notificationSnapshot
  return snapshot === undefined ? frame.notification !== undefined : snapshot.primary !== null
    || snapshot.unreadCount > 0 || snapshot.pendingCount > 0 || snapshot.capabilities.some((entry) => Boolean(entry.reason)
      && (!entry.completed || !entry.error || !entry.requests || !entry.resolve || !entry.navigation))
}
/** 没有可直接展示记录时才缩成入口；未读记录始终保留完整会话卡片区域。 */
export function desktopAssistantNotificationHeight(frame: DesktopAssistantPresentation, expanded = false, error = false): number {
  if (!desktopAssistantHasNotifications(frame)) return 0
  const snapshot = frame.notificationSnapshot
  const directNotice = (snapshot?.primary !== null && snapshot?.primary !== undefined) || snapshot?.items.some((item) => !item.read
    || (item.kind === 'question' || item.kind === 'approval') && item.lifecycle === 'active') === true
  if (!snapshot || directNotice || expanded || error || snapshot.capabilities.some((entry) => Boolean(entry.reason)
    && (!entry.completed || !entry.error || !entry.requests || !entry.resolve || !entry.navigation))) return 276
  return 48
}
/** 列表动作也只接受当前安全快照里的 ID；旧单气泡协议继续可用。 */
export function desktopAssistantNotice(frame: DesktopAssistantPresentation | undefined, noticeId?: string): DesktopAssistantNotification | undefined {
  if (!frame) return undefined
  const snapshot = frame.notificationSnapshot
  const item = snapshot === undefined ? undefined : noticeId === undefined ? snapshot.primary
    : [snapshot.primary, ...snapshot.items].find((entry) => entry?.noticeId === noticeId)
  if (snapshot) return item ? { ...item, generation: snapshot.generation } : undefined
  return frame.notification && (noticeId === undefined || frame.notification.noticeId === noticeId) ? frame.notification : undefined
}

/** Host 必须来自官方 Desktop 启动入口；仅伪造 Profile 名或浏览器 UA 不构成能力。 */
export function isDesktopAssistantHost(platform: string, electron: string | undefined, nodeMode: string | undefined, entry: string): boolean {
  return (platform === 'darwin' || platform === 'win32') && Boolean(electron) && nodeMode === '1'
    && /(?:^|[/\\])@deepseek-ai[/\\]dsh-desktop-host[/\\](?:lib|dist)[/\\]index\.js$/u.test(entry)
}

/** Desktop 与 Web 的位置是不同坐标系，不能复用页面 localStorage 中的位置。 */
export interface DesktopAssistantBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface DesktopAssistantLayout {
  readonly bounds: DesktopAssistantBounds
  readonly avatar: DesktopAssistantBounds
  readonly notification?: DesktopAssistantBounds
  readonly caption?: DesktopAssistantBounds
}

/** 原生消息也要逐字段校验；缺少必需区域或越界不能覆盖上一份可用布局。 */
export function readDesktopAssistantLayout(value: unknown): DesktopAssistantLayout | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const bounds = readDesktopAssistantRectangle(record.bounds), avatar = readDesktopAssistantRectangle(record.avatar)
  const notification = readDesktopAssistantRectangle(record.notification), caption = readDesktopAssistantRectangle(record.caption)
  if (!bounds || !avatar || (record.notification !== undefined && !notification) || (record.caption !== undefined && !caption)) return undefined
  // bounds 是屏幕坐标，可为负；其他区域是窗口内坐标，必须完全包含在窗口中。
  const inside = (region: DesktopAssistantBounds): boolean => region.x >= 0 && region.y >= 0
    && region.x + region.width <= bounds.width + 0.01 && region.y + region.height <= bounds.height + 0.01
  if (![avatar, notification, caption].every((region) => region === undefined || inside(region))) return undefined
  return { bounds, avatar, ...(notification === undefined ? {} : { notification }), ...(caption === undefined ? {} : { caption }) }
}
function readDesktopAssistantRectangle(value: unknown): DesktopAssistantBounds | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!['x', 'y', 'width', 'height'].every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]))) return undefined
  const { x, y, width, height } = record as unknown as DesktopAssistantBounds
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return undefined
  return { x, y, width, height }
}

/** 输入统一为逻辑像素的左上坐标，原生平台只在边界处换算，形象锚点不随展开变化。 */
export function desktopAssistantLayout(anchor: { readonly x: number; readonly y: number }, size: number,
  notification: boolean | number, caption: boolean, areas: readonly DesktopAssistantBounds[]): DesktopAssistantLayout {
  // 保留旧布尔调用；新协议显式给出收起或展开高度，平台脚本共用同一计算。
  const noticeLimit = typeof notification === 'number' ? Math.max(0, Math.min(276, notification)) : notification ? 276 : 0
  const area = areas.find((entry) => anchor.x >= entry.x && anchor.x < entry.x + entry.width && anchor.y >= entry.y && anchor.y < entry.y + entry.height)
    ?? areas[0] ?? { x: 0, y: 0, width: 1024, height: 768 }
  const width = Math.min(Math.max(72, Math.min(320, size)), area.width)
  const avatarHeight = Math.min(Math.ceil(width * 208 / 192), area.height)
  const x = Math.max(area.x, Math.min(anchor.x, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(anchor.y, area.y + area.height - avatarHeight))
  const availableTop = Math.max(0, y - area.y), availableBottom = Math.max(0, area.y + area.height - y - avatarHeight)
  const noticeAbove = availableTop >= availableBottom
  const captionAbove = notification ? !noticeAbove : noticeAbove
  // 小屏优先保留形象，再按上下空间缩小通知和字幕；正文由共用组件独立滚动。
  let noticeHeight = notification ? Math.min(noticeLimit, Math.max(0, (noticeAbove ? availableTop : availableBottom) - 4)) : 0
  let captionHeight = caption ? Math.min(128, Math.max(0, (captionAbove ? availableTop : availableBottom) - 4)) : 0
  // 贴近边缘时把字幕和通知分区堆在宽裕的一侧，不能留一个只有几像素高的字幕区。
  const stacked = notification && caption && captionHeight < 40 && Math.max(availableTop, availableBottom) >= 88
  if (stacked) {
    const space = noticeAbove ? availableTop : availableBottom
    captionHeight = Math.min(128, Math.max(40, Math.floor((space - 8) / 3)))
    noticeHeight = Math.min(noticeLimit, space - captionHeight - 8)
  }
  const combinedHeight = noticeHeight + captionHeight + 4
  const topHeight = stacked ? noticeAbove ? combinedHeight : 0 : (noticeAbove ? noticeHeight : 0) + (captionAbove ? captionHeight : 0)
  const bottomHeight = stacked ? noticeAbove ? 0 : combinedHeight : (noticeAbove ? 0 : noticeHeight) + (captionAbove ? 0 : captionHeight)
  const bubbleWidth = notification || caption ? Math.min(!caption && noticeLimit <= 48 ? Math.max(width, 220) : 320, area.width) : width
  const left = Math.max(area.x, Math.min(x, area.x + area.width - bubbleWidth))
  const top = y - (topHeight > 0 ? topHeight + 4 : 0)
  const bounds = { x: left, y: top, width: bubbleWidth, height: avatarHeight + (topHeight > 0 ? topHeight + 4 : 0) + (bottomHeight > 0 ? bottomHeight + 4 : 0) }
  const avatar = { x: x - left, y: y - top, width, height: avatarHeight }
  const region = (height: number, above: boolean) => ({ x: 0, y: above ? 0 : avatar.y + avatar.height + 4, width: bubbleWidth, height })
  const noticeRegion = region(noticeHeight, noticeAbove), captionRegion = region(captionHeight, captionAbove)
  if (stacked) {
    captionRegion.y = noticeAbove ? noticeHeight + 4 : avatar.y + avatar.height + 4
    if (!noticeAbove) noticeRegion.y = captionRegion.y + captionHeight + 4
  }
  return { bounds, avatar, ...(notification && noticeHeight > 0 ? { notification: noticeRegion } : {}),
    ...(caption && captionHeight > 0 ? { caption: captionRegion } : {}) }
}
export function clampDesktopAssistantBounds(bounds: DesktopAssistantBounds, areas: readonly DesktopAssistantBounds[]): DesktopAssistantBounds {
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1024, height: 768 }
  const area = areas.find((screen) => bounds.x < screen.x + screen.width && bounds.x + bounds.width > screen.x
    && bounds.y < screen.y + screen.height && bounds.y + bounds.height > screen.y) ?? fallback
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height)
  return { x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height }
}
