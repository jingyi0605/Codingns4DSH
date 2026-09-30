import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { getNativeSubagents } from './native-subagent-holder.js'
import { EXTERNAL_SUBAGENT_IDS, externalTeamProvider, withTeamSubagentSelection, type NativeSubagentService } from './native-team-subagent.js'

const SUBAGENT_TIMEOUT_MS = 15 * 60_000

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
    timeoutMs: SUBAGENT_TIMEOUT_MS,
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
      return runNativeSubagent(native, options.nativeSessions, {
        adapterId, prompt, parentAgent, parentId,
        modelId: typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined,
        background: args.run_in_background === true,
        signal: exec.signal,
      })
    },
  }
}

/** DSH Agent 的最小结构：startContinuable 会读 options 与 session.header。 */
interface NativeParentAgent {
  readonly id?: string
  readonly options?: { readonly subagentDepth?: number }
  readonly session?: { readonly header?: { readonly id?: string } }
}

interface NativeSubagentRequest {
  readonly adapterId: string
  readonly prompt: string
  readonly parentAgent: NativeParentAgent
  readonly parentId: string
  readonly modelId?: string | undefined
  readonly background: boolean
  readonly signal?: AbortSignal | undefined
}

async function runNativeSubagent(service: NativeSubagentService, sessions: CodingNsNativeSessionBridge, request: NativeSubagentRequest): Promise<Record<string, unknown>> {
  const started = await withTeamSubagentSelection(request.parentId, request.adapterId, request.modelId, () => service.startContinuable!({
    provider: externalTeamProvider(request.adapterId),
    label: request.prompt.replace(/\s+/gu, ' ').slice(0, 120),
    request: { prompt: [{ type: 'text', text: request.prompt }], parent: request.parentAgent },
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }))
  if (request.background) return { agent: request.adapterId, childSessionId: started.childId, providerSessionId: started.childId, ok: true, background: true, result: '子代理已在原生子智能体会话中启动。' }
  const result = await waitForChildFirstTurn(sessions, started.childId, request.signal)
  return { agent: request.adapterId, childSessionId: started.childId, providerSessionId: started.childId, ok: result.ok, result: result.text || '(子代理没有文本输出)', toolCalls: result.toolCalls }
}

interface ChildResult { readonly ok: boolean; readonly text: string; readonly toolCalls: number }

function waitForChildFirstTurn(sessions: CodingNsNativeSessionBridge, childId: string, signal: AbortSignal | undefined): Promise<ChildResult> {
  return new Promise((resolve) => {
    let text = ''
    let toolCalls = 0
    let done = false
    const seen = new Set<string>()
    let finishTimer: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let detach: (() => void) | undefined
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      if (finishTimer !== undefined) clearTimeout(finishTimer)
      if (timeout !== undefined) clearTimeout(timeout)
      detach?.()
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok, text, toolCalls })
    }
    const onAbort = (): void => finish(false)
    const processEvent = (event: unknown): void => {
      const row = asRecord(event)
      if (row === undefined) return
      const key = typeof row.seq === 'number' || typeof row.eventSeq === 'number' ? String(row.seq ?? row.eventSeq) : JSON.stringify(row)
      if (seen.has(key)) return
      seen.add(key)
      // DSH 的 SessionEvent 是 `{ type, seq, time, data }`：判别字段在顶层，data 只承载
      // 该类型自己的载荷。读 `data.type` 会永远匹配不到，同步等待只能等满超时。
      const type = typeof row.type === 'string' ? row.type : ''
      const data = asRecord(row.data) ?? row
      if (type === 'assistant/message') {
        const message = asRecord(data.message)
        const content = Array.isArray(message?.content) ? message.content : []
        for (const block of content) if (asRecord(block)?.type === 'text' && typeof asRecord(block)?.text === 'string') text = asRecord(block)!.text as string
      } else if (type === 'tool/result') toolCalls += 1
      else if (type === 'turn/end') finishTimer = setTimeout(() => finish(!signal?.aborted && readTurnOk(data)), 50)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    detach = sessions.subscribe({ onEvent(session, event) {
      if (asRecord(asRecord(session)?.header)?.id === childId) processEvent(event)
    } })
    const snapshot = sessions.get(childId) as { snapshotEvents?: () => readonly unknown[] } | undefined
    for (const event of snapshot?.snapshotEvents?.() ?? []) processEvent(event)
    timeout = setTimeout(() => finish(false), SUBAGENT_TIMEOUT_MS)
    timeout.unref?.()
  })
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function readTurnOk(value: Record<string, any>): boolean {
  const reason = asRecord(value.reason)
  return reason?.kind === undefined || reason.kind === 'completed' || reason.kind === 'stop'
}
