import type { CodingNsClientServices, CodingNsRpcResult } from './features/types.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { ASSISTANT_VOICE_EVENTS_PATH, ASSISTANT_VOICE_STREAM_PATH } from '../shared/voice-stream.js'
import type { VoiceClientDevice, VoicePcmFrame, VoiceRuntimeAdapter, VoiceRuntimeCapabilities, VoiceRuntimeEvent, VoiceRuntimeListener, VoiceRuntimeState } from '../shared/contracts/voice-runtime.js'
import { BrowserVoiceDeviceManager } from './voice-device-manager.js'
import { ClientVoiceCapture } from './voice-capture.js'
import { createVoiceHttpError, VoiceStreamUploader } from './voice-stream-uploader.js'
import { MossVoiceOutput } from './moss-voice-output.js'
import { StreamingSentenceQueue } from './streaming-sentence-queue.js'
import { readAssistantTtsParameters, readAssistantTtsSettings } from '../shared/assistant-tts.js'
import { ClientVoiceDiagnostics } from './voice-diagnostics.js'
import { voiceDiagnosticError, type VoiceDiagnosticTrace } from '../shared/voice-diagnostics.js'
import { VoiceChatUpdates } from './voice-chat-updates.js'
import type { AssistantChatRun } from '../shared/contracts/assistant.js'

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
  private leaseRequest: Promise<CodingNsRpcResult> | undefined
  private stopOperation: Promise<void> | undefined
  private active = false
  private hostLeaseActive = false
  private epoch = 0
  private configuredOwner: string
  private selectedInputDeviceId: string | undefined
  private selectedOutputDeviceId: string | undefined
  private diagnostics: ClientVoiceDiagnostics | undefined
  private readonly trace: VoiceDiagnosticTrace = (event, fields) => this.diagnostics?.record(event, fields)
  private readonly output = new MossVoiceOutput({ trace: this.trace, traceContext: () => ({ ownerId: this.configuredOwner, epoch: this.epoch, requestId: this.reply?.requestId }) })
  private reply: { readonly requestId: string; readonly epoch: number; readonly abort: AbortController; readonly startedAt: number; readonly updates: VoiceChatUpdates; playbackStarted: boolean } | undefined
  private chatStreaming = false
  private clearOperation: Promise<void> | undefined
  private settleSpeech: (() => void) | undefined
  private replySequence = 0
  private microphoneMuted = false
  private speakerMuted = false

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
    const moss = readAssistantTtsSettings(this.services.settings?.getSnapshot().value?.assistant.tts).backend === 'moss-onnx'
    const output = moss ? typeof globalThis.AudioContext === 'function' : typeof globalThis.speechSynthesis !== 'undefined'
    return { realtime: supported, wakeWord: false, streamingInput: supported, streamingOutput: moss && output, bargeIn: supported, speechToText: supported, textToSpeech: output }
  }

  get ownerId(): string | undefined { return this.active ? this.configuredOwner : undefined }
  get configuredOwnerId(): string { return this.configuredOwner }
  get inputDeviceId(): string | undefined { return this.selectedInputDeviceId }
  get outputDeviceId(): string | undefined { return this.selectedOutputDeviceId }
  get outputDeviceSupported(): boolean { return readAssistantTtsSettings(this.services.settings?.getSnapshot().value?.assistant.tts).backend === 'moss-onnx' && this.output.outputDeviceSupported }
  get isMicrophoneMuted(): boolean { return this.microphoneMuted }
  get isSpeakerMuted(): boolean { return this.speakerMuted }

  setMicrophoneMuted(muted: boolean): void {
    this.microphoneMuted = muted; this.capture?.setMuted(muted)
    if (muted) this.emit({ type: 'partial', text: '', epoch: this.epoch })
  }
  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted; this.output.setMuted(muted)
    if (muted && readAssistantTtsSettings(this.services.settings?.getSnapshot().value?.assistant.tts).backend === 'browser') {
      this.settleSpeech?.(); this.settleSpeech = undefined; globalThis.speechSynthesis?.cancel()
    }
  }

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
    await this.output.setOutputDevice(deviceId)
    await this.devices.selectOutput(deviceId)
    this.selectedOutputDeviceId = this.devices.snapshot().selectedOutputId ?? undefined
  }

  async start(ownerId?: string): Promise<void> {
    if (this.stopOperation !== undefined) await this.stopOperation
    if (this.active) return
    this.configuredOwner = ownerId?.trim() || this.configuredOwner
    if (this.configuredOwner === '') throw new Error('全局语音租约缺少 ownerId')
    const abort = new AbortController()
    const started = performance.now()
    const callId = createClientId()
    this.responseAbort = abort
    this.active = true
    this.setMicrophoneMuted(false); this.setSpeakerMuted(false)
    try {
      if (readAssistantTtsSettings(this.services.settings?.getSnapshot().value?.assistant.tts).backend === 'moss-onnx') {
        await this.output.prepare()
        if (this.output.outputDeviceSupported && this.selectedOutputDeviceId !== undefined) await this.output.setOutputDevice(this.selectedOutputDeviceId)
      }
      const leaseStarted = performance.now()
      const leaseRequest = this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/start', { ownerId: this.configuredOwner, voiceSessionId: callId }, abort.signal)
      this.leaseRequest = leaseRequest
      const lease = await leaseRequest.finally(() => { if (this.leaseRequest === leaseRequest) this.leaseRequest = undefined })
      if (!lease.ok) throw new Error(lease.error.message)
      if (isRecord(lease.value) && lease.value.unavailable === true) throw new Error(typeof lease.value.message === 'string' ? lease.value.message : '本地 Sherpa 语音运行时不可用')
      if (abort.signal.aborted) throw new Error('语音启动已取消')
      this.hostLeaseActive = true
      // epoch 以 Host 租约为准，不能让刷新后的页面从 1 重新计数。
      this.epoch = readEpoch(isRecord(lease.value) ? lease.value : {}, this.epoch + 1)
      if (isRecord(lease.value) && lease.value.diagnosticsEnabled === true) {
        this.diagnostics = new ClientVoiceDiagnostics(this.services, { ownerId: this.configuredOwner, callId })
        this.trace('client.call.lease', { epoch: this.epoch, durationMs: performance.now() - leaseStarted })
      }
      this.emit({ type: 'state', state: 'loading', epoch: this.epoch })
      const snapshot = await this.devices.refresh()
      if (!snapshot.secureContext) throw new Error('当前页面不是安全上下文，请改用 HTTPS 或 localhost 后访问麦克风')
      if (abort.signal.aborted) throw new Error('语音启动已取消')
      const clientId = createClientId()
      this.uploader = new VoiceStreamUploader({ url: resolveVoiceStreamUrl(ASSISTANT_VOICE_STREAM_PATH, { mode: 'frames' }), ownerId: this.configuredOwner, clientId, trace: this.trace, onError: (error) => this.failTransport(error, abort) })
      const eventsStarted = performance.now()
      const response = await globalThis.fetch(resolveVoiceStreamUrl(ASSISTANT_VOICE_EVENTS_PATH, { ownerId: this.configuredOwner, clientId }), {
        method: 'GET',
        signal: abort.signal,
        credentials: 'same-origin',
        headers: { accept: 'application/x-ndjson' },
      })
      if (!response.ok) throw await createVoiceHttpError(response, '语音流连接失败')
      if (response.body === null) throw new Error('语音事件连接缺少响应正文')
      this.chatStreaming = response.headers.get('x-codingns-voice-chat-stream') === '1'
      this.trace('client.events.connected', { durationMs: performance.now() - eventsStarted, status: response.status, streaming: this.chatStreaming })
      void this.readEvents(response.body, abort)
      const capture = new ClientVoiceCapture({ devices: this.devices, targetSampleRate: 16_000, trace: this.trace, onFrame: (frame) => { if (this.responseAbort === abort) this.sendPcmFrame(frame, this.epoch) }, onEnded: (error) => this.failTransport(error, abort) })
      this.capture = capture
      await capture.start()
      if (abort.signal.aborted) { await capture.stop(); throw new Error('语音启动已取消') }
      this.emit({ type: 'state', state: 'listening', epoch: this.epoch })
      this.trace('client.call.started', { epoch: this.epoch, durationMs: performance.now() - started })
    } catch (error) {
      this.trace('client.call.error', { durationMs: performance.now() - started, errorName: voiceDiagnosticError(error) })
      if (this.responseAbort === abort) await this.stop().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopOperation !== undefined) return this.stopOperation
    const operation = this.stopSession()
    this.stopOperation = operation
    try { await operation } finally { if (this.stopOperation === operation) this.stopOperation = undefined }
  }

  private async stopSession(): Promise<void> {
    if (!this.active && this.capture === undefined && !this.hostLeaseActive) return
    const leaseRequest = this.leaseRequest
    const diagnostics = this.diagnostics
    const stopped = performance.now()
    this.active = false
    this.chatStreaming = false
    this.cancelReply()
    this.uploader?.close()
    this.uploader = undefined
    this.responseAbort?.abort()
    this.responseAbort = undefined
    globalThis.speechSynthesis?.cancel()
    this.output.dispose()
    let captureError: unknown
    try {
      await this.capture?.stop()
    } catch (error) {
      // 采集器可能已经被浏览器提前终止；无论如何都必须继续释放 Host 租约。
      captureError = error
    }
    this.capture = undefined
    // 用户在模型启动期间关闭窗口时，RPC 取消不一定能撤销 Host 已创建的租约。
    // 等待该请求结算后再释放，避免迟到的 start 留下无人持有的实时识别器。
    const pendingLease = await leaseRequest?.catch(() => undefined)
    if (pendingLease?.ok && !(isRecord(pendingLease.value) && pendingLease.value.unavailable === true)) this.hostLeaseActive = true
    if (this.hostLeaseActive) {
      this.hostLeaseActive = false
      await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/stop', { ownerId: this.configuredOwner }).catch(() => undefined)
    }
    this.epoch += 1
    this.emit({ type: 'state', state: 'disabled', epoch: this.epoch })
    diagnostics?.record('client.call.stopped', { epoch: this.epoch, durationMs: performance.now() - stopped })
    diagnostics?.dispose()
    if (this.diagnostics === diagnostics) this.diagnostics = undefined
    if (captureError !== undefined) throw captureError
  }

  async interrupt(): Promise<void> {
    if (!this.active) return
    this.cancelReply()
    this.uploader?.clearPending()
    // 只走一次控制 RPC，避免数据面与 RPC 各打断一次，导致双方 epoch 错位。
    const result = await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/interrupt', { ownerId: this.configuredOwner })
    if (!result.ok) throw new Error(result.error.message)
    if (!this.active) return
    this.epoch = readEpoch(isRecord(result.value) ? result.value : {}, this.epoch + 1)
    this.emit({ type: 'barge-in', epoch: this.epoch })
  }

  sendPcm(frame: VoicePcmFrame, epoch: number): void { this.sendPcmFrame(frame, epoch) }

  async speak(text: string, epoch: number, isCurrent: () => boolean = () => true, settleState = true): Promise<void> {
    if (epoch !== this.epoch || text.trim() === '' || !isCurrent()) return
    const tts = readAssistantTtsSettings(this.services.settings?.getSnapshot().value?.assistant.tts)
    const parameters = readAssistantTtsParameters(tts.parameters)
    const reply = this.reply
    const onStart = (): void => {
      if (epoch !== this.epoch || !isCurrent()) return
      if (reply !== undefined && !reply.playbackStarted) {
        reply.playbackStarted = true
        this.trace('client.turn.first_playback_scheduled', { requestId: reply.requestId, epoch, firstPlaybackMs: performance.now() - reply.startedAt })
      }
      this.emit({ type: 'state', state: 'speaking', epoch })
    }
    if (tts.backend === 'moss-onnx') {
      globalThis.speechSynthesis?.cancel()
      // 完整试听等待播放结束；对话分段只等待合成结束，下一段可在播放期间准备。
      const completed = await this.output[settleState ? 'speak' : 'append'](text.trim(), tts.selectedId, onStart, parameters)
      if (settleState && completed && this.active && epoch === this.epoch && isCurrent()) this.emit({ type: 'state', state: 'listening', epoch })
      return
    }
    this.output.cancel()
    if (this.speakerMuted) return
    const synthesis = globalThis.speechSynthesis
    if (synthesis === undefined || typeof globalThis.SpeechSynthesisUtterance !== 'function') throw new Error('当前浏览器不支持语音播报')
    this.cancelOutput()
    await new Promise<void>((resolve, reject) => {
      this.settleSpeech = resolve
      const utterance = new SpeechSynthesisUtterance(text.trim())
      utterance.lang = 'zh-CN'
      utterance.rate = parameters.rate
      utterance.volume = parameters.volume
      utterance.onstart = onStart
      utterance.onend = () => resolve()
      utterance.onerror = (event) => { if (isCurrent()) reject(new Error(`浏览器语音播报失败：${event.error}`)); else resolve() }
      synthesis.speak(utterance)
    })
    if (isCurrent()) this.settleSpeech = undefined
    if (settleState && this.active && epoch === this.epoch && isCurrent()) this.emit({ type: 'state', state: 'listening', epoch })
  }

  async clearConversation(): Promise<void> {
    this.cancelReply()
    if (!this.active) return
    const epoch = this.epoch
    const operation = this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/chat/clear', { ownerId: this.configuredOwner, epoch }).then((result) => {
      if (!result.ok) throw new Error(result.error.message)
      if (this.active && this.epoch === epoch && this.reply === undefined) this.emit({ type: 'state', state: 'listening', epoch })
    })
    this.clearOperation = operation
    try { await operation } finally { if (this.clearOperation === operation) this.clearOperation = undefined }
  }

  dispose(): void { void this.stop(); this.devices.dispose(); this.listeners.clear() }

  private sendPcmFrame(frame: VoicePcmFrame, epoch: number): void {
    if (!this.active || this.uploader === undefined || epoch !== this.epoch) return
    this.uploader.enqueue(frame, epoch)
  }

  private async readEvents(body: ReadableStream<Uint8Array>, abort: AbortController): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) {
          if (!abort.signal.aborted) throw new Error('语音事件连接已断开，请重新开始实时对话')
          break
        }
        text += decoder.decode(next.value, { stream: true })
        let newline = text.indexOf('\n')
        while (newline >= 0) {
          const line = text.slice(0, newline).trim()
          text = text.slice(newline + 1)
          if (line !== '' && this.responseAbort === abort) this.handleEvent(JSON.parse(line) as Record<string, unknown>)
          newline = text.indexOf('\n')
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) this.failTransport(error instanceof Error ? error : new Error(String(error)), abort)
    } finally {
      reader.releaseLock()
    }
  }

  private handleEvent(value: Record<string, unknown>): void {
    const eventEpoch = readEpoch(value, this.epoch)
    if (eventEpoch < this.epoch || typeof value.type !== 'string') return
    if (value.type === 'chat') {
      const reply = this.reply
      if (reply !== undefined && eventEpoch === reply.epoch && isVoiceChatRun(value.run) && value.run.requestId === reply.requestId) {
        reply.updates.push(value.run)
        this.trace('client.turn.stream_update', { requestId: reply.requestId, epoch: eventEpoch, state: value.run.state, textLength: value.run.text.length })
      }
      return
    }
    if (eventEpoch > this.epoch || value.type === 'barge-in') this.cancelReply()
    this.epoch = eventEpoch
    this.trace('client.voice.event', { epoch: eventEpoch, state: value.type as string, textLength: typeof value.text === 'string' ? value.text.length : undefined })
    if (value.type === 'state' && typeof value.state === 'string') {
      // 识别器继续收音，等待回复时保留思考／播报状态。
      if (this.reply === undefined || value.state !== 'listening') this.emit({ type: 'state', state: value.state as VoiceRuntimeState, epoch: eventEpoch })
    }
    else if (value.type === 'partial' && typeof value.text === 'string' && !this.microphoneMuted) this.emit({ type: 'partial', text: value.text, epoch: eventEpoch })
    else if (value.type === 'final' && typeof value.text === 'string') {
      if (this.microphoneMuted) return
      if (value.text.trim() === '') return
      const requestId = createClientId()
      this.emit({ type: 'final', text: value.text, epoch: eventEpoch, requestId })
      // LLM 和播报在后台运行，下一句的 partial 继续实时显示。
      void this.handleFinalText(value.text, eventEpoch, requestId)
    } else if (value.type === 'barge-in') this.emit({ type: 'barge-in', epoch: eventEpoch })
    else if (value.type === 'error') this.emit({ type: 'error', code: String(value.code ?? 'voice_stream_error'), message: String(value.message ?? value.code ?? ''), recoverable: value.recoverable !== false, epoch: eventEpoch })
  }

  private async handleFinalText(text: string, epoch: number, requestId: string): Promise<void> {
    this.cancelReply()
    const reply = { requestId, epoch, abort: new AbortController(), startedAt: performance.now(), updates: new VoiceChatUpdates(), playbackStarted: false }
    this.reply = reply
    const started = performance.now()
    const fields = { requestId, epoch, textLength: text.length }
    const diagnostics = this.diagnostics
    const trace: VoiceDiagnosticTrace = (event, metrics) => diagnostics?.record(event, { ...fields, ...metrics })
    let polls = 0; let firstText = false; let firstSentence = false
    let outcome = 'cancelled'
    trace('client.turn.start')
    const isCurrent = (): boolean => this.active && this.epoch === epoch && this.reply === reply && !reply.abort.signal.aborted
    const sentences = new StreamingSentenceQueue(async (sentence) => {
      if (!firstSentence) { firstSentence = true; trace('client.turn.first_sentence', { firstSentenceMs: performance.now() - started }) }
      await this.speak(sentence, epoch, isCurrent, false)
    }, isCurrent, Date.now, (event, metrics) => trace(`client.${event}`, metrics))
    const payload = { ownerId: this.configuredOwner, epoch, requestId, sequence: ++this.replySequence }
    try {
      await this.clearOperation
      if (!isCurrent()) return
      this.emit({ type: 'state', state: 'thinking', epoch })
      let result = await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/chat/start', { ...payload, text }, reply.abort.signal)
      let previousText = ''
      while (isCurrent()) {
        if (!result.ok) throw new Error(result.error.message)
        // 首次推送可能早于 start RPC 返回；累计快照优先，不能被旧响应覆盖。
        const pushed = reply.updates.take()
        if (pushed !== undefined && (!isRecord(result.value) || result.value.state === 'running' || pushed.state !== 'running')) result = { ok: true, value: pushed }
        const run = result.value
        if (!isRecord(run) || typeof run.text !== 'string' || !['running', 'completed', 'failed', 'cancelled'].includes(String(run.state))) throw new Error('语音 LLM 返回了无效的对话状态')
        if (run.text !== previousText || run.state === 'completed') {
          if (!firstText && run.text.trim() !== '') { firstText = true; trace('client.turn.first_text', { firstTextMs: performance.now() - started }) }
          previousText = run.text
          this.emit({ type: 'reply', requestId, text: run.text, final: run.state === 'completed', epoch })
        }
        if (run.state === 'running' || run.state === 'completed') sentences.push(run.text, run.state === 'completed')
        if (run.state === 'completed') {
          trace('client.turn.llm_completed', { durationMs: performance.now() - started, count: polls, textLength: run.text.length })
          await sentences.drain()
          if (isCurrent()) await this.output.finish()
          if (isCurrent()) this.emit({ type: 'state', state: 'listening', epoch })
          outcome = isCurrent() ? 'completed' : 'cancelled'
          return
        }
        if (run.state !== 'running') throw new Error(typeof run.error === 'string' ? run.error : '语音 LLM 对话已停止')
        if (this.chatStreaming) {
          const pushed = await reply.updates.next(reply.abort.signal)
          if (pushed !== undefined) { result = { ok: true, value: pushed }; continue }
          if (isCurrent()) trace('client.turn.poll_fallback')
        } else await waitForReplyPoll(reply.abort.signal)
        if (!isCurrent()) return
        const pollStarted = performance.now(); polls++
        result = await this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/chat/read', payload, reply.abort.signal)
        if (performance.now() - pollStarted >= 250) trace('client.turn.slow_poll', { durationMs: performance.now() - pollStarted })
      }
    } catch (error) {
      if (isCurrent()) {
        outcome = 'failed'; trace('client.turn.error', { errorName: voiceDiagnosticError(error), durationMs: performance.now() - started })
        this.emit({ type: 'error', code: 'voice_chat_failed', message: error instanceof Error ? error.message : String(error), recoverable: true, epoch })
        this.cancelReply()
      }
    } finally {
      trace('client.turn.finished', { state: outcome, count: polls, durationMs: performance.now() - started })
      if (this.reply === reply) this.reply = undefined
    }
  }

  private cancelReply(): void {
    const reply = this.reply
    this.reply = undefined
    if (reply !== undefined) this.trace('client.turn.cancel', { requestId: reply.requestId, epoch: reply.epoch })
    reply?.abort.abort()
    this.cancelOutput()
    if (reply !== undefined) void this.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/chat/cancel', { ownerId: this.configuredOwner, epoch: reply.epoch, requestId: reply.requestId }).catch(() => undefined)
  }

  private cancelOutput(): void {
    this.settleSpeech?.()
    this.settleSpeech = undefined
    globalThis.speechSynthesis?.cancel()
    this.output.cancel()
  }

  private failTransport(error: Error, abort: AbortController): void {
    if (this.responseAbort !== abort || abort.signal.aborted) return
    this.trace('client.transport.error', { epoch: this.epoch, errorName: voiceDiagnosticError(error) })
    void this.stop().catch(() => undefined).then(() => {
      if (!this.active) this.emit({ type: 'error', code: 'voice_stream_failed', message: error.message, recoverable: false, epoch: this.epoch })
    })
  }

  private emit(event: VoiceRuntimeEvent): void { for (const listener of [...this.listeners]) { try { listener(event) } catch { /* UI 订阅者异常不能破坏语音数据面 */ } } }
}

function resolveVoiceStreamUrl(path: string, parameters: Record<string, string>): string {
  const url = new URL(path, globalThis.location?.origin ?? 'http://localhost')
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
  return url.toString()
}
function createClientId(): string { try { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` } catch { return `${Date.now()}-${Math.random()}` } }
function readEpoch(value: Record<string, unknown>, fallback: number): number { return typeof value.epoch === 'number' && Number.isInteger(value.epoch) ? value.epoch : fallback }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isVoiceChatRun(value: unknown): value is AssistantChatRun {
  return isRecord(value) && typeof value.requestId === 'string' && typeof value.text === 'string' && value.text.length <= 16000 && ['running', 'completed', 'failed', 'cancelled'].includes(String(value.state))
}

function waitForReplyPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, 250)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
