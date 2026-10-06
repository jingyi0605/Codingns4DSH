import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  findAssistantVoiceModel,
  type AssistantVoiceModel,
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
export async function installAssistantVoiceModel(modelId: string): Promise<InstalledAssistantVoiceModel> {
  const model = findAssistantVoiceModel(modelId)
  if (model === undefined) throw new Error('不支持的实时语音模型')
  const modelDirectory = join(voiceModelRoot(), model.id)
  await mkdir(modelDirectory, { recursive: true, mode: 0o700 })
  let downloaded = false
  const paths: Partial<Record<'asrEncoder' | 'asrDecoder' | 'asrJoiner' | 'asrTokens', string>> = {}
  for (const file of model.files) {
    const target = join(modelDirectory, file.name)
    paths[file.setting] = target
    if (await isNonEmptyFile(target)) continue
    downloaded = true
    await downloadModelFile(model, file.name, target)
  }
  if (paths.asrEncoder === undefined || paths.asrDecoder === undefined || paths.asrJoiner === undefined || paths.asrTokens === undefined) {
    throw new Error('实时语音模型目录不完整')
  }
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

async function downloadModelFile(model: AssistantVoiceModel, name: string, target: string): Promise<void> {
  const url = `https://huggingface.co/${model.repository}/resolve/main/${encodeURIComponent(name)}`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`实时语音模型下载失败（${response.status}）：${name}`)
  }
  const temporary = `${target}.part`
  await unlink(temporary).catch(() => undefined)
  const handle = await open(temporary, 'w', 0o600)
  try {
    const reader = response.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value.byteLength > 0) await handle.write(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    await handle.sync()
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  } finally {
    await handle.close()
  }
  await unlink(target).catch(() => undefined)
  await rename(temporary, target)
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}
