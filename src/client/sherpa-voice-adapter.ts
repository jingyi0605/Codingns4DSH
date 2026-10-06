import type { CodingNsClientServices } from './features/types.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { VoiceClientDevice, VoicePcmFrame, VoiceRuntimeAdapter, VoiceRuntimeCapabilities, VoiceRuntimeEvent, VoiceRuntimeListener, VoiceRuntimeState } from '../shared/contracts/voice-runtime.js'
import { encodeVoiceStreamMessage, encodeVoiceStreamOpen } from '../shared/voice-stream.js'
import { BrowserVoiceDeviceManager } from './voice-device-manager.js'
import { ClientVoiceCapture } from './voice-capture.js'

export interface SherpaClientVoiceAdapterOptions {
  readonly ownerId: string
  readonly services: CodingNsClientServices
}

/** 浏览器侧 Sherpa 数据面：设备和权限在 Client，识别在 Host。 */
export class ClientSherpaVoiceAdapter implements VoiceRuntimeAdapter {
  private readonly listeners = new Set<VoiceRuntimeListener>()
  private readonly services: CodingNsClientServices
  private readonly devices: BrowserVoiceDeviceManager
  private readonly options: SherpaClientVoiceAdapterOptions
  private capture: ClientVoiceCapture | undefined
  private uploader: VoiceStreamUploader | undefined
  private responseAbort: AbortController | undefined
  private active = false
  private hostLeaseActive = false
  private epoch = 0
  private configuredOwner: string
  private selectedInputDeviceId: string | undefined
  private selectedOutputDeviceId: string | undefined

  constructor(options: SherpaClientVoiceAdapterOptions) {
    this.options = options
    this.services = options.services
    this.configuredOwner = options.ownerId
    this.devices = new BrowserVoiceDeviceManager()
    const snapshot = this.devices.snapshot()
    this.selectedInputDeviceId = snapshot.selectedInputId ?? undefined
    this.selectedOutputDeviceId = snapshot.selectedOutputId ?? undefined
    this.devices.subscribe((next) => {
      this.selectedInputDeviceId = next.selectedInputId ?? undefined
      this.selectedOutputDeviceId = next.selectedOutputId ?? undefined
    })
  }

  get capabilities(): VoiceRuntimeCapabilities {
    const secure = this.devices.snapshot().secureContext
    const supported = secure && typeof globalThis.fetch === 'function' && typeof globalThis.ReadableStream === 'function'
    return { realtime: supported, wakeWord: false, streamingInput: supported, streamingOutput: false, bargeIn: supported, speechToText: supported, textToSpeech: typeof globalThis.speechSynthesis !== 'undefined' }
  }

  get ownerId(): string | undefined { return this.active ? this.configuredOwner : undefined }
  get configuredOwnerId(): string { return this.configuredOwner }
  get inputDeviceId(): string | undefined { return this.selectedInputDeviceId }
  get outputDeviceId(): string | undefined { return this.selectedOutputDeviceId }
  get outputDeviceSupported(): boolean { return typeof (globalThis.HTMLMediaElement?.prototype as HTMLMediaElement & { setSinkId?: unknown } | undefined)?.setSinkId === 'function' }

  subscribe(listener: VoiceRuntimeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  async enumerateInputDevices(): Promise<readonly VoiceClientDevice[]> { return (await this.devices.refresh()).inputs }
  async enumerateOutputDevices(): Promise<readonly VoiceClientDevice[]> { return (await this.devices.refresh()).outputs }
  async selectInputDevice(deviceId: string): Promise<void> {
    await this.devices.selectInput(deviceId)
    this.selectedInputDeviceId = this.devices.snapshot().selectedInputId ?? undefined
    if (this.active) { await this.stop(); await this.start(this.configuredOwner) }
  }
  async selectOutputDevice(deviceId: string): Promise<void> {
    if (!this.outputDeviceSupported) throw new Error('当前浏览器不支持输出设备选择')
    await this.devices.selectOutput(deviceId)
    this.selectedOutputDeviceId = this.devices.snapshot().selectedOutputId ?? undefined
    await this.applyOutputDevice()
  }

  async start(ownerId?: string): Promise<void> {
    if (this.active) return
    this.configuredOwner = ownerId?.trim() || this.configuredOwner
    if (this.configuredOwner === '') throw new Error('全局语音租约缺少 ownerId')
    const lease = await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/start', { ownerId: this.configuredOwner })
    if (!lease.ok) throw new Error(lease.error.message)
    if (isRecord(lease.value) && lease.value.unavailable === true) throw new Error(typeof lease.value.message === 'string' ? lease.value.message : '本地 Sherpa 语音运行时不可用')
    this.hostLeaseActive = true
    const snapshot = await this.devices.refresh()
    if (!snapshot.secureContext) throw new Error('当前页面不是安全上下文，请改用 HTTPS 或 localhost 后访问麦克风')
    this.epoch += 1
    const epoch = this.epoch
    const uploader = new VoiceStreamUploader()
    const abort = new AbortController()
    this.uploader = uploader
    this.responseAbort = abort
    this.active = true
    this.emit({ type: 'state', state: 'loading', epoch })
    try {
      uploader.enqueue(encodeVoiceStreamOpen({ ownerId: this.configuredOwner, clientId: createClientId(), sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }))
      const response = await globalThis.fetch(resolveVoiceStreamUrl(), {
        method: 'POST',
        body: uploader.stream,
        signal: abort.signal,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream', accept: 'application/x-ndjson' },
        ...({ duplex: 'half' } as unknown as Record<string, unknown>),
      } as RequestInit)
      if (!response.ok || response.body === null) throw new Error(`语音流连接失败（HTTP ${response.status}）`)
      void this.readEvents(response.body, epoch)
      const capture = new ClientVoiceCapture({ devices: this.devices, targetSampleRate: 16_000, onFrame: (frame) => this.sendPcmFrame(frame, epoch), onEnded: (error) => this.emit({ type: 'error', code: 'voice_capture_ended', message: error.message, recoverable: true, epoch }) })
      this.capture = capture
      await capture.start()
      this.emit({ type: 'state', state: 'listening', epoch })
    } catch (error) {
      await this.stop().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.active && this.capture === undefined && !this.hostLeaseActive) return
    this.active = false
    let captureError: unknown
    try {
      await this.capture?.stop()
    } catch (error) {
      // 采集器可能已经被浏览器提前终止；无论如何都必须继续释放 Host 租约。
      captureError = error
    }
    this.capture = undefined
    this.uploader?.enqueue(encodeVoiceStreamMessage({ type: 'close', epoch: this.epoch }))
    this.uploader?.close()
    this.uploader = undefined
    this.responseAbort?.abort()
    this.responseAbort = undefined
    if (this.hostLeaseActive) {
      this.hostLeaseActive = false
      await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/stop', { ownerId: this.configuredOwner }).catch(() => undefined)
    }
    this.epoch += 1
    this.emit({ type: 'state', state: 'disabled', epoch: this.epoch })
    if (captureError !== undefined) throw captureError
  }

  async interrupt(): Promise<void> {
    this.epoch += 1
    globalThis.speechSynthesis?.cancel()
    this.uploader?.enqueue(encodeVoiceStreamMessage({ type: 'interrupt', epoch: this.epoch }))
    await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/interrupt', { ownerId: this.configuredOwner }).catch(() => undefined)
    this.emit({ type: 'barge-in', epoch: this.epoch })
  }

  sendPcm(frame: VoicePcmFrame, epoch: number): void { this.sendPcmFrame(frame, epoch) }

  async speak(text: string, epoch: number): Promise<void> {
    if (epoch !== this.epoch || text.trim() === '') return
    const synthesis = globalThis.speechSynthesis
    if (synthesis === undefined || typeof globalThis.SpeechSynthesisUtterance !== 'function') throw new Error('当前浏览器不支持语音播报')
    synthesis.cancel()
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text.trim())
      utterance.lang = 'zh-CN'
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve()
      synthesis.speak(utterance)
    })
  }

  dispose(): void { void this.stop(); this.devices.dispose(); this.listeners.clear() }

  private sendPcmFrame(frame: VoicePcmFrame, epoch: number): void {
    if (!this.active || this.uploader === undefined || epoch !== this.epoch) return
    this.uploader.enqueue(encodeVoiceStreamMessage({ type: 'pcm', sequence: frame.sequence, sampleRate: frame.sampleRate, channels: 1, epoch, byteLength: frame.bytes.byteLength }))
    this.uploader.enqueue(frame.bytes)
  }

  private async readEvents(body: ReadableStream<Uint8Array>, streamEpoch: number): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        text += decoder.decode(next.value, { stream: true })
        let newline = text.indexOf('\n')
        while (newline >= 0) {
          const line = text.slice(0, newline).trim()
          text = text.slice(newline + 1)
          if (line !== '') await this.handleEvent(JSON.parse(line) as Record<string, unknown>, streamEpoch)
          newline = text.indexOf('\n')
        }
      }
    } catch (error) {
      if (this.active) this.emit({ type: 'error', code: 'voice_stream_response_failed', message: error instanceof Error ? error.message : String(error), recoverable: true, epoch: streamEpoch })
    }
  }

  private async handleEvent(value: Record<string, unknown>, streamEpoch: number): Promise<void> {
    if (streamEpoch !== this.epoch || typeof value.type !== 'string') return
    if (value.type === 'state' && typeof value.state === 'string') this.emit({ type: 'state', state: value.state as VoiceRuntimeState, epoch: readEpoch(value, streamEpoch) })
    else if (value.type === 'partial' && typeof value.text === 'string') this.emit({ type: 'partial', text: value.text, epoch: readEpoch(value, streamEpoch) })
    else if (value.type === 'final' && typeof value.text === 'string') {
      const eventEpoch = readEpoch(value, streamEpoch)
      this.emit({ type: 'final', text: value.text, epoch: eventEpoch })
      const result = await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/text', { ownerId: this.configuredOwner, text: value.text, requestId: createClientId() })
      if (result.ok && isRecord(result.value) && typeof result.value.speechText === 'string') await this.speak(result.value.speechText, eventEpoch)
    } else if (value.type === 'barge-in') this.emit({ type: 'barge-in', epoch: readEpoch(value, streamEpoch) })
    else if (value.type === 'error') this.emit({ type: 'error', code: String(value.code ?? 'voice_stream_error'), message: String(value.message ?? value.code ?? ''), recoverable: value.recoverable !== false, epoch: readEpoch(value, streamEpoch) })
  }

  private async applyOutputDevice(): Promise<void> {
    if (!this.outputDeviceSupported) return
    for (const media of [...document.querySelectorAll<HTMLMediaElement>('audio,video')]) {
      const sink = (media as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId
      if (typeof sink === 'function') await sink.call(media, this.selectedOutputDeviceId ?? '')
    }
  }

  private emit(event: VoiceRuntimeEvent): void { for (const listener of [...this.listeners]) { try { listener(event) } catch { /* UI 订阅者异常不能破坏语音数据面 */ } } }
}

class VoiceStreamUploader {
  readonly stream: ReadableStream<Uint8Array>
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private closed = false
  constructor() { this.stream = new ReadableStream({ start: (controller) => { this.controller = controller } }) }
  enqueue(bytes: Uint8Array): void { if (!this.closed) { try { this.controller?.enqueue(bytes.slice()) } catch { this.closed = true } } }
  close(): void { if (this.closed) return; this.closed = true; try { this.controller?.close() } catch { /* fetch 已断开 */ } }
}

function resolveVoiceStreamUrl(): string { return new URL('/api/codingns/assistant/voice/stream', globalThis.location?.origin ?? 'http://localhost').toString() }
function createClientId(): string { try { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` } catch { return `${Date.now()}-${Math.random()}` } }
function readEpoch(value: Record<string, unknown>, fallback: number): number { return typeof value.epoch === 'number' && Number.isInteger(value.epoch) ? value.epoch : fallback }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
