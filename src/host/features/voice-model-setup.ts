import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  findAssistantVoiceModel,
  type AssistantVoiceModel,
  type AssistantVoiceModelProgress,
} from '../../shared/voice-models.js'

export interface InstalledAssistantVoiceModel {
  readonly model: AssistantVoiceModel
  readonly paths: Readonly<{
    asrEncoder: string
    asrDecoder: string
    asrJoiner: string
    asrTokens: string
  }>
  readonly downloaded: boolean
}

/**
 * 下载并安装一个受白名单保护的流式模型。
 *
 * 所有路径由 Host 生成，客户端只能提交目录 ID，避免把任意 URL 或任意本地
 * 路径带入设置。临时文件下载完成后才改名，进程中断不会留下半个模型。
 */
export async function installAssistantVoiceModel(
  modelId: string,
  onProgress?: (progress: AssistantVoiceModelProgress) => void,
  options: { readonly directory?: string; readonly signal?: AbortSignal } = {},
): Promise<InstalledAssistantVoiceModel> {
  const model = findAssistantVoiceModel(modelId)
  if (model === undefined) throw new Error('不支持的实时语音模型')
  const progress: AssistantVoiceModelProgress = {
    modelId, phase: 'checking', fileName: null, fileIndex: 0, fileCount: model.files.length,
    downloadedBytes: 0, totalBytes: null,
  }
  onProgress?.(progress)
  options.signal?.throwIfAborted()
  const modelDirectory = options.directory ?? join(voiceModelRoot(), model.id)
  await mkdir(modelDirectory, { recursive: true, mode: 0o700 })
  let downloaded = false
  const paths: Partial<Record<'asrEncoder' | 'asrDecoder' | 'asrJoiner' | 'asrTokens', string>> = {}
  for (const [index, file] of model.files.entries()) {
    const fileProgress = { ...progress, fileName: file.name, fileIndex: index + 1 }
    onProgress?.(fileProgress)
    const target = join(modelDirectory, file.name)
    paths[file.setting] = target
    if (await isNonEmptyFile(target)) continue
    downloaded = true
    await downloadModelFile(model, file.name, target, (downloadedBytes, totalBytes) => {
      onProgress?.({ ...fileProgress, phase: 'downloading', downloadedBytes, totalBytes })
    }, options.signal)
  }
  if (paths.asrEncoder === undefined || paths.asrDecoder === undefined || paths.asrJoiner === undefined || paths.asrTokens === undefined) {
    throw new Error('实时语音模型目录不完整')
  }
  onProgress?.({ ...progress, phase: 'initializing', fileIndex: model.files.length })
  return {
    model,
    paths: {
      asrEncoder: paths.asrEncoder,
      asrDecoder: paths.asrDecoder,
      asrJoiner: paths.asrJoiner,
      asrTokens: paths.asrTokens,
    },
    downloaded,
  }
}

export function voiceModelRoot(): string {
  const dshHome = process.env.DSH_HOME?.trim()
  return join(dshHome === undefined || dshHome === '' ? join(homedir(), '.dsh') : dshHome, 'codingns4dsh', 'voice-models')
}

async function downloadModelFile(
  model: AssistantVoiceModel,
  name: string,
  target: string,
  onProgress: (downloadedBytes: number, totalBytes: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `https://huggingface.co/${model.repository}/resolve/main/${encodeURIComponent(name)}`
  const response = await fetch(url, { redirect: 'follow', ...(signal === undefined ? {} : { signal }) })
  if (!response.ok || response.body === null) {
    throw new Error(`实时语音模型下载失败（${response.status}）：${name}`)
  }
  // fetch 会自动解压响应；压缩正文的 Content-Length 不能用作模型文件大小。
  const contentLength = Number(response.headers.get('content-length'))
  const encoding = response.headers.get('content-encoding')
  const totalBytes = (encoding === null || encoding === 'identity') && Number.isSafeInteger(contentLength) && contentLength > 0
    ? contentLength : null
  let downloadedBytes = 0
  onProgress(0, totalBytes)
  const temporary = `${target}.part`
  await unlink(temporary).catch(() => undefined)
  const handle = await open(temporary, 'w', 0o600)
  let complete = false
  try {
    const reader = response.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        signal?.throwIfAborted()
        if (chunk.done) break
        if (chunk.value.byteLength === 0) continue
        // writeFile 保证整个分块写入，进度只统计已经落盘的字节。
        await handle.writeFile(chunk.value)
        downloadedBytes += chunk.value.byteLength
        onProgress(downloadedBytes, totalBytes)
      }
    } finally {
      reader.releaseLock()
    }
    if (downloadedBytes === 0 || (totalBytes !== null && downloadedBytes !== totalBytes)) {
      throw new Error(`实时语音模型文件下载不完整：${name}`)
    }
    await handle.sync()
    complete = true
  } finally {
    await handle.close()
    // Windows 不允许删除仍然打开的文件，因此关闭后再清理失败下载。
    if (!complete) await unlink(temporary).catch(() => undefined)
  }
  await rename(temporary, target)
  onProgress(downloadedBytes, downloadedBytes)
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}
