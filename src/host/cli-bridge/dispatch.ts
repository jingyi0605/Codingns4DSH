import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { dispatchNativeSubagent, type NativeParentAgent } from '../cli-adapters/native-subagent-dispatch.js'
import { getNativeSubagents } from '../cli-adapters/native-subagent-holder.js'
import { enqueueTeamSubagentSelection, EXTERNAL_SUBAGENT_IDS } from '../cli-adapters/native-team-subagent.js'
import { getAdapterRegistry } from '../cli-adapters/registry-holder.js'
import type { SubagentBridgeDispatchRequest, SubagentBridgeDispatchResult } from './bridge-server.js'

/** DSH Agent 注册表的最小结构；测试可注入替身。 */
export interface BridgeAgentRegistry {
  readonly get?: ((id: string) => unknown) | undefined
  readonly list?: (() => readonly unknown[]) | undefined
}

export interface SubagentBridgeDispatchDeps {
  readonly agents?: BridgeAgentRegistry | undefined
  readonly nativeSessions?: CodingNsNativeSessionBridge | undefined
}

/**
 * 把一次外部 CLI 的子代理请求落地为 DSH 原生可续子会话。
 *
 * 适配器缺省取当前会话绑定；显式 agent 参数允许子代理换用其他外部 Agent。
 * 创建阶段使用排队守卫，保证并行批次按顺序创建而不是互相拒绝。
 */
export async function dispatchBridgeSubagent(
  request: SubagentBridgeDispatchRequest,
  deps: SubagentBridgeDispatchDeps,
): Promise<SubagentBridgeDispatchResult> {
  const native = getNativeSubagents()
  if (native?.startContinuable === undefined) {
    return bridgeFailure('DSH 原生 Subagent 能力不可用，当前 Host 未提供可续子会话')
  }
  if (deps.nativeSessions === undefined) {
    return bridgeFailure('DSH 原生会话桥接不可用')
  }
  const parentAgent = findAgentBySession(deps.agents, request.sessionId)
  if (parentAgent === undefined) {
    return bridgeFailure(`找不到会话对应的 DSH Agent: ${request.sessionId}`)
  }
  const parentId = parentAgent.session?.header?.id ?? parentAgent.id ?? request.sessionId
  const adapterId = (request.agent ?? resolveSessionAdapter(request.sessionId) ?? '').trim()
  if (!EXTERNAL_SUBAGENT_IDS.includes(adapterId as typeof EXTERNAL_SUBAGENT_IDS[number])) {
    return bridgeFailure(`不支持的外部 Agent: ${adapterId === '' ? '(未指定)' : adapterId}`)
  }
  const registry = getAdapterRegistry()
  if (registry !== undefined) {
    const adapter = (await registry.catalog()).find((item) => item.id === adapterId)
    if (adapter === undefined || !adapter.installed || !adapter.enabled) {
      return bridgeFailure(`${adapterId} 未安装或未启用`)
    }
  }
  const modelId = request.model?.trim() === '' ? undefined : request.model?.trim()
  try {
    const result = await dispatchNativeSubagent(native, deps.nativeSessions, {
      adapterId,
      prompt: request.prompt,
      parentAgent,
      parentId,
      modelId,
      background: false,
      select: (action) => enqueueTeamSubagentSelection(parentId, adapterId, modelId, action),
    })
    return {
      ok: result.ok,
      completed: result.completed,
      text: result.text,
      childSessionId: result.childSessionId,
      toolCalls: result.toolCalls,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return bridgeFailure(message || '子代理派发失败，且未返回具体错误。')
  }
}

function bridgeFailure(error: string): SubagentBridgeDispatchResult {
  const message = error.trim() || '子代理派发失败，且未返回具体错误。'
  return { ok: false, completed: false, text: message, error: message }
}

function resolveSessionAdapter(sessionId: string): string | undefined {
  try {
    return getAdapterRegistry()?.getSession(sessionId).adapterId
  } catch {
    return undefined
  }
}

function findAgentBySession(agents: BridgeAgentRegistry | undefined, sessionId: string): NativeParentAgent | undefined {
  if (agents === undefined) return undefined
  if (sessionId !== '' && typeof agents.get === 'function') {
    const direct = agents.get(sessionId)
    if (direct !== undefined) return direct as NativeParentAgent
  }
  for (const candidate of agents.list?.() ?? []) {
    const session = readUnknown(candidate, 'session')
    if (readUnknown(session, 'id') === sessionId || readUnknown(candidate, 'id') === sessionId) return candidate as NativeParentAgent
  }
  return undefined
}

function readUnknown(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}
