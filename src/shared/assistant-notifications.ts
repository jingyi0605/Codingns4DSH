/** 通知与语音动作分离；伴随页只能获得下列安全展示字段。 */
export type AssistantNotificationKind = 'completed' | 'error' | 'question' | 'approval'
export type AssistantNotificationAction = 'presented' | 'read' | 'dismiss'
export interface AssistantNotificationSettings {
  enabled: boolean
  completed: boolean
  error: boolean
  question: boolean
  approval: boolean
}
export const DEFAULT_ASSISTANT_NOTIFICATION_SETTINGS: AssistantNotificationSettings = {
  enabled: true, completed: true, error: true, question: true, approval: true,
}
/** 旧配置回填五个开关，非法值不关闭用户原有通知。 */
export function normalizeAssistantNotificationSettings(value: unknown): AssistantNotificationSettings {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return Object.fromEntries(Object.entries(DEFAULT_ASSISTANT_NOTIFICATION_SETTINGS).map(([key, fallback]) => [key, typeof record[key] === 'boolean' ? record[key] : fallback])) as unknown as AssistantNotificationSettings
}
/** 完整目标只通过主页面的认证查询返回，不放进通知快照。 */
export interface AssistantNotificationTarget {
  /** 认证接口提供的入口 Host，避免客户端把当前选中的远端当成本机。 */
  readonly localHostId?: string
  readonly hostId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly connectionGeneration?: number
  readonly requestId?: string
  readonly requestKind?: 'question' | 'approval'
  readonly actualRequestTarget?: { readonly hostId: string; readonly sessionId: string; readonly requestId: string }
}
export interface AssistantNotification {
  readonly noticeId: string
  readonly kind: AssistantNotificationKind
  readonly hostLabel: string
  readonly workspaceLabel: string
  readonly sessionTitle: string
  readonly text: string
  readonly createdAt: number
  readonly presentedAt?: number
  readonly deadline?: number
  readonly errorExcerpt?: string
  readonly read: boolean
  readonly presentation: 'queued' | 'shown' | 'collapsed'
  readonly lifecycle: 'active' | 'resolved' | 'invalidated'
  readonly availability: 'ready' | 'disconnected' | 'expired'
  readonly connectionGeneration?: number
}
export interface AssistantNotificationCapabilities {
  readonly hostId: string
  readonly completed: boolean
  readonly error: boolean
  readonly requests: boolean
  readonly resolve: boolean
  readonly navigation: boolean
  readonly recovery: boolean
  readonly reason?: string
}
export interface AssistantNotificationSnapshot {
  readonly generation: number
  readonly revision: number
  readonly serverNow: number
  readonly primary: AssistantNotification | null
  readonly items: readonly AssistantNotification[]
  readonly unreadCount: number
  readonly pendingCount: number
  readonly cursor: string | null
  readonly capabilities: readonly AssistantNotificationCapabilities[]
  readonly unchanged?: boolean
  readonly reset?: boolean
}
export interface AssistantNotificationReadRequest { readonly revision?: number; readonly cursor?: string; readonly limit?: number }
export interface AssistantNotificationAckRequest {
  readonly noticeId: string
  readonly generation: number
  readonly action: AssistantNotificationAction
  /** 展示确认携带所见类型，阻止完成帧的迟到确认替升级后的错误启动计时。 */
  readonly kind?: AssistantNotificationKind
  /** 新客户端保留点击帧的连接代次；旧确认载荷可继续省略。 */
  readonly connectionGeneration?: number
}
export interface AssistantNotificationTargetRequest { readonly noticeId: string; readonly generation: number; readonly connectionGeneration?: number }
export interface AssistantNotificationAckResult { readonly generation: number; readonly revision: number; readonly notification: AssistantNotification }
/** 所有外部文本统一删除控制符并限制长度，不能携带 HTML 或工具参数。 */
export function assistantNotificationText(value: unknown, max = 240, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max) || fallback : fallback
}
