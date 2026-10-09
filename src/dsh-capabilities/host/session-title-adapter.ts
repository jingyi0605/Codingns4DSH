import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createDshCapabilityRegistry } from '../routes.js'
import { fallbackOptimizedSessionTitle, isCompleteSessionTitle, normalizeGeneratedSessionTitle, SESSION_TITLE_SYSTEM_PROMPT } from '../../shared/session-title.js'

interface TitleInput { readonly seq: number; readonly text: string }
interface TitleSnapshot {
  readonly eventSeq: number
  readonly title: string
  readonly messageSeqs: readonly number[]
  readonly source: { readonly kind: string }
}
interface NativeSession { append(type: string, data: unknown): unknown }
interface TitleRuntime {
  readonly titles: { get(session: NativeSession): TitleSnapshot | undefined }
  readonly sessions: { get(id: string): NativeSession | undefined }
}
interface TitleRequest {
  readonly purpose: 'session-title'
  readonly provider: string
  readonly model: string
  readonly sessionId: string
  readonly messages: readonly Record<string, any>[]
  readonly signal?: AbortSignal
  readonly [key: string]: unknown
}
interface LlmRuntime { stream(options: Readonly<Record<string, unknown>>): AsyncIterable<Record<string, any>> }
interface EventRuntime { on(name: string, listener: (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>, options: { global: true }): unknown }

export interface SessionTitleOptimizationAdapter {
  setEnabled(enabled: boolean): void
  dispose(): void
}

/**
 * 保留原生提供方和模型，不替换全局标题生成器，也不影响普通对话/压缩请求。
 * 仅在原生标题的 llm/stream 边界增强提示词；接纳、手动命名保护及并发取代仍由 DSH 管理。
 */
export function createSessionTitleOptimizationAdapter(ctx: unknown, dshVersion: string): SessionTitleOptimizationAdapter | undefined {
  const profile = createDshCapabilityRegistry(dshVersion, 'host', ctx).getProfile(ctx)
  const titleCapability = profile.capabilities.get('session.title')
  const llmCapability = profile.capabilities.get('llm.text')
  if (titleCapability?.status !== 'ready' || llmCapability?.status !== 'ready') return undefined
  const native = titleCapability.value as TitleRuntime
  const llm = llmCapability.value as LlmRuntime
  const events = ctx as EventRuntime
  // 嵌套调用继续走原生 LLM 的认证、重试和其他中间件；异步作用域避免自身递归，且不串扰并发会话。
  const nested = new AsyncLocalStorage<boolean>()
  const active = new Set<AbortController>()
  let enabled = false
  let disposed = false
  const disposeHook = events.on('llm/stream', async function* (raw, next) {
    const request = readTitleRequest(raw)
    const inputs = request === undefined ? undefined : readTitleInputs(request.messages)
    if (!enabled || disposed || nested.getStore() || request === undefined || inputs === undefined) {
      yield* next()
      return
    }
    const session = native.sessions.get(request.sessionId)
    if (session === undefined) { yield* next(); return }
    const before = native.titles.get(session)
    const controller = new AbortController()
    active.add(controller)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(request.signal === undefined ? [] : [request.signal])])
    try {
      const title = await nested.run(true, () => generateTitle(llm, session, request, inputs, signal))
      signal.throwIfAborted()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      // 保留真实失败与原生告警；仅补写同一修订的 fallback，不把本地截取伪装成模型输出。
      if (!controller.signal.aborted && !request.signal?.aborted) {
        try { improveFallback(native, session, before, inputs) } catch { /* 会话关闭或投影失效不能覆盖原始模型错误。 */ }
      }
      throw error
    } finally { active.delete(controller) }
  }, { global: true })

  const cancel = (): void => {
    for (const controller of active) controller.abort(new Error('session title optimization disabled'))
  }
  return {
    setEnabled(value) {
      enabled = value && !disposed
      if (!enabled) cancel()
    },
    dispose() {
      if (disposed) return
      disposed = true
      enabled = false
      cancel()
      if (typeof disposeHook === 'function') disposeHook()
      nested.disable()
    },
  }
}

/** 一次生成，必要时再概括一次；不靠裁剪模型输出来满足长度。 */
async function generateTitle(llm: LlmRuntime, session: NativeSession, request: TitleRequest, inputs: readonly TitleInput[], signal: AbortSignal): Promise<string> {
  let messages = request.messages
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted()
    const options = { ...request, system: SESSION_TITLE_SYSTEM_PROMPT, messages, maxTokens: 128, signal }
    // 原生生成器在进入中间件前已记录原始请求；另记实际调用，避免日志继续显示旧提示词。
    session.append('session/title-llm-request', {
      titleProvider: 'codingns-title-optimization', messageSeqs: inputs.map((input) => input.seq),
      route: { provider: request.provider, model: request.model },
      system: options.system, messages, maxTokens: options.maxTokens,
    })
    const text = await readStreamTitle(llm.stream(options), signal)
    const title = normalizeGeneratedSessionTitle(text)
    if (isCompleteSessionTitle(title)) return title
    messages = [
      ...request.messages,
      { role: 'assistant', id: randomUUID(), source: { kind: 'model', provider: request.provider, model: request.model }, content: [{ type: 'text', text: text.slice(0, 2000) }] },
      { role: 'user', source: { kind: 'dsh-session-title-llm' }, content: [{ type: 'text', text: '上一个标题过长或格式不正确。请重新概括完整主题，删除次要信息，严格遵守系统规定的长度，只返回一行标题。不要截断原标题或添加省略号。' }] },
    ]
  }
  throw new Error('session title model did not produce a concise complete title')
}

/** 支持增量与完整块两种原生流，失败终态不接受已经输出的半截标题。 */
async function readStreamTitle(stream: AsyncIterable<Record<string, any>>, signal: AbortSignal): Promise<string> {
  const blocks = new Map<number, { text: string; delta: boolean }>()
  let stopped = false
  for await (const chunk of stream) {
    signal.throwIfAborted()
    const index = typeof chunk.index === 'number' ? chunk.index : 0
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      const previous = blocks.get(index)?.text ?? ''
      if (previous.length + chunk.text.length > 8000) throw new Error('session title model output is too large')
      blocks.set(index, { text: previous + chunk.text, delta: true })
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && !blocks.get(index)?.delta) {
      if (chunk.block.text.length > 8000) throw new Error('session title model output is too large')
      blocks.set(index, { text: chunk.block.text, delta: false })
    }
    if (chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && chunk.blockType === 'tool-call' || chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      throw new Error('session title model unexpectedly requested a tool')
    }
    if (chunk.type === 'finish') {
      if (chunk.reason?.kind !== 'stop') {
        const failure = chunk.reason?.failure
        throw Object.assign(new Error(failure?.message ?? `session title model finished with ${String(chunk.reason?.kind)}`), { code: failure?.code })
      }
      stopped = true
    }
  }
  signal.throwIfAborted()
  if (!stopped) throw new Error('session title model returned an incomplete stream')
  return [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block.text).join('\n')
}

/** 失败时也遵守原生的修订和人工命名所有权，不批量改历史会话。 */
function improveFallback(native: TitleRuntime, session: NativeSession, before: TitleSnapshot | undefined, inputs: readonly TitleInput[]): void {
  const current = native.titles.get(session)
  const first = inputs[0]
  if (first === undefined || before?.source.kind !== 'fallback' || current?.source.kind !== 'fallback'
    || current.eventSeq !== before.eventSeq || current.messageSeqs.length !== 1 || current.messageSeqs[0] !== first.seq) return
  const title = fallbackOptimizedSessionTitle(first.text)
  if (!title || title === current.title) return
  session.append('session/title', { title, messageSeqs: [...current.messageSeqs], source: { kind: 'fallback' } })
}

function readTitleRequest(value: unknown): TitleRequest | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const request = value as Record<string, unknown>
  if (request.purpose !== 'session-title' || typeof request.provider !== 'string' || typeof request.model !== 'string'
    || typeof request.sessionId !== 'string' || !Array.isArray(request.messages)) return undefined
  return request as unknown as TitleRequest
}

/** 只识别已核对的原生标题输入帧；第三方生成器或未知协议保持原样。 */
function readTitleInputs(messages: readonly Record<string, any>[]): readonly TitleInput[] | undefined {
  const prefix = 'Generate the session title from this JSON array of human messages:\n'
  const text = messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(prefix))?.text
  if (typeof text !== 'string') return undefined
  try {
    const inputs: unknown = JSON.parse(text.slice(prefix.length))
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((input) => Number.isSafeInteger(input?.seq) && input.seq >= 0 && typeof input.text === 'string')) return undefined
    return inputs as TitleInput[]
  } catch { return undefined }
}
