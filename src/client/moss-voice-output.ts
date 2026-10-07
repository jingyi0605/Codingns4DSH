import { ASSISTANT_TTS_PATH, readAssistantTtsParameters, type AssistantTtsParameters } from '../shared/assistant-tts.js'
import { voiceDiagnosticId, voiceDiagnosticError, type VoiceDiagnosticTrace, type VoiceDiagnosticFields } from '../shared/voice-diagnostics.js'

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

/** 可取消的 PCM 播放器；同一轮的各段串行生成，生成与播放并行。 */
export class MossVoiceOutput {
  private context: SinkAudioContext | undefined
  private abort: AbortController | undefined
  private readonly sources = new Set<AudioBufferSourceNode>()
  private sequence = 0
  private outputDeviceId = ''
  private nextStart = 0
  private gain: GainNode | undefined
  private muted = false
  private volume = 1

  constructor(private readonly options: { fetch?: typeof fetch; context?: () => AudioContext; trace?: VoiceDiagnosticTrace; traceContext?: () => VoiceDiagnosticFields } = {}) {}

  get outputDeviceSupported(): boolean { return typeof (globalThis.AudioContext?.prototype as SinkAudioContext | undefined)?.setSinkId === 'function' }

  /** 在点击开始或试听时调用，保留浏览器要求的用户手势。 */
  async prepare(): Promise<void> {
    if (this.context === undefined || this.context.state === 'closed') this.context = (this.options.context?.() ?? new AudioContext()) as SinkAudioContext
    if (this.gain === undefined) { this.gain = this.context.createGain(); this.gain.gain.value = this.muted ? 0 : this.volume; this.gain.connect(this.context.destination) }
    if (this.context.state === 'suspended') await this.context.resume()
    if (this.outputDeviceId !== '' && typeof this.context.setSinkId === 'function') await this.context.setSinkId(this.outputDeviceId)
  }

  async setOutputDevice(id: string): Promise<void> {
    if (!this.outputDeviceSupported) throw new Error('当前浏览器不支持 MOSS 播放设备选择')
    if (this.context !== undefined) await this.context.setSinkId!(id)
    this.outputDeviceId = id
  }

  /** 输出静音不中断推理或时间线，恢复后继续听当前播报。 */
  setMuted(muted: boolean): void { this.muted = muted; if (this.gain !== undefined) this.gain.gain.value = muted ? 0 : this.volume }

  async speak(text: string, voiceId?: string, onStart?: () => void, parameters?: Partial<AssistantTtsParameters>): Promise<boolean> {
    this.cancel()
    const sequence = this.sequence
    if (!await this.append(text, voiceId, onStart, parameters) || sequence !== this.sequence) return false
    return this.finish()
  }

  /** 由文本队列串行调用；收到生成结束即可提交下一段，不取消仍在播放的前一段。 */
  async append(text: string, voiceId?: string, onStart?: () => void, parameters?: Partial<AssistantTtsParameters>): Promise<boolean> {
    const started = performance.now()
    const diagnosticId = voiceDiagnosticId()
    const fields: VoiceDiagnosticFields = { ...this.options.traceContext?.(), diagnosticId, textLength: text.length }
    const trace: VoiceDiagnosticTrace = (event, metrics) => this.options.trace?.(`client.tts.${event}`, { ...fields, ...metrics })
    let chunks = 0; let audioMs = 0; let lastChunkAt = started
    const playback = readAssistantTtsParameters(parameters)
    const sequence = this.sequence
    const continuation = this.abort !== undefined
    const abort = this.abort ?? new AbortController(); this.abort = abort
    const readerSignal = abort.signal
    trace('start', { continuation })
    try {
      await this.prepare()
      if (readerSignal.aborted) return false
      const queueStarted = performance.now()
      // 只提前准备有限音频；继续播放时逐步放行，仍只使用一个 Host 推理进程。
      await this.waitUntil(() => this.sources.size === 0 || this.nextStart - this.context!.currentTime <= 5, readerSignal)
      if (readerSignal.aborted) return false
      trace('queue_ready', { waitMs: performance.now() - queueStarted, queueMs: Math.max(0, this.nextStart - this.context!.currentTime) * 1000 })
      this.volume = playback.volume
      this.gain!.gain.value = this.muted ? 0 : this.volume
      const response = await (this.options.fetch ?? globalThis.fetch)(new URL(ASSISTANT_TTS_PATH, globalThis.location?.origin ?? 'http://localhost'), {
        method: 'POST', credentials: 'same-origin', signal: readerSignal,
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ text, parameters: playback, diagnosticId, ...(voiceId === undefined ? {} : { voiceId }), ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }), ...(fields.ownerId === undefined ? {} : { ownerId: fields.ownerId }) }),
      })
      trace('headers', { status: response.status, durationMs: performance.now() - started })
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as { error?: unknown }
        throw new Error(typeof value.error === 'string' ? value.error : `Host TTS 请求失败（${response.status}）`)
      }
      if (response.body === null) throw new Error('Host TTS 响应缺少音频流')
      const reader = response.body.getReader(); const decoder = new TextDecoder()
      let buffer = ''; let completed = false; let played = false
      try {
        while (true) {
          const next = await reader.read()
          if (readerSignal.aborted) return false
          if (next.done) break
          buffer += decoder.decode(next.value, { stream: true })
          if (buffer.length > 2 * 1024 * 1024) throw new Error('Host TTS 音频事件过大')
          let boundary = buffer.indexOf('\n')
          while (boundary >= 0) {
            const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1)
            if (line !== '') {
              const event = JSON.parse(line) as Record<string, unknown>
              if (completed) throw new Error('Host TTS 在完成后继续返回音频')
              if (event.type === 'error') throw new Error(String(event.message))
              if (event.type === 'done') completed = true
              else if (event.type === 'audio') {
                const arrived = performance.now()
                if (chunks === 0) trace('first_audio', { firstAudioMs: arrived - started })
                const samples = decodeMossPcm(event)
                const decodeMs = performance.now() - arrived
                chunks++; audioMs += samples.length / Number(event.sampleRate) * 1000
                trace('chunk', { chunks, decodeMs, samples: samples.length, audioMs: samples.length / Number(event.sampleRate) * 1000, intervalMs: arrived - lastChunkAt, queueMs: Math.max(0, this.nextStart - this.context!.currentTime) * 1000 })
                lastChunkAt = arrived
                if (!played && continuation) this.nextStart += playback.segmentPauseMs / 1000
                await this.waitUntil(() => this.sources.size === 0 || this.nextStart - this.context!.currentTime <= 5, readerSignal)
                if (readerSignal.aborted) return false
                this.enqueue(samples, Number(event.sampleRate), playback.rate, trace, chunks === 1 && !continuation)
                if (!played) { played = true; onStart?.() }
              } else throw new Error('Host TTS 返回未知事件')
            }
            boundary = buffer.indexOf('\n')
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      if (!completed || !played || buffer.trim() !== '') throw new Error('Host TTS 音频流未完整结束')
      trace('generated', { durationMs: performance.now() - started, chunks, audioMs, realTimeFactor: audioMs > 0 ? (performance.now() - started) / audioMs : 0 })
      return !readerSignal.aborted && sequence === this.sequence
    } catch (error) {
      trace('error', { aborted: readerSignal.aborted, durationMs: performance.now() - started, errorName: voiceDiagnosticError(error) })
      if (readerSignal.aborted || sequence !== this.sequence) return false
      this.cancel()
      throw error
    }
  }

  /** 文本队列耗尽后再等音频播完；取消旧轮次不会误清理新轮次的请求。 */
  async finish(): Promise<boolean> {
    const abort = this.abort
    if (abort === undefined) return true
    const sequence = this.sequence
    await this.waitUntil(() => this.sources.size === 0, abort.signal)
    if (this.abort === abort) this.abort = undefined
    return !abort.signal.aborted && sequence === this.sequence
  }

  cancel(): void {
    this.sequence++; this.abort?.abort(); this.abort = undefined
    for (const source of this.sources) { source.onended = null; try { source.stop() } catch { /* 已经播放完 */ } source.disconnect() }
    this.sources.clear(); this.nextStart = 0
  }

  dispose(): void { this.cancel(); this.gain?.disconnect(); this.gain = undefined; const context = this.context; this.context = undefined; void context?.close().catch(() => undefined) }

  private enqueue(samples: Float32Array, sampleRate: number, rate: number, trace: VoiceDiagnosticTrace, first: boolean): void {
    const context = this.context!
    // 最多保留 30 秒待播音频，让异常快速生成也不能无限积压浏览器内存。
    if (this.nextStart - context.currentTime > 30) throw new Error('MOSS 播放队列过长，请缩短文本')
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = rate; source.connect(this.gain!)
    source.onended = () => { this.sources.delete(source); source.disconnect() }
    this.sources.add(source)
    const start = Math.max(context.currentTime + 0.02, this.nextStart)
    const gapMs = this.nextStart > 0 ? Math.max(0, context.currentTime - this.nextStart) * 1000 : 0
    trace('playback_scheduled', { gapMs, queueMs: (start - context.currentTime) * 1000, sourceCount: this.sources.size, contextState: context.state, muted: this.muted })
    if (first) trace('first_playback_scheduled', { queueMs: (start - context.currentTime) * 1000 })
    // 后一块按实际变速后的时长接续，避免调快时留空隙、调慢时相互重叠。
    source.start(start); this.nextStart = start + buffer.duration / rate
  }

  private async waitUntil(ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (ready() || signal.aborted) return
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
      const check = (): void => { if (signal.aborted || ready()) finish(); else timer = setTimeout(check, 30) }
      signal.addEventListener('abort', finish, { once: true }); check()
    })
  }
}

/** PCM 固定为 48kHz、单声道、16 位小端，与 Host 工作进程协议一致。 */
export function decodeMossPcm(event: Record<string, unknown>): Float32Array {
  if (event.sampleRate !== 48_000 || typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('Host TTS PCM 格式无效')
  const raw = atob(event.data)
  if (raw.length === 0 || raw.length % 2 !== 0) throw new Error('Host TTS PCM 长度无效')
  const samples = new Float32Array(raw.length / 2)
  for (let index = 0; index < samples.length; index++) {
    const value = raw.charCodeAt(index * 2) | raw.charCodeAt(index * 2 + 1) << 8
    samples[index] = (value >= 32768 ? value - 65536 : value) / 32768
  }
  return samples
}
