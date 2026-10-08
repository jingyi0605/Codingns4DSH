import { Worker } from 'node:worker_threads'
import type { VoicePcmFrame, VoiceRuntimeAdapter, VoiceRuntimeCapabilities, VoiceRuntimeEvent, VoiceRuntimeListener } from '../../shared/contracts/voice-runtime.js'
import type { SherpaVoiceRuntimeOptions } from './sherpa-voice-runtime.js'
import type { AssistantVoiceHotword } from './assistant-voice-hotwords.js'
import type { SherpaWorkerCommand } from './sherpa-voice-worker.js'
import { traceVoice, type VoiceDiagnosticRecord } from '../../shared/voice-diagnostics.js'

const EMPTY_CAPABILITIES: VoiceRuntimeCapabilities = {
  realtime: false, wakeWord: false, streamingInput: false, streamingOutput: false,
  bargeIn: false, speechToText: false, textToSpeech: false,
}
type CommandInput = SherpaWorkerCommand extends infer T ? T extends SherpaWorkerCommand ? Omit<T, 'id' | 'epoch'> : never : never
interface PendingCommand {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Host 的轻量语音代理。最多保留两秒待识别音频，停止后短暂复用模型，
 * 超时、异常或闲置时直接释放工作线程，不能把大模型永久留在 Host 内存中。
 */
export class SherpaWorkerRuntime implements VoiceRuntimeAdapter {
  private worker: Worker | undefined
  private readonly pending = new Map<number, PendingCommand>()
  private readonly listeners = new Set<VoiceRuntimeListener>()
  private options: SherpaVoiceRuntimeOptions
  private epoch = 0
  private sequence = 0
  private started = false
  private starting: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private disposed = false
  private bufferedAudioMs = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private currentCapabilities = EMPTY_CAPABILITIES

  constructor(options: SherpaVoiceRuntimeOptions = {}, private readonly idleMs = 60_000) {
    this.options = { ...options, env: { ...(options.env ?? process.env) } }
  }
  get capabilities(): VoiceRuntimeCapabilities { return this.currentCapabilities }
  get running(): boolean { return this.started || this.starting !== undefined }
  setEpoch(epoch: number): void { if (Number.isInteger(epoch) && epoch >= 0) this.epoch = epoch }
  subscribe(listener: VoiceRuntimeListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  configureEnvironment(env: Readonly<Record<string, string | undefined>>): void {
    if (this.running) throw new Error('语音运行时正在运行，不能修改模型配置')
    if (JSON.stringify(this.options.env) === JSON.stringify(env)) return
    this.release(new Error('语音配置已更新'))
    this.options = { ...this.options, env: { ...env } }
  }
  configureHotwords(hotwords: readonly AssistantVoiceHotword[]): void {
    if (this.running) throw new Error('语音运行时正在运行，不能修改识别热词')
    if (JSON.stringify(this.options.hotwords ?? []) === JSON.stringify(hotwords)) return
    this.release(new Error('语音热词已更新'))
    this.options = { ...this.options, hotwords: hotwords.map((word) => ({ ...word })) }
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('语音运行时已关闭')
    if (this.stopping !== undefined) { await this.stopping; return this.start() }
    if (this.started) return
    if (this.starting !== undefined) return this.starting
    clearTimeout(this.idleTimer)
    this.starting = this.request({ action: 'start' }, 120_000)
      .then(() => { this.started = true }, (error: unknown) => { this.release(asError(error)); throw error })
      .finally(() => { this.starting = undefined })
    return this.starting
  }
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    this.stopping = (async () => {
      await this.starting?.catch(() => undefined)
      this.started = false
      if (this.worker === undefined) return
      try { await this.request({ action: 'stop' }) }
      finally {
        // dispose 会取消在途 stop；此时不能重新挂上闲置定时器。
        if (!this.disposed && this.worker !== undefined) {
          this.worker.unref()
          this.idleTimer = setTimeout(() => this.release(new Error('语音模型闲置释放')), this.idleMs)
          this.idleTimer.unref()
        }
      }
    })().finally(() => { this.stopping = undefined })
    return this.stopping
  }
  async interrupt(): Promise<void> {
    if (this.worker !== undefined && this.started) await this.request({ action: 'interrupt' })
  }
  async sendPcm(frame: VoicePcmFrame, epoch: number): Promise<void> {
    if (!this.started) throw new Error('语音运行时尚未启动')
    if (epoch !== this.epoch) return
    const duration = frame.bytes.byteLength / 2 / frame.sampleRate * 1000
    if (!Number.isFinite(duration) || duration < 0 || duration + this.bufferedAudioMs > 2_000) {
      throw new Error('语音识别处理积压，请暂停输入后重试')
    }
    this.bufferedAudioMs += duration
    try { await this.request({ action: 'pcm', frame }, 10_000) }
    finally { this.bufferedAudioMs -= duration }
  }
  async speak(text: string, epoch: number): Promise<void> {
    if (epoch !== this.epoch || !this.started) return
    await this.request({ action: 'speak', text }, 60_000)
  }
  dispose(): void {
    this.disposed = true
    this.release(new Error('语音运行时已关闭'))
    this.listeners.clear()
  }

  private request(command: CommandInput, timeoutMs = 10_000): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('语音运行时已关闭'))
    if (this.pending.size >= 64) return Promise.reject(new Error('语音控制队列已满'))
    const worker = this.ensureWorker()
    worker.ref()
    const id = ++this.sequence
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('语音工作线程响应超时')), timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      // structured clone 保留上传流持有的原始缓冲区，不能把它 transfer 后置空。
      try { worker.postMessage({ ...command, id, epoch: this.epoch }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(asError(error)) }
    })
  }

  private ensureWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = new Worker(new URL('./sherpa-voice-worker.js', import.meta.url), { workerData: this.options })
    this.worker = worker
    worker.on('message', (message: { type: 'event' | 'result' | 'diagnostic'; id?: number; event?: VoiceRuntimeEvent; error?: string; capabilities?: VoiceRuntimeCapabilities; record?: VoiceDiagnosticRecord }) => {
      if (this.worker !== worker) return
      if (message.type === 'diagnostic' && message.record !== undefined) { traceVoice(message.record.event, message.record.fields); return }
      if (message.capabilities !== undefined) this.currentCapabilities = message.capabilities
      if (message.type === 'event' && message.event !== undefined && message.event.epoch === this.epoch) {
        for (const listener of this.listeners) listener(message.event)
      }
      if (message.type === 'result' && message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        clearTimeout(pending.timer); this.pending.delete(message.id)
        if (message.error === undefined) pending.resolve()
        else pending.reject(new Error(message.error))
      }
    })
    worker.on('error', (error) => { if (this.worker === worker) this.fail(asError(error)) })
    worker.on('exit', (code) => { if (this.worker === worker) this.fail(new Error(`语音工作线程退出 (${code})`)) })
    return worker
  }
  private fail(error: Error): void {
    this.release(error)
    for (const listener of this.listeners) listener({ type: 'error', code: 'VOICE_WORKER_FAILED', message: error.message, recoverable: false, epoch: this.epoch })
  }
  private release(error: Error): void {
    clearTimeout(this.idleTimer)
    const worker = this.worker
    this.worker = undefined
    this.started = false
    this.currentCapabilities = EMPTY_CAPABILITIES
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    if (worker !== undefined) void worker.terminate().catch(() => undefined)
  }
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)) }
