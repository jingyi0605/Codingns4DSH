import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { voiceProcessEnvironment } from './voice-process-environment.js'

const PYTHON_VERSION = '3.12.12'
const PYTHON_RELEASE = '20251014'
const VERSION_CHECK = 'import sys; sys.exit("MOSS requires Python 3.10 or newer") if sys.version_info < (3, 10) else None'
const ISOLATED_FLAGS = ['-I', '-X', 'utf8']
export type VoiceEnvironmentCommand = (command: string, args: readonly string[], signal: AbortSignal) => Promise<void>
export type VoiceEnvironmentProgress = (phase: string, bytes?: number, total?: number | null) => void
export interface VoicePythonArtifact { readonly target: string; readonly url: string; readonly sha256: string; readonly executable: string }

/** Windows 明确选择系统 bsdtar，避免 Git GNU tar 将盘符识别为远程主机。 */
export function voicePythonArchiveCommand(platform: string = process.platform, environment: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return 'tar'
  const value = (name: string): string | undefined => Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1]
  const root = value('SYSTEMROOT') || value('WINDIR')
  if (!root || !win32.isAbsolute(root)) throw new Error('无法定位 Windows 系统解压器，请检查 SystemRoot 环境变量')
  return win32.join(root, 'System32', 'tar.exe')
}

/** 下载源和摘要均固定；无需预装系统 Python，不执行远程安装脚本。 */
export function voicePythonArtifact(platform: string = process.platform, arch: string = process.arch): VoicePythonArtifact {
  const builds: Record<string, readonly [string, string]> = {
    'darwin-arm64': ['aarch64-apple-darwin', '84cb7acbf75264982c8bdd818bfa1ff0f1eb76007b48a5f3e01d28633b46afdf'],
    'darwin-x64': ['x86_64-apple-darwin', 'f76a921e71e9c8954cccd00f176b7083041527b3b4223670d05bbb2f51209d3f'],
    'linux-arm64': ['aarch64-unknown-linux-gnu', 'd2a6c0d4ceea088f635b309a59d5d700a256656423225f96ddfb71d532adb1aa'],
    'linux-x64': ['x86_64-unknown-linux-gnu', 'c74addcd1b033a6e4d60ead3ab47fcc995569027e01d3061c4a934f363c4a0cf'],
    'win32-x64': ['x86_64-pc-windows-msvc', '3c8b9b10a933909c98b9916297e2093b24a9c2abaa23df1c2622c2bfe052cb94'],
  }
  const build = builds[`${platform}-${arch}`]
  if (build === undefined) throw new Error(`暂不支持自动准备 ${platform}/${arch} 的语音环境，可使用浏览器声音`)
  const [target, sha256] = build
  const file = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${target}-install_only_stripped.tar.gz`
  return { target, sha256, url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encodeURIComponent(file)}`,
    executable: platform === 'win32' ? 'python/python.exe' : 'python/bin/python3' }
}

/** 已有专用虚拟环境继续复用；显式环境覆盖保留兼容，默认自动下载独立解释器。 */
export async function prepareVoicePython(directory: string, signal: AbortSignal, progress: VoiceEnvironmentProgress): Promise<string> {
  const python = join(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const existing = await nonEmpty(python)
  if (existing) {
    try { await runVoiceEnvironmentProcess(python, [...ISOLATED_FLAGS, '-c', VERSION_CHECK], signal); return python }
    catch { signal.throwIfAborted() }
  }
  progress('准备独立语音运行环境')
  const override = process.env.CODINGNS4DSH_TTS_PYTHON?.trim()
  const base = override || await installVoicePythonRuntime(join(directory, 'python-runtime'), voicePythonArtifact(), signal, progress)
  await runVoiceEnvironmentProcess(base, [...ISOLATED_FLAGS, '-c', VERSION_CHECK], signal)
  await runVoiceEnvironmentProcess(base, [...ISOLATED_FLAGS, '-m', 'venv', ...(existing ? ['--clear'] : []), join(directory, 'venv')], signal)
  return python
}

/** 在专属暂存目录验证，再原子提升；失败不留下伪就绪标记，重试能修复坏缓存。 */
export async function installVoicePythonRuntime(root: string, artifact: VoicePythonArtifact, signal: AbortSignal,
  progress: VoiceEnvironmentProgress, run: VoiceEnvironmentCommand = runVoiceEnvironmentProcess): Promise<string> {
  signal.throwIfAborted()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = join(root, `${PYTHON_VERSION}-${PYTHON_RELEASE}-${artifact.target}`)
  const python = join(directory, artifact.executable)
  try {
    const marker = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')) as { sha256?: string }
    if (marker.sha256 === artifact.sha256 && await nonEmpty(python)) {
      await run(python, [...ISOLATED_FLAGS, '-c', VERSION_CHECK], signal)
      return python
    }
  } catch { signal.throwIfAborted() }
  const staging = await mkdtemp(join(root, '.prepare-'))
  try {
    const archive = join(staging, 'python.tar.gz')
    await downloadPython(artifact, archive, signal, progress)
    progress('解压并验证语音运行环境')
    await run(voicePythonArchiveCommand(), ['-xzf', archive, '-C', staging], signal)
    await run(join(staging, artifact.executable), [...ISOLATED_FLAGS, '-c', VERSION_CHECK], signal)
    signal.throwIfAborted()
    await rm(archive)
    await writeFile(join(staging, 'ready.json'), JSON.stringify({ sha256: artifact.sha256 }), { mode: 0o600 })
    await promoteRuntime(staging, directory)
    return python
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** 在下载大型模型前真实导入推理库，提前发现缺失 DLL 或不兼容的二进制依赖。 */
export async function verifyVoicePythonDependencies(python: string, signal: AbortSignal,
  run: VoiceEnvironmentCommand = runVoiceEnvironmentProcess, platform: string = process.platform): Promise<void> {
  try {
    await run(python, [...ISOLATED_FLAGS, '-c', 'import numpy, onnxruntime, sentencepiece, soundfile; from scipy.signal import resample_poly'], signal)
  } catch (error) {
    signal.throwIfAborted()
    const hint = platform === 'win32' ? '请检查 Microsoft Visual C++ 2015–2022 x64 运行库及依赖 DLL，修复后重试。' : '请检查本机二进制依赖，修复后重试。'
    throw new Error('CPU 推理依赖无法加载。' + hint + '\n' + (error instanceof Error ? error.message : String(error)), { cause: error })
  }
}

async function downloadPython(artifact: VoicePythonArtifact, file: string, signal: AbortSignal, progress: VoiceEnvironmentProgress): Promise<void> {
  const response = await fetch(artifact.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]), redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`语音运行环境下载失败（${response.status}），请检查网络后重试`)
  const length = Number(response.headers.get('content-length'))
  const total = length > 0 && response.headers.get('content-encoding') === null ? length : null
  const reader = response.body.getReader()
  const handle = await open(file, 'wx', 0o600)
  const hash = createHash('sha256'); let bytes = 0
  try {
    while (true) {
      const next = await reader.read(); signal.throwIfAborted()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 64 * 1024 * 1024) throw new Error('语音运行环境超过下载大小限制')
      hash.update(next.value); await handle.writeFile(next.value)
      progress('下载独立语音运行环境', bytes, total)
    }
    if (bytes === 0 || total !== null && bytes !== total || hash.digest('hex') !== artifact.sha256) throw new Error('语音运行环境完整性校验失败，请重试')
    await handle.sync()
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await handle.close() }
}

async function promoteRuntime(staging: string, directory: string): Promise<void> {
  const previous = `${directory}.${randomUUID()}.previous`
  let moved = false
  try { await rename(directory, previous); moved = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try { await rename(staging, directory) }
  catch (error) { if (moved) await rename(previous, directory); throw error }
  if (moved) await rm(previous, { recursive: true, force: true })
}

/** 所有命令使用参数数组，退出或取消后才结算，防止重置与旧安装进程互相覆盖。 */
export async function runVoiceEnvironmentProcess(command: string, args: readonly string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: voiceProcessEnvironment() })
    let output = ''; let failure: Error | undefined
    // 流式解码保留跨数据块的多字节字符，错误信息不因中文截断而乱码。
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    const collect = (chunk: string): void => { output = (output + chunk).slice(-4000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const stop = (error: Error): void => { failure = error; child.kill('SIGKILL') }
    const cancel = (): void => stop(new Error('语音环境初始化已取消'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const timeout = setTimeout(() => stop(new Error('语音环境初始化超时')), 600_000)
    child.once('error', (error) => { failure = new Error(`无法运行语音环境命令 ${command}：${error.message}`) })
    child.once('close', (code) => {
      clearTimeout(timeout); signal.removeEventListener('abort', cancel)
      if (failure !== undefined || code !== 0) reject(failure ?? new Error(`语音环境准备失败（${code}）：${output}`))
      else resolve()
    })
  })
}
async function nonEmpty(file: string): Promise<boolean> { try { const info = await stat(file); return info.isFile() && info.size > 0 } catch { return false } }
