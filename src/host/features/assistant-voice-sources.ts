import { createHash } from 'node:crypto'
import type { AssistantTtsVoice } from '../../shared/assistant-tts.js'

export interface ResolvedVoiceSource {
  readonly id: string
  readonly path: string
  readonly repository: 'kyutai/tts-voices' | 'AISHELL/AISHELL-3'
  readonly url: string
  readonly license: string
  readonly language: string
}

/** 只解析已知开放录音库；文件链接和 ID 归一化后产生相同的缓存键。 */
export function resolveAssistantVoiceSource(input: string): ResolvedVoiceSource {
  const value = input.trim()
  if (value.length === 0 || value.length > 2048) throw new Error('请填写完整录音 ID 或音频文件网址')
  let repository: ResolvedVoiceSource['repository'] = 'kyutai/tts-voices'
  let path = value.replace(/^kyutai:/u, '')
  if (value.startsWith('aishell:') || /^SSB\d{8}(?:\.wav)?$/u.test(value)) {
    const id = value.replace(/^aishell:/u, '').replace(/\.wav$/u, '')
    if (!/^SSB\d{8}$/u.test(id)) throw new Error('AISHELL-3 需要完整录音 ID，例如 SSB00050001')
    repository = 'AISHELL/AISHELL-3'; path = `train/wav/${id.slice(0, 7)}/${id}.wav`
  } else if (value.startsWith('hf://')) {
    const prefix = 'hf://kyutai/tts-voices/'
    if (!value.startsWith(prefix)) throw new Error('不支持的 Hugging Face 录音仓库')
    path = value.slice(prefix.length)
  } else if (/^https?:/u.test(value)) {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.port || url.username || url.password) throw new Error('请使用受支持的 Hugging Face 音频文件网址')
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
    if (parts[0] === 'datasets') parts.shift()
    const name = parts.slice(0, 2).join('/')
    if (name !== 'kyutai/tts-voices' && name !== 'AISHELL/AISHELL-3') throw new Error('该网址不属于受支持的开放录音库')
    if (!['resolve', 'blob', 'raw'].includes(parts[2] ?? '') || parts[3] !== 'main') throw new Error('请填写 main 分支中单个音频文件的链接')
    repository = name; path = parts.slice(4).join('/')
  }
  if (!/^[A-Za-z0-9_./@-]+\.(?:wav|flac)$/u.test(path) || path.split('/').some((part) => part === '.' || part === '..' || part === '')) throw new Error('需要 WAV 或 FLAC 参考录音，不能使用网页或音色嵌入文件')
  let license: string
  let language = 'unknown'
  if (repository === 'AISHELL/AISHELL-3') {
    if (!/^(?:train|test)\/wav\/SSB\d{4}\/SSB\d{8}\.wav$/u.test(path) || path.split('/')[2] !== path.split('/')[3]?.slice(0, 7)) throw new Error('AISHELL-3 录音路径无效')
    license = 'Apache-2.0'; language = 'zh'
  } else {
    const directory = path.split('/')[0]
    if (directory === 'voice-donations' || directory === 'voice-zero') license = 'CC0-1.0'
    else if (directory === 'vctk' || directory === 'alba-mackenna' || path.startsWith('cml-tts/fr/')) license = 'CC-BY-4.0'
    else throw new Error('该目录许可不适合默认开放音色导入；请选择 voice-donations、voice-zero、vctk、alba-mackenna 或 cml-tts/fr')
    if (directory === 'vctk' || directory === 'voice-zero' || directory === 'alba-mackenna') language = 'en'
    if (path.startsWith('cml-tts/fr/')) language = 'fr'
  }
  const root = repository === 'AISHELL/AISHELL-3' ? 'datasets/' : ''
  const url = `https://huggingface.co/${root}${repository}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`
  return { id: `ref-${createHash('sha256').update(`${repository}/${path}`).digest('hex')}`, repository, path, url, license, language }
}

export function sourceVoice(source: ResolvedVoiceSource, fields: Record<string, unknown>): AssistantTtsVoice {
  const name = typeof fields.name === 'string' && fields.name.trim() !== '' ? fields.name.trim() : source.path.split('/').at(-1)!.replace(/\.(?:wav|flac)$/u, '')
  const language = typeof fields.language === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/u.test(fields.language) ? fields.language : source.language
  const gender = fields.gender === 'male' || fields.gender === 'female' ? fields.gender : 'unknown'
  if (name.length > 80) throw new Error('音色名称不能超过 80 个字符')
  return { id: source.id, name, language, gender, kind: 'reference', reference: source.id, source: source.url, license: source.license }
}
