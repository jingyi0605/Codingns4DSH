import { randomUUID } from 'node:crypto'
import type { AssistantIndexAnalysisRun, AssistantIndexRun, AssistantIndexSnapshot } from '../../shared/contracts/assistant.js'
import { sanitizeSpeechText } from './assistant-summary.js'

/** 索引缓存和索引记录分开：失效只标记结果过期，不删除已完成结果与运行证据。 */
export class AssistantIndexJournal {
  private records: AssistantIndexRun[] = []
  private latest: AssistantIndexSnapshot | undefined
  private builtAt: number | null = null

  begin(trigger: AssistantIndexRun['trigger'], workspaceIds: readonly string[]): string {
    const id = randomUUID()
    this.records.unshift({ id, trigger, workspaceIds: [...workspaceIds], startedAt: Date.now(), finishedAt: null, durationMs: null, state: 'running', generation: null, included: 0, excluded: 0, unreadable: 0, warnings: [], error: null, sessions: [] })
    this.records = this.records.slice(0, 30)
    return id
  }

  complete(id: string, snapshot: AssistantIndexSnapshot, warnings: readonly string[], failures: ReadonlyMap<string, string>): void {
    this.latest = snapshot
    this.builtAt = Date.now()
    this.finish(id, {
      state: 'completed', generation: snapshot.generation, included: snapshot.entries.length, excluded: snapshot.excludedTargets?.length ?? 0, unreadable: snapshot.unreadableCount, warnings: [...warnings],
      sessions: snapshot.entries.map((entry) => ({ sessionId: entry.sessionId, title: entry.title, workspaceName: entry.workspaceName, result: failures.has(`${entry.hostId}:${entry.sessionId}`) ? 'failed' : entry.summary ? 'read' : 'empty', error: failures.get(`${entry.hostId}:${entry.sessionId}`) ?? null })),
    })
  }

  fail(id: string, error: unknown): void {
    this.finish(id, { state: 'failed', error: sanitizeSpeechText(error instanceof Error ? error.message : String(error)).slice(0, 500) })
  }

  /** 模型异步生成时只更新调用证据，运行记录不包含模型正文。 */
  updateAnalysis(run: AssistantIndexAnalysisRun): void {
    const { text: _text, requestId: _requestId, result: _result, tasks, ...metadata } = run
    const analysis = { ...metadata, ...(tasks === undefined ? {} : { tasks: tasks.map(({ text: _raw, ...task }) => task) }) }
    this.records = this.records.map((record) => record.generation === run.generation ? { ...record, analysis } : record)
  }

  snapshot(): { readonly index: AssistantIndexSnapshot | undefined; readonly indexedAt: number | null; readonly records: readonly AssistantIndexRun[] } {
    return { index: this.latest, indexedAt: this.builtAt, records: this.records }
  }

  clear(): void { this.records = []; this.latest = undefined; this.builtAt = null }

  private finish(id: string, patch: Partial<AssistantIndexRun>): void {
    const now = Date.now()
    this.records = this.records.map((record) => record.id === id ? { ...record, ...patch, finishedAt: now, durationMs: now - record.startedAt } : record)
  }
}
