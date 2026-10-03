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

/** 一次委派请求：任务提示词 + 目标外部适配器。空 prompt 始终拒绝，不读取历史消息。 */
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
  /** 委派接口只在首轮收到 turn/end 后才报告完成。 */
  readonly completed?: boolean | undefined
  readonly status: 'failed' | 'running' | 'completed' | 'interrupted'
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
    return { ok: false, adapterId, status: 'failed', error: `不支持的外部 Agent: ${adapterId === '' ? '(未指定)' : adapterId}` }
  }
  const capability = delegateCapability(deps)
  if (!capability.supported) return { ok: false, adapterId, status: 'failed', error: capability.message }
  const native = getNativeSubagents()
  const sessions = deps.nativeSessions
  if (native?.startContinuable === undefined || sessions === undefined) {
    return { ok: false, adapterId, status: 'failed', error: capability.message }
  }
  const prompt = request.prompt.trim()
  if (prompt === '') {
    return { ok: false, adapterId, status: 'failed', error: '委派任务描述不能为空：请在当前对话中写明任务。' }
  }
  const parentAgent = findAgentBySession(deps.agents, request.sessionId)
  if (parentAgent === undefined) {
    return { ok: false, adapterId, status: 'failed', error: `找不到会话对应的 DSH Agent: ${request.sessionId}` }
  }
  const parentId = parentAgent.session?.header?.id ?? parentAgent.id ?? request.sessionId
  const adapter = (await getAdapterRegistry()?.catalog())?.find((item) => item.id === adapterId)
  if (adapter === undefined || !adapter.installed || !adapter.enabled) {
    return { ok: false, adapterId, status: 'failed', error: `${adapterId} 未安装或未启用` }
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
    return { ok: result.ok, adapterId, childSessionId: result.childSessionId, completed: result.completed, status: result.status }
  } catch (error) {
    return { ok: false, adapterId, status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
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
