import type { AssistantNotificationSessionTarget, AssistantNotificationTarget } from '../../shared/assistant-notifications.js'
import { createVirtualSessionId, parseVirtualSessionId, parseVirtualWorkspaceId } from '../../shared/contracts/peer-host.js'
import type { CodingNsClientServices } from '../../client/features/types.js'
import { readNativeWorkspaceSnapshot } from '../../client/native-workspace-store.js'

interface SessionNavigation { openSession(sessionId: string): unknown }
export interface AssistantSessionSelectionStore {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** 读取 DSH 的唯一前台会话选择源；没有该能力的旧宿主不猜测当前会话。 */
export function readAssistantSessionSelectionStore(context: unknown): AssistantSessionSelectionStore | undefined {
  try {
    const service = (context as { get?: (name: string) => unknown } | undefined)?.get?.('uiWorkspace')
    const selection = (service as { selection?: unknown } | undefined)?.selection
    if (typeof selection !== 'object' || selection === null) return undefined
    const store = selection as Partial<AssistantSessionSelectionStore>
    return typeof store.getSnapshot === 'function' && typeof store.subscribe === 'function' ? store as AssistantSessionSelectionStore : undefined
  } catch { return undefined }
}

/** 将本地/远端虚拟选择归一化为 Host 可匹配的会话三元组。 */
export function normalizeAssistantSessionSelection(value: unknown, context?: unknown): AssistantNotificationSessionTarget | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const rawSessionId = text(record.sessionId) ?? text(asRecord(record.subagentAddress)?.parentSessionId)
  // DSH 0.2.x 的 uiWorkspace.selection 只持久化 sessionId；工作区归属由
  // workspaces.list 的成员关系提供。旧版本或测试宿主若直接提供 workspaceId，
  // 仍优先使用它，避免为兼容新协议改变已有路径。
  const rawWorkspaceId = text(record.workspaceId)
    ?? text(asRecord(record.workspace)?.workspaceId)
    ?? (rawSessionId === undefined ? undefined : readSessionWorkspaceId(context, rawSessionId))
  if (rawSessionId === undefined || rawWorkspaceId === undefined) return undefined
  const session = parseVirtualSessionId(rawSessionId)
  const workspace = parseVirtualWorkspaceId(rawWorkspaceId)
  if (session !== null && workspace !== null && session.hostId !== workspace.hostId) return undefined
  const hostId = session?.hostId ?? workspace?.targetHostId ?? 'local'
  const workspaceId = workspace?.workspaceId
    ?? (hostId !== 'local' && rawWorkspaceId.startsWith(`${hostId}:`) ? rawWorkspaceId.slice(hostId.length + 1) : rawWorkspaceId)
  const sessionId = session?.sessionId ?? rawSessionId
  return { hostId: hostId === 'local' ? 'local' : hostId, workspaceId, sessionId }
}

/** 从原生 Workspace 列表按成员关系反查当前会话，保留远端虚拟 ID。 */
function readSessionWorkspaceId(context: unknown, sessionId: string): string | undefined {
  try {
    const snapshot = readNativeWorkspaceSnapshot(context as Parameters<typeof readNativeWorkspaceSnapshot>[0])
    const exact = snapshot?.items.find((workspace) => workspace.sessionIds.includes(sessionId))
    if (exact !== undefined) return exact.workspaceId
    const parsed = parseVirtualSessionId(sessionId)
    if (parsed === null) return undefined
    const compatible = snapshot?.items.find((workspace) => workspace.sessionIds.some((candidate) => {
      const value = parseVirtualSessionId(candidate)
      return value?.hostId === parsed.hostId && value.sessionId === parsed.sessionId
    }))
    return compatible?.workspaceId
  } catch {
    return undefined
  }
}

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
