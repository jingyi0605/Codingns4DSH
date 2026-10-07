import type { VoicePcmFrame, VoiceRuntimeAdapter, VoiceRuntimeCapabilities, VoiceRuntimeEvent, VoiceRuntimeListener } from '../../shared/contracts/voice-runtime.js'
import type { AssistantVoiceModelPaths } from '../../shared/voice-models.js'
import { prepareSherpaHotwords, type AssistantVoiceHotword, type SherpaHotwordConfig } from './assistant-voice-hotwords.js'

interface SherpaOnlineStream {
  acceptWaveform(value: { samples: Float32Array; sampleRate: number }): void
  inputFinished(): void
}

interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream
  isReady(stream: SherpaOnlineStream): boolean
  decode(stream: SherpaOnlineStream): void
  isEndpoint(stream: SherpaOnlineStream): boolean
  reset(stream: SherpaOnlineStream): void
  getResult(stream: SherpaOnlineStream): { text?: string; is_final?: boolean; is_eof?: boolean }
}

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isDetected(): boolean
  reset(): void
}

interface SherpaTts {
  sampleRate: number
  generate(request: { text: string; sid?: number; speed?: number }): { samples: Float32Array; sampleRate?: number }
}

interface SherpaModule {
  OnlineRecognizer?: new (config: Record<string, unknown>) => SherpaOnlineRecognizer
  Vad?: new (config: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaVad
  OfflineTts?: new (config: Record<string, unknown>) => SherpaTts
  version?: string
}

export interface SherpaVoiceRuntimeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly packageName?: string
  readonly sampleRate?: number
  readonly hotwords?: readonly AssistantVoiceHotword[]
}

/**
 * Sherpa-ONNX Node 的最小适配层。包和模型都是可选运行时资源，主包不把原生
 * addon 打进插件；只有用户启用语音并准备模型后才会动态加载。
 */
export class SherpaVoiceRuntime implements VoiceRuntimeAdapter {
  private readonly listeners = new Set<VoiceRuntimeListener>()
  private env: Readonly<Record<string, string | undefined>>
  private readonly packageName: string
  private readonly sampleRate: number
  private module: SherpaModule | undefined
  private recognizer: SherpaOnlineRecognizer | undefined
  private stream: SherpaOnlineStream | undefined
  private vad: SherpaVad | undefined
  private tts: SherpaTts | undefined
  private started = false
  private epoch = 0
  private lastPartial = ''
  private hotwords: readonly AssistantVoiceHotword[] | undefined

  constructor(options: SherpaVoiceRuntimeOptions = {}) {
    this.env = options.env ?? process.env
    this.packageName = options.packageName ?? this.env.CODINGNS4DSH_VOICE_RUNTIME_PACKAGE ?? 'sherpa-onnx-node'
    this.sampleRate = options.sampleRate ?? readPositiveInteger(this.env.CODINGNS4DSH_VOICE_SAMPLE_RATE) ?? 16000
    this.hotwords = options.hotwords
  }

  /** 更新用户刚保存的模型配置；只能在没有活动租约时重载。 */
  configureEnvironment(env: Readonly<Record<string, string | undefined>>): void {
    if (this.started) throw new Error('Sherpa-ONNX 语音运行时正在运行，不能修改模型配置')
    this.env = env
    this.module = undefined
    this.recognizer = undefined
    this.stream = undefined
    this.vad = undefined
    this.tts = undefined
  }

  /** 词表以通话为快照，更新只在下一次通话加载，不能打断当前识别流。 */
  configureHotwords(words: readonly AssistantVoiceHotword[]): void {
    if (this.started) throw new Error('Sherpa-ONNX 语音运行时正在运行，不能修改识别热词')
    this.hotwords = words.map((word) => ({ ...word }))
    this.recognizer = undefined
  }

  get capabilities(): VoiceRuntimeCapabilities {
    const ready = this.recognizer !== undefined
    return {
      realtime: ready,
      wakeWord: false,
      streamingInput: ready,
      streamingOutput: false,
      bargeIn: ready && this.vad !== undefined,
      speechToText: ready,
      textToSpeech: this.tts !== undefined,
    }
  }

  get running(): boolean { return this.started }

  setEpoch(epoch: number): void { if (Number.isInteger(epoch) && epoch >= 0) this.epoch = epoch }

  subscribe(listener: VoiceRuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.emit({ type: 'state', state: 'loading', epoch: this.epoch })
    await this.load()
    if (this.recognizer === undefined) throw new Error('Sherpa-ONNX 流式 ASR 模型未配置')
    this.stream = this.recognizer.createStream()
    this.lastPartial = ''
    this.started = true
    this.emit({ type: 'state', state: 'listening', epoch: this.epoch })
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.finishStream()
    this.started = false
    this.stream = undefined
    this.lastPartial = ''
    this.emit({ type: 'state', state: 'disabled', epoch: this.epoch })
  }

  interrupt(): void {
    this.stream = this.recognizer?.createStream()
    this.vad?.reset()
    this.lastPartial = ''
    this.emit({ type: 'barge-in', epoch: this.epoch })
    if (this.started) this.emit({ type: 'state', state: 'listening', epoch: this.epoch })
  }

  sendPcm(frame: VoicePcmFrame, epoch: number): void {
    if (!this.started || this.stream === undefined || this.recognizer === undefined) throw new Error('Sherpa-ONNX 语音运行时尚未启动')
    if (epoch !== this.epoch) return
    const samples = pcm16ToFloat32(frame.bytes)
    this.vad?.acceptWaveform(samples)
    if (this.vad?.isDetected() === true) this.emit({ type: 'wake', epoch: this.epoch })
    this.stream.acceptWaveform({ samples, sampleRate: frame.sampleRate })
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream)
      const result = this.recognizer.getResult(this.stream)
      const text = typeof result.text === 'string' ? result.text.trim() : ''
      if (text !== '' && text !== this.lastPartial) {
        this.lastPartial = text
        this.emit({ type: 'partial', text, epoch: this.epoch })
      }
      if (this.recognizer.isEndpoint(this.stream) || result.is_final === true) {
        if (text !== '') this.emit({ type: 'final', text, epoch: this.epoch })
        this.lastPartial = ''
        this.recognizer.reset(this.stream)
      }
    }
  }

  speak(text: string, epoch: number): void {
    if (epoch !== this.epoch) return
    if (this.tts === undefined) throw new Error('Sherpa-ONNX TTS 模型未配置')
    const result = this.tts.generate({ text: text.trim(), sid: readNonNegativeInteger(this.env.CODINGNS4DSH_VOICE_TTS_SPEAKER) ?? 0, speed: 1 })
    if (!(result.samples instanceof Float32Array) || result.samples.length === 0) return
    this.emit({ type: 'audio', bytes: float32ToPcm16(result.samples), sampleRate: result.sampleRate ?? this.tts.sampleRate, channels: 1, epoch })
  }

  private async load(): Promise<void> {
    if (this.recognizer !== undefined) return
    const imported = await dynamicImport(this.packageName) as SherpaModule & { readonly default?: SherpaModule }
    this.module = imported.default ?? imported
    const OnlineRecognizer = this.module.OnlineRecognizer
    const asrEncoder = required(this.env.CODINGNS4DSH_VOICE_ASR_ENCODER, 'CODINGNS4DSH_VOICE_ASR_ENCODER')
    const asrDecoder = required(this.env.CODINGNS4DSH_VOICE_ASR_DECODER, 'CODINGNS4DSH_VOICE_ASR_DECODER')
    const asrJoiner = required(this.env.CODINGNS4DSH_VOICE_ASR_JOINER, 'CODINGNS4DSH_VOICE_ASR_JOINER')
    const asrTokens = required(this.env.CODINGNS4DSH_VOICE_ASR_TOKENS, 'CODINGNS4DSH_VOICE_ASR_TOKENS')
    if (OnlineRecognizer === undefined) throw new Error('Sherpa-ONNX Node 未导出 OnlineRecognizer')
    const hotwords = await prepareSherpaHotwords(asrTokens, this.hotwords)
    try {
      this.recognizer = new OnlineRecognizer(createSherpaRecognizerConfig(
        { asrEncoder, asrDecoder, asrJoiner, asrTokens }, this.sampleRate, readPositiveInteger(this.env.CODINGNS4DSH_VOICE_THREADS) ?? 2,
        undefined, hotwords,
      ))
    } finally {
      // 原生构造器已经把词表读入内存，立即清除含私有名称的临时文件。
      await hotwords?.dispose()
    }
    const vadModel = this.env.CODINGNS4DSH_VOICE_VAD_MODEL
    if (this.module.Vad !== undefined && vadModel !== undefined && vadModel.trim() !== '') {
      this.vad = new this.module.Vad({ sileroVad: { model: vadModel, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.1, windowSize: 512 }, sampleRate: this.sampleRate, numThreads: 1, provider: 'cpu' }, 30)
    }
    const ttsModel = this.env.CODINGNS4DSH_VOICE_TTS_MODEL
    if (this.module.OfflineTts !== undefined && ttsModel !== undefined && ttsModel.trim() !== '') {
      this.tts = new this.module.OfflineTts({ model: { vits: { model: ttsModel, tokens: this.env.CODINGNS4DSH_VOICE_TTS_TOKENS, lexicon: this.env.CODINGNS4DSH_VOICE_TTS_LEXICON } }, numThreads: 2, provider: 'cpu' })
    }
  }

  private finishStream(): void {
    if (this.stream === undefined || this.recognizer === undefined) return
    this.stream.inputFinished()
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream)
      const text = this.recognizer.getResult(this.stream).text?.trim() ?? ''
      if (text !== '' && text !== this.lastPartial) this.emit({ type: 'final', text, epoch: this.epoch })
      if (this.recognizer.isEndpoint(this.stream)) this.recognizer.reset(this.stream)
    }
  }

  private emit(event: VoiceRuntimeEvent): void { for (const listener of [...this.listeners]) { try { listener(event) } catch { /* 订阅者故障不能破坏 ASR */ } } }
}

/** 正式运行时和独立验证进程共用配置，避免“验证通过”与实际启动参数不一致。 */
export function createSherpaRecognizerConfig(paths: AssistantVoiceModelPaths, sampleRate = 16_000, numThreads = 2, endpointSilenceSeconds = 1.2, hotwords?: SherpaHotwordConfig): Record<string, unknown> {
  return {
    featConfig: { sampleRate, featureDim: 80 },
    modelConfig: { transducer: { encoder: paths.asrEncoder, decoder: paths.asrDecoder, joiner: paths.asrJoiner }, tokens: paths.asrTokens, numThreads, provider: 'cpu',
      ...(hotwords === undefined ? {} : { modelingUnit: hotwords.modelingUnit, ...(hotwords.bpeVocab === undefined ? {} : { bpeVocab: hotwords.bpeVocab }) }) },
    decodingMethod: 'modified_beam_search', maxActivePaths: 4, enableEndpoint: true,
    ...(hotwords === undefined ? {} : { hotwordsFile: hotwords.hotwordsFile, hotwordsScore: 0.6 }),
    rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: endpointSilenceSeconds, rule3MinUtteranceLength: 20,
  }
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 2))
  const output = new Float32Array(Math.floor(bytes.byteLength / 2))
  for (let index = 0; index < output.length; index += 1) output[index] = view.getInt16(index * 2, true) / 32768
  return output
}

export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const output = new Uint8Array(samples.length * 2)
  const view = new DataView(output.buffer)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(index * 2, value < 0 ? value * 32768 : value * 32767, true)
  }
  return output
}

async function dynamicImport(specifier: string): Promise<SherpaModule> {
  const importer = new Function('specifier', 'return import(specifier)') as (value: string) => Promise<SherpaModule>
  return importer(specifier)
}
function required(value: string | undefined, name: string): string { if (value === undefined || value.trim() === '') throw new Error(`缺少 Sherpa-ONNX 模型配置 ${name}`); return value.trim() }
function readPositiveInteger(value: string | undefined): number | undefined { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined }
function readNonNegativeInteger(value: string | undefined): number | undefined { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined }
