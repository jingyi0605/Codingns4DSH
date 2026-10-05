import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE,
  CONTEXT_BREAKDOWN_STYLE_ID,
  startContextBreakdownDom,
} from '../data/build/dist/client/context-breakdown-dom.js'

test('只对外部真实上下文会话的面板隐藏启发式明细，停用后移除', async () => {
  const codexDom = new FakeDocument()
  codexDom.body.appendChild(conversation('session-codex').root)
  const codexPanel = contextPanel()
  codexDom.body.appendChild(codexPanel)
  const codexController = startContextBreakdownDom({
    document: codexDom,
    MutationObserver: FakeObserver,
    adapterIdForSession: () => 'codex',
  })
  await nextTurn()
  assert.equal(codexPanel.hasAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE), true)

  const qoderDom = new FakeDocument()
  qoderDom.body.appendChild(conversation('session-qoder').root)
  const qoderPanel = contextPanel()
  qoderDom.body.appendChild(qoderPanel)
  const qoderController = startContextBreakdownDom({
    document: qoderDom,
    MutationObserver: FakeObserver,
    adapterIdForSession: () => 'qoder-cn',
  })
  await nextTurn()
  assert.equal(qoderPanel.hasAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE), true)

  const kimiDom = new FakeDocument()
  kimiDom.body.appendChild(conversation('session-kimi').root)
  const kimiPanel = contextPanel()
  kimiDom.body.appendChild(kimiPanel)
  const kimiController = startContextBreakdownDom({
    document: kimiDom,
    MutationObserver: FakeObserver,
    adapterIdForSession: () => 'kimi',
  })
  await nextTurn()
  assert.equal(kimiPanel.hasAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE), false)

  codexController.dispose()
  assert.equal(codexPanel.hasAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE), false, '停用后必须移除标记')
  qoderController.dispose()
  assert.equal(qoderPanel.hasAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE), false, '停用后必须移除标记')
  kimiController.dispose()
})

test('未展开的触发器与缺少构成明细的面板都不会被标记', async () => {
  const dom = new FakeDocument()
  const collapsed = conversation('session-codex', 'false')
  const barePanel = new FakeElement('div')
  barePanel.setAttribute('role', 'dialog')
  barePanel.appendChild(new FakeElement('div'))
  dom.body.appendChild(collapsed.root)
  dom.body.appendChild(barePanel)

  const controller = startContextBreakdownDom({
    document: dom,
    MutationObserver: FakeObserver,
    adapterIdForSession: () => 'codex',
  })
  await nextTurn()

  assert.equal(barePanel.hasAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE), false)

  // 面板已经打开时，触发器展开即可重新判定。
  collapsed.button.setAttribute('aria-expanded', 'true')
  const panel = contextPanel()
  dom.body.appendChild(panel)
  controller.refresh()
  await nextTurn()
  assert.equal(panel.hasAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE), true)

  controller.dispose()
})

test('适配器未知时按节流窗口请求一次映射刷新', async () => {
  const dom = new FakeDocument()
  dom.body.appendChild(conversation('session-unknown').root)
  dom.body.appendChild(contextPanel())
  let refreshes = 0
  let clock = 0
  const controller = startContextBreakdownDom({
    document: dom,
    MutationObserver: FakeObserver,
    adapterIdForSession: () => undefined,
    refreshAdapters: () => { refreshes += 1 },
    adapterRefreshIntervalMs: 5_000,
    now: () => clock,
  })
  await nextTurn()
  assert.equal(refreshes, 1, '缓存未命中时应请求一次刷新')

  clock = 1_000
  controller.refresh()
  await nextTurn()
  assert.equal(refreshes, 1, '节流窗口内不得重复请求')

  clock = 6_000
  controller.refresh()
  await nextTurn()
  assert.equal(refreshes, 2)

  controller.dispose()
})

test('观察器变化后重扫新面板，dispose 断开观察与样式订阅', async () => {
  const dom = new FakeDocument()
  dom.body.appendChild(conversation('session-codex').root)
  let observer
  class RecordingObserver extends FakeObserver {
    constructor(callback) {
      super(callback)
      observer = this
    }
  }
  const controller = startContextBreakdownDom({
    document: dom,
    MutationObserver: RecordingObserver,
    adapterIdForSession: () => 'codex',
  })
  await nextTurn()

  const panel = contextPanel()
  dom.body.appendChild(panel)
  observer.trigger()
  await nextTurn()
  assert.equal(panel.hasAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE), true, 'portal 插入面板后应被立即标记')

  controller.dispose()
  assert.equal(observer.disconnected, true)
  assert.equal(dom.head.children.length, 1, '样式标签保留但不再叠加')
})

test('样式只注入一次，重复启动不叠加', () => {
  const dom = new FakeDocument()
  const first = startContextBreakdownDom({ document: dom, MutationObserver: FakeObserver })
  const second = startContextBreakdownDom({ document: dom, MutationObserver: FakeObserver })
  first.dispose()
  second.dispose()
  assert.equal(dom.head.children.length, 1)
  assert.equal(dom.head.children[0].dataset.pluginCss, CONTEXT_BREAKDOWN_STYLE_ID)
})

function conversation(sessionId, expanded = 'true') {
  const root = new FakeElement('div')
  root.setAttribute('data-conversation-session', sessionId)
  const button = new FakeElement('button')
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-expanded', expanded)
  root.appendChild(button)
  return { root, button }
}

function contextPanel() {
  const panel = new FakeElement('div')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '上下文已用')
  panel.appendChild(new FakeElement('div'))
  panel.appendChild(new FakeElement('div'))
  const rows = new FakeElement('dl')
  const row = new FakeElement('div')
  row.appendChild(new FakeElement('dt'))
  row.appendChild(new FakeElement('dd'))
  rows.appendChild(row)
  panel.appendChild(rows)
  return panel
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

class FakeObserver {
  constructor(callback) {
    this.callback = callback
    this.disconnected = false
  }

  observe(target, options) {
    this.target = target
    this.options = options
  }

  disconnect() {
    this.disconnected = true
  }

  trigger() {
    this.callback([], this)
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.textContent = ''
  }

  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  querySelector(selector) {
    return findAll(this, selector)[0] ?? null
  }

  querySelectorAll(selector) {
    return findAll(this, selector)
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html')
    this.head = new FakeElement('head')
    this.body = new FakeElement('body')
  }

  createElement(tagName) {
    return new FakeElement(tagName)
  }

  querySelectorAll(selector) {
    return findAll(this.body, selector)
  }
}

function findAll(root, selector) {
  const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector)
  const expectedTag = attribute === null ? selector : undefined
  const found = []
  const visit = (node) => {
    for (const child of node.children) {
      if (selectorMatches(child, expectedTag, attribute)) found.push(child)
      visit(child)
    }
  }
  visit(root)
  return found
}

function selectorMatches(element, expectedTag, attribute) {
  if (attribute === null) return element.tagName === expectedTag.toUpperCase()
  const [, name, value] = attribute
  if (value === undefined) return element.hasAttribute(name)
  return element.getAttribute(name) === value
}
