import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSISTANT_TTS_PATH, ASSISTANT_VOICE_SAMPLE_PATH, MOSS_BUILTIN_VOICES, MOSS_CODEC_REVISION, MOSS_TTS_REVISION, readAssistantTtsParameters, readAssistantTtsSettings, validateAssistantTtsParameters, type AssistantTtsSettings, type AssistantTtsSnapshot, type AssistantTtsStatus } from '../../shared/assistant-tts.js'
import type { CodingNsHostServices } from './types.js'
import { voiceModelRoot } from './voice-model-setup.js'
import { MossTtsWorker } from './moss-tts-worker.js'
import { resolveAssistantVoiceSource, sourceVoice } from './assistant-voice-sources.js'
import { prepareVoicePython, runVoiceEnvironmentProcess, verifyVoicePythonDependencies, type VoiceEnvironmentCommand } from './voice-python-runtime.js'

const TTS_FILES = ['browser_poc_manifest.json', 'tts_browser_onnx_meta.json', 'tokenizer.model', 'moss_tts_prefill.onnx', 'moss_tts_decode_step.onnx', 'moss_tts_local_fixed_sampled_frame.onnx', 'moss_tts_global_shared.data', 'moss_tts_local_shared.data']
const CODEC_FILES = ['codec_browser_onnx_meta.json', 'moss_audio_tokenizer_encode.onnx', 'moss_audio_tokenizer_encode.data', 'moss_audio_tokenizer_decode_step.onnx', 'moss_audio_tokenizer_decode_shared.data']
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024

/** 音色配置、下载与推理统一归 Host；浏览器只提交稳定 ID 和来源链接。 */
export class AssistantTtsService {
  private status: AssistantTtsStatus = { ready: false, busy: false, phase: '尚未初始化', downloadedBytes: 0, totalBytes: null, error: null }
  private abort = new AbortController()
  private pendingChange: Promise<void> | undefined
  private worker: MossTtsWorker | undefined
  private readonly samples = new Map<string, Promise<Uint8Array>>()
  private changing = false
  private repairModels = false
  private readonly directory: string
  private readonly isVoiceActive: () => boolean
  private readonly preparePython: typeof prepareVoicePython
  private readonly runEnvironmentProcess: VoiceEnvironmentCommand

  constructor(private readonly services: CodingNsHostServices, options: {
    directory?: string; isVoiceActive?: () => boolean
    preparePython?: typeof prepareVoicePython; runEnvironmentProcess?: VoiceEnvironmentCommand
  } = {}) {
    this.directory = options.directory ?? join(voiceModelRoot(), 'moss-tts')
    this.isVoiceActive = options.isVoiceActive ?? (() => false)
    this.preparePython = options.preparePython ?? prepareVoicePython
    this.runEnvironmentProcess = options.runEnvironmentProcess ?? runVoiceEnvironmentProcess
  }

  async snapshot(settings = this.settings()): Promise<AssistantTtsSnapshot> {
    const ready = await this.isInstalled()
    this.status = { ...this.status, ready }
    return { settings, voices: [...MOSS_BUILTIN_VOICES, ...settings.voices], status: this.status }
  }

  get outputReady(): boolean { return this.status.ready && !this.status.busy && this.settings().backend === 'moss-onnx' }

  async handle(action: string, payload: unknown): Promise<unknown> {
    if (action === 'tts/catalog') return this.snapshot()
    if (this.changing) throw new Error('音色配置正在更新，请等待完成')
    const value = record(payload)
    const signal = this.abort.signal
    let finish!: () => void
    this.pendingChange = new Promise<void>((resolve) => { finish = resolve })
    this.changing = true
    try {
      switch (action) {
        case 'tts/configure': {
          const settings = this.settings()
          const parameters = validateAssistantTtsParameters(value.parameters, settings.parameters)
          await this.save({ ...settings, parameters }, signal)
          return await this.snapshot()
        }
        case 'tts/setup':
          if (this.isVoiceActive()) throw new Error('请先停止实时语音，再初始化 MOSS')
          return await this.setup(signal, value.prepareOnly === true)
        case 'tts/select': {
          const settings = this.settings()
          const id = typeof value.id === 'string' ? value.id : settings.selectedId
          if (![...MOSS_BUILTIN_VOICES, ...settings.voices].some((voice) => voice.id === id)) throw new Error('音色不存在')
          const backend = value.backend === 'browser' ? 'browser' : 'moss-onnx'
          if (backend === 'moss-onnx' && !await this.isInstalled()) throw new Error('请先初始化 MOSS 本地语音')
          await this.save({ ...settings, backend, selectedId: id }, signal)
          return await this.snapshot()
        }
        case 'tts/import': return await this.importVoice(value, signal)
        case 'tts/remove': {
          const settings = this.settings()
          if (!settings.voices.some((voice) => voice.id === value.id)) throw new Error('只能删除已导入的音色')
          const voices = settings.voices.filter((voice) => voice.id !== value.id)
          // 先修改权威设置；缓存保留，不删除可能仍被本轮推理读取的文件。
          await this.save({ ...settings, voices, selectedId: settings.selectedId === value.id ? 'moss:Junhao' : settings.selectedId }, signal)
          return await this.snapshot()
        }
        default: throw new Error(`未知音色操作：${action}`)
      }
    } finally { this.changing = false; this.pendingChange = undefined; finish() }
  }

  async http(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === ASSISTANT_VOICE_SAMPLE_PATH && request.method === 'GET') {
        const bytes = await this.sample(url.searchParams.get('id') ?? '')
        const flac = Buffer.from(bytes).subarray(0, 4).toString() === 'fLaC'
        return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': flac ? 'audio/flac' : 'audio/wav', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } })
      }
      if (url.pathname !== ASSISTANT_TTS_PATH || request.method !== 'POST') return new Response(null, { status: 405 })
      const value = record(JSON.parse(new TextDecoder().decode(await readBounded(request.body, 12_000))))
      if (typeof value.text !== 'string' || value.text.trim() === '' || value.text.length > 2000) throw new Error('播报文本需要 1～2000 个字符')
      if (this.status.busy || !await this.isInstalled()) throw new Error('MOSS 尚未就绪，请先初始化')
      const settings = this.settings()
      const parameters = value.parameters === undefined ? readAssistantTtsParameters(settings.parameters) : validateAssistantTtsParameters(value.parameters, settings.parameters)
      const voice = [...MOSS_BUILTIN_VOICES, ...settings.voices].find((voice) => voice.id === (value.voiceId ?? settings.selectedId))
      if (voice === undefined) throw new Error('音色不存在')
      const worker = await this.getWorker()
      const encoder = new TextEncoder()
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      request.signal.addEventListener('abort', abort, { once: true })
      const serviceAbort = (): void => controller.abort()
      const serviceSignal = this.abort.signal
      serviceSignal.addEventListener('abort', serviceAbort, { once: true })
      if (request.signal.aborted || serviceSignal.aborted) controller.abort()
      const finish = (): void => { request.signal.removeEventListener('abort', abort); serviceSignal.removeEventListener('abort', serviceAbort) }
      const thisDirectory = this.directory
      const stream = new ReadableStream<Uint8Array>({
        start(output) {
          const send = (value: unknown): void => output.enqueue(encoder.encode(JSON.stringify(value) + '\n'))
          void worker.request('synthesize', { text: value.text, parameters: { chunkTokens: parameters.chunkTokens, segmentPauseMs: parameters.segmentPauseMs, seed: parameters.seed }, ...(voice.kind === 'builtin' ? { voice: voice.reference } : { codesPath: join(thisDirectory, `${voice.reference}.json`) }) },
            (chunk) => send({ type: 'audio', data: Buffer.from(chunk.bytes).toString('base64'), sampleRate: chunk.sampleRate }), controller.signal)
            .then(() => { if (!controller.signal.aborted) send({ type: 'done' }) })
            .catch((error: unknown) => { if (!controller.signal.aborted) send({ type: 'error', message: errorMessage(error) }) })
            .finally(() => { finish(); try { output.close() } catch { /* 浏览器已经取消读取 */ } })
        },
        cancel() { controller.abort(); finish() },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' } })
    } catch (error) { return Response.json({ error: errorMessage(error) }, { status: 400, headers: { 'cache-control': 'no-store' } }) }
  }

  async dispose(): Promise<void> {
    this.abort.abort()
    const closing = this.worker?.dispose()
    this.worker = undefined; this.samples.clear()
    await closing
    await this.pendingChange
  }

  /** 完整重置等待旧写入结算，再重新开放服务；下载素材保留复用。 */
  async cancelPending(): Promise<void> {
    this.abort.abort(new Error('助理已重置'))
    const closing = this.worker?.dispose()
    this.worker = undefined; this.samples.clear()
    await closing
    await this.pendingChange
    this.abort = new AbortController()
    this.status = { ...this.status, busy: false, error: null }
  }

  private settings(): AssistantTtsSettings {
    const settings = readAssistantTtsSettings(this.services.settings?.get().assistant.tts)
    const voices = settings.voices.filter((voice) => {
      try { return resolveAssistantVoiceSource(voice.source).id === voice.id } catch { return false }
    })
    return readAssistantTtsSettings({ ...settings, voices })
  }
  private async save(tts: AssistantTtsSettings, signal = this.abort.signal): Promise<void> {
    signal.throwIfAborted()
    const settings = this.services.settings
    if (settings === undefined) throw new Error('当前 Host 不支持保存音色设置')
    await settings.update({ assistant: { ...settings.get().assistant, tts } })
  }

  private async isInstalled(): Promise<boolean> {
    try {
      const marker = JSON.parse(await readFile(join(this.directory, 'ready.json'), 'utf8')) as Record<string, unknown>
      if (marker.tts !== MOSS_TTS_REVISION || marker.codec !== MOSS_CODEC_REVISION) return false
      for (const file of [this.python(), ...TTS_FILES.map((file) => join(this.directory, 'MOSS-TTS-Nano-100M-ONNX', file)), ...CODEC_FILES.map((file) => join(this.directory, 'MOSS-Audio-Tokenizer-Nano-ONNX', file))]) {
        if (!await nonEmptyFile(file)) return false
      }
      return true
    } catch { return false }
  }

  private python(): string { return join(this.directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') }
  private async getWorker(signal = this.abort.signal): Promise<MossTtsWorker> {
    signal.throwIfAborted()
    if (this.worker === undefined) {
      const script = await workerPath()
      signal.throwIfAborted()
      this.worker = new MossTtsWorker({ python: this.python(), script, modelDirectory: join(this.directory, 'MOSS-TTS-Nano-100M-ONNX') })
    }
    return this.worker
  }

  private async setup(signal: AbortSignal, prepareOnly = false): Promise<AssistantTtsSnapshot> {
    if (this.services.settings === undefined) throw new Error('当前 Host 不支持保存语音设置')
    this.status = { ready: false, busy: true, phase: '准备 Python 3.10+ 环境', downloadedBytes: 0, totalBytes: null, error: null }
    try {
      const closing = this.worker?.dispose()
      this.worker = undefined
      await closing
      signal.throwIfAborted()
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      // 重新验证期间不复用旧就绪标记，避免失败后面板仍显示可以生成。
      await unlink(join(this.directory, 'ready.json')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      await this.preparePython(this.directory, signal, (phase, downloadedBytes = 0, totalBytes = null) => {
        this.status = { ...this.status, phase, downloadedBytes, totalBytes }
      })
      this.status = { ...this.status, phase: '安装 CPU 推理依赖' }
      await this.runEnvironmentProcess(this.python(), ['-I', '-X', 'utf8', '-m', 'ensurepip', '--upgrade'], signal)
      await this.runEnvironmentProcess(this.python(), ['-I', '-X', 'utf8', '-m', 'pip', 'install', '--disable-pip-version-check', '--cache-dir', join(this.directory, 'pip-cache'), '--only-binary=:all:', 'numpy==2.2.6', 'onnxruntime==1.22.1', 'sentencepiece==0.2.1', 'soundfile==0.13.1', 'scipy==1.15.3'], signal)
      this.status = { ...this.status, phase: '检查 CPU 推理依赖' }
      await verifyVoicePythonDependencies(this.python(), signal, this.runEnvironmentProcess)
      const resources = [
        ...TTS_FILES.map((file) => ({ file, repository: 'OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX', revision: MOSS_TTS_REVISION, directory: 'MOSS-TTS-Nano-100M-ONNX' })),
        ...CODEC_FILES.map((file) => ({ file, repository: 'OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX', revision: MOSS_CODEC_REVISION, directory: 'MOSS-Audio-Tokenizer-Nano-ONNX' })),
      ]
      for (const [index, resource] of resources.entries()) {
        const target = join(this.directory, resource.directory, resource.file)
        this.status = { ...this.status, phase: `下载 ${index + 1}/${resources.length}：${resource.file}`, downloadedBytes: 0, totalBytes: null }
        if (!this.repairModels && await nonEmptyFile(target)) continue
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await download(`https://huggingface.co/${resource.repository}/resolve/${resource.revision}/${resource.file}`, target, 1024 * 1024 * 1024, signal,
          (downloadedBytes, totalBytes) => { this.status = { ...this.status, downloadedBytes, totalBytes } })
      }
      this.status = { ...this.status, phase: '验证 ONNX 图与 CPU 推理环境' }
      try { await (await this.getWorker(signal)).request('probe', {}, undefined, signal); this.repairModels = false }
      catch (error) { if (!signal.aborted) this.repairModels = true; throw error }
      signal.throwIfAborted()
      await writeFile(join(this.directory, 'ready.json'), JSON.stringify({ tts: MOSS_TTS_REVISION, codec: MOSS_CODEC_REVISION }), { mode: 0o600 })
      if (!prepareOnly) await this.save({ ...this.settings(), backend: 'moss-onnx' }, signal)
      this.status = { ...this.status, ready: true, phase: 'MOSS 已就绪' }
    } catch (error) {
      this.status = { ...this.status, ready: false, phase: '初始化失败', error: errorMessage(error) }
      throw error
    } finally { this.status = { ...this.status, busy: false } }
    return this.snapshot()
  }

  private async importVoice(value: Record<string, unknown>, signal: AbortSignal): Promise<AssistantTtsSnapshot> {
    if (!await this.isInstalled()) throw new Error('请先初始化 MOSS，再导入音色')
    if (typeof value.source !== 'string') throw new Error('请填写录音 ID 或网址')
    const source = resolveAssistantVoiceSource(value.source)
    const voice = sourceVoice(source, value)
    const settings = this.settings()
    if (settings.voices.length >= 50 && !settings.voices.some((item) => item.id === voice.id)) throw new Error('最多保存 50 个自定义音色')
    const staging = join(this.directory, `${source.id}.${randomUUID()}`)
    try {
      await download(source.url, `${staging}.audio`, MAX_REFERENCE_BYTES, signal, undefined, true)
      await (await this.getWorker(signal)).request('encode', { audioPath: `${staging}.audio`, codesPath: `${staging}.json` }, undefined, signal)
      signal.throwIfAborted()
      // 验证成功才替换缓存，错误录音不会破坏已有可用音色。
      await rename(`${staging}.audio`, join(this.directory, `${source.id}.audio`))
      await rename(`${staging}.json`, join(this.directory, `${source.id}.json`))
    } finally {
      await unlink(`${staging}.audio`).catch(() => undefined)
      await unlink(`${staging}.json`).catch(() => undefined)
    }
    // 从最新配置合并，避免异步导入覆盖其他面板刚保存的选择。
    const current = this.settings()
    const next = { ...current, voices: [...current.voices.filter((item) => item.id !== voice.id), voice], selectedId: voice.id, backend: 'moss-onnx' as const }
    if (value.prepareOnly !== true) await this.save(next, signal)
    return this.snapshot(next)
  }

  private async sample(id: string): Promise<Uint8Array> {
    const previous = this.samples.get(id)
    if (previous !== undefined) return previous
    const task = (async () => {
      const voice = [...MOSS_BUILTIN_VOICES, ...this.settings().voices].find((voice) => voice.id === id)
      if (voice === undefined) throw new Error('音色不存在')
      const path = join(this.directory, voice.kind === 'builtin' ? `builtin-${voice.reference}.audio` : `${voice.reference}.audio`)
      if (!await nonEmptyFile(path)) {
        if (voice.kind !== 'builtin') throw new Error('参考录音缓存缺失，请重新导入')
        if (!await this.isInstalled()) throw new Error('请先初始化 MOSS，再试听官方预设')
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.part`
        try {
          await (await this.getWorker()).request('reference', { voice: voice.reference, audioPath: temporary }, undefined, this.abort.signal)
          await rename(temporary, path)
        } finally { await unlink(temporary).catch(() => undefined) }
      }
      const info = await stat(path)
      if (info.size > MAX_REFERENCE_BYTES) throw new Error('参考录音超过大小限制')
      return readFile(path)
    })()
    this.samples.set(id, task)
    try { return await task } finally { this.samples.delete(id) }
  }
}

async function workerPath(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 7; depth++) {
    const candidate = join(directory, 'assets', 'moss', 'worker.py')
    try { await access(candidate); return candidate } catch { directory = dirname(directory) }
  }
  throw new Error('安装包缺少 MOSS 工作进程资源')
}

async function download(url: string, target: string, maxBytes: number, signal: AbortSignal, progress?: (bytes: number, total: number | null) => void, audio = false): Promise<void> {
  signal.throwIfAborted()
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]), redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`资源下载失败（${response.status}），请检查录音 ID 或网络`)
  const declared = Number(response.headers.get('content-length'))
  const total = declared > 0 && response.headers.get('content-encoding') === null ? declared : null
  if (total !== null && total > maxBytes) { await response.body.cancel(); throw new Error('资源超过下载大小限制') }
  const temporary = `${target}.${randomUUID()}.part`
  const handle = await open(temporary, 'wx+', 0o600)
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read(); signal.throwIfAborted()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new Error('资源超过下载大小限制')
      await handle.writeFile(next.value); progress?.(bytes, total)
    }
    if (bytes === 0 || total !== null && bytes !== total) throw new Error('资源下载不完整')
    if (audio) {
      const header = Buffer.alloc(12)
      await handle.read(header, 0, 12, 0)
      if (header.subarray(0, 4).toString() !== 'fLaC' && !(header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WAVE')) throw new Error('网址没有返回 WAV 或 FLAC 音频，不能导入网页')
    }
    await handle.sync(); await handle.close(); await rename(temporary, target)
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined) }
}

async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (body === null) throw new Error('请求缺少正文')
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) throw new Error('请求正文过大'); chunks.push(next.value) }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  return Buffer.concat(chunks, size)
}

async function nonEmptyFile(path: string): Promise<boolean> { try { const value = await stat(path); return value.isFile() && value.size > 0 } catch { return false } }
function record(value: unknown): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数必须为对象'); return value as Record<string, unknown> }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
