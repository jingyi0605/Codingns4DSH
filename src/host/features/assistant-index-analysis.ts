import { createHash, randomUUID } from 'node:crypto'
import type { AssistantChatModel, AssistantIndexAnalysisRun, AssistantIndexSnapshot, AssistantSessionAnalysis, AssistantSessionIndexTask } from '../../shared/contracts/assistant.js'
import type { AssistantLlmAdapter } from '../../dsh-capabilities/host/assistant-llm-adapter.js'
import { createAssistantIndexSystem } from './assistant-prompts.js'
import { ASSISTANT_INDEX_FORMAT, parseAssistantStructuredIndex } from './assistant-structured-index.js'
import { assistantSessionKey } from './assistant-index-updates.js'
import type { SessionIndexEntry } from '../../shared/contracts/assistant.js'
import { sanitizeSpeechText } from './assistant-summary.js'

interface TaskEntry {
  task: AssistantSessionIndexTask
  readonly abort: AbortController
  result?: AssistantSessionAnalysis
}
interface IndexBatch {
  run: AssistantIndexAnalysisRun
  readonly abort: AbortController
  readonly tasks: readonly TaskEntry[]
  readonly index: AssistantIndexSnapshot
  readonly isCurrent: () => boolean
  readonly changed: (run: AssistantIndexAnalysisRun) => void
  readonly canIndex: (entry: SessionIndexEntry) => boolean
  readonly confirmIdle: (entry: SessionIndexEntry, signal: AbortSignal) => Promise<boolean>
  readonly retryFailures: boolean
}

type CachedTask = { fingerprint: string; thinking: AssistantSessionIndexTask['thinking'] } & (
  { result: AssistantSessionAnalysis } | { sourceVersion: number | undefined; error: string }
)

/** 一个会话一个独立模型任务；只汇总已校验结果，不再要求模型一次输出所有会话。 */
export class AssistantIndexAnalysis {
  private batch: IndexBatch | undefined
  private disposed = false
  private readonly cache = new Map<string, CachedTask>()

  constructor(private readonly adapter: AssistantLlmAdapter | undefined) {}

  start(index: AssistantIndexSnapshot, selection: { provider?: string; model?: string }, prefix: string, isCurrent: () => boolean, changed: IndexBatch['changed'], canIndex: IndexBatch['canIndex'] = (entry) => !entry.running && entry.waiting === null, confirmIdle: IndexBatch['confirmIdle'] = async () => true, retryFailures = true): AssistantIndexAnalysisRun {
    this.cancelActive()
    if (this.disposed) throw new Error('索引服务已释放')
    const requestId = `assistant-index-${randomUUID()}`
    const batch: IndexBatch = {
      index, abort: new AbortController(), isCurrent, changed, canIndex, confirmIdle, retryFailures,
      run: { requestId, provider: selection.provider ?? '', model: selection.model ?? '', generation: index.generation, state: 'running', text: '', error: null, startedAt: Date.now(), finishedAt: null },
      tasks: index.entries.map((entry, number) => ({ abort: new AbortController(), task: { requestId: `${requestId}-${number}`, hostId: entry.hostId, sessionId: entry.sessionId, title: entry.title, workspaceName: entry.workspaceName, state: 'queued', text: '', error: null, startedAt: null, finishedAt: null, thinking: null, ...(entry.sourceVersion === undefined ? {} : { sourceVersion: entry.sourceVersion }) } })),
    }
    const members = new Set(index.entries.map(assistantSessionKey))
    for (const key of this.cache.keys()) if (!members.has(key)) this.cache.delete(key)
    this.batch = batch
    this.publish(batch)
    void this.execute(batch, prefix).catch((error) => {
      if (batch.run.state !== 'running') return
      const message = safeError(error)
      for (const entry of batch.tasks) if (entry.task.state === 'queued') entry.task = { ...entry.task, state: 'failed', error: message, finishedAt: Date.now() }
      batch.run = { ...batch.run, state: 'failed', error: message, finishedAt: Date.now() }
      this.publish(batch)
    })
    return this.read()!
  }

  read(): AssistantIndexAnalysisRun | undefined { return this.batch?.run }

  cancel(requestId: string): AssistantIndexAnalysisRun {
    if (this.batch?.run.requestId !== requestId) throw new Error('索引总结请求已变化，请刷新面板')
    this.stop(this.batch, '索引总结已停止')
    return this.batch.run
  }

  cancelActive(): void { if (this.batch !== undefined) this.stop(this.batch, '索引总结已停止') }
  clear(): void { this.cancelActive(); this.batch = undefined; this.cache.clear() }
  /** 只停止受影响会话，其余任务和已完成结果继续保留。 */
  deferSession(key: string): void {
    const batch = this.batch
    if (batch?.run.state !== 'running') return
    const entry = batch.tasks.find((item) => assistantSessionKey(item.task) === key)
    if (entry === undefined || !['queued', 'running'].includes(entry.task.state)) return
    entry.task = { ...entry.task, state: 'deferred', text: '', error: null, finishedAt: Date.now() }
    entry.abort.abort(new Error('会话正在更新，等待本轮执行结束'))
    this.publish(batch)
  }
  dispose(): void { this.disposed = true; this.cancelActive() }

  private async execute(batch: IndexBatch, prefix: string): Promise<void> {
    const adapter = this.adapter
    if (adapter === undefined) throw new Error('当前 Host 没有可用的 DSH 原生 LLM 服务')
    const catalog = await bounded(batch.abort, () => adapter.catalog(), '模型目录读取')
    if (!this.current(batch)) return
    const explicit = batch.run.provider !== '' || batch.run.model !== ''
    const model = explicit ? catalog.models.find((item) => item.provider === batch.run.provider && item.model === batch.run.model) : catalog.default
    if (model == null) throw new Error('索引材料已读取，但没有可用的总结模型，请配置或选择 DSH 模型后重新执行索引')
    batch.run = { ...batch.run, provider: model.provider, model: model.model }
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (this.current(batch) && cursor < batch.tasks.length) {
        const number = cursor++
        await this.executeTask(batch, batch.tasks[number]!, number, model, prefix)
      }
    }
    // 有界并发防止会话数量变成瞬时 API 压力；每个任务都有自己的取消信号和90秒计时。
    await Promise.all(Array.from({ length: Math.min(2, batch.tasks.length) }, worker))
    if (!this.current(batch)) return
    const failed = batch.tasks.filter((entry) => entry.task.state === 'failed' || entry.task.state === 'cancelled')
    batch.run = { ...batch.run, state: failed.length === 0 ? 'completed' : 'failed', error: failed.length === 0 ? null : `${failed.length} 个会话索引失败：${failed[0]!.task.error}`, finishedAt: Date.now() }
    this.publish(batch)
  }

  private async executeTask(batch: IndexBatch, entry: TaskEntry, number: number, model: AssistantChatModel, prefix: string): Promise<void> {
    if (entry.task.state !== 'queued') return
    const source = batch.index.entries[number]!
    if (!batch.canIndex(source)) { entry.task = { ...entry.task, state: 'deferred' }; this.publish(batch); return }
    const fingerprint = createHash('sha256').update(JSON.stringify([model.provider, model.model, prefix, ASSISTANT_INDEX_FORMAT, source.title, source.summary])).digest('hex')
    const cached = this.cache.get(assistantSessionKey(source))
    if (cached?.fingerprint === fingerprint && 'result' in cached) {
      entry.result = { ...cached.result, workspaceId: source.workspaceId, workspaceName: source.workspaceName, title: source.title, sourceStatus: source.status ?? 'unknown', updatedAt: source.updatedAt }
      entry.task = { ...entry.task, state: 'completed', reused: true, thinking: cached.thinking, finishedAt: Date.now() }
      this.publish(batch); return
    }
    // 其他会话完成只合并结果，不能顺带重试本版本已失败的会话。
    if (!batch.retryFailures && cached?.fingerprint === fingerprint && 'error' in cached && cached.sourceVersion === source.sourceVersion) {
      entry.task = { ...entry.task, state: 'failed', reused: true, thinking: cached.thinking, error: cached.error, finishedAt: Date.now() }
      this.publish(batch); return
    }
    entry.task = { ...entry.task, state: 'running', startedAt: Date.now() }
    this.publish(batch)
    // 只传入一个会话的事实与材料，既不读取其他会话，也不把已有结果反复送入模型。
    const index: AssistantIndexSnapshot = { generation: batch.index.generation, scope: batch.index.scope, unreadableCount: 0, entries: [batch.index.entries[number]!] }
    try {
      const result = await bounded(entry.abort, async () => {
        const limits = await this.adapter!.indexOptions?.(model, entry.abort.signal) ?? { maxTokens: 8192, thinking: 'provider-default' as const }
        entry.abort.signal.throwIfAborted()
        if (!this.current(batch)) throw new Error('索引范围或来源已变化，请重新执行索引')
        if (!await batch.confirmIdle(source, entry.abort.signal) || !batch.canIndex(source)) { this.deferSession(assistantSessionKey(source)); entry.abort.signal.throwIfAborted() }
        entry.task = { ...entry.task, thinking: limits.thinking }
        this.publish(batch)
        const text = await this.adapter!.reply(model, createAssistantIndexSystem(index, prefix), [{ role: 'user', text: '只为本次唯一会话按固定 JSON 格式建立索引。所有结论附该会话的证据，区分已有任务与建议。' }], entry.abort.signal, (text) => {
          if (entry.task.state !== 'running' || entry.abort.signal.aborted) return
          entry.task = { ...entry.task, text }
          this.publish(batch)
        }, limits)
        entry.abort.signal.throwIfAborted()
        return parseAssistantStructuredIndex(text, index).sessions[0]!
      }, '会话索引')
      if (entry.task.state !== 'running' || !this.current(batch)) return
      if (!batch.canIndex(source)) { this.deferSession(assistantSessionKey(source)); return }
      entry.result = result
      this.cache.set(assistantSessionKey(source), { fingerprint, result, thinking: entry.task.thinking })
      entry.task = { ...entry.task, state: 'completed', text: '', finishedAt: Date.now() }
    } catch (error) {
      if (entry.task.state !== 'running') return
      entry.task = { ...entry.task, state: entry.abort.signal.aborted ? 'cancelled' : 'failed', error: safeError(error), finishedAt: Date.now() }
      if (this.current(batch) && batch.canIndex(source)) this.cache.set(assistantSessionKey(source), { fingerprint, sourceVersion: source.sourceVersion, error: entry.task.error!, thinking: entry.task.thinking })
    }
    this.publish(batch)
  }

  private current(batch: IndexBatch): boolean {
    if (batch.run.state !== 'running') return false
    if (this.batch === batch && !this.disposed && batch.isCurrent()) return true
    this.stop(batch, '索引范围或来源已变化，请重新执行索引')
    return false
  }

  private stop(batch: IndexBatch, reason: string): void {
    if (batch.run.state !== 'running') return
    batch.run = { ...batch.run, state: 'cancelled', error: reason, finishedAt: Date.now() }
    batch.abort.abort(new Error(reason))
    for (const entry of batch.tasks) {
      if (entry.task.state !== 'queued' && entry.task.state !== 'running') continue
      entry.task = { ...entry.task, state: 'cancelled', error: reason, finishedAt: Date.now() }
      entry.abort.abort(new Error(reason))
    }
    this.publish(batch)
  }

  private publish(batch: IndexBatch): void {
    const sessions = batch.tasks.flatMap((entry) => entry.result === undefined ? [] : [entry.result])
    const result = { schemaVersion: 1 as const, generation: batch.index.generation, sessions }
    batch.run = { ...batch.run, tasks: batch.tasks.map((entry) => entry.task), ...(sessions.length === 0 ? {} : { result }), text: batch.run.state === 'completed' && sessions.length === batch.tasks.length ? JSON.stringify(result) : '' }
    batch.changed(batch.run)
  }
}

/** 即使模型适配器忽略取消也按时结算，让队列继续推进；迟到结果不会落入已结束任务。 */
async function bounded<T>(abort: AbortController, work: () => Promise<T>, label: string): Promise<T> {
  abort.signal.throwIfAborted()
  let rejectAbort!: (reason: unknown) => void
  const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => rejectAbort(abort.signal.reason)
  abort.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => abort.abort(new Error(`${label}超过 90 秒，请检查模型服务`)), 90_000)
  try { return await Promise.race([Promise.resolve().then(() => { abort.signal.throwIfAborted(); return work() }), stopped]) }
  finally { clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort) }
}

function safeError(error: unknown): string { return sanitizeSpeechText(error instanceof Error ? error.message : String(error)).slice(0, 500) }
