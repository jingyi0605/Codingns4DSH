import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createSubagentBridgeRuntime } from './bridge-holder.js'
import type { SubagentBridgeRuntime } from './bridge-holder.js'

/** 外部 CLI 发起的一次子代理托管请求。 */
export interface SubagentBridgeDispatchRequest {
  readonly sessionId: string
  readonly prompt: string
  readonly action?: 'start' | 'wait' | 'read' | undefined
  readonly childSessionId?: string | undefined
  readonly dependsOn?: readonly string[] | undefined
  readonly timeoutMs?: number | undefined
  readonly agent?: string | undefined
  readonly model?: string | undefined
  readonly description?: string | undefined
  readonly subagentType?: string | undefined
  /** 外部 CLI 的工具调用 id；驱动用它把 blocked 事件投影成完成态。 */
  readonly toolCallId?: string | undefined
}

export interface SubagentBridgeDispatchResult {
  readonly ok: boolean
  readonly completed?: boolean | undefined
  readonly status?: 'creating' | 'running' | 'completed' | 'failed' | 'interrupted' | undefined
  readonly text: string
  readonly childSessionId?: string | undefined
  readonly toolCalls?: number | undefined
  readonly error?: string | undefined
}

export interface SubagentBridgeServer {
  readonly runtime: SubagentBridgeRuntime
  close(): Promise<void>
}

const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * 本机回环桥接服务：只监听 127.0.0.1，每次启动生成随机令牌。
 *
 * 一次派发可能阻塞十几分钟等待子代理首轮，因此关闭 HTTP 请求超时；
 * 认证失败、路由不存在和内部错误都返回稳定的 JSON 结构。
 */
export async function startSubagentBridgeServer(options: {
  readonly dispatch: (request: SubagentBridgeDispatchRequest) => Promise<SubagentBridgeDispatchResult>
}): Promise<SubagentBridgeServer> {
  const token = randomBytes(24).toString('hex')
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, options.dispatch).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      respondJson(response, 500, { ok: false, text: message || '子代理桥接内部错误。', error: message || '子代理桥接内部错误。' })
    })
  })
  server.requestTimeout = 0
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const runtime = createSubagentBridgeRuntime({ baseUrl: `http://127.0.0.1:${String(port)}`, token })
  return {
    runtime,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
    }),
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  dispatch: (input: SubagentBridgeDispatchRequest) => Promise<SubagentBridgeDispatchResult>,
): Promise<void> {
  const url = request.url ?? '/'
  if (request.method === 'GET' && url === '/v1/status') {
    respondJson(response, 200, { ok: true, service: 'codingns-subagent-bridge' })
    return
  }
  if (request.method !== 'POST' || url !== '/v1/dispatch') {
    respondJson(response, 404, { ok: false, error: 'not found' })
    return
  }
  if (!authorize(request, token)) {
    respondJson(response, 401, { ok: false, error: 'unauthorized' })
    return
  }
  const body = await readBody(request)
  if (body === undefined) {
    respondJson(response, 413, { ok: false, error: 'request body too large' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    respondJson(response, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  const input = readDispatchRequest(parsed)
  if (input === undefined) {
    respondJson(response, 400, { ok: false, error: 'sessionId 不能为空，start 操作的 prompt 不能为空' })
    return
  }
  const result = await dispatch(input)
  respondJson(response, 200, result)
}

/** 恒定时间比较 Bearer 令牌；长度不同直接拒绝。 */
function authorize(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(undefined)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(undefined))
  })
}

function readDispatchRequest(value: unknown): SubagentBridgeDispatchRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  const prompt = typeof record.prompt === 'string' ? record.prompt : ''
  const action = record.action === 'wait' || record.action === 'read' || record.action === 'start' ? record.action : 'start'
  if (sessionId === '' || action === 'start' && prompt.trim() === '') return undefined
  const optional = (key: string): string | undefined => {
    const raw = record[key]
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
  }
  return {
    sessionId,
    prompt,
    action,
    ...(typeof record.childSessionId === 'string' && record.childSessionId.trim() !== '' ? { childSessionId: record.childSessionId.trim() } : {}),
    ...(Array.isArray(record.dependsOn) ? { dependsOn: record.dependsOn.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) } : {}),
    ...(typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) ? { timeoutMs: record.timeoutMs } : {}),
    ...(optional('agent') === undefined ? {} : { agent: optional('agent') }),
    ...(optional('model') === undefined ? {} : { model: optional('model') }),
    ...(optional('description') === undefined ? {} : { description: optional('description') }),
    ...(optional('subagentType') === undefined ? {} : { subagentType: optional('subagentType') }),
    ...(optional('toolCallId') === undefined ? {} : { toolCallId: optional('toolCallId') }),
  }
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.writableEnded) return
  try {
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(body))
  } catch {
    // 客户端可能在中途断开；响应失败不影响派发结果。
  }
}
