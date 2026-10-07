import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { SessionIndexEntry } from '../../shared/contracts/assistant.js'

export interface AssistantVoiceHotword {
  readonly phrase: string
  readonly score: number
}

export interface SherpaHotwordConfig {
  readonly hotwordsFile: string
  readonly modelingUnit: 'cjkchar' | 'cjkchar+bpe'
  readonly bpeVocab?: string
  readonly count: number
}

export const MAX_ASSISTANT_VOICE_HOTWORDS = 64
const MAX_PHRASE_LENGTH = 40
// 单个同音术语的权重低于完整短语，避免闲聊中的“绘画”被强行推向“会话”。
const DOMAIN_HOTWORDS: readonly AssistantVoiceHotword[] = [
  { phrase: '工作区', score: 1.0 }, { phrase: '会话', score: 0.25 },
  { phrase: '绘画', score: 1.0 },
  { phrase: '会话列表', score: 1.2 }, { phrase: '当前会话', score: 1.2 },
  { phrase: '工作区会话', score: 1.2 }, { phrase: '会话标题', score: 1.2 },
  { phrase: '工作区的会话', score: 1.2 }, { phrase: '有哪些会话', score: 1.2 },
  { phrase: '这个会话', score: 1.2 }, { phrase: '会话现在', score: 1.2 },
  { phrase: '会话的运行状态', score: 1.2 },
  // 同时给真实绘画语境提供完整短语，防止仅有业务侧词表压过另一种合法含义。
  { phrase: '学绘画', score: 0.8 }, { phrase: '学习绘画', score: 0.8 },
  { phrase: '绘画的颜色', score: 0.8 }, { phrase: '绘画作品', score: 0.8 },
]

/** 只收集受管、未归档的元数据；工作区优先，剩余预算按最近活动选会话标题。 */
export function buildAssistantVoiceHotwords(entries: readonly SessionIndexEntry[], managedWorkspaceIds: readonly string[],
  workspaces: readonly { readonly workspaceId: string; readonly name: string }[] = []): readonly AssistantVoiceHotword[] {
  const managed = new Set(managedWorkspaceIds)
  const included = entries.filter((entry) => managed.has(entry.workspaceId) && entry.archived !== true)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.sessionId.localeCompare(right.sessionId))
  const candidates = [...DOMAIN_HOTWORDS,
    ...workspaces.filter((entry) => managed.has(entry.workspaceId)).map((entry) => ({ phrase: entry.name, score: 0.8 })),
    ...included.map((entry) => ({ phrase: entry.workspaceName, score: 0.8 })),
    ...included.map((entry) => ({ phrase: entry.title ?? '', score: 0.8 })),
  ]
  const selected = new Map<string, AssistantVoiceHotword>()
  for (const candidate of candidates) {
    const phrase = normalizeHotword(candidate.phrase)
    if (phrase === null || selected.has(phrase)) continue
    selected.set(phrase, { ...candidate, phrase })
    if (selected.size === MAX_ASSISTANT_VOICE_HOTWORDS) break
  }
  return [...selected.values()]
}

/** 远端列表没有及时返回时中止本次取词；不能让可选的名称热词拖住通话启动。 */
export async function readAssistantVoiceHotwords(read: (signal: AbortSignal) => Promise<{
  readonly entries: readonly SessionIndexEntry[]
  readonly scope: { readonly managedWorkspaceIds: readonly string[] }
  readonly workspaces?: readonly { readonly workspaceId: string; readonly name: string }[]
}>, timeoutMs = 1500): Promise<readonly AssistantVoiceHotword[]> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('语音热词元数据读取超时')) }, timeoutMs)
  })
  try {
    const source = await Promise.race([read(controller.signal), timeout])
    return buildAssistantVoiceHotwords(source.entries, source.scope.managedWorkspaceIds, source.workspaces)
  } finally { clearTimeout(timer); controller.abort() }
}

/** 去掉热词协议控制符；长标题整体跳过，不截断成可能指向其他会话的短词。 */
function normalizeHotword(value: string): string | null {
  const phrase = value.normalize('NFKC').replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ').trim().replace(/\s+/gu, ' ').toUpperCase()
  return phrase.length >= 2 && phrase.length <= MAX_PHRASE_LENGTH ? phrase : null
}

/** 找到源码或 npm 包的资源根；不依赖进程 cwd，也不读取用户 Profile。 */
function findBpeVocabulary(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 7; depth++) {
    const candidate = join(directory, 'assets', 'voice', 'bilingual-zh-en-bpe.vocab')
    if (existsSync(candidate)) return candidate
    directory = dirname(directory)
  }
  return undefined
}

/** 原生热词编码可能直接退出进程，先检查词元及 BPE 兼容性，未知字符整条跳过。 */
export async function prepareSherpaHotwords(tokensPath: string, words: readonly AssistantVoiceHotword[] = DOMAIN_HOTWORDS,
  temporaryRoot = tmpdir()): Promise<(SherpaHotwordConfig & { dispose(): Promise<void> }) | undefined> {
  const text = await readFile(tokensPath, 'utf8')
  const tokens = new Set(text.split(/\r?\n/u).flatMap((line) => {
    const match = /^(\S+)\s+\d+\s*$/u.exec(line)
    return match?.[1] === undefined ? [] : [match[1]]
  }))
  const vocabulary = findBpeVocabulary()
  const bpePieces = vocabulary === undefined ? [] : (await readFile(vocabulary, 'utf8')).split(/\r?\n/u)
    // 只校验归一化名称能生成的字母词元；原始词表中的引号／连字符不会进入热词。
    .map((line) => line.split(/\s/u)[0]!).filter((piece) => /^[▁A-Z]+$/u.test(piece))
  const bilingual = bpePieces.length > 0 && bpePieces.every((piece) => tokens.has(piece))
  const selected = new Map<string, number>()
  for (const word of words) {
    const phrase = normalizeHotword(word.phrase)
    if (phrase === null || !Number.isFinite(word.score) || word.score <= 0 || word.score > 2) continue
    if (/[A-Z]/u.test(phrase) && !bilingual) continue
    if ([...phrase].some((char) => char !== ' ' && !(/[A-Z]/u.test(char) && bilingual) && !tokens.has(char))) continue
    selected.set(phrase, word.score)
    if (selected.size === MAX_ASSISTANT_VOICE_HOTWORDS) break
  }
  if (selected.size === 0) return undefined
  const directory = await mkdtemp(join(temporaryRoot, 'codingns-voice-hotwords-'))
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    const hotwordsFile = join(directory, 'hotwords.txt')
    await writeFile(hotwordsFile, [...selected].map(([phrase, score]) => `${phrase} :${score}`).join('\n') + '\n', { mode: 0o600 })
    return { hotwordsFile, count: selected.size, modelingUnit: bilingual ? 'cjkchar+bpe' : 'cjkchar',
      ...(bilingual ? { bpeVocab: vocabulary! } : {}), dispose }
  } catch (error) { await dispose(); throw error }
}
