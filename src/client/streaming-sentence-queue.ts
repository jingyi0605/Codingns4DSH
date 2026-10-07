import type { VoiceDiagnosticTrace } from '../shared/voice-diagnostics.js'

/** 消费累计流式文字；短语按标点提前合成，长时间没有句末时也能开始播报。 */
export class StreamingSentenceQueue {
  private text = ''
  private offset = 0
  private pending = 0
  private tail: Promise<void> = Promise.resolve()
  private error: unknown
  private waitingSince: number | undefined

  constructor(private readonly speak: (text: string) => Promise<void>, private readonly isCurrent: () => boolean,
    private readonly now: () => number = Date.now, private readonly trace?: VoiceDiagnosticTrace) {}

  push(value: string, final = false): void {
    if (!this.isCurrent()) return
    if (this.error !== undefined) throw this.error
    const text = value.trimStart()
    // 累计文字允许重复快照，但已经进入播放队列的前缀不能被重写。
    const committed = this.text.slice(0, this.offset)
    if (!text.startsWith(committed)) {
      // Host 结算会 trim 末尾空白；只移除末尾换行不算改写，也不能因此再读一次。
      if (text.trimEnd() !== committed.trimEnd()) throw new Error('助理流式回复改写了已播报内容，请重新对话')
      this.offset = Math.min(this.offset, text.length)
    }
    if (text.length > 16000) throw new Error('助理播报文本过长')
    this.text = text
    const remainder = text.slice(this.offset)
    const boundary = /[。！？!?]+[”’"'）)】]*|\.(?=\s)|\n+|[，,；;：:]+[”’"'）)】]*/gu
    let match: RegExpExecArray | null
    let consumed = 0
    while ((match = boundary.exec(remainder)) !== null) {
      const end = match.index + match[0].length
      // 不把“好，”单独送入模型；也不拆开英文网址、数字分隔符和时间。
      if (/^[,;:!?]/u.test(match[0]) && !isPhraseBoundary(remainder, match.index)) continue
      if (/^[，,；;：:]/u.test(match[0]) && end - consumed < 8) continue
      this.enqueue(remainder.slice(consumed, end))
      consumed = end
    }
    this.offset += consumed
    if (final) { this.enqueue(text.slice(this.offset)); this.offset = text.length; this.waitingSince = undefined; return }
    this.flushPending(consumed > 0)
  }

  async drain(): Promise<void> {
    await this.tail
    if (this.error !== undefined && this.isCurrent()) throw this.error
  }

  private enqueue(value: string): void {
    const text = value.trim()
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return
    if (++this.pending > 32) throw new Error('助理逐句播报队列过长')
    const queued = performance.now()
    this.trace?.('sentence.queued', { textLength: text.length, pending: this.pending })
    // 串行提交 TTS；MOSS 的回调只等待生成完成，音频可以继续在前台播放。
    this.tail = this.tail.then(async () => {
      try {
        this.trace?.('sentence.started', { textLength: text.length, pending: this.pending, waitMs: performance.now() - queued })
        if (this.error === undefined && this.isCurrent()) await this.speak(text)
      }
      catch (error) { this.error = error }
      finally { this.pending-- }
    })
  }

  private flushPending(consumed: boolean): void {
    const now = this.now()
    if (consumed) this.waitingSince = undefined
    let remainder = this.text.slice(this.offset)
    if (!remainder.trim()) { this.waitingSince = undefined; return }
    this.waitingSince ??= now
    // 由正在进行的文本轮询检查等待时长，不建立脱离轮次的后台定时器。
    while (remainder.length >= 64 || remainder.length >= 12 && now - this.waitingSince >= 700) {
      const end = safePrefixEnd(remainder, Math.min(64, remainder.length))
      if (end === 0) return
      this.enqueue(remainder.slice(0, end))
      this.offset += end
      remainder = this.text.slice(this.offset)
      this.waitingSince = remainder.trim() ? now : undefined
      if (this.waitingSince === undefined) return
    }
  }
}

function isPhraseBoundary(text: string, index: number): boolean {
  const punctuation = text[index]!
  if (punctuation === '，' || punctuation === '；' || punctuation === '：') return true
  const before = text.slice(0, index)
  if (/[0-9]$/u.test(before) && (text[index + 1] === undefined || /[0-9]/u.test(text[index + 1]!))) return false
  if (punctuation === ':' && /(?:https?|ftp|file|mailto|wss?)$/iu.test(before)) return false
  return !/(?:https?:\/\/|www\.)[^\s，；：。！？]*$/iu.test(before)
}

/** 只在中文字符或空白后补切，避免将尚未生成完的英文单词、网址和数字拆成两次朗读。 */
function safePrefixEnd(text: string, limit: number): number {
  for (let end = limit; end >= 8; end--) {
    if (/[\s\p{Script=Han}]/u.test(text[end - 1]!)) return end
  }
  return 0
}
