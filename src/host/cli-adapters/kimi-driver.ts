import readline from 'node:readline'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CodingNsAgentEvent, CodingNsAgentQuestionResponse, CodingNsAgentPermissionResponse, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { KIMI_CATALOG, enrichEfforts, isProviderDefaultModel } from './model-catalog.js'
import { probeStoredSession, readFirstJsonRecord, resolveSessionDirectory } from './session-probe.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { isQuestionEvent, readAgentQuestions } from './interaction-events.js'
import { usageChunk } from './rpc-driver-utils.js'
import { terminateChildProcess } from './process-utils.js'

interface KimiPendingInteraction {
  readonly rpcId: string | number
  readonly kind: 'permission' | 'question'
  readonly questions?: ReadonlyMap<string, string>
}

interface KimiInteractionState {
  readonly write: (data: string) => void
  readonly pending: Map<string, KimiPendingInteraction>
}

/** Kimi 的 wire 协议优先，旧版 CLI 不支持时自动回退 stream-json。 */
export class KimiCliDriver extends StandardStreamDriver {
  private legacySyntax = false
  private readonly sessionRoots: readonly string[]
  private readonly interactions = new Map<string, KimiInteractionState>()

  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'kimi', name: 'Kimi CLI', protocol: 'stream-json', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions', 'steer'] }, { binaries: ['kimi', 'kimi-cli'] }, options)
    this.sessionRoots = options.sessionRoots ?? [join(process.env.KIMI_HOME ?? join(homedir(), '.kimi'), 'sessions')]
  }

  async listModels() {
    if (!(await this.detect()).installed) return emptyCatalog()
    const catalog = await super.listModels()
    return catalog.groups.length > 0 ? enrichEfforts(catalog, KIMI_CATALOG) : KIMI_CATALOG
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isDirectory() && basename(path) === id,
      validate: async (path) => {
        const directory = await resolveSessionDirectory(path)
        return await readFirstJsonRecord(join(directory, 'context.jsonl')) !== null
      },
    })
  }

  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json']
    if (input.providerSessionId) args.push(this.legacySyntax ? '--resume' : '--session', input.providerSessionId)
    if (this.legacySyntax) {
      if (input.cwd) args.push('--cwd', input.cwd)
    } else if (input.cwd) args.push('--work-dir', input.cwd)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    return args
  }

  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const state = this.interactions.get(sessionId)
    const pending = state?.pending.get(response.requestId)
    if (state === undefined || pending?.kind !== 'permission') throw new Error('Kimi 权限请求已结束')
    state.pending.delete(response.requestId)
    state.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result: {
        request_id: response.requestId,
        response: response.approved ? 'approve' : 'reject',
        ...(response.reason ? { feedback: response.reason } : {}),
      },
    })}\n`)
  }

  respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): void {
    const state = this.interactions.get(sessionId)
    const pending = state?.pending.get(response.requestId)
    if (state === undefined || pending?.kind !== 'question') throw new Error('Kimi 问题请求已结束')
    state.pending.delete(response.requestId)
    const answers = Object.fromEntries(response.answers.map((answer) => [
      pending.questions?.get(answer.id) ?? answer.id,
      [...answer.selected, ...(answer.custom?.trim() ? [answer.custom.trim()] : [])].join(', '),
    ]))
    state.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result: { request_id: response.requestId, answers },
    })}\n`)
  }

  override dispose(): void {
    this.interactions.clear()
    super.dispose()
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    try {
      yield* this.executeWireTurn(input)
      return
    } catch {
      if (input.signal?.aborted) {
        yield { type: 'finish', reason: 'cancel' }
        return
      }
      for await (const chunk of super.executeTurn(input)) yield chunk
    }
  }

  private async *executeWireTurn(input: CodingNsCliTurnInput): AsyncGenerator<CodingNsAgentEvent> {
    const detection = await this.detect()
    const command = detection.command
    if (command === null) throw new Error('Kimi CLI 未安装')
    this.detectSyntax(command)
    const args = this.legacySyntax ? ['wire', '--output-format', 'stream-json'] : ['--wire']
    if (input.providerSessionId) args.push(this.legacySyntax ? '--resume' : '--session', input.providerSessionId)
    else if (this.legacySyntax) args.push('--new-session')
    if (input.cwd) args.push(this.legacySyntax ? '--cwd' : '--work-dir', input.cwd)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    const child = this.runSpawn(command, args, {
      cwd: input.cwd ?? process.cwd(), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32',
    })
    const stdin = (child as unknown as { stdin: { write(data: string): void } }).stdin
    const interaction: KimiInteractionState = {
      write: (data) => stdin.write(data),
      pending: new Map(),
    }
    this.interactions.set(input.sessionId, interaction)
    let finished = false
    let sawProtocol = false
    const onAbort = (): void => { terminateChildProcess(child) }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    child.stderr.on('data', () => undefined)
    try {
      const initializeId = `initialize:${input.sessionId}`
      const promptId = `prompt:${input.sessionId}`
      stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: initializeId,
        method: 'initialize',
        params: {
          protocol_version: '1.10',
          client: { name: 'dsh-codingns', version: '0.1.1' },
          capabilities: { supports_question: true },
        },
      })}\n`)
      let promptSent = false
      const sendPrompt = (): void => {
        if (promptSent) return
        promptSent = true
        stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: promptId,
          method: 'prompt',
          params: { user_input: input.prompt },
        })}\n`)
      }
      const lines = readline.createInterface({ input: child.stdout })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          let value: unknown
          try { value = JSON.parse(line) } catch { continue }
          if (!isRecord(value)) continue
          if (value.id === initializeId && (value.result !== undefined || value.error !== undefined)) {
            // initialize 是可选握手；旧版返回 method not found 时仍可直接 prompt。
            sendPrompt()
            continue
          }
          if (!promptSent) sendPrompt()
          const request = kimiInteractionRequest(value)
          if (request !== null) {
            interaction.pending.set(request.event.requestId, request.pending)
            sawProtocol = true
            yield request.event
            continue
          }
          if (value.id === promptId && value.result !== undefined) {
            const result = isRecord(value.result) ? value.result : null
            yield { type: 'finish', reason: input.signal?.aborted || result?.status === 'cancelled' ? 'cancel' : 'stop' }
            finished = true
            break
          }
          if (value.id === promptId && value.error !== undefined) throw new Error('Kimi wire 请求失败')
          const result = mapKimiWireEvent(value, input.signal?.aborted ?? false)
          if (result.protocol) sawProtocol = true
          if (result.error) throw new Error('Kimi wire 请求失败')
          for (const chunk of result.chunks) {
            if (chunk.type === 'finish') finished = true
            yield chunk
          }
          if (finished) break
        }
      } finally { lines.close() }
      if (input.signal?.aborted) {
        if (!finished) yield { type: 'finish', reason: 'cancel' }
        return
      }
      if (!finished) throw new Error(sawProtocol ? 'Kimi wire 未返回完成事件' : 'Kimi wire 不可用')
    } finally {
      if (this.interactions.get(input.sessionId) === interaction) this.interactions.delete(input.sessionId)
      input.signal?.removeEventListener('abort', onAbort)
      terminateChildProcess(child)
    }
  }

  private detectSyntax(command: string): void {
    try {
      const result = this.runSpawnSync(command, ['--help'], { encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: process.platform === 'win32' })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase()
      this.legacySyntax = /(?:^|\s)wire(?:\s|$)/u.test(output) && !output.includes('--wire')
    } catch {
      this.legacySyntax = false
    }
  }
}

function mapKimiWireEvent(value: Record<string, unknown>, cancelled: boolean): { protocol: boolean; error: boolean; chunks: CodingNsAgentEvent[] } {
  const params = isRecord(value.params) ? value.params : null
  const event = isRecord(params?.payload)
    ? params.payload
    : isRecord(value.event)
      ? value.event
      : isRecord(value.payload)
        ? value.payload
        : value
  const envelopeType = params?.type ?? value.type ?? event.type ?? value.event ?? ''
  const type = `${envelopeType}`.toLowerCase()
  const isToolEvent = type.includes('tool') || type.includes('command') || type.includes('function')
  const chunks: CodingNsAgentEvent[] = []
  const sessionId = firstString(value, event, ['session_id', 'sessionId', 'id'])
  if (sessionId && (type.includes('session') || type.includes('ready'))) chunks.push({ type: 'session-binding', providerSessionId: sessionId })
  if (isQuestionEvent(type)) {
    const requestId = firstString(event, value, ['request_id', 'requestId', 'question_id', 'id'])
    const questions = readAgentQuestions(event.questions ?? value.questions ?? event)
    if (requestId && questions.length > 0) chunks.push({ type: 'question-request', requestId, questions })
  }
  const permissionId = firstString(event, value, ['request_id', 'requestId', 'permission_id'])
  if (permissionId && type.includes('permission')) chunks.push({ type: 'permission-request', requestId: permissionId, kind: firstString(event, value, ['kind', 'type']) ?? 'unknown' })
  const contentType = typeof event.type === 'string' ? event.type.toLowerCase() : ''
  const text = isQuestionEvent(type) || type.includes('permission')
    ? ''
    : type === 'contentpart' && contentType === 'think'
      ? firstString(event, event, ['think'])
      : textFrom(event)
  if (text) {
    if (type.includes('think') || type.includes('reason') || contentType === 'think') chunks.push({ type: 'reasoning-delta', text })
    else if (!type.includes('result') && !type.includes('complete') && !type.includes('done')) chunks.push({ type: 'text-delta', text })
  }
  const nestedTool = isToolRecord(event.tool_call)
    ? event.tool_call
    : isToolRecord(event.tool_result)
      ? event.tool_result
      : isToolRecord(event.function)
        ? event.function
        : event
  const toolName = firstToolText(nestedTool.tool_name, nestedTool.toolName, nestedTool.name, event.tool_name, event.toolName, event.name)
  if ((toolName || firstToolText(nestedTool.call_id, nestedTool.callId, event.tool_call_id, event.tool_use_id)) && isToolEvent) {
    const callId = firstToolText(nestedTool.call_id, nestedTool.callId, nestedTool.id, event.tool_call_id, event.tool_use_id, event.toolUseId, event.id)
    const input = serializeToolValue(nestedTool.input ?? nestedTool.arguments ?? nestedTool.args ?? nestedTool.parameters ?? event.input ?? event.arguments)
    const returnValue = isRecord(event.return_value) ? event.return_value : null
    const output = serializeToolValue(nestedTool.output ?? nestedTool.result ?? event.output ?? event.result ?? returnValue?.output ?? returnValue?.message)
    const error = serializeToolValue(nestedTool.error ?? event.error ?? (returnValue?.is_error === true ? returnValue.message : undefined))
    const fallback = error !== undefined || type.includes('error') || type.includes('fail')
      ? 'failed'
      : output !== undefined || type.includes('result') || type.includes('complete') || type.includes('return')
        ? 'completed'
        : 'running'
    chunks.push({
      type: 'tool-event',
      toolName: toolName ?? 'tool',
      status: normalizeToolStatus(nestedTool.status ?? event.status, fallback),
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(output !== undefined ? { outputMode: type.includes('delta') ? 'delta' as const : 'snapshot' as const } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(firstToolText(nestedTool.agent_id, nestedTool.agentId, event.agent_id, event.agentId) ? { agentId: firstToolText(nestedTool.agent_id, nestedTool.agentId, event.agent_id, event.agentId)! } : {}),
      ...(serializeToolValue(nestedTool.detail ?? event.detail) !== undefined ? { detail: serializeToolValue(nestedTool.detail ?? event.detail)! } : {}),
    })
  }
  const usage = isRecord(event.usage) ? event.usage : isRecord(value.usage) ? value.usage : null
  const usageEvent = usageChunk(usage)
  if (usageEvent) chunks.push(usageEvent)
  if ((type.includes('error') || type.includes('failed')) && !isToolEvent) return { protocol: true, error: true, chunks }
  if (type.includes('turnend') || type.includes('turn_end') || type.includes('completed') || type.includes('complete') || type === 'done' || type === 'result' || type.includes('session.completed')) chunks.push({ type: 'finish', reason: cancelled ? 'cancel' : 'stop' })
  return { protocol: true, error: false, chunks }
}

function kimiInteractionRequest(value: Record<string, unknown>): {
  readonly event: Extract<CodingNsAgentEvent, { type: 'permission-request' | 'question-request' }>
  readonly pending: KimiPendingInteraction
} | null {
  if (value.method !== 'request' || (typeof value.id !== 'string' && typeof value.id !== 'number')) return null
  const params = isRecord(value.params) ? value.params : null
  const payload = isRecord(params?.payload) ? params.payload : null
  const type = typeof params?.type === 'string' ? params.type.toLowerCase() : ''
  const requestId = firstString(payload ?? {}, payload ?? {}, ['id'])
  if (payload === null || requestId === null) return null
  if (type === 'approvalrequest') {
    const toolName = firstString(payload, payload, ['sender']) ?? 'external-agent'
    const detail = firstString(payload, payload, ['description', 'action'])
    const callId = firstString(payload, payload, ['tool_call_id'])
    return {
      event: {
        type: 'permission-request',
        requestId,
        kind: firstString(payload, payload, ['action']) ?? toolName,
        toolName,
        ...(callId ? { callId } : {}),
        ...(detail ? { detail } : {}),
      },
      pending: { rpcId: value.id, kind: 'permission' },
    }
  }
  if (type === 'questionrequest') {
    const questions = readAgentQuestions(payload.questions)
    if (questions.length === 0) return null
    return {
      event: { type: 'question-request', requestId, questions },
      pending: {
        rpcId: value.id,
        kind: 'question',
        questions: new Map(questions.map((question) => [question.id, question.question])),
      },
    }
  }
  return null
}

function textFrom(value: Record<string, unknown>): string | null {
  for (const key of ['text', 'delta', 'content', 'message']) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return item
    if (Array.isArray(item)) {
      const parts = item.flatMap((part) => typeof part === 'string' ? [part] : isRecord(part) ? [textFrom(part) ?? ''] : [])
      const joined = parts.join('')
      if (joined.trim()) return joined
    }
    if (isRecord(item)) {
      const nested = textFrom(item)
      if (nested) return nested
    }
  }
  return null
}
function firstString(a: Record<string, unknown>, b: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) for (const source of [a, b]) if (typeof source[key] === 'string' && source[key].trim()) return source[key] as string
  return null
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

export { KimiCliDriver as KimiDriver }
