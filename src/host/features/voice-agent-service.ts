export interface VoiceAgentCapabilities {
  readonly secureContext: boolean
  readonly realtime: boolean
  readonly recognition: boolean
  readonly audioInput: boolean
  readonly wakeWord: boolean
  readonly bargeIn: boolean
  readonly streamingAudio: boolean
  readonly readAloud: boolean
  readonly voices: boolean
}

export interface VoiceAction {
  readonly execute: (args: unknown, control: VoiceActionControl) => unknown | Promise<unknown>
  readonly timeoutMs?: number
}

export interface VoiceActionControl {
  readonly resolve: (result: unknown, options?: unknown) => boolean
}

export interface VoiceActionRegistration {
  dispose(): void
}

export type VoiceEvent =
  | { readonly type: 'status'; readonly connected?: boolean; readonly status?: string }
  | { readonly type: 'phase'; readonly phase: string }
  | { readonly type: 'transcript'; readonly role: string; readonly text: string; readonly final?: boolean; readonly source?: string }
  | { readonly type: 'action'; readonly callId: string; readonly name: string; readonly arguments: string; readonly ownerId?: string | null }
  | { readonly type: 'action-result'; readonly callId: string; readonly name: string; readonly ok: boolean; readonly output?: unknown; readonly error?: string }
  | { readonly type: 'audio-level'; readonly source: string; readonly level: number }
  | { readonly type: 'interrupted' }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly recoverable?: boolean }
  | { readonly type: 'closed' }

export interface StartConversationOptions {
  readonly ownerId?: string | null
  readonly context?: unknown
  readonly initialUserText?: string
}

export interface VoiceConversation {
  readonly id: string
  subscribe(listener: (event: VoiceEvent) => void): () => void
  updateContext(context: unknown): void
  resolveAction(callId: string, result: unknown, options?: unknown): void
  interrupt(): void
  end(): Promise<void>
  /** 供 Host 传输层把供应商事件送入服务；不是独立 invoke API。 */
  handleEvent(event: VoiceEvent): void
}

interface ActionRegistryEntry {
  readonly ownerPrefix: string
  readonly actions: Readonly<Record<string, VoiceAction>>
}

interface PendingAction {
  readonly callId: string
  readonly name: string
  readonly conversation: ConversationImpl
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
}

let nextConversationId = 0

/** Host 侧 voiceAgent 契约复刻；不持有当前页面会话，也不依赖具体音频供应商。 */
export class VoiceAgentService {
  private readonly registries: ActionRegistryEntry[] = []
  private capabilitySnapshot: VoiceAgentCapabilities

  constructor(capabilities: Partial<VoiceAgentCapabilities> = {}) {
    this.capabilitySnapshot = {
      secureContext: capabilities.secureContext ?? false,
      realtime: capabilities.realtime ?? false,
      recognition: capabilities.recognition ?? false,
      audioInput: capabilities.audioInput ?? false,
      wakeWord: capabilities.wakeWord ?? false,
      bargeIn: capabilities.bargeIn ?? false,
      streamingAudio: capabilities.streamingAudio ?? false,
      readAloud: capabilities.readAloud ?? false,
      voices: capabilities.voices ?? false,
    }
  }

  capabilities(): VoiceAgentCapabilities {
    return { ...this.capabilitySnapshot }
  }

  /** Host 只更新运行时探测结果，不改变 voiceAgent 的契约面。 */
  updateCapabilities(capabilities: Partial<VoiceAgentCapabilities>): void {
    this.capabilitySnapshot = { ...this.capabilitySnapshot, ...capabilities }
  }

  async startConversation(options?: StartConversationOptions): Promise<VoiceConversation> {
    return new ConversationImpl(this, options)
  }

  registerActions(ownerPrefix: string, actions: Record<string, VoiceAction>): { dispose(): void } {
    // 参考实现只做真假校验，不擅自改写前缀；startsWith 的字节语义由调用方负责。
    if (typeof ownerPrefix !== 'string' || ownerPrefix === '') throw new TypeError('ownerPrefix is required')
    if (!actions || typeof actions !== 'object' || Array.isArray(actions)) throw new TypeError('actions must be an object of executors')
    const normalized: Record<string, VoiceAction> = {}
    for (const [name, action] of Object.entries(actions)) {
      if (!action || typeof action !== 'object' || typeof action.execute !== 'function') {
        throw new TypeError(`action ${name} must provide an execute function`)
      }
      normalized[name] = action
    }
    const entry: ActionRegistryEntry = { ownerPrefix, actions: normalized }
    this.registries.push(entry)
    return { dispose: () => {
      const index = this.registries.indexOf(entry)
      if (index >= 0) this.registries.splice(index, 1)
    } }
  }

  /** 参考实现的兼容别名；动作仍只能从事件出口自动触发。 */
  registerTools(ownerPrefix: string, actions: Record<string, VoiceAction>): { dispose(): void } {
    return this.registerActions(ownerPrefix, actions)
  }

  lookupActions(ownerId: string | null | undefined): Readonly<Record<string, VoiceAction>> | null {
    if (!ownerId) return null
    const merged: Record<string, VoiceAction> = {}
    let matched = false
    for (let index = this.registries.length - 1; index >= 0; index -= 1) {
      const entry = this.registries[index]
      if (entry && ownerId.startsWith(entry.ownerPrefix)) {
        matched = true
        for (const [name, action] of Object.entries(entry.actions)) if (!(name in merged)) merged[name] = action
      }
    }
    return matched ? merged : null
  }

  dispatchAction(conversation: ConversationImpl, event: Extract<VoiceEvent, { type: 'action' }>): void {
    const actions = this.lookupActions(event.ownerId ?? conversation.ownerId)
    if (actions === null) return
    const action = actions[event.name]
    if (!action) {
      emitActionResult(conversation, event, { ok: false, error: `Unknown action: ${event.name}` })
      return
    }
    let args: unknown
    try {
      args = typeof event.arguments === 'string' ? JSON.parse(event.arguments) : event.arguments
    } catch {
      emitActionResult(conversation, event, { ok: false, error: 'Invalid action arguments.' })
      return
    }
    if (!isActionArguments(args)) {
      emitActionResult(conversation, event, { ok: false, error: 'Invalid action arguments.' })
      return
    }
    const pending: PendingAction = { callId: event.callId, name: event.name, conversation, settled: false }
    pending.timer = setTimeout(() => settlePending(pending, { ok: false, error: 'Action execution timed out.' }), validTimeout(action.timeoutMs))
    unrefTimer(pending.timer)
    const control: VoiceActionControl = { resolve: (result) => settlePending(pending, result) }
    try {
      const result = action.execute(args, control)
      if (isPromiseLike(result)) {
        void Promise.resolve(result).then(
          (value) => settlePending(pending, value === undefined ? { ok: true } : value),
          (error: unknown) => settlePending(pending, { ok: false, error: errorMessage(error) }),
        )
      } else settlePending(pending, result === undefined ? { ok: true } : result)
    } catch (error) {
      settlePending(pending, { ok: false, error: errorMessage(error) })
    }
  }
}

class ConversationImpl implements VoiceConversation {
  readonly id = `realtime-voice-${++nextConversationId}`
  readonly ownerId: string | null | undefined
  private readonly service: VoiceAgentService
  private readonly listeners = new Set<(event: VoiceEvent) => void>()
  private closed = false
  private ending = false
  private readonly pendingEvents: VoiceEvent[] = []

  constructor(service: VoiceAgentService, options?: StartConversationOptions) {
    this.service = service
    this.ownerId = options?.ownerId
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    if (this.closed) return () => undefined
    const firstSubscriber = this.listeners.size === 0
    this.listeners.add(listener)
    if (firstSubscriber) {
      const pending = this.pendingEvents.splice(0)
      for (const event of pending) safeCall(listener, event)
    }
    return () => this.listeners.delete(listener)
  }

  updateContext(_context: unknown): void {
    if (this.closed) throw new Error('Conversation is closed.')
  }

  resolveAction(_callId: string, _result: unknown, _options?: unknown): void {
    if (this.closed) throw new Error('Conversation is closed.')
  }

  interrupt(): void {
    if (!this.closed) this.emit({ type: 'interrupted' })
  }

  async end(): Promise<void> {
    if (this.closed || this.ending) return
    this.ending = true
    this.emit({ type: 'phase', phase: 'stopped' })
    this.emit({ type: 'closed' })
    this.closed = true
    this.ending = false
    this.listeners.clear()
    this.pendingEvents.length = 0
  }

  handleEvent(event: VoiceEvent): void {
    if (this.closed) return
    this.emit(event)
    if (event.type === 'action') this.service.dispatchAction(this, event)
  }

  closedForAction(): boolean {
    return this.closed
  }

  emit(event: VoiceEvent): void {
    if (this.listeners.size === 0 && this.pendingEvents.length < 16) this.pendingEvents.push(event)
    for (const listener of [...this.listeners]) safeCall(listener, event)
  }
}

function validTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 300_000
}

function settlePending(pending: PendingAction, result: unknown): boolean {
  if (pending.settled || pending.conversation.closedForAction()) return false
  pending.settled = true
  if (pending.timer !== undefined) clearTimeout(pending.timer)
  emitActionResult(pending.conversation, { type: 'action', callId: pending.callId, name: pending.name, arguments: '{}' }, result)
  return true
}

function normalizeResult(result: unknown): { ok: true; output: unknown } | { ok: false; error: string } {
  if (isFailure(result)) return { ok: false, error: result.error }
  return { ok: true, output: result }
}

function isFailure(value: unknown): value is { ok: false; error: string } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false && typeof (value as { error?: unknown }).error === 'string'
}

function truncateOutput(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 3997)}...` : value
  if (Array.isArray(value)) return value.map((item) => truncateOutput(item))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateOutput(item)]))
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emitActionResult(
  conversation: ConversationImpl,
  event: Extract<VoiceEvent, { type: 'action' }>,
  result: unknown,
): void {
  // 参考实现的 action-result.ok 表示工具结果已成功送入会话；动作自身返回
  // `{ ok: false, error }` 时，失败信息仍位于 output 中，不能改成外层 error。
  try {
    conversation.resolveAction(event.callId, result)
    conversation.emit({
      type: 'action-result',
      callId: event.callId,
      name: event.name,
      ok: true,
      output: truncateOutput(result),
    })
  } catch (error) {
    conversation.emit({
      type: 'action-result',
      callId: event.callId,
      name: event.name,
      ok: false,
      error: errorMessage(error),
    })
  }
}

function isActionArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

function safeCall(listener: (event: VoiceEvent) => void, event: VoiceEvent): void {
  try { listener(event) } catch { /* 单个订阅者异常不能破坏事件分发 */ }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
  candidate.unref?.()
}
