import assert from 'node:assert/strict'
import test from 'node:test'
import { protectText, restoreText, stripPlaceholders } from '../src/host/features/session-translation-protection.js'
import { createSessionTranslationService } from '../src/host/features/session-translation-service.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS } from '../src/shared/contracts/session-translation.js'

const button = '<button type="button" class="_button_1rv3m_2 _ghost_1rv3m_45 _sm_1rv3m_28">跟随 DSH 默认模型</button>'
const marker = '@@CODINGNS_TRANSLATION_0@@'
type Request = Record<string, any>

function fixture(reply: (source: string, request: Request) => string) {
  const sources: string[] = []
  const service = createSessionTranslationService({
    llm: {
      listProviders: () => [{ id: 'test', name: 'Test' }],
      listModels: async () => [{ id: 'primary', name: 'Primary' }],
      stream(request: Request) {
        const source = request.messages[0].content[0].text.split('SOURCE TEXT BEGIN\n')[1].split('\nSOURCE TEXT END')[0]
        sources.push(source)
        return (async function* () {
          yield { type: 'text-delta', text: reply(source, request) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get: (name: string) => name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'test', model: 'primary' }) }
      : undefined,
  }, '0.2.1-alpha.2')!
  assert.ok(service)
  service.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service.activate()
  return { service, sources }
}

for (const adapter of ['codex', 'dsh']) {
  test(`${adapter} preserves the supplied button verbatim and translates both instructions`, async (t) => {
    const prose = '修改以上按钮为红色字体，并使用弹出模态框确认后再执行；\n避免用户误点击导致丢失模型列表设置'
    const english = 'Change the button text to red and confirm in a modal before proceeding;\nprevent accidental clicks from losing the model list settings.'
    const f = fixture((source) => source.replace(prose, english))
    t.after(() => f.service.dispose())
    const result = await f.service.translateInputDetailed!(adapter, `${button}\n${prose}`, undefined, true)
    assert.equal(result.translated, `${button}\n${english}`)
    assert.equal(result.failed, undefined)
    assert.equal(result.sourceLanguage, 'zh')
    assert.deepEqual(f.sources, [`${marker}\n${prose}`])
  })
}

const snippets = [
  button,
  '<div title="1 > 0"><div><button data-label=\'中文\'>默认模型</button></div><br><img alt="图片"></div>',
  '<配置 名称="模型">\n  <选项>中文</选项>\n</配置>',
  '<settings name="模型">\n  <option>中文</option>\n</settings>',
  '<my-button aria-label="确认" />',
  '<button>请检查 `原文` 按钮</button>',
  '<!-- <button>不要翻译</button> -->',
  '<![CDATA[<button>原文</button>]]>',
  '<script>const label = "中文"; if (a < b) console.log(label)</script>',
  '```html\n<button>中文</button>\n```',
  '~~~js\nconst label = "中文"\n~~~',
  '``const label = `中文` ``',
  '`const label = "中文"`',
  '{"label":"中文", "nested":[{"text":"右括号 } 和 \\\"引号\\\""}]}',
  '[{"label":"中文"}, {"label":"默认模型"}]',
  '{"label":"请检查 `原文` 按钮"}',
  'npm run test -- --label="中文"',
  'https://example.com/中文',
  '/tmp/中文.txt',
  'C:\\project\\中文.txt',
]

for (const snippet of snippets) {
  test(`protects a mixed-message literal: ${snippet.slice(0, 70)}`, () => {
    const source = `请检查以下内容：\n${snippet}\n然后修改按钮颜色。`
    const protectedText = protectText(source)
    assert.equal(protectedText.text, `请检查以下内容：\n${marker}\n然后修改按钮颜色。`)
    assert.deepEqual(protectedText.values, [snippet])
    assert.equal(restoreText(protectedText.text, protectedText.values), source)
  })
}

test('keeps surrounding same-line prose and multiple elements separate', () => {
  const second = '<span title="中文">说明</span>'
  const source = `将 ${button} 改为红色，并隐藏 ${second}，请确认。`
  const protectedText = protectText(source)
  assert.equal(protectedText.text, `将 ${marker} 改为红色，并隐藏 @@CODINGNS_TRANSLATION_1@@，请确认。`)
  assert.deepEqual(protectedText.values, [button, second])
  assert.equal(restoreText(protectedText.text, protectedText.values), source)
})

test('does not swallow prose after incomplete tags, comparisons, or ordinary braces', () => {
  const source = '如果 a < b 且 b > c，请检查 {这个条件} 和 [说明](document)。'
  assert.equal(protectText(source).text, source)
  assert.equal(protectText('<button title="中文">请修改按钮颜色。').text, `${marker}请修改按钮颜色。`)
})

test('protects an unfinished fenced block without translating its content', () => {
  const source = '请检查：\n```js\nconst label = "中文"'
  const protectedText = protectText(source)
  assert.equal(protectedText.text, `请检查：\n${marker}`)
  assert.equal(restoreText(protectedText.text, protectedText.values), source)
})

test('source marker literals cannot collide with generated placeholders', () => {
  const source = `请检查 ${marker} 和 ${button}`
  const protectedText = protectText(source)
  assert.deepEqual(protectedText.values, [marker, button])
  assert.equal(restoreText(protectedText.text, protectedText.values), source)
})

test('code-only input and output bypass translation', async (t) => {
  const f = fixture(() => { throw new Error('code must not reach the model') })
  t.after(() => f.service.dispose())
  for (const snippet of snippets) {
    assert.equal(await f.service.translateInput('codex', snippet, undefined, true), snippet)
    assert.equal(await f.service.translateOutput('dsh', 'assistant', snippet, undefined, true), null)
  }
  assert.equal(f.sources.length, 0)
})

test('language detection ignores code in a different language', async (t) => {
  const f = fixture(() => { throw new Error('already English') })
  t.after(() => f.service.dispose())
  const original = `${button}\nPlease change this button to red.`
  const result = await f.service.translateInputDetailed!('codex', original, undefined, true)
  assert.equal(result.translated, original)
  assert.equal(result.alreadyTargetLanguage, true)
  assert.equal(f.sources.length, 0)
})

for (const kind of ['assistant', 'reasoning'] as const) {
  test(`${kind} output preserves HTML and validates only translated prose`, async (t) => {
    const englishButton = `<button title="${'English source code '.repeat(30)}">Follow default model</button>`
    const f = fixture((source) => source.replace('Please review this button.', '请检查。'))
    t.after(() => f.service.dispose())
    const result = await f.service.translateOutput('dsh', kind, `${englishButton}\nPlease review this button.`, undefined, true)
    assert.equal(result?.translated, `${englishButton}\n请检查。`)
    assert.equal(result?.failed, undefined)
    assert.deepEqual(f.sources, [`${marker}\nPlease review this button.`])
  })
}

test('long Chinese code cannot invalidate a short English translation', async (t) => {
  const element = `<button>${'中文原文'.repeat(100)}</button>`
  const f = fixture(() => `${marker}\nFix it.`)
  t.after(() => f.service.dispose())
  const result = await f.service.translateInputDetailed!('codex', `${element}\n请修改。`, undefined, true)
  assert.equal(result.translated, `${element}\nFix it.`)
  assert.equal(result.failed, undefined)
})

test('missing, duplicated, unknown, altered, and untranslated responses preserve the original', async (t) => {
  const original = `${button}\n请修改按钮。`
  for (const response of [
    'Please fix the button.',
    `${marker} ${marker}\nFix the button.`,
    `${marker} @@CODINGNS_TRANSLATION_7@@\nFix the button.`,
    '@@CODINGNS_TRANSLATION_00@@\nFix the button.',
    '@@CODINGNS_TRANSLATION_ 0@@\nFix the button.',
    `${marker}\n请修改按钮。`,
    marker,
  ]) {
    const f = fixture(() => response)
    t.after(() => f.service.dispose())
    const result = await f.service.translateInputDetailed!('codex', original, undefined, true)
    assert.equal(result.translated, original, response)
    assert.equal(result.failed, true, response)
  }
})

test('a damaged placeholder preserves the original assistant and reasoning output', async (t) => {
  const f = fixture(() => '请修改按钮。')
  t.after(() => f.service.dispose())
  const original = `${button}\nPlease change this button.`
  for (const kind of ['assistant', 'reasoning'] as const) {
    const result = await f.service.translateOutput('dsh', kind, original, undefined, true)
    assert.equal(result?.translated, original)
    assert.equal(result?.failed, true)
  }
  assert.equal(f.sources.length, 2)
  assert.equal(stripPlaceholders(f.sources[0]!).trim(), 'Please change this button.')
})
