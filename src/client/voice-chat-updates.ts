import type { AssistantChatRun } from '../shared/contracts/assistant.js'

/** 每轮只保留最新累计快照，推送快于消费时也不会无限堆积文字。 */
export class VoiceChatUpdates {
  private latest: AssistantChatRun | undefined
  private settled = false
  private wake: (() => void) | undefined

  push(run: AssistantChatRun): void {
    if (this.settled) return
    this.latest = run
    this.settled = run.state !== 'running'
    this.wake?.()
  }

  take(): AssistantChatRun | undefined {
    const run = this.latest
    this.latest = undefined
    return run
  }

  /** 事件优先；长时间无事件才读取 RPC，兼容丢失推送与旧 Host。 */
  async next(signal: AbortSignal): Promise<AssistantChatRun | undefined> {
    if (this.latest !== undefined || signal.aborted) return this.take()
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer); signal.removeEventListener('abort', finish)
        if (this.wake === finish) this.wake = undefined
        resolve()
      }
      const timer = setTimeout(finish, 700)
      this.wake = finish
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
    return this.take()
  }
}
