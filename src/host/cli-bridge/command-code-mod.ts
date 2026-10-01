/**
 * Command Code 托管 mod：把内建 `agent` 工具调用转投给 DSH 原生子代理。
 *
 * 由驱动以 `--mod <path>` 每次运行加载；桥接配置（地址/令牌/会话）从进程环境
 * 读取。转投失败（桥接不可达、未启用）时返回 undefined，让内建子代理继续工作。
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
  if (baseUrl === '' || token === '' || sessionId === '') return
  cmd.hooks({
    beforeToolCall: async (context) => {
      // 只接管内建子代理入口；agent_output / agent_stop 等控制工具保持原样。
      if (context.toolName !== 'agent') return undefined
      const input = context.input ?? {}
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.trim() === '') return undefined
      const text = await dispatchToBridge(baseUrl, token, sessionId, context.toolCallId, prompt, input)
      if (text === undefined) return undefined
      return { block: true, additionalContext: text }
    },
  })
}

async function dispatchToBridge(
  baseUrl: string,
  token: string,
  sessionId: string,
  toolCallId: string | undefined,
  prompt: string,
  input: Record<string, unknown>,
): Promise<string | undefined> {
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
        ...(typeof input.model === 'string' && input.model.trim() !== '' ? { model: input.model.trim() } : {}),
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const payload = await response.json() as { readonly ok?: unknown; readonly text?: unknown }
    if (payload.ok !== true) return undefined
    const text = typeof payload.text === 'string' ? payload.text : ''
    return text.trim() === '' ? '(子代理没有文本输出)' : text
  } catch {
    // 桥接故障时交给内建子代理；错误不写 stdout，避免污染 CLI 的协议流。
    return undefined
  }
}
