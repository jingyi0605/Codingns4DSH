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
const DISPATCH_TIMEOUT_MS = 16 * 60_000

interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: unknown
}

const TOOL_DEFINITION = {
  name: 'agent_subagent',
  description: 'Delegate a self-contained subtask to a DSH-native subagent session and return its result; multiple calls in one batch run in parallel. Use it whenever the user asks for parallel sessions/agents, subagents, or to delegate/offload parts of the work. Provide a complete, self-contained `prompt` for every call.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '完整、自包含的子任务说明。' },
      agent: { type: 'string', description: '外部编码 Agent id；缺省沿用当前会话的 Agent。' },
      model: { type: 'string', description: '可选模型覆盖。' },
      description: { type: 'string', description: '给子代理的简短标题。' },
      subagent_type: { type: 'string', description: '子代理类型提示（explore/plan/general）。' },
    },
    required: ['prompt'],
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
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  if (prompt.trim() === '') return textResult('prompt 不能为空', true)
  if (BRIDGE_URL === '' || BRIDGE_TOKEN === '' || SESSION_ID === '') return textResult('Codingns4DSH 子代理桥接未配置', true)
  try {
    const response = await fetch(`${BRIDGE_URL}/v1/dispatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        prompt,
        ...(typeof args.agent === 'string' && args.agent.trim() !== '' ? { agent: args.agent.trim() } : { agent: ADAPTER_ID }),
        ...(typeof args.model === 'string' && args.model.trim() !== '' ? { model: args.model.trim() } : {}),
        ...(typeof args.description === 'string' && args.description.trim() !== '' ? { description: args.description.trim() } : {}),
        ...(typeof args.subagent_type === 'string' && args.subagent_type.trim() !== '' ? { subagentType: args.subagent_type.trim() } : {}),
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (!response.ok) return textResult(`子代理桥接请求失败：HTTP ${String(response.status)}`, true)
    const payload = asRecord(await response.json())
    if (payload?.ok !== true) {
      return textResult(`子代理执行失败：${typeof payload?.error === 'string' ? payload.error : '未知错误'}`, true)
    }
    const text = typeof payload.text === 'string' && payload.text.trim() !== '' ? payload.text : '(子代理没有文本输出)'
    return textResult(text, false)
  } catch (error) {
    return textResult(`子代理桥接不可达：${error instanceof Error ? error.message : String(error)}`, true)
  }
}

function textResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
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
