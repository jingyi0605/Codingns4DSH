import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { isStage0Runtime } from './stage0-dev-hmr.js'
import { sanitizeVoiceDiagnosticFields, subscribeVoiceDiagnostics, traceVoice, type VoiceDiagnosticRecord } from '../shared/voice-diagnostics.js'

/** 有界批量写入：磁盘变慢时丢诊断并记录数量，不让通话等待磁盘。 */
export class VoiceDiagnosticWriter {
  private pending: string[] = []
  private pendingBytes = 0
  private dropped = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> | undefined
  private closed = false
  private failed = false
  private fileIndex = 0
  private fileBytes = 0
  private readonly prefix: string

  constructor(readonly directory: string, private readonly options: { maxFileBytes?: number; maxFiles?: number; maxPendingBytes?: number } = {}) {
    this.prefix = `voice-performance-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`
  }

  get filePath(): string { return join(this.directory, `${this.prefix}.${this.fileIndex}.jsonl`) }

  record(record: VoiceDiagnosticRecord, source: 'host' | 'client' = 'host'): void {
    if (this.closed || this.failed || !/^[a-z][a-z0-9_.-]{0,99}$/u.test(record.event)) return
    const line = JSON.stringify({ timestamp: new Date(record.timestamp).toISOString(), receivedAt: new Date().toISOString(), source, event: record.event, fields: sanitizeVoiceDiagnosticFields(record.fields) }) + '\n'
    const bytes = Buffer.byteLength(line)
    if (this.pendingBytes + bytes > (this.options.maxPendingBytes ?? 1024 * 1024)) { this.dropped++; return }
    this.pending.push(line); this.pendingBytes += bytes
    this.schedule()
  }

  /** 单一写入任务保序；只由测试或释放资源等待，不从采集、播放路径 await。 */
  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.writing !== undefined) { await this.writing; if (this.pending.length > 0) await this.flush(); return }
    if (this.failed || this.pending.length === 0) return
    const lines = this.pending.join('')
    const dropped = this.dropped
    this.pending = []; this.pendingBytes = 0; this.dropped = 0
    const task = this.write(lines, dropped).catch((error: unknown) => {
      this.failed = true; this.pending = []; this.pendingBytes = 0
      // 文件日志不可用必须可见；只输出一次，避免异常重试刷屏。
      console.warn('CodingNS voice diagnostic log write failed', error instanceof Error ? error.name : 'UnknownError')
    })
    this.writing = task
    try { await task } finally { this.writing = undefined; if (!this.closed && this.pending.length > 0) this.schedule() }
  }

  async dispose(): Promise<void> { this.closed = true; await this.flush() }

  private schedule(): void {
    if (this.timer !== undefined || this.closed || this.writing !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 500)
    this.timer.unref()
  }

  private async write(lines: string, dropped: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const content = lines + (dropped > 0 ? JSON.stringify({ timestamp: new Date().toISOString(), source: 'host', event: 'diagnostics.dropped', fields: { dropped } }) + '\n' : '')
    const bytes = Buffer.byteLength(content)
    if (this.fileBytes > 0 && this.fileBytes + bytes > (this.options.maxFileBytes ?? 20 * 1024 * 1024)) {
      this.fileIndex = (this.fileIndex + 1) % (this.options.maxFiles ?? 5)
      this.fileBytes = 0
      // 只循环本次启动生成的唯一文件名，不清理目录里已有的其他日志。
      await writeFile(this.filePath, '', { mode: 0o600 })
    }
    await appendFile(this.filePath, content, { mode: 0o600 })
    this.fileBytes += bytes
  }
}

/** 自动诊断仅在专用 Stage0 开启，日志固定落在该仓库 data/logs 下。 */
export function installVoiceDiagnostics(active: () => boolean): { writer: VoiceDiagnosticWriter; dispose: () => Promise<void> } | undefined {
  if (!isStage0Runtime() || process.env.CODINGNS4DSH_VOICE_DIAGNOSTICS === '0') return undefined
  const writer = new VoiceDiagnosticWriter(join(process.env.CODINGNS4DSH_STAGE0_REPO_ROOT!, 'data', 'logs'))
  const unsubscribe = subscribeVoiceDiagnostics((record) => writer.record(record))
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  let previousCpu = process.cpuUsage()
  let previousTime = performance.now()
  const timer = setInterval(() => {
    const now = performance.now(); const cpu = process.cpuUsage(); const memory = process.memoryUsage()
    if (active()) traceVoice('host.health', {
      durationMs: now - previousTime, cpuPercent: (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / ((now - previousTime) * 10),
      rssMb: memory.rss / 1048576, heapMb: memory.heapUsed / 1048576,
      eventLoopMeanMs: delay.mean / 1e6, eventLoopMaxMs: delay.max / 1e6, eventLoopP99Ms: delay.percentile(99) / 1e6,
    })
    previousCpu = cpu; previousTime = now; delay.reset()
  }, 2000)
  timer.unref()
  traceVoice('diagnostics.started', {})
  return { writer, dispose: async () => { clearInterval(timer); delay.disable(); unsubscribe(); await writer.dispose() } }
}
