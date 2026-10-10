/**
 * Command Code 托管 mod：把内建 `agent` 工具调用转投给 DSH 原生子代理。
 *
 * 由驱动以 `--mod <path>` 每次运行加载；桥接配置（地址/令牌/会话）从进程环境
 * 读取。托管关闭时不注入本 Mod；桥接子会话只注入禁用标记，不允许继续创建
 * 嵌套外部 Agent。
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

interface ModApiLike {
  readonly getActiveTools?: () => readonly string[]
  readonly setActiveTools?: (names: readonly string[]) => void
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
  const bridgeConfigured = baseUrl !== '' && token !== '' && sessionId !== ''
  // 普通会话既没有桥接配置，也没有防递归标记：保持 Command Code 原生行为。
  if (!nativeAgentDisabled && !bridgeConfigured) return
  const disableNativeSubagentTools = (): void => {
    const getActiveTools = cmd.getActiveTools
    const setActiveTools = cmd.setActiveTools
    if (getActiveTools === undefined || setActiveTools === undefined) return
    // 官方 Mod API 的工具过滤是启动期最可靠的屏蔽面：被移除的工具不会进入
    // 模型 schema，后续即使模型伪造调用也会被核心拒绝。保留 MCP 的
    // mcp__codingns__agent_subagent，让所有外部委派统一回到 DSH 子会话。
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
        additionalContext: failureText('Command Code 原生子代理工具已禁用', '请使用 DSH 的 agent_subagent 工具查看子会话。'),
      }
      const input = context.input ?? {}
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.trim() === '') return {
        block: true,
        additionalContext: failureText('请求缺少子任务提示词', 'DSH 桥接不会回退到 Command Code 内建子代理。'),
      }
      if (!bridgeConfigured) return {
        block: true,
        additionalContext: failureText('当前会话禁止嵌套子代理', '该会话是 DSH 子代理会话，不能再次创建外部 Agent。'),
      }
      const dispatched = await dispatchToBridge(baseUrl, token, sessionId, context.toolCallId, prompt, input)
      return dispatched.ok === true
        ? { block: true, additionalContext: dispatched.text }
        : { block: true, additionalContext: dispatched.failure }
    },
  })
}

type DispatchOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly failure: string }

async function dispatchToBridge(
  baseUrl: string,
  token: string,
  sessionId: string,
  toolCallId: string | undefined,
  prompt: string,
  input: Record<string, unknown>,
): Promise<DispatchOutcome> {
  try {
    const response = await fetch(`${baseUrl}/v1/dispatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        prompt,
        // Command Code 的 agent 工具是同步 hook；这里明确改为后台派发，
        // 否则 hook 会一直等到子会话 turn/end，外部工具调用容易撞上 300 秒上限。
        runInBackground: true,
        ...(toolCallId === undefined || toolCallId === '' ? {} : { toolCallId }),
        ...(typeof input.description === 'string' && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
        ...(typeof input.subagent_type === 'string' && input.subagent_type.trim() !== '' ? { subagentType: input.subagent_type.trim() } : {}),
        ...(typeof input.agent === 'string' && input.agent.trim() !== '' ? { agent: input.agent.trim() } : {}),
        ...(typeof input.model === 'string' && input.model.trim() !== '' ? { model: input.model.trim() } : {}),
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { ok: false, failure: failureText(`桥接返回 HTTP ${String(response.status)}`, await readBridgeError(response)) }
    }
    const payload = await response.json() as {
      readonly ok?: unknown
      readonly status?: unknown
      readonly completed?: unknown
      readonly childSessionId?: unknown
      readonly text?: unknown
      readonly toolCalls?: unknown
      readonly error?: unknown
    }
    if (payload.ok !== true) {
      const detail = typeof payload.error === 'string' && payload.error.trim() !== '' ? payload.error.trim() : ''
      return { ok: false, failure: failureText('桥接拒绝了这次子代理派发', detail) }
    }
    const text = typeof payload.text === 'string' && payload.text.trim() !== '' ? payload.text : '(子代理没有文本输出)'
    // 把子会话身份带回外部 Agent；否则它只能知道“已启动”，却无法继续
    // 调用 action=read/wait 观察结果。
    return {
      ok: true,
      text: JSON.stringify({
        ok: true,
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
        ...(typeof payload.completed === 'boolean' ? { completed: payload.completed } : {}),
        ...(typeof payload.childSessionId === 'string' ? { childSessionId: payload.childSessionId } : {}),
        ...(typeof payload.toolCalls === 'number' ? { toolCalls: payload.toolCalls } : {}),
        text,
        ...(typeof payload.error === 'string' && payload.error.trim() !== '' ? { error: payload.error } : {}),
      }),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, failure: failureText('无法连接 DSH 子代理桥接', reason) }
  }
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
    `[codingns4dsh] 子代理托管派发失败：${summary}。`,
    detail === '' ? '' : `原因：${detail}`,
    '本次调用没有回退到 Command Code 内建子代理，任务尚未执行。请修复托管配置后重试，或在 DSH 设置中关闭「子代理托管」。',
  ]
  return lines.filter((line) => line !== '').join('\n')
}
