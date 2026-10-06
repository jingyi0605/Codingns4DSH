import type { VoicePcmFrame } from '../shared/contracts/voice-runtime.js'
import { inspectBrowserVoiceSecurity } from './voice-security.js'
import { BrowserVoiceDeviceManager } from './voice-device-manager.js'

export interface ClientVoiceCaptureOptions {
  readonly devices: BrowserVoiceDeviceManager
  readonly onFrame: (frame: VoicePcmFrame) => void | Promise<void>
  readonly onEnded?: (error: Error) => void
  readonly targetSampleRate?: number
}

interface CaptureAudioContext extends AudioContext {
  readonly audioWorklet: AudioWorklet
}

/** 浏览器端实时 PCM 采集器；设备权限始终由 Client 自己持有。 */
export class ClientVoiceCapture {
  private readonly options: ClientVoiceCaptureOptions
  private stream: MediaStream | undefined
  private context: CaptureAudioContext | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private processor: AudioWorkletNode | ScriptProcessorNode | undefined
  private output: GainNode | undefined
  private workletUrl: string | undefined
  private sequence = 0
  private started = false
  private inputRate = 16_000

  constructor(options: ClientVoiceCaptureOptions) { this.options = options }

  get isStarted(): boolean { return this.started }

  async start(): Promise<void> {
    if (this.started) return
    const security = inspectBrowserVoiceSecurity()
    if (!security.secure) throw new Error('当前页面不是安全上下文，请改用 HTTPS 或 localhost 后访问麦克风')
    const mediaDevices = globalThis.navigator?.mediaDevices
    if (mediaDevices === undefined || typeof mediaDevices.getUserMedia !== 'function') throw new Error('当前浏览器不支持 getUserMedia')
    const permission = await this.options.devices.requestInputPermission()
    const selected = permission.selectedInputId
    const constraints: MediaStreamConstraints = {
      audio: selected === null ? { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } : {
        deviceId: { exact: selected },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    }
    const stream = await mediaDevices.getUserMedia(constraints)
    this.stream = stream
    try {
      const Context = (globalThis as typeof globalThis & { AudioContext?: new (options?: AudioContextOptions) => CaptureAudioContext; webkitAudioContext?: new (options?: AudioContextOptions) => CaptureAudioContext }).AudioContext
        ?? (globalThis as typeof globalThis & { webkitAudioContext?: new (options?: AudioContextOptions) => CaptureAudioContext }).webkitAudioContext
      if (Context === undefined) throw new Error('当前浏览器不支持 AudioContext')
      const context = new Context({ sampleRate: this.options.targetSampleRate ?? 16_000 })
      this.context = context
      this.inputRate = context.sampleRate
      await context.resume()
      this.source = context.createMediaStreamSource(stream)
      this.output = context.createGain()
      this.output.gain.value = 0
      this.output.connect(context.destination)
      this.sequence = 0
      if (context.audioWorklet !== undefined && typeof AudioWorkletNode === 'function') await this.startWorklet(context)
      else this.startScriptProcessor(context)
      this.started = true
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', this.handleEnded, { once: true })
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    const stream = this.stream
    const processor = this.processor
    this.started = false
    this.stream = undefined
    this.processor = undefined
    this.source?.disconnect()
    this.source = undefined
    processor?.disconnect()
    this.output?.disconnect()
    this.output = undefined
    if (this.context !== undefined && this.context.state !== 'closed') await this.context.close()
    this.context = undefined
    if (this.workletUrl !== undefined) URL.revokeObjectURL(this.workletUrl)
    this.workletUrl = undefined
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener('ended', this.handleEnded)
      try { track.stop() } catch { /* 轨道可能已由浏览器停止 */ }
    }
  }

  private async startWorklet(context: CaptureAudioContext): Promise<void> {
    const source = this.source
    const output = this.output
    if (source === undefined || output === undefined || context.audioWorklet === undefined) throw new Error('音频采集图未初始化')
    const sourceText = `class CodingNsVoiceProcessor extends AudioWorkletProcessor { process(inputs) { const input = inputs[0] && inputs[0][0]; if (input) this.port.postMessage(new Float32Array(input)); return true; } } registerProcessor('codingns-voice-capture', CodingNsVoiceProcessor);`
    const blob = new Blob([sourceText], { type: 'application/javascript' })
    this.workletUrl = URL.createObjectURL(blob)
    await context.audioWorklet.addModule(this.workletUrl)
    const node = new AudioWorkletNode(context, 'codingns-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    node.port.onmessage = (event: MessageEvent<Float32Array>): void => {
      if (!this.started && this.context !== context) return
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data)
      this.emitSamples(samples)
    }
    source.connect(node)
    node.connect(output)
    this.processor = node
  }

  private startScriptProcessor(context: CaptureAudioContext): void {
    const source = this.source
    const output = this.output
    if (source === undefined || output === undefined) throw new Error('音频采集图未初始化')
    const node = context.createScriptProcessor(1024, 1, 1)
    node.onaudioprocess = (event): void => this.emitSamples(event.inputBuffer.getChannelData(0))
    source.connect(node)
    node.connect(output)
    this.processor = node
  }

  private readonly handleEnded = (): void => {
    if (!this.started) return
    this.options.onEnded?.(new Error('麦克风轨道已结束'))
    void this.stop()
  }

  private emitSamples(samples: Float32Array): void {
    if (!this.started) return
    const bytes = resampleFloat32ToPcm16(samples, this.inputRate, this.options.targetSampleRate ?? 16_000)
    if (bytes.byteLength === 0) return
    const frame: VoicePcmFrame = { sequence: ++this.sequence, bytes, sampleRate: this.options.targetSampleRate ?? 16_000, channels: 1 }
    void Promise.resolve(this.options.onFrame(frame)).catch((error) => this.options.onEnded?.(error instanceof Error ? error : new Error(String(error))))
  }
}

/** 无依赖的线性重采样，适合语音 16 kHz 采集；整段音频不会进入内存。 */
export function resampleFloat32ToPcm16(samples: Float32Array, inputRate: number, outputRate: number): Uint8Array {
  if (samples.length === 0) return new Uint8Array()
  if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) throw new RangeError('采样率必须为正数')
  const outputLength = Math.max(1, Math.round(samples.length * outputRate / inputRate))
  const bytes = new Uint8Array(outputLength * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * inputRate / outputRate
    const left = Math.min(samples.length - 1, Math.floor(sourcePosition))
    const right = Math.min(samples.length - 1, left + 1)
    const fraction = sourcePosition - left
    const sample = Math.max(-1, Math.min(1, (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction))
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true)
  }
  return bytes
}
