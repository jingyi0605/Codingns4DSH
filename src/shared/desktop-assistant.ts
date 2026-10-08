import { ASSISTANT_AVATAR_STATES, type AssistantAvatarModel, type AssistantAvatarState } from './assistant-avatar.js'

export const DESKTOP_ASSISTANT_CHANNEL = '/codingns-desktop-assistant'
/** 伴随页面只有展示数据，不能携带 DSH 令牌、工作区或会话控制句柄。 */
export interface DesktopAssistantPresentation {
  readonly visible: boolean
  readonly state: AssistantAvatarState
  readonly caption: string
  readonly label: string
}
export interface DesktopAssistantFrame extends DesktopAssistantPresentation {
  readonly model: AssistantAvatarModel
  readonly size: number
}
export interface DesktopAssistantStatus {
  readonly available: boolean
  readonly visible: boolean
  readonly owned: boolean
  /** 是否已有页面持有窗口；可选字段兼容旧 Host 的答复。 */
  readonly attached?: boolean
  readonly openSequence: number
  readonly error?: string | undefined
}

/** 不将渲染器提供的任意对象直接转发到原生进程。 */
export function readDesktopAssistantPresentation(value: unknown): DesktopAssistantPresentation {
  if (!value || typeof value !== 'object') throw new TypeError('悬浮状态无效')
  const record = value as Record<string, unknown>
  if (typeof record.visible !== 'boolean' || !ASSISTANT_AVATAR_STATES.includes(record.state as AssistantAvatarState)
    || typeof record.caption !== 'string' || record.caption.length > 8000
    || typeof record.label !== 'string' || record.label.length > 160) throw new TypeError('悬浮状态无效')
  return { visible: record.visible, state: record.state as AssistantAvatarState, caption: record.caption, label: record.label }
}

/** Host 必须来自官方 Desktop 启动入口；仅伪造 Profile 名或浏览器 UA 不构成能力。 */
export function isDesktopAssistantHost(platform: string, electron: string | undefined, nodeMode: string | undefined, entry: string): boolean {
  return (platform === 'darwin' || platform === 'win32') && Boolean(electron) && nodeMode === '1'
    && /(?:^|[/\\])@deepseek-ai[/\\]dsh-desktop-host[/\\](?:lib|dist)[/\\]index\.js$/u.test(entry)
}

/** Desktop 与 Web 的位置是不同坐标系，不能复用页面 localStorage 中的位置。 */
export interface DesktopAssistantBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export function clampDesktopAssistantBounds(bounds: DesktopAssistantBounds, areas: readonly DesktopAssistantBounds[]): DesktopAssistantBounds {
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1024, height: 768 }
  const area = areas.find((screen) => bounds.x < screen.x + screen.width && bounds.x + bounds.width > screen.x
    && bounds.y < screen.y + screen.height && bounds.y + bounds.height > screen.y) ?? fallback
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height)
  return { x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height }
}
