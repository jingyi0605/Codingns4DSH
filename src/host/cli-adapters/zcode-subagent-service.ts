/**
 * ZCode 子代理服务：RPC 只接受 DSH 会话 ID，原生库路径与 Provider 会话标识留在 Host。
 *
 * 读取放进 worker 线程（`node:sqlite` 是同步 API，
 * 大库上的解析不能阻塞会话与 RPC 事件循环），并做短 TTL 缓存与在飞请求去重，
 * 让面板的 3 秒轮询不会反复开库。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ZcodeSubagentCursor, ZcodeSubagentDetail, ZcodeSubagentSnapshot } from '../../shared/contracts/zcode-subagent.js'
import type { CodingNsCliSessionStore } from './session-store.js'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, limit = 400): string => typeof value === 'string' ? value.slice(0, limit) : ''
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0

/** Host 只接受界面回传的短游标；越界值直接拒绝，不进入 SQL。 */
function readCursor(value: unknown): ZcodeSubagentCursor | undefined {
  if (value === undefined) return undefined
  const cursor = object(value)
  if (!Number.isSafeInteger(cursor.beforeTime) || number(cursor.beforeTime) < 0) throw new Error('Invalid subagent history cursor')
  if (typeof cursor.beforeId !== 'string' || cursor.beforeId.length > 200) throw new Error('Invalid subagent history cursor')
  return { beforeTime: number(cursor.beforeTime), beforeId: cursor.beforeId }
}

export class ZcodeSubagentService {
  private readonly cache = new Map<string, { at: number; binding: string; value: ZcodeSubagentSnapshot }>()
  private readonly pending = new Map<string, Promise<ZcodeSubagentSnapshot>>()
  private readonly detailPending = new Map<string, Promise<ZcodeSubagentDetail>>()
  private readonly workers = new Set<Worker>()
  constructor(
    private readonly store: Pick<CodingNsCliSessionStore, 'get'>,
    private readonly databasePath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
  ) {}

  async read(payload: unknown): Promise<ZcodeSubagentSnapshot> {
    const sessionId = text(object(payload).sessionId, 200)
    const binding = sessionId === '' ? undefined : this.store.get(sessionId)
    if (sessionId === '' || binding?.adapterId !== 'zcode' || binding.status === 'archived') return { available: false, reason: 'not-zcode', runs: [], hasMore: false }
    const ids = [...new Set([binding.providerSessionId].filter((value): value is string => typeof value === 'string' && value !== ''))]
    if (ids.length === 0) return { available: true, reason: null, runs: [], hasMore: false }
    const key = ids.join('|')
    const cached = this.cache.get(sessionId)
    if (cached !== undefined && cached.binding === key && Date.now() - cached.at < 2500) return cached.value
    const pendingKey = `${sessionId}:${key}`
    const previous = this.pending.get(pendingKey)
    if (previous !== undefined) return previous
    const request = this.runInWorker<ZcodeSubagentSnapshot>({ ids })
      .then(value => {
        // 历史会话可能很多，缓存必须有上界。
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(sessionId, { at: Date.now(), binding: key, value })
        return value
      })
      .finally(() => this.pending.delete(pendingKey))
    this.pending.set(pendingKey, request)
    return request
  }

  async readAgent(payload: unknown): Promise<ZcodeSubagentDetail> {
    const input = object(payload)
    const sessionId = text(input.sessionId, 200)
    const binding = sessionId === '' ? undefined : this.store.get(sessionId)
    if (sessionId === '' || binding?.adapterId !== 'zcode' || binding.status === 'archived') throw new Error('请选择一个 ZCode 会话')
    const ids = [...new Set([binding.providerSessionId].filter((value): value is string => typeof value === 'string' && value !== ''))]
    const agentId = text(input.agentId, 400)
    if (agentId === '') throw new Error('缺少子代理标识')
    const cursor = readCursor(input.cursor)
    const key = JSON.stringify([sessionId, ids, agentId, cursor ?? null])
    const existing = this.detailPending.get(key)
    if (existing !== undefined) return existing
    const request = this.runInWorker<ZcodeSubagentDetail>({ ids, agentId, ...(cursor === undefined ? {} : { cursor }) })
      .finally(() => this.detailPending.delete(key))
    this.detailPending.set(key, request)
    return request
  }

  private runInWorker<T>(request: { ids: string[]; agentId?: string; cursor?: ZcodeSubagentCursor }): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./zcode-subagent-worker.js', import.meta.url), { workerData: { databasePath: this.databasePath, ...request } })
      this.workers.add(worker)
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('ZCode subagent database read timed out')) }, 15_000)
      worker.once('message', (message: { value?: T; error?: string }) => {
        clearTimeout(timer)
        if (message.value !== undefined) resolve(message.value)
        else reject(new Error(message.error ?? 'Subagent reader failed'))
      })
      worker.once('error', error => { clearTimeout(timer); reject(error) })
      worker.once('exit', code => {
        clearTimeout(timer)
        this.workers.delete(worker)
        // Reject if a worker exits without a reply, including disposal with code 0.
        reject(new Error(`Subagent reader exited (${String(code)})`))
      })
    })
  }

  dispose(): void {
    for (const worker of this.workers) void worker.terminate()
    this.workers.clear()
    this.cache.clear()
    this.pending.clear()
    this.detailPending.clear()
  }
}
