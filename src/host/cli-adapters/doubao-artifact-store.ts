import { createHash } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { DoubaoArtifact } from './doubao-artifacts.js'
import type { DoubaoBridge } from './doubao-cdp.js'

export const DOUBAO_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024
export interface DoubaoSavedArtifact { readonly path: string; readonly size: number; readonly sha256: string }

/** 同时处理两种平台的分隔符、设备名和非法字符；只生成产物目录内的普通文件名。 */
export function doubaoArtifactName(value: string): string {
  let name = value.replaceAll('\\', '/').split('/').at(-1)!.normalize('NFC')
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '')
  if (!name) name = '豆包产物'
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(name)) name = `_${name}`
  const ext = path.extname(name).slice(0, 24)
  let stem = name.slice(0, name.length - path.extname(name).length)
  while (Buffer.byteLength(stem + ext) > 180) stem = [...stem].slice(0, -1).join('')
  return stem + ext
}

/** 权限来自当前 DSH 会话；仅在项目根目录下创建或复用真实的 Doubao 目录。 */
export async function doubaoArtifactDirectory(input: CodingNsCliTurnInput): Promise<string> {
  if (!['workspace-write', 'danger-full-access'].includes(input.permission?.sandboxMode ?? '')) {
    throw new Error('豆包云端已完成，但当前会话没有已确认的项目写入权限；文件尚未保存，请在豆包 App 下载')
  }
  if (!input.cwd || !path.isAbsolute(input.cwd)) throw new Error('豆包云端已完成，但未取得当前会话的绝对项目路径；文件尚未保存，请在豆包 App 下载')
  let root: string
  try {
    root = await realpath(input.cwd)
    if (!(await stat(root)).isDirectory()) throw new Error('not directory')
  } catch { throw new Error('豆包产物的项目目录不可访问；文件尚未保存，请在豆包 App 下载') }
  const directory = path.join(root, 'Doubao')
  try {
    try { await mkdir(directory) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    // 不跟随预先存在的符号链接，避免产物和临时下载文件被导向项目之外。
    if (!(await lstat(directory)).isDirectory()) throw new Error('not directory')
    const resolved = await realpath(directory)
    if (path.dirname(resolved) !== root) throw new Error('outside project')
    return resolved
  } catch { throw new Error('无法创建或使用项目内的 Doubao 目录，请检查写入权限及同名文件或符号链接；文件尚未保存') }
}

/** 临时文件完整下载后用硬链接发布：原子出现且绝不覆盖文件、目录或符号链接。 */
export async function saveDoubaoArtifact(
  bridge: DoubaoBridge, artifact: DoubaoArtifact, root: string, signal: AbortSignal,
): Promise<DoubaoSavedArtifact> {
  signal.throwIfAborted()
  if (artifact.size !== undefined && artifact.size > DOUBAO_ARTIFACT_MAX_BYTES) throw new Error('豆包单个产物超过 64 MiB，未保存，请在豆包 App 下载')
  if (await realpath(root) !== root) throw new Error('产物目录已发生变化，未开始下载')
  const temporary = await mkdtemp(path.join(root, '.codingns-doubao-'))
  try {
    const partial = path.join(temporary, 'download')
    const result = await download(bridge, artifact, partial, signal)
    signal.throwIfAborted()
    if (await realpath(root) !== root || path.dirname(await realpath(temporary)) !== root) throw new Error('项目目录在下载期间发生变化，未保存产物')
    const name = doubaoArtifactName(artifact.name)
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    for (let index = 0; index < 1000; index++) {
      signal.throwIfAborted()
      const target = path.join(root, index ? `${stem} (${index})${ext}` : name)
      try { await link(partial, target); return { path: target, ...result } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('无法在项目目录保存豆包产物；未覆盖已有文件') }
    }
    throw new Error('项目中同名产物过多，未覆盖已有文件')
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

async function download(bridge: DoubaoBridge, artifact: DoubaoArtifact, target: string, signal: AbortSignal): Promise<Omit<DoubaoSavedArtifact, 'path'>> {
  // 只重试下载一次，不重发生成任务；重试前截断自己创建的临时文件。
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const file = await open(target, 'w', 0o600)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await bridge.download(artifact.url, DOUBAO_ARTIFACT_MAX_BYTES)
      if (!response.ok || !response.body) throw new Error('豆包文件下载失败')
      reader = response.body.getReader()
      const hash = createHash('sha256')
      let size = 0
      for (;;) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > DOUBAO_ARTIFACT_MAX_BYTES) throw new Error('豆包产物超出下载大小限制')
        hash.update(chunk.value)
        // FileHandle.write 允许短写，必须显式写完本块。
        let offset = 0
        while (offset < chunk.value.length) {
          const written = await file.write(chunk.value, offset, chunk.value.length - offset)
          if (!written.bytesWritten) throw new Error('豆包产物写入不完整')
          offset += written.bytesWritten
        }
      }
      if (artifact.size !== undefined && artifact.size !== size) throw new Error('豆包文件大小与产物声明不符')
      await file.sync()
      return { size, sha256: hash.digest('hex') }
    } catch {
      signal.throwIfAborted()
      if (attempt >= 1) throw new Error('豆包产物下载或校验失败（已重试下载，未重发任务）；请在豆包 App 下载')
    } finally { try { await reader?.cancel() } catch { /* 读取器可能已经因网络错误关闭。 */ } await file.close() }
  }
}
