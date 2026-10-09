import { assistantNotificationText } from './assistant-notifications.js'

/** 远端只传已验证的事件事实，不传完整会话、工具参数或认证材料。 */
export interface AssistantNotificationFact {
  readonly kind: 'completed' | 'error' | 'question' | 'approval' | 'resolved'
  readonly workspaceId: string
  readonly sessionId: string
  readonly logicalId: string
  readonly requestId?: string
  readonly requestKind?: 'question' | 'approval'
  /** 显示父会话时仍保留原生请求实际所属的子会话身份。 */
  readonly actualRequestSessionId?: string
  readonly sessionTitle: string
  readonly workspaceLabel: string
  readonly hostLabel: string
  readonly errorExcerpt?: string
  readonly seq?: number
}

export interface AssistantNotificationFeedCapabilities {
  readonly completed: boolean
  readonly error: boolean
  readonly requests: boolean
  readonly resolve: boolean
  readonly recovery: boolean
}

/** epoch 区分来源进程；revision 是有界日志游标，不是完成时间。 */
export interface AssistantNotificationFeed {
  readonly protocol: 1
  readonly epoch: string
  readonly revision: number
  readonly baseline: boolean
  readonly gap: boolean
  readonly events: readonly AssistantNotificationFact[]
  readonly pending: readonly AssistantNotificationFact[]
  readonly capabilities: AssistantNotificationFeedCapabilities
}

export interface AssistantNotificationFeedRequest {
  readonly workspaceIds: readonly string[]
  readonly epoch?: string
  readonly revision?: number
}

/** 不可信远端响应经过同一个白名单解析，拒绝未知终态和超量正文。 */
export function readAssistantNotificationFact(value: unknown): AssistantNotificationFact | null {
  const item = record(value)
  if (item === null || !['completed', 'error', 'question', 'approval', 'resolved'].includes(String(item.kind))) return null
  const workspaceId = identity(item.workspaceId, 512)
  const sessionId = identity(item.sessionId, 256)
  const logicalId = identity(item.logicalId, 512)
  if (workspaceId === null || sessionId === null || logicalId === null) return null
  const kind = item.kind as AssistantNotificationFact['kind']
  const requestId = identity(item.requestId, 256)
  const requestKind = item.requestKind === 'question' || item.requestKind === 'approval' ? item.requestKind : undefined
  const actualRequestSessionId = identity(item.actualRequestSessionId, 256)
  if ((kind === 'question' || kind === 'approval' || kind === 'resolved') && requestId === null) return null
  if (kind === 'resolved' && requestKind === undefined) return null
  return {
    kind, workspaceId, sessionId, logicalId,
    sessionTitle: assistantNotificationText(item.sessionTitle, 240, '未命名会话'),
    workspaceLabel: assistantNotificationText(item.workspaceLabel, 160, workspaceId),
    hostLabel: assistantNotificationText(item.hostLabel, 160, '远端 Host'),
    ...(requestId === null ? {} : { requestId }),
    ...(requestKind === undefined ? {} : { requestKind }),
    ...(actualRequestSessionId === null ? {} : { actualRequestSessionId }),
    ...(typeof item.errorExcerpt === 'string' ? { errorExcerpt: assistantNotificationText(item.errorExcerpt) } : {}),
    ...(Number.isSafeInteger(item.seq) && Number(item.seq) >= 0 ? { seq: Number(item.seq) } : {}),
  }
}

export function readAssistantNotificationFeed(value: unknown): AssistantNotificationFeed {
  const item = record(value)
  const epoch = identity(item?.epoch, 160)
  if (item?.protocol !== 1 || epoch === null || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0
    || typeof item.baseline !== 'boolean' || typeof item.gap !== 'boolean'
    || !Array.isArray(item.events) || item.events.length > 512 || !Array.isArray(item.pending)) {
    throw Object.assign(new Error('远端通知来源协议无效'), { code: 'UNSUPPORTED_CAPABILITY' })
  }
  const capabilities = record(item.capabilities)
  if (capabilities === null) throw Object.assign(new Error('远端未声明通知来源能力'), { code: 'UNSUPPORTED_CAPABILITY' })
  const parse = (values: readonly unknown[]): AssistantNotificationFact[] => values.map((value) => {
    const fact = readAssistantNotificationFact(value)
    if (fact === null) throw Object.assign(new Error('远端通知事实无效'), { code: 'INVALID_INPUT' })
    return fact
  })
  const pending = parse(item.pending)
  if (pending.some(fact => fact.kind !== 'question' && fact.kind !== 'approval')) throw new Error('远端待办包含非请求事实')
  return {
    protocol: 1, epoch, revision: Number(item.revision), baseline: item.baseline, gap: item.gap,
    events: parse(item.events), pending,
    capabilities: {
      completed: capabilities.completed === true, error: capabilities.error === true,
      requests: capabilities.requests === true, resolve: capabilities.resolve === true, recovery: capabilities.recovery === true,
    },
  }
}

export function readAssistantNotificationFeedRequest(value: unknown): AssistantNotificationFeedRequest {
  const item = record(value)
  if (item === null || !Array.isArray(item.workspaceIds) || item.workspaceIds.length > 128) throw new TypeError('通知来源需要有界工作区范围')
  const workspaceIds = item.workspaceIds.map(value => {
    const id = identity(value, 512)
    if (id === null) throw new TypeError('通知来源工作区 ID 无效')
    return id
  })
  if (item.revision !== undefined && (!Number.isSafeInteger(item.revision) || Number(item.revision) < 0)) throw new TypeError('通知来源 revision 无效')
  const epoch = item.epoch === undefined ? undefined : identity(item.epoch, 160)
  if (epoch === null) throw new TypeError('通知来源 epoch 无效')
  return {
    workspaceIds: [...new Set(workspaceIds)],
    ...(epoch === undefined ? {} : { epoch }),
    ...(item.revision === undefined ? {} : { revision: Number(item.revision) }),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function identity(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null
}
