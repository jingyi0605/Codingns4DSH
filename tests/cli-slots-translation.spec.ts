import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerCliConversationSlots, useCliSessionTranslationEnabled } from '../src/client/cli-slots.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { SESSION_TRANSLATION_ADAPTER_IDS } from '../src/shared/contracts/session-translation.js'
import type { CodingNsCliModelGroup } from '../src/shared/contracts/cli-adapter.js'
import { notifyNativeTranslationDefaultChanged, readNativeTranslationDefault, setNativeTranslationDefaultReader } from '../src/client/native-translation-default.js'
import { watchNativeModelMenu } from '../src/client/native-model-translation-menu.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { ConversationTranslationSettings } from '../src/client/conversation-translation-settings.js'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'

const t = resolveCodingNsTranslator()
const locale = {
  bind: () => t,
  getSnapshot: () => ({ revision: 0 }),
  subscribe: () => () => undefined,
  register: () => () => undefined,
} as never

function createProbe(adapterId = 'dsh', options: {
  readDefault?: () => boolean | undefined
  translationEnabled?: boolean | undefined
  failSessionSet?: boolean
  modelGroups?: readonly CodingNsCliModelGroup[]
  modelId?: string
} = {}) {
  const registered = new Map<string, { component: (props: any) => ReactElement | null; props: Record<string, unknown> }>()
  let selection = { adapterId, modelId: options.modelId ?? 'test-model', effortId: 'high', translationEnabled: 'translationEnabled' in options ? options.translationEnabled : true }
  const calls: Array<{ endpoint: string; payload: any }> = []
  const rpc = {
    async call(_channel: string, endpoint: string, payload: any) {
      calls.push({ endpoint, payload })
      let value: unknown
      if (endpoint === 'cli/session/get') value = selection
      else if (endpoint === 'cli/session/set') {
        if (options.failSessionSet) throw new Error('session update failed')
        value = selection = { ...selection, ...payload }
      }
      else if (endpoint === 'cli/catalog') value = SESSION_TRANSLATION_ADAPTER_IDS.map((id) => ({ id, name: id, installed: true, enabled: true }))
      else if (endpoint === 'cli/models') value = {
        groups: options.modelGroups ?? [{ id: adapterId, name: adapterId, models: [{ id: 'test-model', name: 'Test model', efforts: ['high'] }] }],
        currentModel: options.modelId ?? 'test-model', currentEffort: 'high',
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
  const dispose = registerCliConversationSlots(slots as never, rpc, locale, options.readDefault ?? (() => true), {} as never)
  return { registered, rpc, calls, sessionId, dispose }
}

let nextSessionId = 0
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('Claude menu pins Fable and sorts providers, names and context variants without mutating other Agent catalogs', async () => {
  const models = [
    { id: 'tlp/sonnet', name: 'Claude Sonnet 5.5 · tlp', efforts: [], magpieProviderId: 'tlp' },
    { id: 'hl/gpt-12', name: 'GPT-12 · hl', efforts: [], magpieProviderId: 'hl' },
    { id: 'hl/sonnet[1m]', name: 'Claude Sonnet 5.5 [1m] · hl', efforts: [], magpieProviderId: 'hl' },
    { id: 'haiku', name: 'haiku', efforts: [] },
    { id: 'tlp/gpt-6', name: 'GPT-6 · tlp', efforts: [], magpieProviderId: 'tlp' },
    { id: 'hl/opus', name: 'claude-opus-5-5 · hl', efforts: [], magpieProviderId: 'hl' },
    { id: 'opus', name: 'opus', efforts: [] },
    { id: 'hl/gpt-6', name: 'GPT-6 · hl', efforts: [], magpieProviderId: 'hl' },
    { id: 'hl/sonnet', name: 'Claude Sonnet 5.5 · hl', efforts: [], magpieProviderId: 'hl' },
    { id: 'fable', name: 'Fable', efforts: [] },
    { id: 'sonnet', name: 'sonnet', efforts: [] },
    { id: 'provider-default', name: 'Default', efforts: [] },
  ]
  const originalIds = models.map((model) => model.id)
  Object.freeze(models)
  for (const adapterId of ['claude-code', 'codex']) {
    const probe = createProbe(adapterId, { modelGroups: [{ id: 'models', name: 'Models', models }], modelId: 'sonnet' })
    const slot = probe.registered.get('codingns4dsh-model')!
    const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
    try {
      const tree = await openModelPane(renderer)
      const actual = modelOptions(tree).map((element) => element.key)
      const expected = adapterId === 'claude-code' ? [
        'provider-default', 'sonnet', 'opus', 'haiku', 'fable',
        'hl/opus', 'hl/sonnet', 'hl/sonnet[1m]', 'hl/gpt-6', 'hl/gpt-12', 'tlp/sonnet', 'tlp/gpt-6',
      ] : originalIds
      assert.deepEqual(actual, expected.map((id) => `models:${id}`))
      assert.deepEqual(models.map((model) => model.id), originalIds, 'sorting must not mutate the cached Host catalog')
    } finally { renderer.dispose(); probe.dispose() }
  }
})

test('Claude model menu keeps context variants distinct and submits their exact IDs', async () => {
  const models = [
    { id: 'hl/claude-sonnet-5-5', name: 'Claude Sonnet 5.5 · hl', efforts: ['high'], source: 'magpie' as const, magpieProviderId: 'hl' },
    { id: 'hl/claude-sonnet-5-5[1m]', name: 'Claude Sonnet 5.5 · hl [1m]', efforts: ['high'], source: 'magpie' as const, magpieProviderId: 'hl' },
    { id: 'tlp/claude-sonnet-5-5', name: 'Claude Sonnet 5.5 · tlp', efforts: ['high'], source: 'magpie' as const, magpieProviderId: 'tlp' },
  ]
  for (const selected of models) {
    const probe = createProbe('claude-code', {
      modelGroups: [{ id: 'claude', name: 'Claude', models }], modelId: 'sonnet',
    })
    const slot = probe.registered.get('codingns4dsh-model')!
    const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
    try {
      const tree = await openModelPane(renderer)
      const options = modelOptions(tree)
      assert.equal(options.length, 3)
      for (const model of models) {
        const option = options.find((element) => element.key === `claude:${model.id}`)!
        assert.ok(renderToStaticMarkup(option).includes(model.name))
      }
      options.find((element) => element.key === `claude:${selected.id}`)!.props.onClick()
      await flush()
      assert.ok(probe.calls.some((call) => call.endpoint === 'cli/session/set' && call.payload.modelId === selected.id))
    } finally { renderer.dispose(); probe.dispose() }
  }
})

test('model submenu stays constrained to the picker width and exposes full names on truncated rows', async () => {
  const longName = 'provider/very-long-model-name-that-must-not-expand-the-mobile-screen'
  const probe = createProbe('codex', {
    modelGroups: [{ id: 'models', name: 'Models', models: [{ id: 'long-model', name: longName, efforts: [] }] }],
    modelId: 'long-model',
  })
  const slot = probe.registered.get('codingns4dsh-model')!
  const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
  try {
    const tree = await openModelPane(renderer)
    const menu = elementWhere(tree, (element) => element.props.className === 'codingns4dsh-model-menu')!
    const option = modelOptions(tree)[0]!
    assert.equal(menu.props.style.width, 'min(420px, calc(100vw - 24px))')
    assert.equal(menu.props.style.maxWidth, 'min(420px, calc(100vw - 24px))')
    assert.equal(menu.props.style.boxSizing, 'border-box')
    assert.equal(option.props.title, longName)
    assert.equal(option.props.style.minWidth, 0)
  } finally { renderer.dispose(); probe.dispose() }
})

test('Agent catalog failures remain visible and a retry restores the external Agents', async () => {
  const probe = createProbe()
  const call = probe.rpc.call
  let catalogRequests = 0
  probe.rpc.call = async (channel, endpoint, payload) => {
    if (endpoint === 'cli/catalog' && ++catalogRequests === 1) throw new Error('Host unavailable')
    return call(channel, endpoint, payload)
  }
  const slot = probe.registered.get('codingns4dsh-agent')!
  const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
  try {
    renderer.render()
    await flush()
    elementWhere(renderer.render(), element => element.type === 'button')!.props.onClick()
    const failed = renderer.render()
    assert.ok(elementWhere(failed, element => element.props.role === 'alert'))
    assert.ok(elementWhere(failed, element => element.key === 'dsh'))
    const retry = elementWhere(failed, element => element.type === 'button' && element.props.children === t('cli.retryCatalog'))!
    retry.props.onClick()
    renderer.render()
    await flush()
    const recovered = renderer.render()
    assert.equal(catalogRequests, 2)
    assert.equal(elementWhere(recovered, element => element.props.role === 'alert'), undefined)
    assert.ok(elementWhere(recovered, element => element.key === 'gemini'))
  } finally { renderer.dispose(); probe.dispose() }
})

test('pending translation follows the native default and per-session switches for native and external agents', async () => {
  setNativeTranslationDefaultReader(() => true)
  try {
    for (const [adapterId, override, expected] of [
      ['dsh', undefined, true], ['dsh', false, false], ['dsh', true, true],
      ['codex', undefined, false], ['codex', false, false], ['codex', true, true],
    ] as const) {
      const probe = createProbe(adapterId, { translationEnabled: override })
      const renderer = createHookRenderer(() => useCliSessionTranslationEnabled(probe.sessionId, probe.rpc), {})
      try {
        renderer.render()
        await flush()
        assert.equal(renderer.render(), expected, `${adapterId}: ${override}`)
      } finally { renderer.dispose(); probe.dispose() }
    }
  } finally { setNativeTranslationDefaultReader(undefined) }
})

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

test('the settings icon precedes the master switch and opens a dialog for native and external models', async () => {
  for (const adapterId of ['dsh', 'codex']) {
    const probe = createProbe(adapterId, { translationEnabled: false })
    const slot = probe.registered.get('codingns4dsh-model')!
    const dom = createNativeMenuProbe()
    const renderer = createHookRenderer((props: Record<string, unknown>) => {
      const root = slot.component(props)
      if (root?.props.hidden) (root as any).ref.current = dom.anchor
      return root
    }, slot.props)
    try {
      renderer.render()
      await flush(); renderer.render(); await flush()
      if (adapterId !== 'dsh') elementWhere(renderer.render(), element => element.type === 'button')!.props.onClick()
      const tree = renderer.render()!
      const row = adapterId === 'dsh' ? (tree.props.children as any)[0].children : elementWhere(tree, element => element.key === 'translation')!
      const controls = (row.type(row.props) as ReactElement<any>).props.children
      assert.equal(controls[1].type, 'button')
      assert.equal(controls[1].props['aria-label'], t('cli.translationSettings'))
      assert.equal(controls[2].type, Switch)
      assert.equal(controls[2].props.checked, false)
      controls[1].props.onClick()
      const dialog = elementWhere(renderer.render(), element => element.type === ConversationTranslationSettings)!
      assert.ok(dialog)
      assert.equal(dialog.props.adapterId, adapterId)
      assert.equal(probe.calls.some(call => call.endpoint === 'cli/session/set'), false)
      if (adapterId === 'dsh') {
        dom.attributes.set('aria-expanded', 'false'); dom.mutate()
        assert.ok(elementWhere(renderer.render(), element => element.type === ConversationTranslationSettings), 'closing the native menu must not unmount settings')
      }
      dialog.props.onClose()
      assert.equal(elementWhere(renderer.render(), element => element.type === ConversationTranslationSettings), undefined)
    } finally { renderer.dispose(); probe.dispose() }
  }
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

test('原生翻译目标禁用时仍读取模型目录，但不向菜单插入空容器', () => {
  const current = createNativeMenuProbe()
  let modelReads = 0
  const dispose = watchNativeModelMenu(current.anchor, () => undefined, () => {
    modelReads++
    return []
  }, false)
  try {
    assert.equal(modelReads, 1)
    assert.equal(current.menu.children.length, 0)
    current.mutate()
    assert.equal(modelReads, 2, 'Magpie tagging keeps observing even without translation UI')
    assert.equal(current.menu.children.length, 0)
  } finally { dispose() }
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
  const toggleRow = () => (renderer.render()!.props.children as any)[0].children as ReactElement<any>
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
    assert.deepEqual(renderer.render()!.props.children, [null, null])
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
    assert.equal((renderer.render()!.props.children as any)[0].children.props.checked, false)
    renderer.render(nextSlot.props)
    await flush()
    assert.equal((renderer.render()!.props.children as any)[0].children.props.checked, true, '不能沿用上一会话的关闭状态')
  } finally { renderer.dispose(); previous.dispose(); next.dispose() }
})

const searchModelGroups: readonly CodingNsCliModelGroup[] = [
  {
    id: 'alpha', name: 'Alpha provider', models: [
      { id: 'alpha-one', name: 'Alpha One', efforts: ['high'] },
      { id: 'alpha-two', name: 'Alpha Two', efforts: ['high'] },
      { id: 'beta-one', name: 'Beta One', efforts: ['high'] },
    ],
  },
  {
    id: 'beta', name: 'Beta provider', models: [
      { id: 'gamma-one', name: 'Gamma One', efforts: ['high'] },
      { id: 'delta-one', name: 'Delta One', efforts: ['high'] },
      { id: 'epsilon-one', name: 'Epsilon One', efforts: ['high'] },
    ],
  },
]

/** 打开外部 Agent 的模型列表子面板，返回当前渲染树。 */
async function openModelPane(renderer: ReturnType<typeof createHookRenderer>): Promise<ReactNode> {
  renderer.render()
  await flush()
  renderer.render()
  await flush()
  elementWhere(renderer.render(), (element) => element.type === 'button' && element.props['aria-haspopup'] === 'menu')!.props.onClick()
  elementWhere(renderer.render(), (element) => element.key === 'model')!.props.onClick()
  return renderer.render()
}

function modelOptions(node: ReactNode): Array<ReactElement<any>> {
  const found: Array<ReactElement<any>> = []
  const visit = (child: ReactNode): void => {
    if (Array.isArray(child)) { child.forEach(visit); return }
    if (child === null || typeof child !== 'object' || !('props' in child)) return
    const element = child as ReactElement<any>
    if (element.props.role === 'menuitemradio' && typeof element.key === 'string' && element.key.includes(':')) found.push(element)
    visit(element.props.children)
  }
  visit(node)
  return found
}

test('external Agent 模型列表只为 Host 确认的 Magpie 模型显示来源标签', async () => {
  const groups: readonly CodingNsCliModelGroup[] = [{
    id: 'codex', name: 'Codex', models: [
      { id: 'auto/gpt-6.1-sol', name: 'GPT-6.1 Sol-Auto', efforts: ['low', 'high'], source: 'magpie' },
      { id: 'codex/gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'high'] },
      { id: 'tlp/gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'high'], source: 'magpie', magpieProviderId: 'tlp' },
      { id: 'hl/gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'high'], source: 'magpie', magpieProviderId: 'hl' },
    ],
  }]
  const probe = createProbe('codex', { modelGroups: groups, modelId: 'auto/gpt-6.1-sol' })
  const slot = probe.registered.get('codingns4dsh-model')!
  const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
  try {
    const tree = await openModelPane(renderer)
    const magpieRow = modelOptions(tree).find((element) => element.key === 'codex:auto/gpt-6.1-sol')
    const ordinaryRow = modelOptions(tree).find((element) => element.key === 'codex:codex/gpt-6.1-sol')
    assert.ok(magpieRow)
    assert.ok(ordinaryRow)
    const magpieMarkup = renderToStaticMarkup(magpieRow)
    assert.match(magpieMarkup, /data-codingns-magpie-model-tag/u)
    assert.match(magpieMarkup, /<img[^>]+src="\/api\/codingns\/provider-icons\/magpie\.png/u, 'the external logo comes from the Host icon route, not a remote URL')
    assert.match(magpieMarkup, /margin-inline-start:auto/u, 'the external logo occupies the trailing column')
    assert.ok(magpieMarkup.indexOf('aria-hidden="true">✓') < magpieMarkup.indexOf('data-codingns-magpie-model-tag'), 'the external checkmark stays before the logo')
    assert.doesNotMatch(renderToStaticMarkup(ordinaryRow), /data-codingns-magpie-model-tag/u)
    const providerRow = modelOptions(tree).find((element) => element.key === 'codex:tlp/gpt-6.1-sol')!
    assert.match(renderToStaticMarkup(providerRow), />tlp<\/span><img/u)
    const otherProviderRow = modelOptions(tree).find((element) => element.key === 'codex:hl/gpt-6.1-sol')!
    assert.match(renderToStaticMarkup(otherProviderRow), />hl<\/span><img/u, 'equal model names retain distinct provider tags')
    providerRow.props.onClick()
    await flush()
    const update = probe.calls.filter((call) => call.endpoint === 'cli/session/set').at(-1)!
    assert.equal(update.payload.modelId, 'tlp/gpt-6.1-sol', 'provider display does not change model selection')
    assert.equal(update.payload.magpieProviderId, undefined, 'provider display is not persisted in session state')
  } finally { renderer.dispose(); probe.dispose() }
})

function searchBox(node: ReactNode): ReactElement<any> | undefined {
  return elementWhere(node, (element) => element.props.role === 'searchbox')
}

test('外部 Agent 模型超过 4 个时提供与内置模型选择器一致的搜索、清空与空结果状态', async () => {
  const probe = createProbe('codex', { modelGroups: searchModelGroups, modelId: 'alpha-one' })
  const slot = probe.registered.get('codingns4dsh-model')!
  const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
  try {
    let tree = await openModelPane(renderer)
    assert.equal(elementWhere(tree, (element) => element.key === 'back'), undefined, '搜索组件上方不能有返回按钮')
    const menu = elementWhere(tree, (element) => element.props.role === 'menu')!
    const menuChildren = Array.isArray(menu.props.children) ? menu.props.children : [menu.props.children]
    assert.equal(menuChildren[0]?.key, 'model-search', '搜索行必须是模型子面板的第一项')
    const search = searchBox(tree)!
    assert.ok(search, '超过 4 个模型必须出现搜索框')
    assert.equal(search.props.placeholder, t('cli.modelSearch'))
    assert.equal(search.props['aria-label'], t('cli.modelSearch'))
    assert.equal(search.props.value, '')
    assert.match(search.props.className, /codingns4dsh-model-search/u)
    assert.equal(elementWhere(tree, (element) => element.key === 'clear'), undefined, '空查询不显示清除按钮')
    assert.equal(modelOptions(tree).length, 6)
    assert.equal(elementWhere(tree, (element) => element.props.role === 'group' && element.props['aria-label'] === 'Alpha provider') !== undefined, true)
    assert.equal(elementWhere(tree, (element) => element.props.role === 'group' && element.props['aria-label'] === 'Beta provider') !== undefined, true)

    search.props.onChange({ currentTarget: { value: 'beta' } })
    tree = renderer.render()
    assert.equal(modelOptions(tree).length, 1, '查询只保留匹配模型')
    assert.ok(elementWhere(tree, (element) => element.key === 'alpha:beta-one'))
    assert.equal(elementWhere(tree, (element) => element.props.role === 'group' && element.props['aria-label'] === 'Beta provider'), undefined, '空分组必须隐藏')
    assert.match(searchBox(tree)!.props.className, /codingns4dsh-model-search-with-query/u)

    elementWhere(tree, (element) => element.key === 'clear')!.props.onClick()
    tree = renderer.render()
    assert.equal(searchBox(tree)!.props.value, '')
    assert.equal(modelOptions(tree).length, 6, '清空查询恢复完整目录')
    assert.equal(elementWhere(tree, (element) => element.key === 'clear'), undefined)

    searchBox(tree)!.props.onChange({ currentTarget: { value: 'zzz' } })
    tree = renderer.render()
    await flush()
    tree = renderer.render()
    assert.equal(modelOptions(tree).length, 0)
    assert.ok(elementWhere(tree, (element) => element.props.role === 'status' && element.props.children === t('cli.modelSearchEmpty')),
      '无匹配时显示与内置选择器相同的空结果文案')
  } finally { renderer.dispose(); probe.dispose() }
})

test('模型搜索按内置选择器的名称排名过滤，Enter 选中当前高亮模型', async () => {
  const probe = createProbe('codex', { modelGroups: searchModelGroups, modelId: 'alpha-one' })
  const slot = probe.registered.get('codingns4dsh-model')!
  const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
  try {
    let tree = await openModelPane(renderer)
    const search = searchBox(tree)!
    // 子序列匹配：'gmo' 命中 Gamma One，前缀命中优先于目录顺序。
    search.props.onChange({ currentTarget: { value: 'gmo' } })
    tree = renderer.render()
    assert.deepEqual(modelOptions(tree).map((element) => element.key), ['beta:gamma-one'])
    assert.equal(elementWhere(tree, (element) => element.props['data-highlighted'] === 'true')?.key, 'beta:gamma-one')

    searchBox(tree)!.props.onKeyDown({ key: 'Enter', preventDefault() {} })
    await flush()
    assert.ok(probe.calls.some((call) => call.endpoint === 'cli/session/set' && call.payload.modelId === 'gamma-one'),
      'Enter 应提交当前高亮的搜索命中项')
  } finally { renderer.dispose(); probe.dispose() }
})

test('模型不超过 4 个时不显示搜索框，达到 5 个才显示', async () => {
  for (const [count, expected] of [[4, false], [5, true]] as const) {
    const groups: readonly CodingNsCliModelGroup[] = [{
      id: 'codex', name: 'codex',
      models: Array.from({ length: count }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}`, efforts: ['high'] })),
    }]
    const probe = createProbe('codex', { modelGroups: groups, modelId: 'model-0' })
    const slot = probe.registered.get('codingns4dsh-model')!
    const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
    try {
      const tree = await openModelPane(renderer)
      assert.equal(searchBox(tree) !== undefined, expected, `${count} 个模型`)
    } finally { renderer.dispose(); probe.dispose() }
  }
})

test('搜索组件注入的样式复用内置模型选择器的结构与主题令牌', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let css = ''
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (style: { textContent: string }) => { css = style.textContent } },
  } })
  try {
    const dispose = registerCliConversationSlots({ inject: () => () => undefined } as never, {} as never, { bind: () => (key: string) => key } as never)
    dispose()
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'document')
    else Object.defineProperty(globalThis, 'document', original)
  }
  assert.match(css, /\.codingns4dsh-model-search-row\{[^}]*position:relative/u)
  assert.match(css, /\.codingns4dsh-model-search-row \.codingns4dsh-model-search\{[^}]*border-radius:var\(--dsw-radius-md/u)
  assert.match(css, /\.codingns4dsh-model-search-clear\{[^}]*width:24px;height:24px/u)
  assert.match(css, /\.codingns4dsh-model-groups\{[^}]*width:100%;max-width:100%;min-width:0[^}]*overflow-x:hidden;overflow-y:auto/u)
  assert.match(css, /\.codingns4dsh-model-option\{[^}]*box-sizing:border-box;min-width:0;max-width:100%;overflow:hidden/u)
  assert.match(css, /\.codingns4dsh-model-search-row \.codingns4dsh-model-search input\{[^}]*font-size:/u)
  assert.match(css, /::placeholder\{color:var\(--dsw-alias-label-caption/u)
})

test('模型与思考档位子面板不提供返回按钮，Escape 先回根菜单再关闭弹层', async () => {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => undefined },
    addEventListener(type: string, listener: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: (event: any) => void) {
      listeners.get(type)?.delete(listener)
    },
    dispatch(type: string, event: any) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
    },
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  const probe = createProbe('codex', { modelGroups: searchModelGroups, modelId: 'alpha-one' })
  const slot = probe.registered.get('codingns4dsh-model')!
  const renderer = createHookRenderer(slot.component, slot.props, { checkHookOrder: true })
  try {
    let tree = await openModelPane(renderer)
    assert.equal(elementWhere(tree, (element) => element.key === 'back'), undefined)
    const escape = () => document.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })

    escape()
    tree = renderer.render()
    assert.ok(elementWhere(tree, (element) => element.key === 'model' && element.props.role === 'menuitem'), 'Escape 应从模型列表回到根菜单')
    assert.equal(searchBox(tree), undefined)

    // 思考档位子面板同样没有返回按钮。
    elementWhere(tree, (element) => element.key === 'effort')!.props.onClick()
    tree = renderer.render()
    assert.equal(elementWhere(tree, (element) => element.key === 'back'), undefined, '思考档位子面板不能有返回按钮')

    escape()
    tree = renderer.render()
    assert.ok(elementWhere(tree, (element) => element.key === 'model' && element.props.role === 'menuitem'))
    escape()
    tree = renderer.render()
    assert.equal(elementWhere(tree, (element) => element.props.role === 'menu'), undefined, '根菜单再按 Escape 关闭弹层')
  } finally {
    renderer.dispose(); probe.dispose()
    if (original === undefined) Reflect.deleteProperty(globalThis, 'document')
    else Object.defineProperty(globalThis, 'document', original)
  }
})
