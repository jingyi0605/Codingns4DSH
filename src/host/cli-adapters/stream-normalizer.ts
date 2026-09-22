import type { CodingNsCliStreamChunk } from '../../shared/contracts/cli-adapter.js'

type SnapshotChunk = Extract<CodingNsCliStreamChunk, { readonly type: 'reasoning-snapshot' | 'text-snapshot' }>
type UsageChunk = Extract<CodingNsCliStreamChunk, { readonly type: 'usage' }>

export type CodingNsNormalizedCliStreamChunk = Exclude<CodingNsCliStreamChunk, SnapshotChunk>

/**
 * 把驱动差异收敛成 DSH 可消费的增量流。
 *
 * 有些 CLI 发送真正的 delta，有些 CLI 反复发送从头累积的 snapshot。规范化器
 * 分别记录推理和正文已经发送的内容，避免完整快照被重复追加到 DSH 会话日志。
 */
export class CodingNsCliStreamNormalizer {
  private reasoning = ''
  private text = ''
  private reasoningBoundary = false
  private textBoundary = false
  private usage: UsageChunk | null = null

  push(chunk: CodingNsCliStreamChunk): readonly CodingNsNormalizedCliStreamChunk[] {
    if (chunk.type === 'reasoning-delta') {
      this.reasoning = this.reasoningBoundary ? chunk.text : this.reasoning + chunk.text
      this.reasoningBoundary = false
      return chunk.text === '' ? [] : [chunk]
    }
    if (chunk.type === 'text-delta') {
      this.text = this.textBoundary ? chunk.text : this.text + chunk.text
      this.textBoundary = false
      return chunk.text === '' ? [] : [chunk]
    }
    if (chunk.type === 'reasoning-snapshot') return this.appendSnapshot('reasoning', chunk.text)
    if (chunk.type === 'text-snapshot') return this.appendSnapshot('text', chunk.text)
    if (chunk.type === 'usage') {
      this.usage = chunk
      return []
    }
    if (chunk.type === 'tool-running') {
      this.reasoningBoundary = true
      this.textBoundary = true
      return [chunk]
    }
    if (chunk.type === 'finish') {
      const usage = this.takeUsage()
      return usage === null ? [chunk] : [usage, chunk]
    }
    return [chunk]
  }

  /** 流未携带 finish 时仍返回最后一次统计，避免正常结束路径丢失 usage。 */
  flush(): readonly CodingNsNormalizedCliStreamChunk[] {
    const usage = this.takeUsage()
    return usage === null ? [] : [usage]
  }

  private appendSnapshot(channel: 'reasoning' | 'text', snapshot: string): readonly CodingNsNormalizedCliStreamChunk[] {
    const previous = channel === 'reasoning' ? this.reasoning : this.text
    const boundary = channel === 'reasoning' ? this.reasoningBoundary : this.textBoundary
    if (channel === 'reasoning') this.reasoningBoundary = false
    else this.textBoundary = false

    // 工具前后通常是两条不同的 Assistant 消息。只有新快照不包含旧基线时才
    // 开启新段；累计快照仍按原基线去重，避免工具事件导致整段重放。
    if (boundary && !snapshot.startsWith(previous)) {
      if (channel === 'reasoning') this.reasoning = snapshot
      else this.text = snapshot
      return snapshot === '' ? [] : [{ type: `${channel}-delta`, text: snapshot }]
    }
    if (previous.startsWith(snapshot)) return []

    const text = snapshot.startsWith(previous)
      ? snapshot.slice(previous.length)
      : snapshot.slice(Math.min(previous.length, snapshot.length))
    if (snapshot.length >= previous.length) {
      if (channel === 'reasoning') this.reasoning = snapshot
      else this.text = snapshot
    }
    return text === '' ? [] : [{ type: `${channel}-delta`, text }]
  }

  private takeUsage(): UsageChunk | null {
    const usage = this.usage
    this.usage = null
    return usage
  }
}
