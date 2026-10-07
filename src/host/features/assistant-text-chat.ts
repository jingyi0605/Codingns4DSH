import type { AssistantChatCatalog, AssistantChatMessage, AssistantChatRun, AssistantIndexSnapshot } from '../../shared/contracts/assistant.js'
import type { AssistantLlmAdapter } from '../../dsh-capabilities/host/assistant-llm-adapter.js'
import { sanitizeSpeechText } from './assistant-summary.js'
import { createAssistantChatSystem } from './assistant-prompts.js'
import { readAssistantAttachments } from '../../shared/assistant-attachments.js'
import { traceVoice } from '../../shared/voice-diagnostics.js'
export { createAssistantChatSystem } from './assistant-prompts.js'

interface ChatEntry {
  run: AssistantChatRun
  readonly abort: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
  readonly completion: Promise<AssistantChatRun>
  readonly settle: (run: AssistantChatRun) => void
}

/** 有界的 LLM 轮次；后台生成，累计快照可推送及读取，关闭窗口可以主动取消。 */
export class AssistantTextChat {
  private readonly runs = new Map<string, ChatEntry>()
  private catalogCache: AssistantChatCatalog | undefined
  private disposed = false
  private cancellationRevision = 0
  private readonly revoked = new Set<string>()
  private readonly listeners = new Set<(run: AssistantChatRun) => void>()

  constructor(private readonly adapter: AssistantLlmAdapter | undefined, private readonly label = 'LLM 对话') {}

  /** 推送累计快照；旧 RPC 读取和等待结算接口继续保留。 */
  subscribe(listener: (run: AssistantChatRun) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(run: AssistantChatRun): void {
    for (const listener of this.listeners) { try { listener(run) } catch { /* 下行订阅异常不能中断模型生成 */ } }
  }

  async catalog(): Promise<AssistantChatCatalog> {
    this.catalogCache = this.adapter === undefined
      ? { models: [], default: null, errors: ['当前 Host 没有可用的 DSH 原生 LLM 服务'] }
      : await this.adapter.catalog()
    return this.catalogCache
  }

  async start(payload: unknown, index: AssistantIndexSnapshot, isCurrent: () => boolean = () => true, createSystem: (index: AssistantIndexSnapshot) => string = createAssistantChatSystem, allowEmptyScope = false, admittedAttachments = false): Promise<AssistantChatRun> {
    const request = readChatRequest(payload, admittedAttachments)
    const revision = this.cancellationRevision
    if (this.revoked.has(request.requestId)) throw new Error('助理对话已取消')
    if (request.generation !== index.generation || !allowEmptyScope && index.scope.status === 'empty') throw new Error('索引范围或版本已变化，请先执行索引再发送消息')
    if (this.adapter === undefined) throw new Error('当前 Host 没有可用的 DSH 原生 LLM 服务')
    const existing = this.runs.get(request.requestId)
    if (existing !== undefined) return existing.run
    const catalog = this.catalogCache ?? await this.catalog()
    // 模型目录可能需要异步读取；真正发起模型请求前必须再核对生命周期与范围。
    if (this.disposed || revision !== this.cancellationRevision || this.revoked.has(request.requestId) || !isCurrent()) throw new Error('对话已取消或索引范围或版本已变化，请重新发送')
    const concurrent = this.runs.get(request.requestId)
    if (concurrent !== undefined) return concurrent.run
    const model = catalog.models.find((item) => item.provider === request.provider && item.model === request.model)
    if (model === undefined) throw new Error('所选模型不在 DSH 当前模型目录中，请刷新模型列表')
    // 超出容量时只移除已结束轮次，不能丢掉仍在运行的请求与取消句柄。
    for (const [id, entry] of this.runs) if (this.runs.size >= 30 && entry.run.state !== 'running') this.runs.delete(id)
    if (this.runs.size >= 30) throw new Error('正在运行的调试请求过多，请先停止已有请求')
    const system = createSystem(index)
    const abort = new AbortController()
    const run: AssistantChatRun = { requestId: request.requestId, provider: model.provider, model: model.model, generation: index.generation, state: 'running', text: '', error: null, startedAt: Date.now(), finishedAt: null }
    let settle!: (run: AssistantChatRun) => void
    const completion = new Promise<AssistantChatRun>((resolve) => { settle = resolve })
    const entry: ChatEntry = { run, abort, timer: undefined, completion, settle }
    this.runs.set(request.requestId, entry)
    const started = performance.now()
    const diagnosticFields = { requestId: request.requestId, provider: model.provider, model: model.model }
    let firstText = false
    traceVoice('host.llm.start', { ...diagnosticFields, messageCount: request.messages.length, systemLength: system.length })
    entry.timer = setTimeout(() => {
      const reason = `${this.label}超过 90 秒，请检查模型服务`
      entry.run = { ...entry.run, state: 'cancelled', error: reason, finishedAt: Date.now() }
      abort.abort(new Error(reason))
      traceVoice('host.llm.timeout', { ...diagnosticFields, durationMs: performance.now() - started })
      this.publish(entry.run)
      entry.settle(entry.run)
    }, 90_000)
    void this.adapter.reply(model, system, request.messages, abort.signal, (text) => {
      if (!firstText && text.trim() !== '') { firstText = true; traceVoice('host.llm.first_text', { ...diagnosticFields, firstTextMs: performance.now() - started }) }
      if (!abort.signal.aborted && text !== entry.run.text) { entry.run = { ...entry.run, text }; this.publish(entry.run) }
    }, undefined,
      (call) => {
        traceVoice('host.llm.tool', { ...diagnosticFields, action: call.name, state: call.state })
        if (abort.signal.aborted) return
        const calls = new Map((entry.run.toolCalls ?? []).map((item) => [item.id, item]))
        calls.set(call.id, call)
        entry.run = { ...entry.run, toolCalls: [...calls.values()].slice(-24) }
        this.publish(entry.run)
      })
      .then((text) => {
        if (abort.signal.aborted) return
        entry.run = { ...entry.run, text, state: 'completed', finishedAt: Date.now() }
      })
      .catch((error) => { if (!abort.signal.aborted) entry.run = { ...entry.run, state: 'failed', error: sanitizeSpeechText(error instanceof Error ? error.message : String(error)).slice(0, 500), finishedAt: Date.now() } })
      .finally(() => {
        traceVoice('host.llm.finished', { ...diagnosticFields, state: entry.run.state, durationMs: performance.now() - started, textLength: entry.run.text.length, toolCount: entry.run.toolCalls?.length ?? 0 })
        this.publish(entry.run)
        clearTimeout(entry.timer); entry.timer = undefined; entry.settle(entry.run)
      })
    return run
  }

  read(requestId: string): AssistantChatRun {
    const entry = this.runs.get(requestId)
    if (entry === undefined) throw new Error('找不到该文本调试请求，请重新发送')
    return entry.run
  }

  /** 等待结算供语音提交多轮历史；取消立即结算，不依赖上游是否响应 Abort。 */
  wait(requestId: string): Promise<AssistantChatRun> {
    const entry = this.runs.get(requestId)
    if (entry === undefined) throw new Error('找不到该文本调试请求')
    return entry.completion
  }

  cancel(requestId: string): AssistantChatRun {
    const entry = this.runs.get(requestId)
    if (entry === undefined) throw new Error('找不到该文本调试请求')
    if (entry.run.state === 'running') {
      clearTimeout(entry.timer); entry.timer = undefined
      entry.abort.abort(new Error(`${this.label}已停止`))
      traceVoice('host.llm.cancel', { requestId, durationMs: Date.now() - entry.run.startedAt })
      entry.run = { ...entry.run, state: 'cancelled', finishedAt: Date.now(), error: `${this.label}已停止` }
      this.publish(entry.run)
      entry.settle(entry.run)
    }
    return entry.run
  }

  cancelActive(): void {
    this.cancellationRevision++
    for (const [id, entry] of this.runs) if (entry.run.state === 'running') this.cancel(id)
  }

  /** 关闭请求可以先于启动到达；显式撤销标记覆盖模型目录尚未返回的阶段。 */
  revoke(requestId: string): AssistantChatRun | null {
    this.revoked.add(requestId)
    if (this.revoked.size > 1000) this.revoked.delete(this.revoked.values().next().value!)
    return this.runs.has(requestId) ? this.cancel(requestId) : null
  }

  dispose(): void {
    this.disposed = true
    this.cancelActive()
    this.listeners.clear()
    this.runs.clear()
  }
}

function readChatRequest(value: unknown, admittedAttachments: boolean): { requestId: string; provider: string; model: string; generation: number; messages: readonly AssistantChatMessage[] } {
  const request = value as Record<string, unknown> | null
  if (request === null || typeof request !== 'object') throw new Error('文本调试请求无效')
  for (const key of ['requestId', 'provider', 'model']) if (typeof request[key] !== 'string' || !(request[key] as string).trim() || (request[key] as string).length > 200) throw new Error('文本调试缺少请求标识或模型')
  if (!Number.isSafeInteger(request.generation) || !Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 20) throw new Error('文本调试索引版本或消息数量无效')
  const messages: AssistantChatMessage[] = request.messages.map((item: any, index: number) => {
    if (item?.role !== (index % 2 === 0 ? 'user' : 'assistant') || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 8000) throw new Error('文本调试消息必须由用户与助理交替组成，每条不超过 8000 字符')
    // 调试 RPC 不得引用浏览器没有上传的附件；仅正式对话传入的已接收记录可携带引用。
    if (!admittedAttachments && item.attachments !== undefined) throw new Error('调试对话不接受附件引用')
    const attachments = readAssistantAttachments(item.attachments)
    return { role: item.role, text: item.text.trim(), ...(attachments.length === 0 ? {} : { attachments }) }
  })
  if (messages.at(-1)?.role !== 'user') throw new Error('文本调试最后一条必须是用户消息')
  return { requestId: request.requestId as string, provider: request.provider as string, model: request.model as string, generation: request.generation as number, messages }
}
