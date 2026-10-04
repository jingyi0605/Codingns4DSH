/**
 * Command Code 托管 mod：把内建 `agent` 工具调用转投给 DSH 原生子代理。
 *
 * 由驱动以 `--mod <path>` 每次运行加载；桥接配置（地址/令牌/会话）从进程环境
 * 读取。未注入桥接配置时（托管关闭）不注册任何 hook，内建子代理照常工作。
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
  readonly hooks: (hooks: {
    readonly beforeToolCall?: (context: ToolCallHookContext) => Promise<ToolCallHookResult | undefined> | ToolCallHookResult | undefined
  }) => unknown
}

const DISPATCH_TIMEOUT_MS = 16 * 60_000

export default function codingNsSubagentMod(cmd: ModApiLike): void {
  const baseUrl = (process.env.CODINGNS_BRIDGE_URL ?? '').replace(/\/+$/u, '')
  const token = process.env.CODINGNS_BRIDGE_TOKEN ?? ''
  const sessionId = process.env.CODINGNS_DSH_SESSION_ID ?? ''
  // 托管未开启时驱动不会注入桥接配置：此时完全不接管内建子代理。
  if (baseUrl === '' || token === '' || sessionId === '') return
  cmd.hooks({
    beforeToolCall: async (context) => {
      // 只接管内建子代理入口；agent_output / agent_stop 等控制工具保持原样。
      if (context.toolName !== 'agent') return undefined
      const input = context.input ?? {}
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      // 没有提示词时无从转投，交给内建子代理，避免把空任务派发出去。
      if (prompt.trim() === '') return undefined
      const dispatched = await dispatchToBridge(baseUrl, token, sessionId, context.toolCallId, prompt, input)
      return dispatched.ok
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
    const payload = await response.json() as { readonly ok?: unknown; readonly text?: unknown; readonly error?: unknown }
    if (payload.ok !== true) {
      const detail = typeof payload.error === 'string' && payload.error.trim() !== '' ? payload.error.trim() : ''
      return { ok: false, failure: failureText('桥接拒绝了这次子代理派发', detail) }
    }
    const text = typeof payload.text === 'string' ? payload.text : ''
    return { ok: true, text: text.trim() === '' ? '(子代理没有文本输出)' : text }
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
