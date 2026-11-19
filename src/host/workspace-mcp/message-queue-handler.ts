import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { WorkspaceSessionControlAdapter } from '../../dsh-capabilities/host/workspace-session-control-adapter.js'
import type { CodingNsHostServices } from '../features/types.js'
import { WorkspaceMcpHandlerError as QueueError } from './file-handler.js'

const MAX_SESSION_QUEUE = 100
const MAX_PENDING = 256
export const DEFAULT_MESSAGE_PRIORITY = 50
export const MCP_MESSAGE_PREFIX = 'mcp-msg-'

type State = 'queued' | 'submitting' | 'accepted' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'uncertain'
interface Message {
  messageId: string
  sessionId: string
  workspaceId: string
  agentId?: string
  text?: string
  priority: number
  sentAt: string
  state: State
  startedAt?: number
  turn?: number
  errorCode?: string
}
interface SessionAgent { workspaceId: string; agentId?: string; priority?: number }
interface QueueData { version: 1; messages: Message[]; sessions: Record<string, SessionAgent> }
export type QueueNotice = {
  sessionId: string; workspaceId: string; agentId?: string; messageId: string
} & (
  | { type: 'session.message_queued'; queuePosition: number; estimatedWaitMs: number }
  | { type: 'session.message_dequeued'; reason: 'processing' | 'cancelled' | 'failed' | 'uncertain' }
  | { type: 'session.queue_changed'; queuePosition: number; priority: number }
  | { type: 'session.agent_message_sent'; message: string }
  | { type: 'session.failed'; errorCode: string; errorMessage: string }
)

interface QueueOptions {
  services: CodingNsHostServices
  control: WorkspaceSessionControlAdapter
  workspaceOf: (sessionId: string) => string | undefined
  notice: (event: QueueNotice) => void
  filePath?: string
}

/** Native session events advance the MCP queue. */
export class WorkspaceMcpMessageQueue {
  private data: QueueData = { version: 1, messages: [], sessions: {} }
  private loaded = false
  private tail = Promise.resolve()
  private readonly active = new Map<string, Promise<void>>()
  private readonly openTurns = new Map<string, number>()
  private readonly durations = new Map<string, number>()
  private readonly disposers: (() => void)[] = []
  private readonly lifetime = new AbortController()
  private enabled = false

  private readonly options: QueueOptions

  constructor(options: QueueOptions) {
    this.options = options
    const native = options.services.nativeSessions
    if (native?.supportsEvents === true) this.disposers.push(native.subscribe({ onEvent: (session, event) => {
      const id = sessionIdentity(session)
      if (id !== undefined) this.observe(id, event)
    } }))
    const dispose = options.services.events?.on('agent/status', (value: unknown) => {
      const row = record(value)
      const agent = record(row?.agent)
      const id = sessionIdentity(agent?.session) ?? sessionIdentity(agent)
      if (id !== undefined && row?.status === 'idle') this.run(this.settleIdle(id))
    })
    if (typeof dispose === 'function') this.disposers.push(dispose as () => void)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) this.run(this.serial(() => {
      for (const id of new Set(this.data.messages.filter((row) => row.state === 'queued' || isActive(row.state)).map((row) => row.sessionId))) this.wake(id)
    }))
  }

  async close(): Promise<void> {
    this.enabled = false
    this.lifetime.abort()
    for (const dispose of this.disposers.splice(0)) dispose()
    await this.tail
    this.openTurns.clear()
    // Native prompt admission can outlive an aborted caller; its persisted checkpoint is reconciled at startup.
  }

  bindSession(sessionId: string, workspaceId: string, agentId?: string, priority?: number): Promise<void> {
    return this.change(() => { Object.defineProperty(this.data.sessions, sessionId, { value: { workspaceId, agentId, priority }, enumerable: true, configurable: true, writable: true }) })
  }

  async sessionAgent(sessionId: string, workspaceId: string): Promise<string | undefined> {
    await this.serial(() => undefined)
    const row = Object.hasOwn(this.data.sessions, sessionId) ? this.data.sessions[sessionId] : undefined
    return row?.workspaceId === workspaceId ? row.agentId : undefined
  }

  async agentContext(sessionId: string, workspaceId: string, turn?: number): Promise<{ agentId?: string; messageId?: string }> {
    return this.serial(() => {
      const row = this.data.messages.find((item) => item.workspaceId === workspaceId && item.sessionId === sessionId
        && (turn === undefined ? item.state === 'processing' : item.turn === turn))
      if (row !== undefined) return { ...(row.agentId === undefined ? {} : { agentId: row.agentId }), messageId: row.messageId }
      const binding = Object.hasOwn(this.data.sessions, sessionId) ? this.data.sessions[sessionId] : undefined
      return binding?.workspaceId === workspaceId && binding.agentId !== undefined ? { agentId: binding.agentId } : {}
    })
  }

  async messageAgent(sessionId: string, workspaceId: string, messageId: string): Promise<string | undefined> {
    await this.serial(() => undefined)
    return this.data.messages.find((row) => row.sessionId === sessionId && row.workspaceId === workspaceId
      && row.messageId === messageId && row.turn !== undefined)?.agentId
  }

  async submit(input: { sessionId: string; workspaceId: string; text: string; agentId?: string; priority?: number }, signal: AbortSignal, created = false): Promise<unknown> {
    const messageId = `${MCP_MESSAGE_PREFIX}${randomUUID()}`
    const { sessionId, workspaceId } = input
    const receipt = await this.change(() => {
      signal.throwIfAborted()
      if (!this.enabled || this.lifetime.signal.aborted) throw new QueueError('WORKSPACE_MCP_STOPPED', 'The message queue is disabled.')
      const waiting = this.waiting(sessionId, workspaceId)
      if (waiting.length >= MAX_SESSION_QUEUE || this.data.messages.filter((row) => row.state === 'queued' || isActive(row.state)).length >= MAX_PENDING) {
        throw new QueueError('QUEUE_FULL', 'The message queue is full.')
      }
      const binding = Object.hasOwn(this.data.sessions, sessionId) ? this.data.sessions[sessionId] : undefined
      const agentId = input.agentId ?? (binding?.workspaceId === workspaceId ? binding.agentId : undefined)
      const priority = input.priority ?? (binding?.workspaceId === workspaceId ? binding.priority : undefined) ?? DEFAULT_MESSAGE_PRIORITY
      const row: Message = { ...input, priority, messageId, sentAt: new Date().toISOString(), state: 'queued', ...(agentId === undefined ? {} : { agentId }) }
      this.data.messages.push(row)
      const result = this.receipt(row)
      return { row, result }
    })
    const waiting = receipt.result.queuePosition > 1 || this.active.has(sessionId) || this.openTurns.has(sessionId) || this.options.control.isBusy?.(sessionId) === true
      || this.data.messages.some((row) => row.sessionId === sessionId && isActive(row.state))
    this.notice(receipt.row, { type: 'session.message_queued', queuePosition: receipt.result.queuePosition, estimatedWaitMs: receipt.result.estimatedWaitMs })
    if (waiting) {
      this.wake(sessionId, created ? workspaceId : undefined)
      return receipt.result
    }
    await this.wake(sessionId, created ? workspaceId : undefined)
    return this.serial(() => {
      const row = this.find(sessionId, workspaceId, messageId)
      const result = this.receipt(row)
      return row.errorCode === undefined ? result : { ...result, error: { code: row.errorCode, message: 'The message did not complete. Check its status before retrying.' } }
    })
  }

  status(sessionId: string, workspaceId: string, messageId: string): Promise<unknown> {
    return this.serial(() => this.receipt(this.find(sessionId, workspaceId, messageId)))
  }

  cancel(sessionId: string, workspaceId: string, messageId: string): Promise<unknown> {
    return this.change(() => {
      const row = this.find(sessionId, workspaceId, messageId)
      if (row.state === 'cancelled') return undefined
      if (row.state !== 'queued') throw new QueueError('CANNOT_CANCEL', 'The message is no longer waiting in the MCP queue.')
      row.state = 'cancelled'
      delete row.text
      return row
    }).then((row) => {
      if (row !== undefined) this.notice(row, { type: 'session.message_dequeued', reason: 'cancelled' })
      this.wake(sessionId)
      return { success: true }
    })
  }

  prioritize(sessionId: string, workspaceId: string, messageId: string, priority: number): Promise<unknown> {
    return this.change(() => {
      const row = this.find(sessionId, workspaceId, messageId)
      if (row.state !== 'queued') throw new QueueError('CANNOT_PRIORITIZE', 'The message is no longer waiting in the MCP queue.')
      row.priority = priority
      return { row, newPosition: this.receipt(row).queuePosition }
    }).then(({ row, newPosition }) => {
      this.notice(row, { type: 'session.queue_changed', queuePosition: newPosition, priority })
      this.wake(sessionId)
      return { success: true, newPosition, reason: 'Priority updated.' }
    })
  }

  peek(sessionId: string, workspaceId: string, limit: number, includeProcessing: boolean): Promise<unknown> {
    return this.serial(() => {
      const current = includeProcessing ? this.data.messages.find((row) => row.sessionId === sessionId && row.workspaceId === workspaceId && isActive(row.state)) : undefined
      const all = this.waiting(sessionId, workspaceId)
      return {
        ...(current === undefined ? {} : { current: { ...this.receipt(current), estimatedRemainingMs: this.remaining(current) } }),
        queue: all.slice(0, limit).map((row) => ({ ...this.receipt(row), position: all.indexOf(row) + 1 })),
        hasMore: all.length > limit,
      }
    })
  }

  private wake(sessionId: string, createdWorkspace?: string): Promise<void> {
    if (!this.enabled || this.lifetime.signal.aborted) return Promise.resolve()
    const current = this.active.get(sessionId)
    if (current !== undefined) return current
    const task = this.deliver(sessionId, createdWorkspace).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, task)
    this.run(task)
    return task
  }

  private async deliver(sessionId: string, createdWorkspace?: string): Promise<void> {
    const workspaceId = this.options.workspaceOf(sessionId) ?? createdWorkspace
    if (workspaceId === undefined) return
    const next = await this.change(() => {
      if (!this.enabled || this.lifetime.signal.aborted || this.openTurns.has(sessionId) || this.options.control.isBusy?.(sessionId) === true) return undefined
      if (this.data.messages.some((row) => row.sessionId === sessionId && isActive(row.state))) return undefined
      const row = this.waiting(sessionId, workspaceId)[0]
      if (row === undefined) return undefined
      row.state = 'submitting'
      row.startedAt = Date.now()
      return row
    })
    if (next === undefined) return
    // Persistence can yield while the native UI starts a turn or moves the session.
    if (!this.enabled || (this.options.workspaceOf(sessionId) ?? createdWorkspace) !== workspaceId
      || this.openTurns.has(sessionId) || this.options.control.isBusy?.(sessionId) === true) {
      await this.change(() => {
        const row = this.find(sessionId, workspaceId, next.messageId)
        row.state = 'queued'
        delete row.startedAt
      })
      return
    }
    if (this.lifetime.signal.aborted) return
    let result: State
    try {
      const response = await this.options.control.prompt({ requestId: next.messageId, sessionId, mode: 'queue', content: [{ type: 'text', text: next.text! }] }, this.lifetime.signal)
      result = record(response)?.accepted === true ? 'accepted' : 'failed'
    } catch {
      result = 'uncertain'
    }
    if (this.lifetime.signal.aborted) return
    const updated = await this.change(() => {
      const row = this.find(sessionId, workspaceId, next.messageId)
      if (row.state !== 'submitting') return undefined // A native event can arrive before the RPC reply.
      row.state = result
      if (result !== 'accepted') {
        delete row.text
        row.errorCode = result === 'failed' ? 'WORKSPACE_MCP_PROMPT_REJECTED' : 'WORKSPACE_MCP_PROMPT_UNCERTAIN'
      }
      return row
    })
    if (updated !== undefined && (result === 'failed' || result === 'uncertain')) {
      this.notice(updated, { type: 'session.message_dequeued', reason: result })
      this.notice(updated, { type: 'session.failed', errorCode: updated.errorCode!, errorMessage: 'DSH did not confirm the message. Check its status before retrying.' })
      this.wakeAfterDelivery(sessionId)
    }
  }

  private wakeAfterDelivery(sessionId: string): void {
    const current = this.active.get(sessionId)
    if (current === undefined) this.wake(sessionId)
    else this.run(current.then(() => { this.wake(sessionId) }))
  }

  private async settleIdle(sessionId: string): Promise<void> {
    if (!this.data.messages.some((row) => row.sessionId === sessionId && (row.state === 'queued' || isActive(row.state)))) return
    await this.active.get(sessionId)?.catch(() => undefined)
    if (this.lifetime.signal.aborted) return
    const pending = this.options.control.isPromptPending
    if (pending !== undefined) {
      const rejected = await this.change(() => {
        if (this.openTurns.has(sessionId) || this.options.control.isBusy?.(sessionId) === true) return undefined
        const row = this.data.messages.find((item) => item.sessionId === sessionId && item.state === 'accepted')
        if (row === undefined || pending(sessionId, row.messageId) !== false) return undefined
        row.state = 'failed'
        row.errorCode = 'WORKSPACE_MCP_PROMPT_DROPPED'
        delete row.text
        return row
      })
      if (rejected !== undefined) {
        this.notice(rejected, { type: 'session.message_dequeued', reason: 'failed' })
        this.notice(rejected, { type: 'session.failed', errorCode: 'WORKSPACE_MCP_PROMPT_DROPPED', errorMessage: 'DSH removed the message before starting its turn.' })
      }
    }
    await this.wake(sessionId)
  }

  private observe(sessionId: string, value: unknown): void {
    const event = record(value)
    const data = record(event?.data)
    if (data === undefined || this.lifetime.signal.aborted || (!this.enabled && !this.loaded)) return
    if (event?.type === 'turn/start' && typeof data.turn === 'number') {
      this.openTurns.set(sessionId, data.turn)
    } else if (event?.type === 'user/message') {
      const message = record(data.message) ?? data
      const id = record(message.source)?.rpcId
      const turn = typeof data.turn === 'number' ? data.turn : this.openTurns.get(sessionId)
      if (typeof id !== 'string' || !id.startsWith(MCP_MESSAGE_PREFIX) || turn === undefined) return
      this.run(this.change(() => {
        const row = this.data.messages.find((item) => item.messageId === id && item.sessionId === sessionId && (isActive(item.state) || item.state === 'uncertain'))
        if (row === undefined || row.turn !== undefined) return undefined
        row.turn = turn
        row.state = 'processing'
        const text = row.text
        delete row.text
        return { row, text }
      }).then((update) => {
        if (update === undefined) return
        this.notice(update.row, { type: 'session.message_dequeued', reason: 'processing' })
        if (update.row.agentId !== undefined && update.text !== undefined) this.notice(update.row, { type: 'session.agent_message_sent', message: update.text })
      }))
    } else if (event?.type === 'turn/end' && typeof data.turn === 'number') {
      const turn = data.turn
      if (this.openTurns.get(sessionId) === turn) this.openTurns.delete(sessionId)
      if (!this.data.messages.some((item) => item.sessionId === sessionId && (isActive(item.state) || item.state === 'queued' || item.state === 'uncertain'))) return
      this.run(this.change(() => {
        const row = this.data.messages.find((item) => item.sessionId === sessionId && item.turn === turn && (item.state === 'processing' || item.state === 'uncertain'))
        if (row === undefined) return
        const reason = record(data.reason)
        row.state = reason?.kind === 'completed' ? 'completed' : reason?.kind === 'aborted' ? 'cancelled' : 'failed'
        if (row.state === 'failed') row.errorCode = String(record(reason?.error)?.code ?? 'WORKSPACE_MCP_TURN_FAILED').slice(0, 128)
        else delete row.errorCode
        if (row.startedAt !== undefined) this.durations.set(sessionId, Math.max(1_000, Date.now() - row.startedAt))
      }).then(() => this.wakeAfterDelivery(sessionId)))
    }
  }

  private waiting(sessionId: string, workspaceId: string): Message[] {
    return this.data.messages.filter((row) => row.sessionId === sessionId && row.workspaceId === workspaceId && row.state === 'queued')
      .sort((a, b) => b.priority - a.priority)
  }

  private find(sessionId: string, workspaceId: string, messageId: string): Message {
    const row = this.data.messages.find((item) => item.sessionId === sessionId && item.workspaceId === workspaceId && item.messageId === messageId)
    if (row === undefined) throw new QueueError('NOT_FOUND', 'The message was not found in this session.')
    return row
  }

  private remaining(row: Message): number {
    return Math.max(0, (this.durations.get(row.sessionId) ?? 30_000) - (Date.now() - (row.startedAt ?? Date.now())))
  }

  private receipt(row: Message) {
    const queued = row.state === 'queued'
    const queuePosition = queued ? this.waiting(row.sessionId, row.workspaceId).indexOf(row) + 1 : 0
    const active = this.data.messages.find((entry) => entry.sessionId === row.sessionId && isActive(entry.state))
    const estimatedWaitMs = queued ? (this.durations.get(row.sessionId) ?? 30_000) * (queuePosition - 1) + (active === undefined ? 30_000 : this.remaining(active)) : 0
    return {
      accepted: row.state !== 'failed' && row.state !== 'uncertain' && row.state !== 'cancelled',
      success: row.state !== 'failed' && row.state !== 'uncertain' && row.state !== 'cancelled',
      messageId: row.messageId, sessionId: row.sessionId, workspaceId: row.workspaceId, agentId: row.agentId,
      status: row.state === 'accepted' || row.state === 'submitting' ? 'processing' : row.state,
      priority: row.priority, sentAt: row.sentAt, canCancel: queued, canPrioritize: queued,
      ...(queued ? { reason: 'Waiting for the session to be ready.' } : {}),
      ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
      queuePosition, estimatedWaitMs,
    }
  }

  private notice(row: Message, event: DistributiveOmit<QueueNotice, 'sessionId' | 'workspaceId' | 'agentId' | 'messageId'>): void {
    this.options.notice({ ...event, sessionId: row.sessionId, workspaceId: row.workspaceId, messageId: row.messageId, ...(row.agentId === undefined ? {} : { agentId: row.agentId }) })
  }

  private change<T>(action: () => T): Promise<T> {
    return this.serial(async () => {
      const previous = structuredClone(this.data)
      const before = JSON.stringify(previous)
      try {
        const result = action()
        if (JSON.stringify(this.data) !== before) await this.persist()
        return result
      } catch (error) { this.data = previous; throw error }
    })
  }

  private serial<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { await this.load(); return action() })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private get path(): string {
    return this.options.filePath ?? join(process.env.CODINGNS4DSH_STATE_DIR?.trim() || join(homedir(), '.config', 'codingns4dsh'), 'workspace-mcp-messages.json')
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    const text = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (text !== undefined) {
      const state = JSON.parse(text) as QueueData
      if (state.version !== 1 || !Array.isArray(state.messages) || record(state.sessions) === undefined) throw new Error('Invalid Workspace MCP message store.')
      this.data = state
      // Never resend an admission whose outcome is unknown after a process restart.
      for (const row of this.data.messages) if (isActive(row.state)) {
        row.state = 'uncertain'
        row.errorCode = 'WORKSPACE_MCP_PROMPT_UNCERTAIN'
        delete row.text
      }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const path = this.path
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(this.data), { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    }
  }

  private run(promise: Promise<unknown>): void { void promise.catch(() => undefined) }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
function isActive(value: State): boolean { return value === 'submitting' || value === 'accepted' || value === 'processing' }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function sessionIdentity(value: unknown): string | undefined {
  const row = record(value)
  const id = record(row?.header)?.id ?? row?.id ?? row?.sessionId
  return typeof id === 'string' ? id : undefined
}
