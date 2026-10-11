/**
 * 最小 MCP stdio server：把外部 CLI 的子代理调用转发到 Host 桥接端点。
 *
 * 只依赖 Node 内置能力，由外部 CLI 以 `node <entry.js>` 直接启动；桥接地址、
 * 令牌和 DSH 会话身份全部来自进程环境，不读取磁盘上的任何配置。
 */

const BRIDGE_URL = (process.env.CODINGNS_BRIDGE_URL ?? '').replace(/\/+$/u, '')
const BRIDGE_TOKEN = process.env.CODINGNS_BRIDGE_TOKEN ?? ''
const SESSION_ID = process.env.CODINGNS_DSH_SESSION_ID ?? ''
const ADAPTER_ID = process.env.CODINGNS_ADAPTER_ID ?? ''
// OpenCode V2 会把同目录下的 MCP server 全部放进工具目录，子会话需要独立
// 的回传工具名；其他 ACP/Claude/Codex 适配器仍兼容原有 agent_subagent schema。
const IS_SUBAGENT_CHILD = process.env.CODINGNS_SUBAGENT_CHILD === '1' && ADAPTER_ID === 'opencode'
/** 子会话只暴露回传工具，避免在多个历史 codingns_* 桥接间猜路由。 */
const TOOL_NAME = IS_SUBAGENT_CHILD ? 'send_message' : 'agent_subagent'
// MCP 客户端通常把单次 tools/call 限制在 300 秒左右。start 永远后台返回；
// wait 也只做一次有界观察，超时后由模型再次调用 read/wait 继续轮询。
const DISPATCH_TIMEOUT_MS = 260_000
const MAX_WAIT_TIMEOUT_MS = 240_000

interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: unknown
}

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: IS_SUBAGENT_CHILD
    ? 'Report the completed result to the parent DSH session. This is the only supported child-to-parent report tool; do not search another codingns_* namespace. The parent session is inferred from the current child session, so child_session_id and agent_id are optional.'
    : 'Start external Agent subtasks asynchronously in independent DSH sessions. action=start returns immediately with child_session_id; action=send normally delivers a follow-up message from parent to child, while a child session may use its own parent session id (or omit child_session_id) to report back to that parent. Child sessions cannot use action=start to create nested external agents; use action=send for the report. Use action=read for an immediate status check or action=wait for a bounded wait (at most 240 seconds per call). A failed child must be inspected with read/wait before deciding whether to recreate or take over. Respect depends_on before starting dependent work.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '完整、自包含的子任务说明。' },
      agent: { type: 'string', description: '外部编码 Agent id；缺省沿用当前会话的 Agent。' },
      model: { type: 'string', description: '可选模型覆盖。' },
      description: { type: 'string', description: '给子代理的简短标题。' },
      subagent_type: { type: 'string', description: '子代理类型提示（explore/plan/general）。' },
      action: { type: 'string', enum: ['start', 'read', 'wait', 'send'] },
      run_in_background: { type: 'boolean', description: 'start 是否立即返回；缺省为 true。' },
      child_session_id: { type: 'string', description: '父代理发送时填子会话 ID；子代理回传时可填父会话 ID，也可省略。' },
      agent_id: { type: 'string', description: '兼容父会话回传指令；子会话通常不需要填写，父会话由当前会话身份推导。' },
      message: { type: 'string', description: '发送给已创建子代理的后续消息；action=send 时必填。' },
      timeout_ms: { type: 'number' },
      depends_on: { type: 'array', items: { type: 'string' } },
    },
    required: [],
    additionalProperties: false,
  },
} as const

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') void handleLine(line)
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))

async function handleLine(line: string): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (typeof message !== 'object' || message === null) return
  const request = message as JsonRpcRequest
  const id = request.id
  // 通知没有 id，不需要响应。
  if (id === undefined || id === null) return
  const method = typeof request.method === 'string' ? request.method : ''
  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: readProtocolVersion(request.params),
        capabilities: { tools: {} },
        serverInfo: { name: 'codingns-subagent-bridge', version: '0.2.0' },
      })
      return
    }
    if (method === 'ping') {
      respond(id, {})
      return
    }
    if (method === 'tools/list') {
      respond(id, { tools: [TOOL_DEFINITION] })
      return
    }
    if (method === 'tools/call') {
      respond(id, await callTool(request.params))
      return
    }
    respondError(id, -32601, `Method not found: ${method}`)
  } catch (error) {
    respondError(id, -32603, error instanceof Error ? error.message : String(error))
  }
}

async function callTool(params: unknown): Promise<Record<string, unknown>> {
  const record = asRecord(params)
  const name = typeof record?.name === 'string' ? record.name : ''
  if (name !== TOOL_DEFINITION.name) return textResult(`未知工具: ${name}`, true)
  const args = asRecord(record?.arguments) ?? {}
  const action = IS_SUBAGENT_CHILD
    ? 'send'
    : args.action === 'wait' || args.action === 'read' || args.action === 'send' ? args.action : 'start'
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  const message = typeof args.message === 'string' ? args.message : ''
  if (action === 'start' && prompt.trim() === '') return textResult('start 操作的 prompt 不能为空', true)
  if (action === 'send' && message.trim() === '' && prompt.trim() === '') return textResult('send 操作的 message 不能为空', true)
  if (BRIDGE_URL === '' || BRIDGE_TOKEN === '' || SESSION_ID === '') return textResult('Codingns4DSH 子代理桥接未配置', true)
  try {
    const response = await fetch(`${BRIDGE_URL}/v1/dispatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        prompt,
        action,
        ...(message.trim() === '' ? {} : { message }),
        ...(action === 'start' ? { runInBackground: args.run_in_background !== false } : {}),
        ...(typeof args.child_session_id === 'string' && args.child_session_id.trim() !== ''
          ? { childSessionId: args.child_session_id.trim() }
          : typeof args.agent_id === 'string' && args.agent_id.trim() !== ''
            ? { childSessionId: args.agent_id.trim() }
            : {}),
        ...(Array.isArray(args.depends_on) ? { dependsOn: args.depends_on.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) } : {}),
        ...(action === 'wait' ? { timeoutMs: boundedWaitTimeout(args.timeout_ms) } : {}),
        ...(typeof args.agent === 'string' && args.agent.trim() !== '' ? { agent: args.agent.trim() } : { agent: ADAPTER_ID }),
        ...(typeof args.model === 'string' && args.model.trim() !== '' ? { model: args.model.trim() } : {}),
        ...(typeof args.description === 'string' && args.description.trim() !== '' ? { description: args.description.trim() } : {}),
        ...(typeof args.subagent_type === 'string' && args.subagent_type.trim() !== '' ? { subagentType: args.subagent_type.trim() } : {}),
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    const payload = await readJsonRecord(response)
    if (!response.ok) {
      const detail = typeof payload?.error === 'string' && payload.error.trim() !== '' ? payload.error.trim() : `HTTP ${String(response.status)}`
      return textResult(`子代理桥接请求失败：${detail}`, true)
    }
    if (payload?.ok !== true) {
      const safePayload = payload ?? {}
      const status = safePayload.status
      if (status === 'creating' || status === 'running') {
        return textResult(JSON.stringify({
          ok: false,
          status,
          completed: safePayload.completed === true,
          ...(typeof safePayload.childSessionId === 'string' ? { childSessionId: safePayload.childSessionId } : {}),
          text: typeof safePayload.text === 'string' ? safePayload.text : '子代理仍在运行。',
        }), false)
      }
      if (status === 'failed' || status === 'interrupted') {
        return textResult(JSON.stringify({
          ok: false,
          status,
          completed: safePayload.completed === true,
          ...(typeof safePayload.childSessionId === 'string' ? { childSessionId: safePayload.childSessionId } : {}),
          ...(typeof safePayload.failureReviewed === 'boolean' ? { failureReviewed: safePayload.failureReviewed } : {}),
          ...(typeof safePayload.failureReviewRequired === 'boolean' ? { failureReviewRequired: safePayload.failureReviewRequired } : {}),
          ...(typeof safePayload.failureGuidance === 'string' ? { failureGuidance: safePayload.failureGuidance } : {}),
          text: typeof safePayload.text === 'string' ? safePayload.text : '子代理已失败，请检查状态。',
          ...(typeof safePayload.error === 'string' ? { error: safePayload.error } : {}),
        }), false)
      }
      const detail = typeof safePayload.error === 'string' && safePayload.error.trim() !== '' ? safePayload.error.trim() : '桥接端未返回具体错误。'
      return textResult(`子代理执行失败：${detail}`, true)
    }
    // 启动结果必须把 childSessionId/status 交给模型；只返回文本会让后台任务
    // 无法被后续 read/wait 追踪。统一以 JSON 文本承载，同时保留原始字段。
    return textResult(JSON.stringify({
      ok: true,
      ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
      ...(typeof payload.completed === 'boolean' ? { completed: payload.completed } : {}),
      ...(typeof payload.childSessionId === 'string' ? { childSessionId: payload.childSessionId } : {}),
      ...(typeof payload.parentSessionId === 'string' ? { parentSessionId: payload.parentSessionId } : {}),
      ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
      ...(typeof payload.toolCalls === 'number' ? { toolCalls: payload.toolCalls } : {}),
      ...(typeof payload.failureReviewed === 'boolean' ? { failureReviewed: payload.failureReviewed } : {}),
      ...(typeof payload.failureReviewRequired === 'boolean' ? { failureReviewRequired: payload.failureReviewRequired } : {}),
      ...(typeof payload.failureGuidance === 'string' ? { failureGuidance: payload.failureGuidance } : {}),
      text: typeof payload.text === 'string' && payload.text.trim() !== '' ? payload.text : '子代理已完成，但没有文本输出。',
      ...(typeof payload.error === 'string' && payload.error.trim() !== '' ? { error: payload.error } : {}),
    }), false)
  } catch (error) {
    return textResult(`子代理桥接不可达：${error instanceof Error ? error.message : String(error)}`, true)
  }
}

function boundedWaitTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_WAIT_TIMEOUT_MS
  return Math.max(1, Math.min(Math.floor(value), MAX_WAIT_TIMEOUT_MS))
}

function textResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(await response.json())
  } catch {
    return undefined
  }
}

function readProtocolVersion(params: unknown): string {
  const record = asRecord(params)
  return typeof record?.protocolVersion === 'string' && record.protocolVersion !== '' ? record.protocolVersion : '2024-11-05'
}

function respond(id: string | number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function respondError(id: string | number, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
