import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerCliConversationSlots } from '../src/client/cli-slots.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { SESSION_TRANSLATION_ADAPTER_IDS } from '../src/shared/contracts/session-translation.js'
import { notifyNativeTranslationDefaultChanged, readNativeTranslationDefault, setNativeTranslationDefaultReader } from '../src/client/native-translation-default.js'
import { watchNativeModelMenu } from '../src/client/native-model-translation-menu.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const t = resolveCodingNsTranslator()
const locale = {
  bind: () => t,
  getSnapshot: () => ({ revision: 0 }),
  subscribe: () => () => undefined,
  register: () => () => undefined,
} as never

function createProbe(adapterId = 'dsh', options: { readDefault?: () => boolean | undefined; translationEnabled?: boolean | undefined } = {}) {
  const registered = new Map<string, { component: (props: any) => ReactElement | null; props: Record<string, unknown> }>()
  let selection = { adapterId, modelId: 'test-model', effortId: 'high', translationEnabled: 'translationEnabled' in options ? options.translationEnabled : true }
  const calls: Array<{ endpoint: string; payload: any }> = []
  const rpc = {
    async call(_channel: string, endpoint: string, payload: any) {
      calls.push({ endpoint, payload })
      let value: unknown
      if (endpoint === 'cli/session/get') value = selection
      else if (endpoint === 'cli/session/set') value = selection = { ...selection, ...payload }
      else if (endpoint === 'cli/catalog') value = SESSION_TRANSLATION_ADAPTER_IDS.map((id) => ({ id, name: id, installed: true, enabled: true }))
      else if (endpoint === 'cli/models') value = {
        groups: [{ id: adapterId, name: adapterId, models: [{ id: 'test-model', name: 'Test model', efforts: ['high'] }] }],
        currentModel: 'test-model', currentEffort: 'high',
      }
      else throw new Error(`Unexpected RPC: ${endpoint}`)
      return { ok: true as const, value }
    },
  }
  const sessionId = `translation-slot-${adapterId}-${nextSessionId++}`
  const slots = {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(options: any, component: (props: any) => ReactElement | null) {
      registered.set(options.id, { component, props: options.inject(sessionId) })
      return () => { registered.delete(options.id) }
    },
  }
  const dispose = registerCliConversationSlots(slots as never, rpc, locale, options.readDefault ?? (() => true))
  return { registered, rpc, calls, sessionId, dispose }
}

let nextSessionId = 0
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function elementWhere(node: ReactNode, predicate: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = elementWhere(child, predicate)
      if (found !== undefined) return found
    }
  } else if (node !== null && typeof node === 'object' && 'props' in node) {
    const element = node as ReactElement<any>
    return predicate(element) ? element : elementWhere(element.props.children, predicate)
  }
  return undefined
}

test('DSH 原生会话保留原生模型席位，不显示独立的翻译按钮', () => {
  const probe = createProbe()
  try {
    assert.deepEqual([...probe.registered.keys()], ['codingns4dsh-agent', 'codingns4dsh-model'])
    const slot = probe.registered.get('codingns4dsh-model')!
    const html = renderToStaticMarkup(createElement(slot.component, slot.props))
    assert.doesNotMatch(html, /<button|翻译对话|codingns4dsh-model-root/u)
  } finally { probe.dispose() }
})

test('所有外部 Agent 从默认 DSH 状态加载配置后都能渲染模型菜单，Hooks 顺序保持不变', async () => {
  for (const adapterId of SESSION_TRANSLATION_ADAPTER_IDS) {
    const probe = createProbe(adapterId)
    const slot = probe.registered.get('codingns4dsh-model')!
    const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
    try {
      renderer.render()
      await flush()
      renderer.render()
      await flush()
      const root = renderer.render()
      assert.equal(root?.props.className, 'codingns4dsh-model-root', adapterId)
      assert.ok(probe.calls.some((call) => call.endpoint === 'cli/models'), adapterId)
      const trigger = elementWhere(root, (element) => element.type === 'button')!
      assert.equal(trigger.props.disabled, false, adapterId)
      trigger.props.onClick()
      const menu = renderer.render()
      assert.ok(elementWhere(menu, (element) => element.props.role === 'menu'), adapterId)
      assert.ok(elementWhere(menu, (element) => element.key === 'translation'), adapterId)
      assert.ok(elementWhere(menu, (element) => element.key === 'model'), adapterId)
      assert.ok(elementWhere(menu, (element) => element.key === 'effort'), adapterId)
    } finally { renderer.dispose(); probe.dispose() }
  }
})

test('同一输入框在外部 Agent 与 DSH 之间来回切换后，模型选择器仍可使用', async () => {
  const probe = createProbe('codex')
  const modelSlot = probe.registered.get('codingns4dsh-model')!
  const agentSlot = probe.registered.get('codingns4dsh-agent')!
  const model = createHookRenderer(modelSlot.component, modelSlot.props, { checkHookOrder: true })
  const agent = createHookRenderer(agentSlot.component, agentSlot.props, { checkHookOrder: true })
  try {
    model.render(); agent.render()
    await flush()
    model.render(); agent.render()
    await flush()
    assert.equal(model.render()?.props.className, 'codingns4dsh-model-root')
    for (const adapterId of ['dsh', 'claude-code', 'dsh', 'codex']) {
      elementWhere(agent.render(), (element) => element.type === 'button')!.props.onClick()
      elementWhere(agent.render(), (element) => element.key === adapterId && element.props.role === 'menuitemradio')!.props.onClick()
      model.render()
      await flush()
      model.render()
      await flush()
      const root = model.render()
      if (adapterId === 'dsh') assert.equal(root?.props.hidden, true)
      else assert.equal(root?.props.className, 'codingns4dsh-model-root')
    }
  } finally { model.dispose(); agent.dispose(); probe.dispose() }
})

/** 复现原生模型菜单的 Portal、aria-controls 与多会话作用域，不依赖 CSS 哈希。 */
function createNativeMenuProbe() {
  const observers = new Set<() => void>()
  const attributes = new Map([['aria-controls', 'native-model-menu'], ['aria-expanded', 'true']])
  let role = 'menu'
  let rootPane = true
  let clickCount = 0
  let resizeCount = 0
  const menu = {
    children: [] as any[],
    getAttribute: () => role,
    querySelector: () => rootPane ? {} : null,
    prepend(target: any) { target.parentElement = menu; menu.children.unshift(target) },
  }
  const trigger = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    click() { clickCount++; attributes.set('aria-expanded', 'false') },
  }
  const document = {
    body: {},
    defaultView: {
      MutationObserver: class {
        readonly callback: () => void
        constructor(callback: () => void) { this.callback = callback }
        observe() { observers.add(this.callback) }
        disconnect() { observers.delete(this.callback) }
      },
      Event,
      dispatchEvent() { resizeCount++ },
    },
    getElementById: (id: string) => id === 'native-model-menu' ? menu : null,
    createElement() {
      const listeners = new Map<string, (event: any) => void>()
      return {
        nodeType: 1, dataset: {}, parentElement: null as any, listeners,
        addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener) },
        remove() {
          const index = menu.children.indexOf(this)
          if (index >= 0) menu.children.splice(index, 1)
          this.parentElement = null
        },
      }
    },
  }
  const anchor = { ownerDocument: document, closest: () => ({ querySelector: () => trigger }) } as unknown as HTMLElement
  return {
    anchor, attributes, menu, observers,
    mutate() { for (const scan of observers) scan() },
    setPane(nextRole: string, isRoot: boolean) { role = nextRole; rootPane = isRoot },
    get clickCount() { return clickCount },
    get resizeCount() { return resizeCount },
  }
}

test('翻译行容器只进入当前会话的原生模型主菜单，关闭、进入子菜单和卸载时释放', () => {
  const current = createNativeMenuProbe()
  const other = createNativeMenuProbe()
  const targets: Array<HTMLElement | null> = []
  const dispose = watchNativeModelMenu(current.anchor, (target) => targets.push(target))
  try {
    assert.equal(current.menu.children.length, 1)
    assert.equal(other.menu.children.length, 0)
    current.mutate()
    assert.equal(targets.length, 1, '重复 DOM 通知不能重复插入翻译行')
    current.setPane('group', false)
    current.mutate()
    assert.equal(current.menu.children.length, 0, '模型搜索列表保持原样')
    current.setPane('menu', false)
    current.mutate()
    assert.equal(current.menu.children.length, 0, '思考等级列表保持原样')
    current.setPane('menu', true)
    current.mutate()
    assert.equal(current.menu.children.length, 1)
    current.menu.children[0].listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
    assert.equal(current.clickCount, 1, '翻译开关获得焦点后 Esc 仍关闭原生菜单')
    current.mutate()
    assert.equal(current.menu.children.length, 0)
    current.attributes.set('aria-expanded', 'true')
    current.attributes.set('aria-controls', 'other-menu')
    current.mutate()
    assert.equal(current.menu.children.length, 0, '不按全局菜单或文案猜测会话归属')
    current.attributes.set('aria-controls', 'native-model-menu')
    current.mutate()
    assert.equal(current.menu.children.length, 1)
  } finally { dispose() }
  assert.equal(current.menu.children.length, 0)
  assert.equal(current.observers.size, 0)
  assert.equal(current.resizeCount, 1)
})

test('原生菜单中的共享翻译开关跟随设置更新、写回会话覆盖值，停用模块后立即移除', async () => {
  let enabled = true
  setNativeTranslationDefaultReader(() => enabled)
  const probe = createProbe('dsh', { readDefault: readNativeTranslationDefault, translationEnabled: undefined })
  const dom = createNativeMenuProbe()
  const slot = probe.registered.get('codingns4dsh-model')!
  const renderer = createHookRenderer((props: Record<string, unknown>) => {
    const root = slot.component(props)
    if (root?.props.hidden) (root as any).ref.current = dom.anchor
    return root
  }, slot.props, { checkHookOrder: true })
  const toggleRow = () => (renderer.render()!.props.children as any).children as ReactElement<any>
  try {
    renderer.render()
    await flush()
    assert.equal(dom.menu.children.length, 1)
    assert.equal(toggleRow().props.checked, true)
    assert.match(renderToStaticMarkup(toggleRow()), /role="switch"[^>]*aria-checked="true"/u)
    enabled = false
    notifyNativeTranslationDefaultChanged()
    assert.equal(toggleRow().props.checked, false)
    toggleRow().props.onChange(true)
    await flush()
    assert.equal(toggleRow().props.checked, true, '会话显式开启覆盖默认关闭')
    assert.ok(probe.calls.some((call) => call.endpoint === 'cli/session/set' && call.payload.adapterId === 'dsh' && call.payload.translationEnabled === true))
    setNativeTranslationDefaultReader(undefined)
    assert.equal(renderer.render()!.props.children, null)
    assert.equal(dom.menu.children.length, 0)
  } finally { renderer.dispose(); probe.dispose(); setNativeTranslationDefaultReader(undefined) }
})

test('同一个模型槽位进入已缓存的新 DSH 会话时，采用该会话开关值', async () => {
  const previous = createProbe('dsh', { readDefault: () => false, translationEnabled: false })
  const next = createProbe('dsh', { readDefault: () => false, translationEnabled: true })
  const nextSlot = next.registered.get('codingns4dsh-model')!
  const preload = createHookRenderer(nextSlot.component, nextSlot.props)
  try {
    // Agent 槽位可能先读到新会话；此后模型槽位的 session/get 命中已发布的缓存。
    preload.render()
    await flush()
    preload.render()
  } finally { preload.dispose() }
  const dom = createNativeMenuProbe()
  const slot = previous.registered.get('codingns4dsh-model')!
  const renderer = createHookRenderer((props: Record<string, unknown>) => {
    const root = slot.component(props)
    if (root?.props.hidden) (root as any).ref.current = dom.anchor
    return root
  }, slot.props, { checkHookOrder: true })
  try {
    renderer.render()
    await flush()
    assert.equal((renderer.render()!.props.children as any).children.props.checked, false)
    renderer.render(nextSlot.props)
    await flush()
    assert.equal((renderer.render()!.props.children as any).children.props.checked, true, '不能沿用上一会话的关闭状态')
  } finally { renderer.dispose(); previous.dispose(); next.dispose() }
})
