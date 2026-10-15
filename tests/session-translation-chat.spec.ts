import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, createElement, isValidElement, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantReasoningContent, TranslationAction, registerSessionTranslationChatUi } from '../src/client/session-translation-chat.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import type { SessionTranslationRecord } from '../src/shared/contracts/session-translation.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { createPresentationSlots } from './fixtures/presentation-slots.js'

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
  registerSessionTranslationChatUi(createServices(probe.slots), { primitives: { projectUserText: (text: string) => text } })
  return probe.registered
}

test('alpha.3 renders ordinary and translated user content through native factories without removed owner callbacks', () => {
  const probe = createSlotsProbe()
  Object.assign(probe.slots!, { registerFactory() {} })
  const services = { ...createServices(probe.slots), dshVersion: '0.2.1-alpha.3' }
  const dispose = registerSessionTranslationChatUi(services, { primitives: {} })
  const calls: { name: string; props: any }[] = []
  const loadImage = () => undefined
  const renderFactorySlot = (name: string, props: any) => {
    calls.push({ name, props })
    return createElement('span', { 'data-native-content': true }, props.content?.text ?? 'native image')
  }
  for (const source of [undefined, { kind: 'user', codingnsTranslationInput: inputRecord }]) {
    const html = render(probe.registered.get('user')!.component, {
      node: { id: 'user', data: { content: [{ type: 'text', text: 'message' }, { type: 'image', attachment: { attachmentId: 'image' } }], source, referenceLabels: ['session'], skillNames: ['skill'] } },
      renderFactorySlot, loadImage,
    })
    assert.match(html, /data-native-content/)
    assert.match(html, /message/)
    const call = calls.at(-1)!
    assert.equal(call.name, 'conversation.chat.user.content')
    assert.equal(call.props.loadImage, loadImage)
    assert.deepEqual(call.props.facts, { sessionLabels: ['session'], skillNames: ['skill'] })
    assert.deepEqual(call.props.content.attachments, [{ type: 'image', image: { attachment: { attachmentId: 'image' } } }])
  }
  render(probe.registered.get('assistant-step')!.component, {
    node: { id: 'assistant', location: { kind: 'step', turn: { status: 'closed' } }, data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'image', attachment: { attachmentId: 'result' } }] } },
    renderFactorySlot, loadImage,
  })
  assert.equal(calls.at(-1)?.name, 'conversation.images.content')
  assert.equal(calls.at(-1)?.props.align, 'start')
  dispose()
  assert.equal(probe.registered.size, 0)
})

test('alpha.3 translation follows late factory declarations, reloads and disposal', () => {
  const slots = createPresentationSlots()
  const removeRoot = slots.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
  } } as any, () => null)
  const native = () => null
  const removeNative = slots.register({ name: 'conversation.chat.node', key: 'user' } as any, native)
  const dispose = registerSessionTranslationChatUi({ ...createServices(slots as any), dshVersion: '0.2.1-alpha.3' })
  const renderers = () => slots.entries('conversation.chat.node' as never)
  assert.equal(renderers().length, 1, 'native renderer survives while factories are unavailable')
  const text = () => slots.registerFactory({ name: 'conversation.user.text', scope: 'session',
    children: { 'conversation.user.text.node': { kind: 'keyed', scope: 'session' } } } as any, () => null)
  const removeText = text()
  assert.equal(renderers().length, 1)
  const content = () => slots.registerFactory({ name: 'conversation.chat.user.content', scope: 'session',
    children: { 'conversation.chat.user.images': { kind: 'single', scope: 'session' } } } as any, () => null)
  const removeContent = content()
  assert.equal(renderers().length, 3, 'text translation does not wait for the optional image gallery')
  removeContent()
  assert.equal(renderers().length, 1)
  const removeReplacement = content()
  assert.equal(renderers().length, 3)
  removeText()
  assert.equal(renderers().length, 1)
  const removeTextReplacement = text()
  assert.equal(renderers().length, 3)
  dispose()
  assert.equal(renderers().length, 1)
  removeTextReplacement()
  const removeAfterStop = text()
  assert.equal(renderers().length, 1, 'disposed feature must not remount on later factory changes')
  removeAfterStop(); removeReplacement(); removeNative(); removeRoot()
})

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

function elements(node: ReactNode): ReactElement<any>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  return [node, ...Children.toArray(node.props.children).flatMap(elements)]
}

test('pending translation is clickable, shows progress, and switches to completed or failed details', (t) => {
  const listeners = new Map<string, unknown>()
  const previousWindow = globalThis.window
  Object.assign(globalThis, { window: {
    innerWidth: 900, innerHeight: 700,
    addEventListener: (name: string, listener: unknown) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } })
  const props = { messageId: 'pending-input', services: {} as CodingNsClientServices, translationT, original: inputRecord.original }
  const renderer = createHookRenderer(TranslationAction, props)
  t.after(() => {
    renderer.dispose()
    if (previousWindow === undefined) delete (globalThis as any).window
    else globalThis.window = previousWindow
  })
  let tree = renderer.render()
  const button = elements(tree).find((element) => element.type === 'button')!
  assert.equal(button.props.disabled, undefined)
  assert.equal(button.props['aria-expanded'], false)
  assert.ok(elements(tree).some((element) => element.props['data-codingns-translation-pending'] === true))
  ;(button as any).ref.current = { getBoundingClientRect: () => ({ left: 200, right: 228, top: 500, bottom: 528 }) }
  button.props.onClick()
  tree = renderer.render()
  let dialog = elements(tree).find((element) => element.props.role === 'dialog')!
  assert.ok(dialog)
  let html = renderToStaticMarkup(dialog)
  assert.ok(html.includes(translationT('translation.statusTranslating')))
  assert.ok(html.includes(translationT('translation.progressHelp')))
  assert.ok(html.includes(inputRecord.original))
  assert.equal(html.includes(translationT('translation.modelUsed')), false)
  const progress = elements(dialog).find((element) => element.type === 'progress')!
  assert.ok(progress)
  assert.equal(progress.props.value, undefined, 'translation progress must not invent a completion percentage')

  const record = { ...outputRecord, original: inputRecord.original, translated: inputRecord.translated, durationMs: 1234, totalTokens: 456 }
  tree = renderer.render({ ...props, record } as typeof props)
  assert.equal(elements(tree).some((element) => element.props['data-codingns-translation-pending'] === true), false)
  dialog = elements(tree).find((element) => element.props.role === 'dialog')!
  html = renderToStaticMarkup(dialog)
  assert.ok(html.includes(inputRecord.translated))
  assert.ok(html.includes(translationT('translation.statusTranslated')))
  assert.ok(html.includes('deepseek / chat · 1.23 s · 456 tok'))
  assert.equal(html.includes(translationT('translation.progressHelp')), false)
  assert.equal(elements(dialog).some((element) => element.type === 'progress'), false)

  for (const [metrics, suffix] of [
    [{}, 'deepseek / chat</div>'],
    [{ durationMs: 2000 }, 'deepseek / chat · 2.00 s</div>'],
    [{ durationMs: 0, totalTokens: 0 }, 'deepseek / chat · 0.00 s · 0 tok</div>'],
  ] as const) {
    tree = renderer.render({ ...props, record: { ...outputRecord, ...metrics } } as typeof props)
    html = renderToStaticMarkup(elements(tree).find((element) => element.props.role === 'dialog')!)
    assert.ok(html.includes(suffix), html)
  }

  tree = renderer.render({ ...props, record: { ...record, failed: true, translated: record.original } } as typeof props)
  html = renderToStaticMarkup(elements(tree).find((element) => element.props.role === 'dialog')!)
  assert.ok(html.includes(translationT('translation.statusFailed')))
  elements(tree).find((element) => element.type === 'button')!.props.onClick()
  tree = renderer.render()
  assert.equal(elements(tree).some((element) => element.props.role === 'dialog'), false)
  assert.equal(listeners.size, 0)
})

test('input and reply history pass translation metrics to the popup action', () => {
  const renderers = captureRenderers()
  const metrics = { durationMs: 1234, totalTokens: 456 }
  for (const [key, node] of [
    ['user', { id: 'user-metrics', data: {
      content: [{ type: 'text', text: inputRecord.translated }],
      source: { kind: 'user', codingnsTranslationInput: { ...inputRecord, ...metrics } },
    } }],
    ['assistant-step', {
      id: 'assistant-metrics', location: { kind: 'step', turn: { status: 'closed' } },
      data: { status: 'settled', turn: 1, step: 1, blocks: [
        { kind: 'text', text: outputRecord.original, codingnsTranslation: { ...outputRecord, ...metrics } },
      ] },
    }],
  ] as const) {
    const component = renderers.get(key)!.component as (props: any) => ReactElement
    const renderer = createHookRenderer(component, { node, t: chatT, translationT, services: {}, sessionId: 'metrics' })
    try {
      const action = elements(renderer.render()).find((element) => element.type === TranslationAction)!
      assert.equal(action.props.record.durationMs, metrics.durationMs)
      assert.equal(action.props.record.totalTokens, metrics.totalTokens)
    } finally { renderer.dispose() }
  }
})

test('Chinese input target keeps the final translation action after pending state ends', () => {
  const userView = captureRenderers().get('user')!.component
  const html = render(userView, {
    node: { id: 'user-zh', data: {
      content: [{ type: 'text', text: 'Conversation test' }],
      source: { kind: 'user', codingnsTranslationInput: { ...inputRecord, targetLanguage: 'zh' } },
    } },
  })
  assert.ok(html.includes('data-codingns-translation-action'))
  assert.equal(html.includes('data-codingns-translation-pending'), false)
})

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
        blocks: [{ kind: 'text', text: outputRecord.original, codingnsTranslation: outputRecord }],
      },
    },
    sessionId: 'translation-chat',
  })
  assert.ok(assistantHtml.includes('随时可以开始。'))
  assert.equal(assistantHtml.includes('Ready to help.'), false)
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

test('原文已是目标语言时翻译入口显示蓝色状态点而不是已翻译的绿色', () => {
  const renderers = captureRenderers()
  const userHtml = render(renderers.get('user')!.component, {
    node: {
      id: 'user-3',
      data: {
        seq: 10,
        time: Date.now(),
        content: [{ type: 'text', text: 'tool test' }],
        source: {
          kind: 'user',
          codingnsTranslationInput: {
            original: 'tool test',
            translated: 'tool test',
            sourceLanguage: 'en',
            targetLanguage: 'en',
            alreadyTargetLanguage: true,
          },
        },
      },
    },
    sessionId: 'translation-chat',
  })

  assert.ok(userHtml.includes('data-codingns-translation-action'), '无需翻译的记录同样要渲染翻译入口')
  assert.ok(userHtml.includes('原文已是目标语言，无需翻译'), `无需翻译状态必须给出提示：${userHtml}`)
  // 状态点用 accent（蓝）而不是 success（绿）：输入已经是目标语言，没有调用翻译模型。
  assert.ok(userHtml.includes('var(--dsw-alias-button-info-fill, #1677ff)'), `无需翻译必须显示蓝色状态点：${userHtml}`)
  assert.equal(userHtml.includes('var(--dsw-alias-state-success-primary'), false)
})

const reasoningRecord: SessionTranslationRecord = {
  original: 'The user just sent a period. This is a minimal input without a clear request.',
  translated: '用户刚刚发送了一个句号。这是一个没有明确请求的极简输入。',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  outputKind: 'reasoning',
  bilingual: false,
  model: { provider: 'glor02', model: 'deepseek-v4.1-flash' },
}

const markdownLabels = {
  code: {
    copyLabel: chatT('copy'),
    copiedLabel: chatT('copied'),
    toolbarLabels: {
      codeLabel: chatT('codeBlock.title'),
      wrapLabel: chatT('codeBlock.wrap'),
      unwrapLabel: chatT('codeBlock.unwrap'),
    },
  },
  footnotes: chatT('markdown.footnotes'),
}

test('思考块展开后必须渲染译文正文，不能只留下翻译入口', () => {
  const renderers = captureRenderers()
  const assistantView = renderers.get('assistant-step')!.component
  const node = {
    id: 'assistant-reasoning',
    location: { kind: 'step', turn: { status: 'closed' } },
    data: {
      status: 'settled',
      turn: 1,
      step: 1,
      blocks: [{ kind: 'reasoning', text: reasoningRecord.original, codingnsTranslation: reasoningRecord }],
    },
  }

  // 折叠态：思考行摘要取自译文正文。
  const collapsed = render(assistantView, { node, sessionId: 'translation-chat' })
  assert.ok(collapsed.includes('用户刚刚发送了一个句号'), `思考行摘要必须使用译文：${collapsed}`)

  // 展开态：DSH 的 renderFactorySlot 在工厂缺失时只渲染 fallback（缺省 null），
  // 这里用同样的语义做替身——正文必须由 fallback 渲染出来，不能依赖工厂存在。
  const factoryCalls: string[] = []
  const renderFactorySlot = (name: string, _props: Record<string, unknown>, options?: { readonly fallback?: ReactNode }): ReactNode => {
    factoryCalls.push(name)
    return options?.fallback ?? null
  }
  const expanded = renderToStaticMarkup(createElement(AssistantReasoningContent, {
    messageId: 'turn-1-step-1-reasoning-0',
    services: {},
    translationT,
    text: reasoningRecord.translated,
    running: false,
    translationRecord: reasoningRecord,
    markdownLabels,
    pathImages: { resolve: () => undefined },
    renderFactorySlot,
  }))

  assert.ok(expanded.includes('用户刚刚发送了一个句号'), `展开后的思考正文必须渲染译文：${expanded}`)
  assert.ok(expanded.includes('data-codingns-translation-action'), '展开后的思考正文仍需保留翻译入口')
  assert.ok(factoryCalls.length <= 1, `工厂只应被查询一次：${factoryCalls.join(', ')}`)
})
