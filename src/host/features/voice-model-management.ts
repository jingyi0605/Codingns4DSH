import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssistantVoiceSettings } from '../../shared/contracts/config.js'
import {
  ASSISTANT_VOICE_MODEL_CATALOG, findAssistantVoiceModel,
  type AssistantVoiceModel, type AssistantVoiceModelPaths, type AssistantVoiceModelProgress,
  type AssistantVoiceModelStatus, type AssistantVoiceModelsSnapshot,
} from '../../shared/voice-models.js'
import { installAssistantVoiceModel, voiceModelRoot, type InstalledAssistantVoiceModel } from './voice-model-setup.js'
import { probeAssistantVoiceModel } from './voice-model-probe.js'

export type AssistantVoiceModelProbe = (paths: AssistantVoiceModelPaths, signal: AbortSignal) => Promise<void>
type Validation = AssistantVoiceModelStatus['validation']
const unchecked: Validation = { state: 'unchecked', checkedAt: null, error: null }

/** 统一管理缓存事实与验证记录；查看状态不会触发下载或原生模型加载。 */
export class AssistantVoiceModelManager {
  constructor(private readonly probe: AssistantVoiceModelProbe = (paths, signal) => probeAssistantVoiceModel(paths, { signal })) {}

  async snapshot(settings: AssistantVoiceSettings, runtime: {
    readonly running: boolean
    readonly ready: boolean
    readonly operation: AssistantVoiceModelsSnapshot['operation']
  }): Promise<AssistantVoiceModelsSnapshot> {
    const currentModelId = settings.initialized && settings.provider === 'sherpa-onnx' ? settings.modelId?.trim() || null : null
    const models = await Promise.all(ASSISTANT_VOICE_MODEL_CATALOG.map(async (model) => {
      const current = currentModelId === model.id
      const paths = current ? configuredPaths(settings) ?? cachedPaths(model) : cachedPaths(model)
      const inspected = await inspectFiles(model, paths)
      const validation = inspected.state === 'downloaded' ? await readValidation(model.id, inspected.fingerprint) : unchecked
      return { modelId: model.id, current, ...inspected.status, validation }
    }))
    return { models, currentModelId, runtimeRunning: runtime.running, runtimeReady: runtime.ready, operation: runtime.operation }
  }

  async verify(modelId: string, settings: AssistantVoiceSettings, signal: AbortSignal): Promise<Validation> {
    const model = requireModel(modelId)
    const paths = currentPaths(model, settings) ?? cachedPaths(model)
    await this.validate(model, paths, signal)
    return { state: 'passed', checkedAt: Date.now(), error: null }
  }

  /** 先验证再交给调用方保存配置；修复在独立目录完成，失败时保留旧缓存。 */
  async prepare(modelId: string, settings: AssistantVoiceSettings, onProgress: (progress: AssistantVoiceModelProgress) => void, signal: AbortSignal, repair = false): Promise<InstalledAssistantVoiceModel> {
    const model = requireModel(modelId)
    const stage = (phase: AssistantVoiceModelProgress['phase']): void => onProgress({
      modelId, phase, fileName: null, fileIndex: model.files.length, fileCount: model.files.length, downloadedBytes: 0, totalBytes: null,
    })
    if (repair) return this.repair(model, onProgress, signal)
    const configured = currentPaths(model, settings)
    const reuse = configured !== undefined && (await inspectFiles(model, configured)).state === 'downloaded'
    const installed: InstalledAssistantVoiceModel = reuse
      ? { model, paths: configured!, downloaded: false }
      : await installAssistantVoiceModel(modelId, onProgress, { signal })
    stage('verifying')
    await this.validate(model, installed.paths, signal)
    stage('initializing')
    return installed
  }

  private async validate(model: AssistantVoiceModel, paths: AssistantVoiceModelPaths, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const before = await inspectFiles(model, paths)
    if (before.state !== 'downloaded') throw new Error('模型文件尚未下载完整，请先补全下载')
    try {
      await this.probe(paths, signal)
      signal.throwIfAborted()
      const after = await inspectFiles(model, paths)
      if (after.fingerprint !== before.fingerprint) throw new Error('验证期间模型文件发生变化，请重新验证')
      await writeValidation(model.id, before.fingerprint, { state: 'passed', checkedAt: Date.now(), error: null })
    } catch (error) {
      if (!signal.aborted) await writeValidation(model.id, before.fingerprint, {
        state: 'failed', checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
      throw error
    }
  }

  private async repair(model: AssistantVoiceModel, onProgress: (progress: AssistantVoiceModelProgress) => void, signal: AbortSignal): Promise<InstalledAssistantVoiceModel> {
    const staging = join(voiceModelRoot(), `.${model.id}-${randomUUID()}.download`)
    try {
      const installed = await installAssistantVoiceModel(model.id, onProgress, { directory: staging, signal })
      onProgress({ modelId: model.id, phase: 'verifying', fileName: null, fileIndex: model.files.length, fileCount: model.files.length, downloadedBytes: 0, totalBytes: null })
      await this.probe(installed.paths, signal)
      signal.throwIfAborted()
      await promoteDirectory(staging, join(voiceModelRoot(), model.id))
      const paths = cachedPaths(model)
      const inspected = await inspectFiles(model, paths)
      await writeValidation(model.id, inspected.fingerprint, { state: 'passed', checkedAt: Date.now(), error: null })
      onProgress({ modelId: model.id, phase: 'initializing', fileName: null, fileIndex: model.files.length, fileCount: model.files.length, downloadedBytes: 0, totalBytes: null })
      return { model, paths, downloaded: true }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}

function requireModel(modelId: string): AssistantVoiceModel {
  const model = findAssistantVoiceModel(modelId)
  if (model === undefined) throw new Error('不支持的实时语音模型')
  return model
}

function cachedPaths(model: AssistantVoiceModel): AssistantVoiceModelPaths {
  return Object.fromEntries(model.files.map((file) => [file.setting, join(voiceModelRoot(), model.id, file.name)])) as unknown as AssistantVoiceModelPaths
}

function configuredPaths(settings: AssistantVoiceSettings): AssistantVoiceModelPaths | undefined {
  const { asrEncoder, asrDecoder, asrJoiner, asrTokens } = settings
  return [asrEncoder, asrDecoder, asrJoiner, asrTokens].every((path) => path.trim() !== '')
    ? { asrEncoder, asrDecoder, asrJoiner, asrTokens } : undefined
}

function currentPaths(model: AssistantVoiceModel, settings: AssistantVoiceSettings): AssistantVoiceModelPaths | undefined {
  return settings.initialized && settings.provider === 'sherpa-onnx' && settings.modelId?.trim() === model.id ? configuredPaths(settings) : undefined
}

async function fileInfo(path: string): Promise<{ bytes: number; mtime: number; ctime: number }> {
  try {
    const info = await stat(path)
    return info.isFile() ? { bytes: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs } : { bytes: 0, mtime: 0, ctime: 0 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, mtime: 0, ctime: 0 }
    throw error
  }
}

async function inspectFiles(model: AssistantVoiceModel, paths: AssistantVoiceModelPaths) {
  const facts = await Promise.all(model.files.map(async (file) => {
    const path = paths[file.setting]
    const [info, partial] = await Promise.all([fileInfo(path), fileInfo(`${path}.part`)])
    return { name: file.name, path, ...info, partialBytes: partial.bytes, present: info.bytes > 0 }
  }))
  const count = facts.filter((file) => file.present).length
  const state: AssistantVoiceModelStatus['state'] = count === facts.length ? 'downloaded'
    : count > 0 || facts.some((file) => file.partialBytes > 0) ? 'partial' : 'missing'
  return {
    state,
    fingerprint: JSON.stringify(facts.map(({ path, bytes, mtime, ctime }) => [path, bytes, mtime, ctime])),
    status: { state, totalBytes: facts.reduce((sum, file) => sum + file.bytes, 0), files: facts.map(({ name, path, bytes, partialBytes, present }) => ({ name, path, bytes, partialBytes, present })) },
  }
}

async function readValidation(modelId: string, fingerprint: string): Promise<Validation> {
  try {
    const value = JSON.parse(await readFile(join(voiceModelRoot(), modelId, '.validation.json'), 'utf8'))
    if (value.fingerprint !== fingerprint || !['passed', 'failed'].includes(value.state) || typeof value.checkedAt !== 'number') return unchecked
    return { state: value.state, checkedAt: value.checkedAt, error: typeof value.error === 'string' ? value.error : null }
  } catch { return unchecked }
}

async function writeValidation(modelId: string, fingerprint: string, validation: Validation): Promise<void> {
  const directory = join(voiceModelRoot(), modelId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.validation-${randomUUID()}.part`)
  try {
    await writeFile(temporary, JSON.stringify({ fingerprint, ...validation }), { mode: 0o600 })
    await rename(temporary, join(directory, '.validation.json'))
  } finally { await rm(temporary, { force: true }) }
}

/** 只有整组文件验证通过才替换缓存目录，目录替换失败时恢复原目录。 */
async function promoteDirectory(staging: string, target: string): Promise<void> {
  const backup = `${target}.backup-${randomUUID()}`
  let backedUp = false
  try { await rename(target, backup); backedUp = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try { await rename(staging, target) }
  catch (error) { if (backedUp) await rename(backup, target); throw error }
  if (backedUp) await rm(backup, { recursive: true, force: true })
}
