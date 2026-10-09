import type { CodingNsHostServices } from '../features/types.js'
import type { AssistantNotificationAckRequest, AssistantNotificationReadRequest, AssistantNotificationSnapshot } from '../../shared/assistant-notifications.js'
import { readDesktopAssistantNotification, readDesktopAssistantNotificationSnapshot, type DesktopAssistantNoticeEvent, type DesktopAssistantPresentation } from '../../shared/desktop-assistant.js'
import type { AssistantAvatarReaction } from '../../shared/assistant-avatar.js'

/** 生命周期持有通知中心；原生模块只读取安全快照，并确认真实呈现。 */
export interface DesktopAssistantNotificationSource {
  read(input?: AssistantNotificationReadRequest): AssistantNotificationSnapshot
  presented(input: AssistantNotificationAckRequest): void
}
const sources = new WeakMap<CodingNsHostServices, DesktopAssistantNotificationSource>()
/** Host 全局助理创建中心后登记，清理时只注销自己的实例，避免旧代次清除新中心。 */
export function bindDesktopAssistantNotifications(services: CodingNsHostServices, source: DesktopAssistantNotificationSource): () => void {
  sources.set(services, source)
  return () => { if (sources.get(services) === source) sources.delete(services) }
}
export function getDesktopAssistantNotifications(services: CodingNsHostServices): DesktopAssistantNotificationSource | undefined { return sources.get(services) }
/** 回传前中心可能已经抢占/换代；只确认当前安全快照对应的真实首展。 */
export function confirmDesktopAssistantNotification(services: CodingNsHostServices, event: DesktopAssistantNoticeEvent): void {
  const source = sources.get(services)
  if (!source) return
  const snapshot = source.read(), notice = snapshot.primary
  if (snapshot.generation !== event.noticeGeneration || notice?.noticeId !== event.noticeId
    || (event.noticeKind !== undefined && notice.kind !== event.noticeKind)
    || notice.connectionGeneration !== event.connectionGeneration) throw new Error('通知呈现身份已失效')
  source.presented({ noticeId: event.noticeId, generation: event.noticeGeneration, action: 'presented',
    kind: notice.kind, ...(event.connectionGeneration === undefined ? {} : { connectionGeneration: event.connectionGeneration }) })
}
/** 主页面隐藏时，原生显示直接跟随同一个 Host 中心；不另开会话事件源或认证通道。 */
export function desktopAssistantNotificationPresentation(services: CodingNsHostServices, presentation: DesktopAssistantPresentation, input?: AssistantNotificationReadRequest): DesktopAssistantPresentation {
  const source = sources.get(services)
  if (!source) return presentation
  const snapshot = readDesktopAssistantNotificationSnapshot(source.read(input)), primary = snapshot?.primary
  const { notification: previous, notificationSnapshot: previousSnapshot, reaction: previousReaction, ...base } = presentation
  const safe = snapshot === undefined ? base : { ...base, notificationSnapshot: snapshot }
  if (!primary || !snapshot) return safe
  // DSH 主窗口在前台时，完成提示静默记为已读：不弹气泡，也不保留未读；失败、审批与提问照常呈现。
  if (presentation.appActive === true && primary.kind === 'completed') {
    if (!primary.read) source.presented({ noticeId: primary.noticeId, generation: snapshot.generation, action: 'read' })
    return safe
  }
  const notification = readDesktopAssistantNotification({ ...primary, generation: snapshot.generation })
  if (!notification) return safe
  const reactions: Record<typeof primary.kind, AssistantAvatarReaction> = { completed: 'success', error: 'concerned', question: 'question', approval: 'approval' }
  return { ...safe, notification, reaction: reactions[primary.kind] }
}
