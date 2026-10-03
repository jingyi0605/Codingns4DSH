import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { getNativeSubagents } from './native-subagent-holder.js'
import { EXTERNAL_SUBAGENT_IDS } from './native-team-subagent.js'
import { dispatchNativeSubagent, NATIVE_SUBAGENT_TIMEOUT_MS, readNativeSubagentLifecycle, waitNativeSubagentLifecycle, type NativeParentAgent } from './native-subagent-dispatch.js'
import { isDelegationTargetAllowed } from './delegation-authorization.js'

export function createAgentSubagentTool(options: { readonly nativeSessions?: CodingNsNativeSessionBridge | undefined } = {}): Record<string, unknown> {
  return {
    name: 'agent_subagent',
    description: '规划并执行外部 Agent 子任务。action=start 创建子会话；action=wait 等待指定 child session 终态；action=read 读取当前状态和结果。依赖步骤必须先 wait/read 前置会话。',
    parameters: {
      type: 'object',
      properties: {
      agent: { type: 'string', enum: [...EXTERNAL_SUBAGENT_IDS] },
      prompt: { type: 'string', description: '完整、自包含的子任务说明。' },
      model: { type: 'string' },
      run_in_background: { type: 'boolean' },
      action: { type: 'string', enum: ['start', 'wait', 'read'] },
      child_session_id: { type: 'string' },
      timeout_ms: { type: 'number' },
      depends_on: { type: 'array', items: { type: 'string' } },
    },
      required: [],
      additionalProperties: false,
    },
    // dsh-tools 的 `tools.register` 强制要求 `output.render` 是函数；把 render 放在
    // 顶层会被注册校验拒绝，并被 Host 的 catch 吞成一条 debugWarn，模型侧表现为
    // “工具不存在”。契约以 output 对象为准。
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, result: unknown) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    timeoutMs: NATIVE_SUBAGENT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal; agent?: NativeParentAgent }) {
      const adapterId = typeof args.agent === 'string' ? args.agent.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      const native = getNativeSubagents()
      const parentAgent = exec.agent
      const parentId = parentAgent?.session?.header?.id ?? parentAgent?.id
      const action = args.action === 'wait' || args.action === 'read' ? args.action : 'start'
      const childSessionId = typeof args.child_session_id === 'string' ? args.child_session_id.trim() : ''
      if (parentId === undefined) throw new Error('DSH 原生 Subagent 缺少父会话身份')
      if (action === 'read') {
        const lifecycle = readNativeSubagentLifecycle(childSessionId)
        if (lifecycle === undefined || lifecycle.parentSessionId !== parentId) {
          return { ok: false, status: 'failed', error: `DELEGATE_CHILD_NOT_FOUND: 找不到父会话下的子会话：${childSessionId}` }
        }
        return { ok: true, ...lifecycle }
      }
      if (action === 'wait') {
        const lifecycle = await waitNativeSubagentLifecycle(childSessionId, typeof args.timeout_ms === 'number' ? args.timeout_ms : NATIVE_SUBAGENT_TIMEOUT_MS)
        if (lifecycle === undefined || lifecycle.parentSessionId !== parentId) {
          return { ok: false, status: 'failed', error: `DELEGATE_CHILD_NOT_FOUND: 找不到父会话下的子会话：${childSessionId}` }
        }
        return { ok: lifecycle.status === 'completed', ...lifecycle }
      }
      if (!EXTERNAL_SUBAGENT_IDS.includes(adapterId as typeof EXTERNAL_SUBAGENT_IDS[number]) || prompt === '') throw new Error('agent 与 prompt 均不能为空且必须使用受支持的外部 Agent')
      if (!isDelegationTargetAllowed(parentId, adapterId)) {
        throw new Error(`DELEGATE_TARGET_NOT_ALLOWED: 当前对话未授权使用 ${adapterId}`)
      }
      const dependsOn = Array.isArray(args.depends_on)
        ? args.depends_on.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
        : []
      const dependencyStates = dependsOn.map((id) => readNativeSubagentLifecycle(id))
      const blocked = dependencyStates.some((state) => state === undefined || state.parentSessionId !== parentId || state.status !== 'completed')
      if (blocked) {
        return {
          ok: false,
          status: 'failed',
          error: 'DELEGATE_DEPENDENCY_NOT_READY: 前置子会话尚未 completed，请先调用 action=wait 或 action=read。',
          dependencies: dependencyStates,
        }
      }
      // startContinuable 会把 parent 当真实 Agent 使用（读 agent.options.subagentDepth、
      // agent.session.header），因此必须传 exec.agent 本身；传 `{ id }` 占位对象会在
      // resolveChildDepth 抛 TypeError。这里同时要求能解析出父会话 id，供选择键去重。
      if (native?.startContinuable === undefined || parentAgent === undefined || parentId === undefined || options.nativeSessions === undefined) throw new Error('DSH 原生 Subagent 能力不可用，当前 Host 未提供可续子会话')
      const result = await dispatchNativeSubagent(native, options.nativeSessions, {
        adapterId,
        prompt,
        parentAgent,
        parentId,
        modelId: typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined,
        background: args.run_in_background === true,
        signal: exec.signal,
      })
      if (result.background) {
        return { agent: result.adapterId, childSessionId: result.childSessionId, providerSessionId: result.childSessionId, ok: true, completed: false, status: result.status, background: true, result: result.text }
      }
      return {
        agent: result.adapterId,
        childSessionId: result.childSessionId,
        providerSessionId: result.childSessionId,
        ok: result.ok,
        completed: result.completed,
        status: result.status,
        result: result.text,
        toolCalls: result.toolCalls,
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    },
  }
}
