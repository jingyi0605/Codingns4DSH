import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { getNativeSubagents } from './native-subagent-holder.js'
import { EXTERNAL_SUBAGENT_IDS } from './native-team-subagent.js'
import { dispatchNativeSubagent, NATIVE_SUBAGENT_TIMEOUT_MS, type NativeParentAgent } from './native-subagent-dispatch.js'

export function createAgentSubagentTool(options: { readonly nativeSessions?: CodingNsNativeSessionBridge | undefined } = {}): Record<string, unknown> {
  return {
    name: 'agent_subagent',
    description: '把一个自包含的子任务派发给外部编码 Agent；可等待首轮结果，也可后台启动。',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...EXTERNAL_SUBAGENT_IDS] },
        prompt: { type: 'string', description: '完整、自包含的子任务说明。' },
        model: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
      required: ['agent', 'prompt'],
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
      if (!EXTERNAL_SUBAGENT_IDS.includes(adapterId as typeof EXTERNAL_SUBAGENT_IDS[number]) || prompt === '') throw new Error('agent 与 prompt 均不能为空且必须使用受支持的外部 Agent')
      const native = getNativeSubagents()
      const parentAgent = exec.agent
      const parentId = parentAgent?.session?.header?.id ?? parentAgent?.id
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
        return { agent: result.adapterId, childSessionId: result.childSessionId, providerSessionId: result.childSessionId, ok: true, background: true, result: result.text }
      }
      return { agent: result.adapterId, childSessionId: result.childSessionId, providerSessionId: result.childSessionId, ok: result.ok, result: result.text || '(子代理没有文本输出)', toolCalls: result.toolCalls }
    },
  }
}
