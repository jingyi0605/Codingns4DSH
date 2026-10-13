/**
 * Command Code 托管 mod：把内建 `agent` 工具调用转投给 DSH 原生子代理。
 *
 * 由驱动以 `--mod <path>` 每次运行加载；桥接配置（地址/令牌/会话）从进程环境
 * 读取。Command Code 会话始终注入本 Mod；桥接父、子会话都拿到派发端点，子
 * 会话通过标记禁止继续创建嵌套外部 Agent，但可以使用 send 回传父会话。桥接
 * 不可用时也必须阻断原生 agent，避免静默回退。
 *
 * 桥接已配置但派发失败时**不再静默回退**：过去返回 undefined 会让 CLI 悄悄改用
 * 内建子代理，父会话与界面都看不出「托管失败」，实测中表现为「界面只有 5 个
 * 子代理，但 CLI 侧 10 个任务全部成功」。现在改为 block + 可读失败原因。
 *
 * 该文件被外部 CLI 通过 jiti 直接加载，因此必须自包含：零导入、零依赖。
 */

interface ToolCallHookContext {
  readonly toolCallId?: string
  readonly toolName?: string
  readonly input?: Record<string, unknown>
}

interface ToolCallHookResult {
  readonly block?: boolean
  readonly additionalContext?: string
}

interface ToolModuleLike {
  readonly schema: {
    readonly name: string
    readonly description: string
    readonly input_schema: Record<string, unknown>
  }
  readonly run: (context: { readonly input: unknown }) => Promise<{
    readonly ok: boolean
    readonly content?: readonly { readonly type: 'text'; readonly text: string }[]
    readonly error?: string
  }>
}

interface ModApiLike {
  readonly getActiveTools?: () => readonly string[]
  readonly setActiveTools?: (names: readonly string[]) => void
  readonly addTool?: (tool: ToolModuleLike) => unknown
  readonly hooks: (hooks: {
    readonly onSessionStart?: () => void
    readonly beforeToolCall?: (context: ToolCallHookContext) => Promise<ToolCallHookResult | undefined> | ToolCallHookResult | undefined
  }) => unknown
}

const DISPATCH_TIMEOUT_MS = 16 * 60_000

export default function codingNsSubagentMod(cmd: ModApiLike): void {
  const baseUrl = (process.env.CODINGNS_BRIDGE_URL ?? '').replace(/\/+$/u, '')
  const token = process.env.CODINGNS_BRIDGE_TOKEN ?? ''
  const sessionId = process.env.CODINGNS_DSH_SESSION_ID ?? ''
  const nativeAgentDisabled = process.env.CODINGNS_DISABLE_NATIVE_AGENT === '1'
  const subagentChild = process.env.CODINGNS_SUBAGENT_CHILD === '1'
  const bridgeConfigured = baseUrl !== '' && token !== '' && sessionId !== ''
  // 未注入屏蔽标记且没有桥接配置时才是独立运行的 Command Code；DSH 启动的
  // 会话始终带标记，不能因为桥接暂时不可用而回退到原生 agent。
  if (!nativeAgentDisabled && !bridgeConfigured) return

  // legacy `-p` 模式不会像 ACP 那样从 session/new 接收 mcpServers。直接注册
  // DSH 工具，才能让 Command Code 在启动时就拥有正确的委派入口；仅靠
  // beforeToolCall 拦截原生 agent 会把模型逼回错误工具或让它继续内联。
  cmd.addTool?.({
    schema: {
      name: 'agent_subagent',
       description: 'Asynchronously create external Agent child sessions through the CodingNS DSH bridge and track them with read/wait/send. Child sessions may report through their parent session id and cannot use start to create nested subagents.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A complete, self-contained subtask description.' },
          agent: { type: 'string', description: 'External Agent id; defaults to the current session.' },
          model: { type: 'string', description: 'Optional model override.' },
          description: { type: 'string', description: 'Subtask title.' },
          subagent_type: { type: 'string', description: 'Subagent type hint.' },
          action: { type: 'string', enum: ['start', 'read', 'wait', 'send'] },
          run_in_background: { type: 'boolean' },
          child_session_id: { type: 'string', description: 'Child session id for a parent follow-up; a child may provide its parent session id or omit it when reporting back.' },
          message: { type: 'string' },
          timeout_ms: { type: 'number' },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
        required: [],
        additionalProperties: false,
      },
    },
    run: async ({ input }) => runDshAgentTool(baseUrl, token, sessionId, subagentChild, input),
  })

  const disableNativeSubagentTools = (): void => {
    const getActiveTools = cmd.getActiveTools
    const setActiveTools = cmd.setActiveTools
    if (getActiveTools === undefined || setActiveTools === undefined) return
    // 官方 Mod API 的工具过滤是启动期最可靠的屏蔽面：被移除的工具不会进入
    // 模型 schema，后续即使模型伪造调用也会被核心拒绝。上面注册的
    // agent_subagent 是唯一允许的外部委派入口。
    setActiveTools(getActiveTools().filter((name) => name !== 'agent' && name !== 'agent_output'))
  }
  cmd.hooks({
    // ACP 在 harness 绑定后才拥有完整工具目录，因此必须在 session start
    // 再执行一次；仅在 mod factory 阶段调用会看到空目录，无法真正禁用工具。
    onSessionStart: disableNativeSubagentTools,
    beforeToolCall: async (context) => {
      // 工具过滤是第一道防线；这里仍保留执行期兜底，防止旧版 CLI 或恢复会话
      // 在 schema 缓存中残留 agent。无论如何都不允许回退到本地后台子代理。
      if (context.toolName !== 'agent' && context.toolName !== 'agent_output') return undefined
      if (context.toolName === 'agent_output') return {
        block: true,
        additionalContext: failureText('The native Command Code subagent tool is disabled', 'Use the DSH agent_subagent tool to inspect child sessions.'),
      }
      const input = context.input ?? {}
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.trim() === '') return {
        block: true,
        additionalContext: failureText('The request is missing a subtask prompt', 'The DSH bridge will not fall back to the built-in Command Code subagent.'),
      }
      if (!bridgeConfigured) return {
        block: true,
        additionalContext: failureText(
          subagentChild ? 'Nested subagents are not allowed in this session' : 'The DSH subagent bridge is unavailable',
          subagentChild ? 'This is a DSH child session and cannot create another external Agent.' : 'The bridge has not started or is no longer available; an external Agent cannot be created.',
        ),
      }
      const dispatched = await dispatchToBridge(baseUrl, token, sessionId, context.toolCallId, prompt, input)
      return dispatched.ok === true
        ? { block: true, additionalContext: dispatched.text }
        : { block: true, additionalContext: dispatched.failure }
    },
  })
}

async function runDshAgentTool(
  baseUrl: string,
  token: string,
  sessionId: string,
  subagentChild: boolean,
  rawInput: unknown,
): Promise<{ readonly ok: boolean; readonly content?: readonly { readonly type: 'text'; readonly text: string }[]; readonly error?: string }> {
  const input = asRecord(rawInput)
  const action = input?.action === 'read' || input?.action === 'wait' || input?.action === 'send' ? input.action : 'start'
  const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
  const message = typeof input?.message === 'string' ? input.message : ''
  if (subagentChild && action === 'start') return { ok: false, error: failureText('Nested subagents are not allowed in this session', 'This is a DSH child session and cannot create another external Agent.') }
  if (baseUrl === '' || token === '' || sessionId === '') return { ok: false, error: failureText('The DSH subagent bridge is unavailable', 'The bridge has not started or is no longer available; an external Agent cannot be created.') }
  if (action === 'start' && prompt.trim() === '') return { ok: false, error: 'agent_subagent requires a non-empty prompt for the start action.' }
  if (action === 'send' && prompt.trim() === '' && message.trim() === '') return { ok: false, error: 'agent_subagent requires a message or prompt for the send action.' }
  const dispatched = await dispatchRequest(baseUrl, token, {
    sessionId,
    prompt,
    action,
    ...(message.trim() === '' ? {} : { message }),
    ...(action === 'start' ? { runInBackground: input?.run_in_background !== false } : {}),
    ...(typeof input?.child_session_id === 'string' && input.child_session_id.trim() !== '' ? { childSessionId: input.child_session_id.trim() } : {}),
    ...(Array.isArray(input?.depends_on) ? { dependsOn: input.depends_on.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) } : {}),
    ...(typeof input?.timeout_ms === 'number' && Number.isFinite(input.timeout_ms) ? { timeoutMs: input.timeout_ms } : {}),
    ...(typeof input?.agent === 'string' && input.agent.trim() !== '' ? { agent: input.agent.trim() } : {}),
    ...(typeof input?.model === 'string' && input.model.trim() !== '' ? { model: input.model.trim() } : {}),
    ...(typeof input?.description === 'string' && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
    ...(typeof input?.subagent_type === 'string' && input.subagent_type.trim() !== '' ? { subagentType: input.subagent_type.trim() } : {}),
  })
  return dispatched.ok === true
    ? { ok: true, content: [{ type: 'text', text: dispatched.text }] }
    : { ok: false, error: dispatched.failure }
}

type DispatchOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly failure: string }

interface BridgeRequest {
  readonly sessionId: string
  readonly prompt: string
  readonly action?: 'start' | 'read' | 'wait' | 'send'
  readonly message?: string
  readonly runInBackground?: boolean
  readonly childSessionId?: string
  readonly dependsOn?: readonly string[]
  readonly timeoutMs?: number
  readonly toolCallId?: string
  readonly agent?: string
  readonly model?: string
  readonly description?: string
  readonly subagentType?: string
}

async function dispatchToBridge(
  baseUrl: string,
  token: string,
  sessionId: string,
  toolCallId: string | undefined,
  prompt: string,
  input: Record<string, unknown>,
): Promise<DispatchOutcome> {
  return dispatchRequest(baseUrl, token, {
    sessionId,
    prompt,
    action: 'start',
    runInBackground: true,
    ...(toolCallId === undefined || toolCallId === '' ? {} : { toolCallId }),
    ...(typeof input.description === 'string' && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
    ...(typeof input.subagent_type === 'string' && input.subagent_type.trim() !== '' ? { subagentType: input.subagent_type.trim() } : {}),
    ...(typeof input.agent === 'string' && input.agent.trim() !== '' ? { agent: input.agent.trim() } : {}),
    ...(typeof input.model === 'string' && input.model.trim() !== '' ? { model: input.model.trim() } : {}),
  })
}

async function dispatchRequest(baseUrl: string, token: string, request: BridgeRequest): Promise<DispatchOutcome> {
  try {
    const response = await fetch(`${baseUrl}/v1/dispatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { ok: false, failure: failureText(`The bridge returned HTTP ${String(response.status)}`, await readBridgeError(response)) }
    }
    const payload = await response.json() as {
      readonly ok?: unknown
      readonly status?: unknown
      readonly completed?: unknown
      readonly childSessionId?: unknown
      readonly parentSessionId?: unknown
      readonly text?: unknown
      readonly toolCalls?: unknown
      readonly error?: unknown
    }
    const knownStatus = payload.status === 'creating' || payload.status === 'running' || payload.status === 'completed' || payload.status === 'failed' || payload.status === 'interrupted'
    if (payload.ok !== true && !knownStatus) {
      const detail = typeof payload.error === 'string' && payload.error.trim() !== '' ? payload.error.trim() : ''
      return { ok: false, failure: failureText('The bridge rejected this subagent dispatch', detail) }
    }
    const text = typeof payload.text === 'string' && payload.text.trim() !== '' ? payload.text : '(The subagent produced no text output.)'
    // 把子会话身份带回外部 Agent；否则它只能知道“已启动”，却无法继续
    // 调用 action=read/wait 观察结果。
    return {
      ok: true,
      text: JSON.stringify({
        ok: payload.ok === true,
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
        ...(typeof payload.completed === 'boolean' ? { completed: payload.completed } : {}),
        ...(typeof payload.childSessionId === 'string' ? { childSessionId: payload.childSessionId } : {}),
        ...(typeof payload.parentSessionId === 'string' ? { parentSessionId: payload.parentSessionId } : {}),
        ...(typeof payload.toolCalls === 'number' ? { toolCalls: payload.toolCalls } : {}),
        text,
        ...(typeof payload.error === 'string' && payload.error.trim() !== '' ? { error: payload.error } : {}),
      }),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, failure: failureText('Unable to connect to the DSH subagent bridge', reason) }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readBridgeError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { readonly error?: unknown }
    return typeof payload.error === 'string' ? payload.error.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 失败文本直接作为工具结果交给模型，因此必须写清楚「这不是任务失败，而是托管
 * 派发失败」，否则模型会把基础设施故障当成子任务结论继续推理。
 */
function failureText(summary: string, detail: string): string {
  const lines = [
    `[codingns4dsh] Managed subagent dispatch failed: ${summary}.`,
    detail === '' ? '' : `Reason: ${detail}`,
    'This call did not fall back to the built-in Command Code subagent, and the task has not run. Fix the DSH subagent hosting configuration and retry.',
  ]
  return lines.filter((line) => line !== '').join('\n')
}
