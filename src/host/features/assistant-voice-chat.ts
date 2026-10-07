import type { AssistantChatMessage, AssistantChatRun, AssistantIndexSnapshot } from '../../shared/contracts/assistant.js'
import { AssistantTextChat } from './assistant-text-chat.js'
import type { AssistantConversation } from './assistant-conversation.js'

export interface AssistantVoiceChatContext {
  readonly index: AssistantIndexSnapshot
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly isCurrent: () => boolean
  readonly createSystem: (index: AssistantIndexSnapshot) => string
}

interface VoiceChatEntry {
  readonly ownerId: string
  readonly epoch: number
  readonly requestId: string
  readonly text: string
  readonly context: AssistantVoiceChatContext
  start?: Promise<AssistantChatRun>
  started: boolean
  cancelled: boolean
  committed: boolean
}

/** 一份租约拥有一份有界历史；只有完成且仍有效的问答对能进入下一轮。 */
export class AssistantVoiceChat {
  private readonly entries = new Map<string, VoiceChatEntry>()
  private history: AssistantChatMessage[] = []
  private contextKey = ''
  private active: VoiceChatEntry | undefined
  private readonly cancelledRequests = new Set<string>()
  private orderKey = ''
  private sequence = 0

  constructor(private readonly chat: AssistantTextChat, private readonly conversation?: AssistantConversation) {}

  async start(ownerId: string, epoch: number, requestId: string, text: string, context: AssistantVoiceChatContext, sequence?: number): Promise<AssistantChatRun> {
    if (this.cancelledRequests.has(JSON.stringify([ownerId, epoch, requestId]))) throw new Error('语音对话已取消')
    const orderKey = JSON.stringify([ownerId, epoch])
    if (orderKey !== this.orderKey) { this.orderKey = orderKey; this.sequence = 0 }
    const existing = this.entries.get(requestId)
    if (existing?.start !== undefined) {
      if (existing.ownerId !== ownerId || existing.epoch !== epoch || existing.text !== text) throw new Error('语音请求标识已被使用，请重新开始本轮对话')
      if (!existing.context.isCurrent()) throw new Error('语音对话索引或配置已变化，请重新说话')
      return existing.start
    }
    const nextSequence = sequence ?? this.sequence + 1
    if (!Number.isSafeInteger(nextSequence) || nextSequence <= this.sequence) throw new Error('语音对话顺序已失效，请重新说话')
    this.sequence = nextSequence
    const key = JSON.stringify([ownerId, context.index.generation, context.index.scope, context.provider, context.model, context.prompt])
    if (key !== this.contextKey) { this.clear(); this.contextKey = key }
    // 上一轮可能刚完成、客户端尚未来得及轮询，先提交完成对再开始追问。
    if (this.active?.started) this.commit(this.active, this.chat.read(this.active.requestId))
    this.cancelActive()
    for (const [id, entry] of this.entries) if (this.entries.size >= 30 && entry !== this.active) this.entries.delete(id)
    const entry: VoiceChatEntry = { ownerId, epoch, requestId, text, context, started: false, cancelled: false, committed: false }
    this.entries.set(requestId, entry)
    this.active = entry
    // 在模型目录的异步读取之前登记本轮；关闭、清空和新话语都能取消尚未启动的请求。
    const isCurrent = (): boolean => !entry.cancelled && this.active === entry && context.isCurrent()
    const start = this.conversation === undefined
      ? this.chat.start({ requestId, provider: context.provider, model: context.model, generation: context.index.generation, messages: [...this.history.slice(-18), { role: 'user', text }] }, context.index, isCurrent, context.createSystem)
      : this.conversation.start(requestId, text, { ...context, isCurrent }, 'voice')
    entry.start = start
      .then((run) => {
        entry.started = true
        if (entry.cancelled || !context.isCurrent()) return this.chat.cancel(requestId)
        void this.chat.wait(requestId).then((result) => this.commit(entry, result))
        return run
      })
    return entry.start
  }

  read(ownerId: string, epoch: number, requestId: string): AssistantChatRun {
    const entry = this.requireEntry(ownerId, epoch, requestId)
    if (!entry.context.isCurrent()) this.cancel(ownerId, epoch, requestId)
    const run = this.chat.read(requestId)
    if (entry.cancelled) return { ...run, state: 'cancelled', error: '语音对话已停止或索引已变化', finishedAt: Date.now() }
    this.commit(entry, run)
    return run
  }

  async wait(ownerId: string, epoch: number, requestId: string): Promise<AssistantChatRun> {
    const entry = this.requireEntry(ownerId, epoch, requestId)
    await entry.start
    const result = await this.chat.wait(requestId)
    return this.read(ownerId, epoch, result.requestId)
  }

  cancel(ownerId: string, epoch: number, requestId: string): void {
    // HTTP 取消可能先于启动到达；保留有界撤销标记，禁止迟到请求重新启动模型。
    this.cancelledRequests.add(JSON.stringify([ownerId, epoch, requestId]))
    if (this.cancelledRequests.size > 60) this.cancelledRequests.delete(this.cancelledRequests.values().next().value!)
    const entry = this.entries.get(requestId)
    if (entry?.ownerId !== ownerId || entry.epoch !== epoch) return
    entry.cancelled = true
    if (entry.started) this.chat.cancel(requestId)
    if (this.active === entry) this.active = undefined
  }

  cancelActive(): void {
    const entry = this.active
    if (entry !== undefined) this.cancel(entry.ownerId, entry.epoch, entry.requestId)
  }

  clear(): void {
    for (const entry of this.entries.values()) this.cancel(entry.ownerId, entry.epoch, entry.requestId)
    this.entries.clear()
    this.history = []
    this.contextKey = ''
  }

  private requireEntry(ownerId: string, epoch: number, requestId: string): VoiceChatEntry {
    const entry = this.entries.get(requestId)
    if (entry === undefined || entry.ownerId !== ownerId || entry.epoch !== epoch) throw new Error('找不到当前租约的语音对话请求')
    return entry
  }

  private commit(entry: VoiceChatEntry, run: AssistantChatRun): void {
    if (this.conversation !== undefined) return
    if (run.state !== 'completed' || !run.text.trim() || entry.committed || entry.cancelled || this.active !== entry || !entry.context.isCurrent()) return
    entry.committed = true
    this.history = [...this.history, { role: 'user', text: entry.text }, { role: 'assistant', text: run.text }].slice(-18) as AssistantChatMessage[]
  }
}
