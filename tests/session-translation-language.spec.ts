import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionTranslationService } from '../src/host/features/session-translation-service.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS } from '../src/shared/contracts/session-translation.js'

const screenshotText = [
  '已按功能分批提交，未提交无关文件：',
  '',
  '1. `9fd2d5d` 修复：会话翻译统一保留 AI 原文并使用英文续跑提示；',
  '2. `6b49d07` 测试：补齐会话翻译原文历史与英文续跑回归；',
  '3. `db74ff7` 优化：会话翻译客户端补齐等待状态与译文展示；',
  '4. `da52083` 测试：补齐会话翻译等待状态与模型开关回归；',
  '',
  '验证通过，工作区干净。未推送到远程。',
].join('\n')

function fixture(reply = '翻译后的内容。') {
  const sources: string[] = []
  const service = createSessionTranslationService({
    llm: {
      listProviders: () => [{ id: 'test', name: 'Test' }],
      listModels: async () => [{ id: 'translator', name: 'Translator' }],
      stream(request: Record<string, any>) {
        const source = request.messages[0].content[0].text.split('SOURCE TEXT BEGIN\n')[1].split('\nSOURCE TEXT END')[0]
        sources.push(source)
        return (async function* () {
          yield { type: 'text-delta', text: JSON.stringify({ translation: reply }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get: (name: string) => name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'test', model: 'translator' }) }
      : undefined,
  }, '0.2.1-alpha.2')
  assert.ok(service)
  service.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service.activate()
  return { service, sources }
}

const chineseProse = [
  screenshotText,
  'AI 已完成。',
  '已完成 DSH 配置更新，测试通过。',
  '已完成ＤＳＨ配置更新，测试通过。',
  '已完成 React 与 TypeScript 的配置检查，相关测试全部通过，工作区保持干净。',
  '已完成 Node.js 客户端兼容性检查，相关测试全部通过。',
  '已更新 sourceLanguage 字段，相关测试全部通过。',
  '已更新 source_language 字段，相关测试全部通过。',
  '已完成 API、CLI 和 UI 的兼容性检查，相关测试全部通过。',
  '已完成 API 检查。\n```ts\nconst english = "Please review this file before merging"\n```',
]

for (const adapter of ['codex', 'dsh']) {
  for (const kind of ['assistant', 'reasoning'] as const) {
    test(`${adapter} ${kind} skips Chinese prose with embedded technical terms`, async (t) => {
      const f = fixture()
      t.after(() => f.service.dispose())
      for (const original of chineseProse) {
        const record = await f.service.translateOutput(adapter, kind, original, undefined, true)
        assert.equal(f.sources.length, 0, original)
        assert.equal(record?.sourceLanguage, 'zh', original)
        assert.equal(record?.alreadyTargetLanguage, true, original)
        assert.equal(record?.original, original)
        assert.equal(record?.translated, original)
        assert.equal(record?.model, undefined)
        assert.equal(record?.failed, undefined)
      }
    })
  }
}

test('input uses the same Chinese detection without changing original text', async (t) => {
  const f = fixture()
  t.after(() => f.service.dispose())
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, inputLanguage: 'zh' })
  for (const original of chineseProse) {
    const result = await f.service.translateInputDetailed!('codex', original, undefined, true)
    assert.equal(f.sources.length, 0, original)
    assert.equal(result.sourceLanguage, 'zh', original)
    assert.equal(result.alreadyTargetLanguage, true, original)
    assert.equal(result.translated, original)
    assert.equal(result.model, undefined)
  }
})

test('Chinese prose with technical terms still translates to a different target language', async (t) => {
  const f = fixture('The DSH configuration update is complete.')
  t.after(() => f.service.dispose())
  const original = '已完成 DSH 配置更新，测试通过。'
  const input = await f.service.translateInputDetailed!('codex', original, undefined, true)
  assert.equal(input.sourceLanguage, 'zh')
  assert.equal(input.alreadyTargetLanguage, undefined)
  assert.equal(input.translated, 'The DSH configuration update is complete.')
  assert.equal(input.failed, undefined)
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, outputLanguage: 'en' })
  const output = await f.service.translateOutput('codex', 'assistant', original, undefined, true)
  assert.equal(output?.sourceLanguage, 'zh')
  assert.equal(output?.alreadyTargetLanguage, undefined)
  assert.equal(output?.translated, input.translated)
  assert.equal(output?.failed, undefined)
  assert.deepEqual(f.sources, [original, original])
})

test('Chinese context does not hide foreign prose or ambiguous mixed text', async (t) => {
  const f = fixture()
  t.after(() => f.service.dispose())
  const chinese = '已完成全部配置更新和兼容性检查，相关测试全部通过，工作区保持干净'
  const mixed = [
    `${chinese}，please review this file 后再提交。`,
    `${chinese}。\nPlease review this file.`,
    `${chinese}。Done.`,
    `${chinese}；Done`,
    `${chinese}\nDone`,
    `${chinese}，请确认 do not merge 的提示。`,
    `${chinese}，请确认 Please **review** 的提示。`,
    `${chinese}，请确认 veuillez vérifier le fichier 的提示。`,
    `${chinese}，请确认 bitte diese Datei prüfen 的提示。`,
    `${chinese}，AI 返回 Спасибо。`,
    `${chinese}，AI 返回 감사합니다。`,
    'Please review the implementation and run all tests. 谢谢。',
    'DSH 好',
  ]
  for (const original of mixed) {
    const before = f.sources.length
    const record = await f.service.translateOutput('codex', 'assistant', original, undefined, true)
    assert.equal(f.sources.length, before + 1, original)
    assert.equal(record?.alreadyTargetLanguage, undefined, original)
    assert.equal(record?.sourceLanguage, undefined, original)
    assert.equal(record?.translated, '翻译后的内容。')
    assert.equal(record?.failed, undefined)
  }
})

// 真实 Stage0 回归：Codex 只回复 STAGE0_INITIAL_OK 时，模型按保留规则原样返回，
// 中文目标的结果校验找不到汉字，回复被标记为“翻译失败”。
const identifierOnly = ['STAGE0_INITIAL_OK', 'STAGE0_INITIAL_OK\n1', '`STAGE0_INITIAL_OK`', 'sourceLanguage', 'Node.js', '9fd2d5d', '"OK_DONE".']

for (const kind of ['assistant', 'reasoning'] as const) {
  test(`纯标识符的 ${kind} 输出不调用翻译模型，也不记为失败`, async (t) => {
    const f = fixture()
    t.after(() => f.service.dispose())
    for (const original of identifierOnly) {
      assert.equal(await f.service.translateOutput('codex', kind, original, undefined, true), null, original)
    }
    assert.deepEqual(f.sources, [])
  })
}

test('纯标识符输入原样发送，插话等普通输入仍经模型翻译后发送', async (t) => {
  const f = fixture('Reply 1')
  t.after(() => f.service.dispose())
  for (const original of identifierOnly) {
    const result = await f.service.translateInputDetailed!('codex', original, undefined, true)
    assert.equal(result.translated, original, original)
    assert.equal(result.failed, undefined, original)
  }
  assert.deepEqual(f.sources, [])
  for (const original of ['回复1', '只回复 STAGE0_INITIAL_OK']) {
    const result = await f.service.translateInputDetailed!('codex', original, undefined, true)
    assert.equal(result.translated, 'Reply 1', original)
    assert.equal(result.failed, undefined, original)
  }
  assert.deepEqual(f.sources, ['回复1', '只回复 STAGE0_INITIAL_OK'])
})

test('普通英文单词不属于标识符，输出仍交给翻译模型', async (t) => {
  const f = fixture('好的。')
  t.after(() => f.service.dispose())
  for (const original of ['OK', 'Done', 'Run STAGE0_INITIAL_OK now']) {
    const record = await f.service.translateOutput('codex', 'assistant', original, undefined, true)
    assert.equal(record?.translated, '好的。', original)
    assert.equal(record?.failed, undefined, original)
  }
  assert.equal(f.sources.length, 3)
})

test('existing Japanese, English, French, and German detection remains intact', async (t) => {
  const f = fixture()
  t.after(() => f.service.dispose())
  for (const [language, original] of [
    ['ja', 'DSH の設定を更新しました。'],
    ['en', 'Please check this file.'],
    ['fr', 'Bonjour, merci.'],
    ['de', 'Hallo, danke.'],
  ] as const) {
    f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, outputLanguage: language })
    const record = await f.service.translateOutput('codex', 'assistant', original, undefined, true)
    assert.equal(record?.sourceLanguage, language)
    assert.equal(record?.alreadyTargetLanguage, true)
    assert.equal(record?.translated, original)
  }
  assert.equal(f.sources.length, 0)
  f.service.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  const japanese = await f.service.translateOutput('codex', 'assistant', 'DSH の設定を更新しました。', undefined, true)
  assert.equal(japanese?.sourceLanguage, 'ja')
  assert.equal(japanese?.alreadyTargetLanguage, undefined)
  assert.equal(f.sources.length, 1)
})
