import type { AssistantNotificationTarget } from '../../shared/assistant-notifications.js'
import { createVirtualSessionId, parseVirtualSessionId, parseVirtualWorkspaceId } from '../../shared/contracts/peer-host.js'
import type { CodingNsClientServices } from '../../client/features/types.js'

interface SessionNavigation { openSession(sessionId: string): unknown }

/** 只探测 DSH 公开的 UI 导航能力；不操作草稿、消息、问题答案或审批。 */
export function supportsAssistantSessionNavigation(context: unknown): boolean {
  return navigation(context) !== undefined
}

/** Host 负责目标与连接代次校验，本适配器只把可信目标交给原生导航。 */
export async function openAssistantNotificationSession(services: Pick<CodingNsClientServices, 'uiContext' | 'hostRouter'>,
  target: AssistantNotificationTarget, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const ui = navigation(services.uiContext)
  if (ui === undefined) throw new Error('当前 DSH 不支持会话导航')
  if (!target.hostId || !target.workspaceId || !target.sessionId) throw new Error('提醒导航目标无效')
  // 入口 Host 与目标 Host 是两种身份。认证目标提供真实入口，旧数据沿用当前路由。
  const localHostId = target.localHostId
    ?? services.hostRouter.getCurrent()?.hostId ?? 'local'
  const remote = target.hostId !== localHostId && target.hostId !== 'local'
  const workspace = parseVirtualWorkspaceId(target.workspaceId)
  const session = parseVirtualSessionId(target.sessionId)
  const matchesHost = (hostId: string): boolean => remote ? hostId === target.hostId : hostId === localHostId || hostId === 'local'
  if ((workspace !== null && !matchesHost(workspace.hostId)) || (session !== null && !matchesHost(session.hostId))) {
    throw new Error('提醒的 Host 与虚拟会话身份不一致')
  }
  const workspaceId = workspace?.workspaceId ?? (remote && target.workspaceId.startsWith(`${target.hostId}:`)
    ? target.workspaceId.slice(target.hostId.length + 1) : target.workspaceId)
  const sessionId = session?.sessionId ?? target.sessionId
  // 远端必须使用虚拟 ID，绝不把同名 sessionId 交给本机导航。
  const uiSessionId = remote ? createVirtualSessionId(target.hostId, sessionId) : sessionId
  const scope = await services.hostRouter.switchTo({ hostId: localHostId, targetHostId: remote ? target.hostId : null, workspaceId, sessionId })
  signal?.throwIfAborted()
  services.hostRouter.assertCurrent(scope)
  const result = await ui.openSession(uiSessionId)
  signal?.throwIfAborted()
  if (result === false) throw new Error('DSH 未能打开目标会话')
  services.hostRouter.assertCurrent(scope)
}

function navigation(context: unknown): SessionNavigation | undefined {
  try {
    const service = (context as { get?: (name: string) => unknown } | undefined)?.get?.('uiWorkspace') as SessionNavigation | undefined
    return typeof service?.openSession === 'function' ? service : undefined
  } catch { return undefined }
}
