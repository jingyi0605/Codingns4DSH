import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ASSISTANT_AVATAR_ENGINE_ENTRY,
  ASSISTANT_AVATAR_ENGINE_MAX_ARCHIVE_BYTES,
  ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES,
  ASSISTANT_AVATAR_ENGINE_SHA512,
  ASSISTANT_AVATAR_ENGINE_TARBALL,
  ASSISTANT_AVATAR_ENGINE_VERSION,
} from '../../shared/assistant-avatar-engine.js'
import { systemTarCommand } from '../tar-archive.js'

export type AssistantAvatarEngineProgress =
  | { readonly phase: 'checking' }
  | { readonly phase: 'downloading'; readonly bytes: number; readonly total: number | null }
  | { readonly phase: 'extracting' }
  | { readonly phase: 'ready' }
export type AssistantAvatarEngineDownload = (url: string, file: string, signal: AbortSignal,
  progress: (bytes: number, total: number | null) => void) => Promise<void>
export type AssistantAvatarEngineCommand = (command: string, args: readonly string[], signal: AbortSignal) => Promise<void>
export interface AssistantAvatarEngineInstallOptions {
  readonly signal: AbortSignal
  readonly directory?: string
  readonly progress?: (progress: AssistantAvatarEngineProgress) => void
  readonly download?: AssistantAvatarEngineDownload
  readonly run?: AssistantAvatarEngineCommand
}

/**
 * CodingNS 自有引擎目录，不复用 DSH 插件目录、源码或 Desktop Profile。
 *
 * 显式目录用于离线预置与测试；默认与语音模型同根，随 DSH_HOME 隔离。
 */
export function assistantAvatarEngineDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.CODINGNS4DSH_AVATAR_ENGINE_DIR?.trim()
  if (configured !== undefined && configured !== '') return configured
  const dshHome = environment.DSH_HOME?.trim()
  return join(dshHome === undefined || dshHome === '' ? join(homedir(), '.dsh') : dshHome,
    'codingns4dsh', 'avatar-engine', `l2d-${ASSISTANT_AVATAR_ENGINE_VERSION}`)
}

/** 只读取已校验的完整安装；缺少标记、版本漂移或入口异常都视为未安装。 */
export async function readAssistantAvatarEngine(options: { readonly directory?: string } = {}): Promise<string | undefined> {
  const directory = options.directory ?? assistantAvatarEngineDirectory()
  try {
    const marker = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')) as { version?: unknown; sha512?: unknown }
    if (marker.version !== ASSISTANT_AVATAR_ENGINE_VERSION || marker.sha512 !== ASSISTANT_AVATAR_ENGINE_SHA512) return undefined
    const bytes = await readFile(join(directory, ASSISTANT_AVATAR_ENGINE_ENTRY))
    return bytes.byteLength < ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES ? undefined : bytes.toString('utf8')
  } catch { return undefined }
}

export async function assistantAvatarEngineInstalled(options: { readonly directory?: string } = {}): Promise<boolean> {
  return await readAssistantAvatarEngine(options) !== undefined
}

/**
 * 在专属暂存目录下载、校验并解压，最后原子提升；失败不留伪就绪标记。
 *
 * 同进程内串行化，重复点击不会产生两份并发下载；已就绪时直接返回。
 */
export function installAssistantAvatarEngine(options: AssistantAvatarEngineInstallOptions): Promise<void> {
  return serialize(() => installOnce(options))
}

async function installOnce(options: AssistantAvatarEngineInstallOptions): Promise<void> {
  const directory = options.directory ?? assistantAvatarEngineDirectory()
  options.signal.throwIfAborted()
  options.progress?.({ phase: 'checking' })
  if (await assistantAvatarEngineInstalled({ directory })) return
  const root = dirname(directory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(root, '.prepare-'))
  try {
    const archive = join(staging, 'engine.tgz')
    options.progress?.({ phase: 'downloading', bytes: 0, total: null })
    await (options.download ?? downloadEngineArchive)(ASSISTANT_AVATAR_ENGINE_TARBALL, archive, options.signal,
      (bytes, total) => options.progress?.({ phase: 'downloading', bytes, total }))
    options.signal.throwIfAborted()
    options.progress?.({ phase: 'extracting' })
    await (options.run ?? runEngineProcess)(systemTarCommand(), ['-xzf', archive, '-C', staging], options.signal)
    const info = await stat(join(staging, ASSISTANT_AVATAR_ENGINE_ENTRY)).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size < ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES) throw new Error('Live2D 引擎解压结果不完整，请重试')
    options.signal.throwIfAborted()
    await rm(archive, { force: true })
    await writeFile(join(staging, 'ready.json'), JSON.stringify({ version: ASSISTANT_AVATAR_ENGINE_VERSION, sha512: ASSISTANT_AVATAR_ENGINE_SHA512 }), { mode: 0o600 })
    await promoteEngine(staging, directory)
    options.progress?.({ phase: 'ready' })
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** 摘要与大小上限固定，不执行远程脚本；网络失败与内容变化都必须在写入前失败。 */
async function downloadEngineArchive(url: string, file: string, signal: AbortSignal,
  progress: (bytes: number, total: number | null) => void): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]), redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`Live2D 引擎下载失败（${response.status}），请检查网络后重试`)
  const length = Number(response.headers.get('content-length'))
  const total = length > 0 && response.headers.get('content-encoding') === null ? length : null
  const reader = response.body.getReader()
  const handle = await open(file, 'wx', 0o600)
  const hash = createHash('sha512')
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read(); signal.throwIfAborted()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > ASSISTANT_AVATAR_ENGINE_MAX_ARCHIVE_BYTES) throw new Error('Live2D 引擎超过下载大小限制')
      hash.update(next.value); await handle.writeFile(next.value)
      progress(bytes, total)
    }
    if (bytes === 0 || (total !== null && bytes !== total)) throw new Error('Live2D 引擎下载不完整，请重试')
    if (hash.digest('base64') !== ASSISTANT_AVATAR_ENGINE_SHA512) throw new Error('Live2D 引擎完整性校验失败，请重试')
    await handle.sync()
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await handle.close() }
}

/** 参数数组调用，取消与超时后才结算，避免旧安装进程覆盖新结果。 */
export async function runEngineProcess(command: string, args: readonly string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; let failure: Error | undefined
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    const collect = (chunk: string): void => { output = (output + chunk).slice(-2000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const stop = (error: Error): void => { failure = error; child.kill('SIGKILL') }
    const cancel = (): void => stop(new Error('Live2D 引擎安装已取消'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const timeout = setTimeout(() => stop(new Error('Live2D 引擎解压超时')), 180_000)
    child.once('error', (error) => { failure = new Error(`无法运行解压命令 ${command}：${error.message}`) })
    child.once('close', (code) => {
      clearTimeout(timeout); signal.removeEventListener('abort', cancel)
      if (failure !== undefined || code !== 0) reject(failure ?? new Error(`Live2D 引擎解压失败（${code}）：${output}`))
      else resolve()
    })
  })
}

async function promoteEngine(staging: string, directory: string): Promise<void> {
  const previous = `${directory}.${randomUUID()}.previous`
  let moved = false
  try { await rename(directory, previous); moved = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try { await rename(staging, directory) }
  catch (error) { if (moved) await rename(previous, directory); throw error }
  if (moved) await rm(previous, { recursive: true, force: true })
}

let engineInstallation: Promise<unknown> = Promise.resolve()
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const task = engineInstallation.then(action)
  engineInstallation = task.catch(() => undefined)
  return task
}
