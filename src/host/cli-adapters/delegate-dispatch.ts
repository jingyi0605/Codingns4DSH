import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { dispatchNativeSubagent, type NativeParentAgent } from './native-subagent-dispatch.js'
import { getNativeSubagents } from './native-subagent-holder.js'
import { enqueueTeamSubagentSelection, EXTERNAL_SUBAGENT_IDS } from './native-team-subagent.js'
import { getAdapterRegistry } from './registry-holder.js'

/** DSH Agent 注册表的最小结构；Host 侧由 `agents` 服务满足，测试可注入替身。 */
export interface DelegateAgentRegistry {
  readonly get?: ((id: string) => unknown) | undefined
  readonly list?: (() => readonly unknown[]) | undefined
}

export interface DelegateDispatchDeps {
  readonly agents?: DelegateAgentRegistry | undefined
  readonly nativeSessions?: CodingNsNativeSessionBridge | undefined
}

/** 一次委派请求：任务提示词 + 目标外部适配器。prompt 为空时回退到会话最近一条人类消息。 */
export interface DelegateDispatchRequest {
  readonly sessionId: string
  readonly adapterId: string
  readonly prompt: string
  readonly modelId?: string | undefined
}

export interface DelegateDispatchResult {
  readonly ok: boolean
  readonly adapterId: string
  readonly childSessionId?: string | undefined
  readonly error?: string | undefined
}

/** 委派能力的结构化诊断；Client 在弹出适配器列表前用它决定菜单可用性。 */
export interface DelegateCapability {
  readonly supported: boolean
  readonly code: 'CODINGNS_DELEGATE_READY' | 'CODINGNS_DELEGATE_UNAVAILABLE'
  readonly message: string
}

/**
 * `/委派` 的 Host 侧能力探测。
 *
 * 委派依赖 DSH 原生可续子代理（`subagents.startContinuable`）与原生会话桥接；
 * 两者任一缺失都必须给出可读诊断，而不是让 Client 弹出空列表。
 */
export function delegateCapability(deps: DelegateDispatchDeps): DelegateCapability {
  const native = getNativeSubagents()
  if (native?.startContinuable === undefined) {
    return {
      supported: false,
      code: 'CODINGNS_DELEGATE_UNAVAILABLE',
      message: '当前 DSH 未提供可续子代理能力，无法委派外部 Agent 子会话。',
    }
  }
  if (deps.nativeSessions === undefined || deps.nativeSessions.available !== true) {
    return {
      supported: false,
      code: 'CODINGNS_DELEGATE_UNAVAILABLE',
      message: '当前 DSH 原生会话桥接不可用，无法委派外部 Agent 子会话。',
    }
  }
  return {
    supported: true,
    code: 'CODINGNS_DELEGATE_READY',
    message: '可以把任务委派给外部 Agent 的原生子智能体会话。',
  }
}

/**
 * 把一个任务异步委派给所选外部 Agent，落地为 DSH 原生可续子会话。
 *
 * 语义与 `agent_subagent` 的后台模式一致：立刻返回 childSessionId，不阻塞父会话。
 * 同一个父会话可以对多个不同适配器并行委派（并发键按适配器区分），
 * 同一适配器的重复委派按队列串行创建，避免 startContinuable 的单飞守卫直接拒绝。
 */
export async function dispatchDelegateSubagent(
  request: DelegateDispatchRequest,
  deps: DelegateDispatchDeps,
): Promise<DelegateDispatchResult> {
  const adapterId = request.adapterId.trim()
  if (!EXTERNAL_SUBAGENT_IDS.includes(adapterId as typeof EXTERNAL_SUBAGENT_IDS[number])) {
    return { ok: false, adapterId, error: `不支持的外部 Agent: ${adapterId === '' ? '(未指定)' : adapterId}` }
  }
  const capability = delegateCapability(deps)
  if (!capability.supported) return { ok: false, adapterId, error: capability.message }
  const native = getNativeSubagents()
  const sessions = deps.nativeSessions
  if (native?.startContinuable === undefined || sessions === undefined) {
    return { ok: false, adapterId, error: capability.message }
  }
  // 菜单路径下 popupSelect 会接管焦点，草稿里往往只剩 `/委派` 本身；此时沿用会话
  // 最近一条人类消息作为任务，让「先跟主 Agent 说需求、再连续委派给多个外部 Agent」
  // 成为可用流程。显式写在 `/委派` 后面的文字始终优先。
  const prompt = request.prompt.trim() === ''
    ? readLatestUserPrompt(sessions, request.sessionId)
    : request.prompt.trim()
  if (prompt === '') {
    return { ok: false, adapterId, error: '委派任务描述不能为空：请在 /委派 后写明任务，或先向当前会话发一条需求。' }
  }
  const parentAgent = findAgentBySession(deps.agents, request.sessionId)
  if (parentAgent === undefined) {
    return { ok: false, adapterId, error: `找不到会话对应的 DSH Agent: ${request.sessionId}` }
  }
  const parentId = parentAgent.session?.header?.id ?? parentAgent.id ?? request.sessionId
  const adapter = (await getAdapterRegistry()?.catalog())?.find((item) => item.id === adapterId)
  if (adapter === undefined || !adapter.installed || !adapter.enabled) {
    return { ok: false, adapterId, error: `${adapterId} 未安装或未启用` }
  }
  const modelId = request.modelId?.trim() === '' ? undefined : request.modelId?.trim()
  try {
    const result = await dispatchNativeSubagent(native, sessions, {
      adapterId,
      prompt,
      parentAgent,
      parentId,
      modelId,
      background: true,
      // 委派是异步的：父会话不等首轮结果，但创建阶段仍必须串行化。
      select: (action) => enqueueTeamSubagentSelection(parentId, adapterId, modelId, action),
    })
    return { ok: result.ok, adapterId, childSessionId: result.childSessionId }
  } catch (error) {
    return { ok: false, adapterId, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 从会话事件流里取最近一条真实用户消息的文本。
 *
 * 只接受 `user/message`，并跳过插件注入的上下文（compaction 检查点、step 继续提示）
 * 与没有 source 的旧事件：这些不是用户需求，拿它们当任务会把无关内容发给外部 Agent。
 */
function readLatestUserPrompt(sessions: CodingNsNativeSessionBridge, sessionId: string): string {
  const session = sessions.get(sessionId) as { snapshotEvents?: () => readonly unknown[] } | undefined
  const events = session?.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = asRecord(events[index])
    if (row?.type !== 'user/message') continue
    const data = asRecord(row.data)
    if (data === undefined) continue
    if (!isHumanSource(data.source)) continue
    const text = readContentText(data.content)
    if (text !== '') return text
  }
  return ''
}

/** 插件注入的 user/message 带 plugin/compact-checkpoint 等来源，必须排除。 */
function isHumanSource(source: unknown): boolean {
  const row = asRecord(source)
  if (row === undefined) return false
  const kind = row.kind
  return kind === undefined || kind === 'user'
}

function readContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const row = asRecord(part)
      return row?.type === 'text' && typeof row.text === 'string' ? row.text : ''
    })
    .filter((text) => text !== '')
    .join('\n')
    .trim()
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}

/** 依次尝试 `agents.get(id)` 与注册表遍历；两者都失败才算找不到父 Agent。 */
function findAgentBySession(agents: DelegateAgentRegistry | undefined, sessionId: string): NativeParentAgent | undefined {
  if (agents === undefined) return undefined
  if (sessionId !== '' && typeof agents.get === 'function') {
    const direct = agents.get(sessionId)
    if (direct !== undefined) return direct as NativeParentAgent
  }
  for (const candidate of agents.list?.() ?? []) {
    const session = readUnknown(candidate, 'session')
    if (readUnknown(session, 'id') === sessionId || readUnknown(candidate, 'id') === sessionId) {
      return candidate as NativeParentAgent
    }
  }
  return undefined
}

function readUnknown(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}
