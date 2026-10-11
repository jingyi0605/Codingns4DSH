import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { dispatchNativeSubagent, isNativeSubagentSession, nativeSubagentEventCursor, nativeSubagentFailureNeedsReview, nativeSubagentFailureReviewFields, nativeSubagentParentSessionId, readNativeSubagentLifecycle, reviewNativeSubagentFailure, sendNativeSubagentMessage, sendNativeSubagentParentMessage, trackNativeSubagentFollowup, waitNativeSubagentLifecycle, type NativeParentAgent } from '../cli-adapters/native-subagent-dispatch.js'
import { getSingleDelegationTarget, isDelegationTargetAllowed } from '../cli-adapters/delegation-authorization.js'
import { getNativeSubagents } from '../cli-adapters/native-subagent-holder.js'
import { enqueueTeamSubagentSelection, EXTERNAL_SUBAGENT_IDS, hasNativeSubagentStart } from '../cli-adapters/native-team-subagent.js'
import { getAdapterRegistry } from '../cli-adapters/registry-holder.js'
import { getSubagentBridge } from './bridge-holder.js'
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
  if (!hasNativeSubagentStart(native)) {
    return bridgeFailure('DSH 原生 Subagent 能力不可用，当前 Host 未提供可续子会话')
  }
  if (deps.nativeSessions === undefined) {
    return bridgeFailure('DSH 原生会话桥接不可用')
  }
  const parentAgent = findAgentBySession(deps.agents, request.sessionId)
  if (parentAgent === undefined) {
    return bridgeFailure(`找不到会话对应的 DSH Agent: ${request.sessionId}`)
  }
  // 桥接环境已经用 request.sessionId 绑定了调用方身份；不能改用 Agent 对象的
  // 可变 header/id，否则子 Agent 创建期间的对象复用会把主会话误认成子会话。
  const parentId = request.sessionId.trim()
  if (parentId === '') return bridgeFailure('子代理桥接缺少当前会话 ID')
  const action = request.action ?? 'start'
  const ownParentTarget = isNativeSubagentSession(deps.nativeSessions, parentId)
    ? nativeSubagentParentSessionId(deps.nativeSessions, parentId)
    : undefined
  if (action === 'start' && ownParentTarget !== undefined) {
    return bridgeFailure('当前会话禁止嵌套子代理：子会话只能通过 send 回传父会话报告')
  }
  if (action === 'read' || action === 'wait') {
    const childSessionId = request.childSessionId?.trim() ?? ''
    const lifecycle = action === 'read'
      ? readNativeSubagentLifecycle(childSessionId)
      : await waitNativeSubagentLifecycle(childSessionId, request.timeoutMs)
    if (lifecycle === undefined || lifecycle.parentSessionId !== parentId) return bridgeFailure(`DELEGATE_CHILD_NOT_FOUND: 找不到父会话下的子会话：${childSessionId}`)
    const reviewed = reviewNativeSubagentFailure(childSessionId) ?? lifecycle
    return { ok: reviewed.status === 'completed', completed: reviewed.completed, status: reviewed.status, text: reviewed.text ?? '子代理尚未产生文本结果。', childSessionId: reviewed.childSessionId, ...(reviewed.error === undefined ? {} : { error: reviewed.error }), ...nativeSubagentFailureReviewFields(reviewed) }
  }
  if (action === 'send') {
    const requestedTargetId = request.childSessionId?.trim() ?? ''
    const parentTarget = ownParentTarget
    const message = (request.message ?? request.prompt).trim()
    // 外部 CLI 子会话也可以把完整报告回传给自己的父会话。目标缺省时，或
    // 显式传入登记的 parentSessionId 时，走受控的父消息注入，不把父会话当成 child 查找。
    if (parentTarget !== undefined && (requestedTargetId === '' || requestedTargetId === parentTarget)) {
      const sent = sendNativeSubagentParentMessage(deps.nativeSessions, parentId, message)
      return sent.ok
        ? { ok: true, completed: false, status: 'running', text: '子代理报告已回传父会话。', parentSessionId: sent.parentSessionId ?? parentTarget }
        : bridgeFailure(sent.error ?? '父会话报告回传失败。')
    }
    const childSessionId = requestedTargetId
    const lifecycle = readNativeSubagentLifecycle(childSessionId)
    if (lifecycle === undefined || lifecycle.parentSessionId !== parentId) return bridgeFailure(`DELEGATE_CHILD_NOT_FOUND: 找不到父会话下的子会话：${childSessionId}`)
    const reviewed = reviewNativeSubagentFailure(childSessionId) ?? lifecycle
    const cursor = nativeSubagentEventCursor(deps.nativeSessions, childSessionId)
    const sent = await sendNativeSubagentMessage(native, { parentAgent, parentId, childSessionId, message })
    if (!sent.ok) return { ok: false, completed: false, status: 'failed', text: sent.error ?? '子代理消息发送失败。', childSessionId, error: sent.error ?? '子代理消息发送失败。', ...nativeSubagentFailureReviewFields(reviewed) }
    trackNativeSubagentFollowup(deps.nativeSessions, childSessionId, cursor)
    return { ok: true, completed: false, status: 'running', text: '后续消息已发送给子代理。', childSessionId, ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }) }
  }
  const authorizedTarget = getSingleDelegationTarget(request.sessionId)
  const adapterId = (request.agent ?? authorizedTarget?.adapterId ?? resolveSessionAdapter(request.sessionId) ?? '').trim()
  if (!EXTERNAL_SUBAGENT_IDS.includes(adapterId as typeof EXTERNAL_SUBAGENT_IDS[number])) {
    return bridgeFailure(`不支持的外部 Agent: ${adapterId === '' ? '(未指定)' : adapterId}`)
  }
  const registry = getAdapterRegistry()
  if (registry !== undefined) {
    // dsh 是 DSH 自带的内置 Agent，不在外部 CLI Registry 中登记驱动；其子
    // 会话由原生 spawn Provider 负责，不能因为 catalog 没有外部条目而拒绝。
    const adapter = adapterId === 'dsh'
      ? { installed: true, enabled: true }
      : (await registry.catalogForUse([adapterId])).find((item) => item.id === adapterId)
    if (adapter === undefined || !adapter.installed || !adapter.enabled) {
      return bridgeFailure(`${adapterId} 未安装或未启用`)
    }
  }
  if (!isDelegationTargetAllowed(parentId, adapterId)) return bridgeFailure(`DELEGATE_TARGET_NOT_ALLOWED: 当前对话未授权使用 ${adapterId}`)
  const dependencyStates = (request.dependsOn ?? []).map((id) => readNativeSubagentLifecycle(id))
  if (dependencyStates.some((state) => state === undefined || state.parentSessionId !== parentId || state.status !== 'completed')) {
    const failedDependency = dependencyStates.find((state) => state !== undefined && nativeSubagentFailureNeedsReview(state))
    return bridgeFailure(failedDependency === undefined
      ? 'DELEGATE_DEPENDENCY_NOT_READY: 前置子会话尚未 completed，请先 wait/read。'
      : 'DELEGATE_DEPENDENCY_FAILED_REVIEW_REQUIRED: 前置子代理 failed，必须先 read/wait 查看失败状态，再评估重新创建或接管。')
  }
  const modelId = request.model?.trim() === ''
    ? authorizedTarget?.modelId
    : request.model?.trim() ?? authorizedTarget?.modelId
  try {
    const result = await dispatchNativeSubagent(native, deps.nativeSessions, {
      adapterId,
      prompt: request.prompt,
      parentAgent,
      parentId,
      modelId,
      // 外部 CLI 的桥接调用由调用方决定是否后台运行。MCP/Command Code 入口
      // 会显式传 true，避免工具调用被迫等待子会话首轮完成；保留缺省同步语义
      // 兼容 Host 内部直接调用 dispatchBridgeSubagent 的旧消费者。
      background: request.runInBackground === true,
      select: (action) => enqueueTeamSubagentSelection(parentId, adapterId, modelId, action),
    })
    // 成功的转投必须登记重定向：CLI 侧收到的是 `tool_hook_blocked`，驱动只有命中
    // 这条记录才会把它投影成桥接返回的运行/完成态。不登记时成功派发也会显示为失败。
    if (result.ok && request.toolCallId !== undefined && request.toolCallId !== '') {
      try {
        getSubagentBridge()?.recordRedirect(request.sessionId, request.toolCallId, {
          childSessionId: result.childSessionId,
          ok: true,
          completed: result.completed,
          status: result.status,
          toolCalls: result.toolCalls,
        })
      } catch { /* 桥接句柄缺失只影响工具态显示，不能改变派发结果 */ }
    }
    const lifecycle = readNativeSubagentLifecycle(result.childSessionId)
    return {
      ok: result.ok,
      completed: result.completed,
      status: result.status,
      text: result.text,
      childSessionId: result.childSessionId,
      toolCalls: result.toolCalls,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(lifecycle === undefined ? {} : nativeSubagentFailureReviewFields(lifecycle)),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return bridgeFailure(message || '子代理派发失败，且未返回具体错误。')
  }
}

function bridgeFailure(error: string): SubagentBridgeDispatchResult {
  const message = error.trim() || '子代理派发失败，且未返回具体错误。'
  return { ok: false, completed: false, status: 'failed', text: message, error: message }
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
