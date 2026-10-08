import type { CodingNsAgentEvent } from '../../shared/contracts/cli-adapter.js'
import type { SseEvent } from './http-sse-client.js'
import { DoubaoToolProjector } from './doubao-tools.js'

interface Block {
  id: string
  type: number
  parent: string
  text: string
}
const record = (value: unknown): Record<string, any> => typeof value === 'object' && value !== null ? value as Record<string, any> : {}

/** 每个回合一个投影器；只处理白名单字段，绝不把原始响应作为工具输出。 */
export class DoubaoEventProjector {
  private readonly blocks = new Map<string, Block>()
  private readonly tools = new DoubaoToolProjector()
  private currentBlock: Block | undefined
  private emitted = { text: '', reasoning: '' }
  replyId: string | undefined
  acknowledged = false
  ended = false

  constructor(private readonly conversationId: string) {}

  accept(event: SseEvent): CodingNsAgentEvent[] {
    if (event.event === 'SSE_HEARTBEAT') return []
    let data: Record<string, any>
    try { data = record(JSON.parse(event.data)) } catch { throw new Error('豆包流事件格式不兼容') }
    if (event.event === 'STREAM_ERROR') throw new Error(`豆包返回流错误（${Number(data.code ?? data.error_code) || '未知状态'}）`)
    if (event.event === 'SSE_ACK') {
      if (data.ack_client_meta?.conversation_id !== this.conversationId) throw new Error('豆包 ACK 会话不匹配，已停止接收，未改写绑定')
      this.acknowledged = true
      return []
    }
    if (!['STREAM_MSG_NOTIFY', 'STREAM_CHUNK', 'CHUNK_DELTA', 'SSE_REPLY_END'].includes(event.event ?? '')) return []
    if (!this.acknowledged) throw new Error('豆包未确认目标会话即返回正文')
    if (typeof data.message_id === 'string') this.replyId = data.message_id
    if (event.event === 'SSE_REPLY_END') {
      if (typeof data.msg_finish_attr?.msgid === 'string') this.replyId = data.msg_finish_attr.msgid
      if (data.end_type === 3) this.ended = true
      return []
    }
    // 工作任务可能在阶段结束之后继续输出；只有最后一段结束且连接关闭才算完成。
    this.ended = false
    if (event.event === 'CHUNK_DELTA') {
      if (!this.currentBlock || typeof data.text !== 'string') throw new Error('豆包增量缺少所属文本块')
      this.currentBlock.text += data.text
      return this.projectText()
    }
    const output: CodingNsAgentEvent[] = []
    const patches = event.event === 'STREAM_MSG_NOTIFY' ? [record(data.content)]
      : (Array.isArray(data.patch_op) ? data.patch_op : []).map((op: unknown) => record(record(op).patch_value))
    for (const patch of patches) {
      for (const raw of Array.isArray(patch.content_block) ? patch.content_block : []) output.push(...this.applyBlock(record(raw)))
    }
    output.push(...this.projectText())
    return output
  }

  private applyBlock(raw: Record<string, any>): CodingNsAgentEvent[] {
    if (typeof raw.block_id !== 'string') throw new Error('豆包内容块缺少标识')
    if (raw.patch_type === 3) { this.blocks.delete(raw.block_id); this.currentBlock = undefined; return this.tools.remove(raw.block_id) }
    const previous = this.blocks.get(raw.block_id)
    const block: Block = previous ?? { id: raw.block_id, type: Number(raw.block_type), parent: '', text: '' }
    if (typeof raw.parent_id === 'string') block.parent = raw.parent_id
    if (typeof raw.block_type === 'number') block.type = raw.block_type
    if ([10023, 10041, 10043, 10066].includes(block.type)) throw new Error('豆包任务需要原生交互，请在豆包 App 中完成确认；本适配器尚不支持代答')
    this.blocks.set(block.id, block)
    if (block.type === 10000) {
      const text = raw.content?.text_block?.text
      if (typeof text === 'string') block.text = raw.patch_type === 2 ? text : block.text + text
      this.currentBlock = block
    } else this.currentBlock = undefined
    return this.tools.accept(block.id, block.type, raw.content, raw.patch_type === 2, raw.is_finish === true)
  }

  private isReasoning(block: Block): boolean {
    const visited = new Set<string>()
    let parent = this.blocks.get(block.parent)
    while (parent && !visited.has(parent.id)) {
      if (parent.type === 10040) return true
      visited.add(parent.id)
      parent = this.blocks.get(parent.parent)
    }
    return false
  }

  private projectText(): CodingNsAgentEvent[] {
    const values = { text: '', reasoning: '' }
    for (const block of this.blocks.values()) {
      if (block.type === 10000) values[this.isReasoning(block) ? 'reasoning' : 'text'] += block.text
    }
    const output: CodingNsAgentEvent[] = []
    for (const channel of ['reasoning', 'text'] as const) {
      const before = this.emitted[channel]
      const after = values[channel]
      if (before === after) continue
      output.push(after.startsWith(before) ? { type: `${channel}-delta`, text: after.slice(before.length) }
        : { type: `${channel}-snapshot`, text: after })
      this.emitted[channel] = after
    }
    return output
  }
}
