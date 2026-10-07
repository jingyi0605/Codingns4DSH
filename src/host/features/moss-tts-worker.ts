import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { voiceProcessEnvironment } from './voice-process-environment.js'
import { traceVoice, voiceDiagnosticError, voiceDiagnosticsEnabled } from '../../shared/voice-diagnostics.js'

export interface MossAudioChunk { readonly bytes: Uint8Array; readonly sampleRate: number }
interface PendingRequest {
  readonly id: string
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
  readonly audio: ((chunk: MossAudioChunk) => void) | undefined
  readonly diagnosticId: string
}

/** 一个 Host 共用一个串行工作进程；取消会真正结束 CPU 推理，空闲释放模型。 */
export class MossTtsWorker {
  private child: ChildProcessWithoutNullStreams | undefined
  private pending: PendingRequest | undefined
  private closed: Promise<void> = Promise.resolve()
  private idle: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private busy = false
  private stderr = ''
  private startup: Promise<void> | undefined

  constructor(private readonly options: { python: string; script: string; modelDirectory: string; timeoutMs?: number; idleMs?: number }) {}

  /** 只加载模型，不占用推理请求；首句到达时共用同一启动 Promise。 */
  async prepare(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('MOSS 推理进程已经释放')
    signal?.throwIfAborted()
    if (this.idle !== undefined) clearTimeout(this.idle)
    let stopped: Error | undefined
    const stop = (error: Error): void => { stopped = error; if (!this.busy) this.stop(error) }
    const abort = (): void => stop(new Error('MOSS 预热已取消'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop(new Error('MOSS 预热超时')), this.options.timeoutMs ?? 180_000)
    try {
      if (this.child === undefined) await this.closed
      if (stopped !== undefined) throw stopped
      await this.ensureStarted()
      if (stopped !== undefined) throw stopped
      signal?.throwIfAborted()
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (this.child === undefined) await this.closed
      if (!this.busy && !this.disposed) this.scheduleIdle()
    }
  }

  async request(action: string, payload: Record<string, unknown>, audio?: (chunk: MossAudioChunk) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.disposed) throw new Error('MOSS 推理进程已经释放')
    if (this.busy) { traceVoice('host.moss.busy', { action }); throw new Error('MOSS 正在处理另一个请求，请稍后重试') }
    signal?.throwIfAborted()
    this.busy = true
    const started = performance.now()
    const diagnosticId = typeof payload.diagnosticId === 'string' ? payload.diagnosticId : randomUUID()
    traceVoice('host.moss.request', { diagnosticId, action, continuation: this.child !== undefined })
    if (this.idle !== undefined) clearTimeout(this.idle)
    let stopped: Error | undefined
    const stop = (error: Error): void => { stopped = error; this.stop(error) }
    const abort = (): void => stop(new Error('MOSS 推理已取消'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop(new Error('MOSS 推理超时，请重试或缩短文本')), this.options.timeoutMs ?? 180_000)
    try {
      if (this.child === undefined) await this.closed
      if (stopped !== undefined) throw stopped
      await this.ensureStarted()
      traceVoice('host.moss.ready_for_request', { diagnosticId, action, waitMs: performance.now() - started })
      if (stopped !== undefined) throw stopped
      if (this.disposed) throw new Error('MOSS 推理进程已经释放')
      signal?.throwIfAborted()
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = randomUUID()
        this.pending = { id, resolve, reject, audio, diagnosticId }
        this.child!.stdin.write(JSON.stringify({ ...payload, id, action, diagnostics: voiceDiagnosticsEnabled() }) + '\n', (error) => { if (error !== null && error !== undefined) this.stop(error) })
      })
    } catch (error) {
      traceVoice('host.moss.error', { diagnosticId, action, durationMs: performance.now() - started, aborted: signal?.aborted ?? false, errorName: voiceDiagnosticError(error) })
      throw error
    } finally {
      traceVoice('host.moss.finished', { diagnosticId, action, durationMs: performance.now() - started })
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      // 取消必须等到句柄关闭后才允许重试，避免 Windows 上旧模型仍被占用。
      if (this.child === undefined) await this.closed
      this.busy = false
      if (!this.disposed) this.scheduleIdle()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stop(new Error('MOSS 服务已停止'))
    await this.closed
  }

  private ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('MOSS 推理进程已经释放')
    if (this.startup !== undefined) return this.startup
    if (this.child !== undefined) return Promise.resolve()
    let settle: (() => void) | undefined
    let fail: ((error: Error) => void) | undefined
    const started = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject })
    const startupAt = performance.now()
    traceVoice('host.moss.startup', { threads: 4 })
    this.stderr = ''
    const child = spawn(this.options.python, ['-X', 'utf8', '-u', this.options.script, this.options.modelDirectory], { stdio: 'pipe', windowsHide: true, env: voiceProcessEnvironment() })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000) })
    const failed = (error: Error): void => {
      if (this.child !== child) return
      fail?.(error); this.stop(error)
    }
    child.once('error', failed)
    child.stdin.on('error', failed)
    this.closed = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        lines.close()
        if (this.child === child) failed(new Error(`MOSS 工作进程退出（${code ?? 'signal'}）：${this.stderr}`))
        resolve()
      })
    })
    lines.on('line', (line: string) => {
      if (this.child !== child) return
      try {
        if (line.length > 2 * 1024 * 1024) throw new Error('MOSS 工作进程响应过大')
        const event = JSON.parse(line) as Record<string, unknown>
        if (event.type === 'ready') { traceVoice('host.moss.ready', { durationMs: performance.now() - startupAt, threads: 4 }); settle?.(); settle = undefined; fail = undefined; return }
        if (event.type === 'fatal') { failed(new Error(String(event.message))); return }
        const request = this.pending
        if (request === undefined || event.id !== request.id) throw new Error('MOSS 工作进程响应 ID 不匹配')
        if (event.type === 'diagnostic') {
          traceVoice('host.moss.phase', { diagnosticId: request.diagnosticId, ...(typeof event.fields === 'object' && event.fields !== null ? event.fields : {}) })
        } else if (event.type === 'audio') {
          if (typeof event.data !== 'string' || event.sampleRate !== 48_000) throw new Error('MOSS 返回无效 PCM')
          const bytes = Buffer.from(event.data, 'base64')
          if (bytes.length === 0 || bytes.length % 2 !== 0) throw new Error('MOSS 返回无效 PCM 长度')
          request.audio?.({ bytes, sampleRate: event.sampleRate })
        } else if (event.type === 'done' || event.type === 'error') {
          this.pending = undefined
          if (event.type === 'error') request.reject(new Error(String(event.message)))
          else request.resolve((event.result ?? {}) as Record<string, unknown>)
        } else throw new Error('MOSS 工作进程事件无效')
      } catch (error) { failed(error instanceof Error ? error : new Error(String(error))) }
    })
    // stop 在加载期间也需要唤醒请求，不让取消等待到超时。
    this.rejectStartup = (error) => fail?.(error)
    const startup = started.finally(() => { this.rejectStartup = undefined; if (this.startup === startup) this.startup = undefined })
    this.startup = startup
    return startup
  }

  private scheduleIdle(): void {
    if (this.idle !== undefined) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 120_000)
    this.idle.unref()
  }

  private rejectStartup: ((error: Error) => void) | undefined
  private stop(error = new Error('MOSS 工作进程已释放')): void {
    if (this.idle !== undefined) clearTimeout(this.idle)
    this.rejectStartup?.(error)
    this.pending?.reject(error); this.pending = undefined
    const child = this.child; this.child = undefined
    child?.kill('SIGKILL')
  }
}
