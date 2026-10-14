import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerSessionTranslationChatUi } from '../src/client/session-translation-chat.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import type { SessionTranslationRecord } from '../src/shared/contracts/session-translation.js'

const translationT = resolveCodingNsTranslator()
const chatT = (key: string, params?: Record<string, unknown>): string => {
  if (key === 'message.referenceSummary') return `引用会话 · ${String(params?.labels ?? '')}`
  if (key === 'message.referenceSeparator') return '、'
  if (key === 'copy') return '复制'
  if (key === 'copied') return '已复制'
  if (key === 'message.extraBlock') return '附加内容'
  if (key === 'message.unknownBlock') return '未知内容'
  if (key === 'message.stopped') return '已停止'
  if (key === 'message.think') return '思考'
  if (key === 'codeBlock.title') return '代码'
  if (key === 'codeBlock.wrap') return '换行'
  if (key === 'codeBlock.unwrap') return '不换行'
  if (key === 'markdown.footnotes') return '脚注'
  if (key === 'json.truncated') return `已截断 ${String(params?.total ?? '')}`
  return key
}

/** 只记录注册结果的槽位替身：捕获 CodingNS 用哪个 key、哪个优先级遮蔽了原生渲染器。 */
function createSlotsProbe(): {
  readonly slots: CodingNsClientServices['slots']
  readonly registered: Map<string, { component: ComponentType<any>; priority: number }>
} {
  const registered = new Map<string, { component: ComponentType<any>; priority: number }>()
  const slots = {
    inject(_key: string, callback: () => () => void) { return callback() },
    register(options: Record<string, unknown>, component: ComponentType<any>) {
      registered.set(String(options.key), { component, priority: Number(options.priority ?? 0) })
      return () => registered.delete(String(options.key))
    },
  } as unknown as CodingNsClientServices['slots']
  return { slots, registered }
}

function createServices(slots: CodingNsClientServices['slots']): CodingNsClientServices {
  return {
    dshVersion: '0.2.1-alpha.2',
    settings: {} as CodingNsClientServices['settings'],
    rpc: {} as CodingNsClientServices['rpc'],
    peerHost: {} as CodingNsClientServices['peerHost'],
    hostRouter: {} as CodingNsClientServices['hostRouter'],
    peerHostSession: {} as CodingNsClientServices['peerHostSession'],
    locale: { bind: () => translationT } as unknown as CodingNsClientServices['locale'],
    slots,
  }
}

function captureRenderers(): Map<string, { component: ComponentType<any>; priority: number }> {
  const probe = createSlotsProbe()
  registerSessionTranslationChatUi(createServices(probe.slots))
  return probe.registered
}

function render(component: ComponentType<any>, props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(component, { t: chatT, translationT, services: {}, ...props }))
}

const inputRecord = {
  original: '对话测试',
  translated: 'Conversation test',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  model: { provider: 'deepseek', model: 'chat' },
}

const outputRecord: SessionTranslationRecord = {
  original: 'Ready to help.',
  translated: '随时可以开始。',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  outputKind: 'assistant',
  bilingual: false,
  model: { provider: 'deepseek', model: 'chat' },
}

test('会话翻译渲染器在无翻译记录时仍渲染用户消息与 AI 正文，不再返回 null', () => {
  const renderers = captureRenderers()
  const userView = renderers.get('user')!.component
  const assistantView = renderers.get('assistant-step')!.component

  // 关键回归：两个渲染器都以 priority -100 遮蔽 DSH 原生渲染器（原生为默认 0），
  // 遮蔽后没有回退路径，返回 null 就等于把消息从对话里删掉。
  assert.equal(renderers.get('user')!.priority, -100)
  assert.equal(renderers.get('assistant-step')!.priority, -100)

  // 附件会话的真实形状：用户消息只有 source.kind='user'，没有任何翻译元数据。
  const userHtml = render(userView, {
    node: { id: 'user-1', data: { seq: 8, time: Date.now(), content: [{ type: 'text', text: '对话测试' }], source: { kind: 'user' } } },
    sessionId: 'translation-chat',
  })
  assert.ok(userHtml.includes('对话测试'), `无翻译记录的用户消息必须渲染正文：${userHtml}`)
  assert.equal(userHtml.includes('data-codingns-translation-action'), false)

  // AI 正文同理：没有 codingnsTranslation 记录时也要完整渲染 text / reasoning 块。
  const assistantHtml = render(assistantView, {
    node: {
      id: 'assistant-1',
      location: { kind: 'step', turn: { status: 'closed' } },
      data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'text', text: 'Ready to help.' }] },
    },
    sessionId: 'translation-chat',
  })
  assert.ok(assistantHtml.includes('Ready to help.'), `无翻译记录的 AI 正文必须渲染：${assistantHtml}`)
  assert.equal(assistantHtml.includes('data-codingns-translation-action'), false)
})

test('会话翻译渲染器在有翻译记录时保留翻译入口与引用汇总', () => {
  const renderers = captureRenderers()
  const userView = renderers.get('user')!.component
  const assistantView = renderers.get('assistant-step')!.component

  const userHtml = render(userView, {
    node: {
      id: 'user-2',
      data: {
        seq: 9,
        time: Date.now(),
        content: [{ type: 'text', text: 'Conversation test' }],
        source: { kind: 'user', codingnsTranslationInput: inputRecord },
        referenceLabels: ['会话 A', '会话 B'],
      },
    },
    sessionId: 'translation-chat',
  })
  assert.ok(userHtml.includes('data-codingns-translation-action'), '有输入翻译记录时必须保留翻译入口')
  assert.ok(userHtml.includes('引用会话 · 会话 A、会话 B'), `引用汇总需与原生一致：${userHtml}`)

  const assistantHtml = render(assistantView, {
    node: {
      id: 'assistant-2',
      location: { kind: 'step', turn: { status: 'closed' } },
      data: {
        status: 'settled',
        turn: 1,
        step: 1,
        blocks: [{ kind: 'text', text: '随时可以开始。', codingnsTranslation: outputRecord }],
      },
    },
    sessionId: 'translation-chat',
  })
  assert.ok(assistantHtml.includes('随时可以开始。'))
  assert.ok(assistantHtml.includes('data-codingns-translation-action'), '有输出翻译记录时必须保留翻译入口')
})

test('仅含工具调用块的助手步骤保持原生行为：不渲染空步骤', () => {
  const renderers = captureRenderers()
  const assistantHtml = render(renderers.get('assistant-step')!.component, {
    node: {
      id: 'assistant-3',
      location: { kind: 'step', turn: { status: 'closed' } },
      data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'tool-call', callId: 'c1' }] },
    },
    sessionId: 'translation-chat',
  })
  // 工具调用卡片由独立的 tool-call 节点渲染；这里必须与 DSH 原生 AssistantMarkdown 一样留空。
  assert.equal(assistantHtml, '')
})
