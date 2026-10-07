import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAssistantVoiceHotwords, MAX_ASSISTANT_VOICE_HOTWORDS, prepareSherpaHotwords, readAssistantVoiceHotwords } from '../src/host/features/assistant-voice-hotwords.js'
import { createSherpaRecognizerConfig, SherpaVoiceRuntime } from '../src/host/features/sherpa-voice-runtime.js'
import type { SessionIndexEntry } from '../src/shared/contracts/assistant.js'

const session = (patch: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({ sessionId: 's1', workspaceId: 'w1', workspaceName: 'CodingNS', hostId: 'local', title: '语音修复', running: false, completed: false, updatedAt: 1, waiting: null, ...patch })

test('名称元数据读取有超时边界，忽略取消的迟到结果不能替换本轮词表', async () => {
  let signal!: AbortSignal
  let finish!: (value: any) => void
  const pending = readAssistantVoiceHotwords((value) => { signal = value; return new Promise((resolve) => { finish = resolve }) }, 20)
  await assert.rejects(pending, /读取超时/u)
  assert.equal(signal.aborted, true)
  finish({ entries: [session()], scope: { managedWorkspaceIds: ['w1'] } })
  const current = await readAssistantVoiceHotwords(async () => ({ entries: [], scope: { managedWorkspaceIds: [] } }))
  assert.ok(!current.some((word) => word.phrase === 'CODINGNS'))
})

test('热词只取受管非归档元数据，去重后优先工作区和最近标题，限制数量及长度', () => {
  const entries = [session(), session({ sessionId: 'old', title: '旧标题', updatedAt: 0 }),
    session({ workspaceId: 'outside', title: '不应暴露' }), session({ archived: true, title: '归档标题' }),
    session({ title: '长'.repeat(41) }), ...Array.from({ length: 90 }, (_, index) => session({ sessionId: `recent-${index}`, title: `最近标题${index}`, updatedAt: 100 + index }))]
  const words = buildAssistantVoiceHotwords(entries, ['w1'], [{ workspaceId: 'w1', name: 'CodingNS' }, { workspaceId: 'outside', name: '范围外' }])
  assert.equal(words.length, MAX_ASSISTANT_VOICE_HOTWORDS)
  assert.equal(words.filter((word) => word.phrase === 'CODINGNS').length, 1)
  for (const excluded of ['不应暴露', '归档标题', '范围外', '旧标题', '长'.repeat(41)]) assert.ok(!words.some((word) => word.phrase === excluded), excluded)
  assert.ok(words.findIndex((word) => word.phrase === 'CODINGNS') < words.findIndex((word) => word.phrase === '最近标题89'))
  assert.ok(buildAssistantVoiceHotwords([], ['w1'], [{ workspaceId: 'w1', name: '空工作区' }]).some((word) => word.phrase === '空工作区'))
  assert.ok(buildAssistantVoiceHotwords(entries, []).every((word) => !['CODINGNS', '语音修复'].includes(word.phrase)))
})

test('原生热词先排除 OOV、非法权重和协议注入；临时文件权限及清理不依赖 Profile', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-hotword-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const tokens = join(directory, 'tokens.txt')
  await writeFile(tokens, '<blk> 0\n<unk> 1\n工 2\n作 3\n区 4\n会 5\n话 6\n')
  const config = await prepareSherpaHotwords(tokens, [
    { phrase: '工作区', score: 1 }, { phrase: '会话', score: 0.6 }, { phrase: 'CODINGNS', score: 0.8 },
    { phrase: '不存在', score: 0.8 }, { phrase: '会话 :99', score: 1 }, { phrase: '工作区', score: Infinity },
  ], directory)
  assert.ok(config)
  assert.equal(config.modelingUnit, 'cjkchar')
  assert.equal(config.count, 2)
  assert.equal(await readFile(config.hotwordsFile, 'utf8'), '工作区 :1\n会话 :0.6\n')
  if (process.platform !== 'win32') assert.equal((await stat(config.hotwordsFile)).mode & 0o777, 0o600)
  const paths = { asrEncoder: 'e', asrDecoder: 'd', asrJoiner: 'j', asrTokens: tokens }
  const native = createSherpaRecognizerConfig(paths, 16000, 2, 0.8, config)
  assert.equal(native.decodingMethod, 'modified_beam_search')
  assert.equal(native.maxActivePaths, 4)
  assert.equal(native.hotwordsFile, config.hotwordsFile)
  assert.equal((native.modelConfig as Record<string, unknown>).modelingUnit, 'cjkchar')
  await config.dispose()
  assert.deepEqual(await readdir(directory), ['tokens.txt'])
  assert.equal(await prepareSherpaHotwords(tokens, [{ phrase: '无效', score: 1 }], directory), undefined)
})

test('当前双语 BPE 词表完整匹配才能启用英文名称，缺词元时安全退回中文', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-bpe-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vocabulary = await readFile(new URL('../assets/voice/bilingual-zh-en-bpe.vocab', import.meta.url), 'utf8')
  const pieces = vocabulary.trim().split('\n').map((line) => line.split(/\s/u)[0]!)
  const tokens = join(directory, 'tokens.txt')
  // 实际双语模型没有单独的引号和连字符；不应因此禁用安全的字母名称。
  await writeFile(tokens, [...pieces.filter((piece) => !["'", '-'].includes(piece)), '工', '作', '区'].map((piece, index) => `${piece} ${index}`).join('\n'))
  const words = [{ phrase: 'CodingNS 工作区', score: 0.8 }, { phrase: '工作区', score: 1 }]
  const bilingual = await prepareSherpaHotwords(tokens, words, directory)
  assert.equal(bilingual?.modelingUnit, 'cjkchar+bpe')
  assert.equal(bilingual?.count, 2)
  assert.ok(bilingual?.bpeVocab)
  await bilingual?.dispose()
  await writeFile(tokens, '工 1\n作 2\n区 3\n')
  const chinese = await prepareSherpaHotwords(tokens, words, directory)
  assert.equal(chinese?.modelingUnit, 'cjkchar')
  assert.equal(chinese?.count, 1)
  await chinese?.dispose()
})

test('热词快照在原生构造后删除，通话期间拒绝修改，构造失败允许重试', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-hotword-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const tokens = join(directory, 'tokens.txt')
  await writeFile(tokens, '会 0\n话 1\n')
  const modulePath = join(directory, 'native.mjs')
  await writeFile(modulePath, `import { existsSync } from 'node:fs';
let attempts = 0;
export class OnlineRecognizer {
  constructor(config) { if (!existsSync(config.hotwordsFile)) throw new Error('热词提前清理'); this.file = config.hotwordsFile; if (++attempts === 1) throw new Error('一次性加载失败'); }
  createStream() { if (existsSync(this.file)) throw new Error('热词文件未清理'); return { inputFinished() {}, acceptWaveform() {} }; }
  isReady() { return false; }
}`)
  const runtime = new SherpaVoiceRuntime({ packageName: modulePath, env: { CODINGNS4DSH_VOICE_ASR_ENCODER: 'e', CODINGNS4DSH_VOICE_ASR_DECODER: 'd', CODINGNS4DSH_VOICE_ASR_JOINER: 'j', CODINGNS4DSH_VOICE_ASR_TOKENS: tokens } })
  t.after(() => runtime.stop())
  await assert.rejects(runtime.start(), /一次性加载失败/u)
  await runtime.start()
  assert.throws(() => runtime.configureHotwords([]), /正在运行/u)
  await runtime.stop()
  runtime.configureHotwords([{ phrase: '会话', score: 0.6 }])
  await runtime.start()
  await runtime.stop()
})
