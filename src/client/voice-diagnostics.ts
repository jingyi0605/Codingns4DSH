import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { sanitizeVoiceDiagnosticFields, type VoiceDiagnosticFields, type VoiceDiagnosticRecord } from '../shared/voice-diagnostics.js'
import type { CodingNsClientServices } from './features/types.js'

/** 浏览器指标走现有 RPC 批量落盘；一个请求在途时不再提交第二个。 */
export class ClientVoiceDiagnostics {
  private records: VoiceDiagnosticRecord[] = []
  private dropped = 0
  private sending = false
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>
  private observer: PerformanceObserver | undefined
  private previousTime = performance.now()

  constructor(private readonly services: CodingNsClientServices, private readonly scope: VoiceDiagnosticFields) {
    this.timer = setInterval(() => {
      const now = performance.now()
      // 后台标签的定时器降频要与主线程卡顿区分开。
      this.record('client.health', { intervalMs: now - this.previousTime, state: globalThis.document?.visibilityState ?? 'unknown' })
      this.previousTime = now
      void this.flush()
    }, 2000)
    ;(this.timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
    try {
      if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) this.record('client.longtask', { durationMs: entry.duration })
        })
        this.observer.observe({ entryTypes: ['longtask'] })
      }
    } catch { /* 浏览器未实现 Long Tasks API 时保留定时器延迟指标 */ }
  }

  record(event: string, fields: VoiceDiagnosticFields = {}): void {
    if (this.closed) return
    if (this.records.length >= 256) { this.dropped++; return }
    this.records.push({ timestamp: Date.now(), event, fields: sanitizeVoiceDiagnosticFields({ ...this.scope, ...fields }) })
    if (this.records.length === 64 && !this.sending) void this.flush()
  }

  async flush(): Promise<void> {
    if (this.sending || this.records.length === 0) return
    const records = this.records.splice(0, 64)
    const dropped = this.dropped; this.dropped = 0
    this.sending = true
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 5000)
    try {
      const result = await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/diagnostics', { ...this.scope, records, dropped }, abort.signal)
      if (!result.ok) this.dropped += records.length + dropped
    } catch { this.dropped += records.length + dropped }
    finally {
      clearTimeout(timeout); this.sending = false
      if ((this.closed || this.records.length >= 64) && this.records.length > 0) void this.flush()
    }
  }

  dispose(): void { this.closed = true; clearInterval(this.timer); this.observer?.disconnect(); void this.flush() }
}
