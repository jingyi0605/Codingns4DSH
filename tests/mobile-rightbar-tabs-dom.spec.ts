import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MOBILE_RIGHTBAR_TABS_ATTRIBUTE,
  MOBILE_RIGHTBAR_TABS_STYLE_ID,
  startMobileRightbarTabsDom,
} from '../data/build/dist/client/mobile-rightbar-tabs-dom.js'

class FakeElement {
  readonly children = new Set<FakeElement>()
  readonly attrs = new Map<string, string>()
  parent: FakeElement | undefined
  id = ''
  textContent = ''
  clicks = 0
  drags = 0
  constructor(attrs: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value)
  }
  appendChild(child: FakeElement): void { child.parent = this; this.children.add(child) }
  remove(): void { this.parent?.children.delete(this); this.parent = undefined }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value) }
  removeAttribute(name: string): void { this.attrs.delete(name) }
  closest(selector: string): FakeElement | null {
    if (selector !== '[data-sidebar-right-panel] [data-dockkit-strip-tabs]') return null
    let tabs: FakeElement | undefined
    for (let node: FakeElement | undefined = this; node !== undefined; node = node.parent) {
      if (tabs === undefined && node.attrs.has('data-dockkit-strip-tabs')) tabs = node
      if (tabs !== undefined && node.attrs.has('data-sidebar-right-panel')) return tabs
    }
    return null
  }
}

class FakeDocument {
  readonly documentElement = new FakeElement()
  readonly head = new FakeElement()
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  createElement(): FakeElement { return new FakeElement() }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
  listenerCount(type: string): number { return this.listeners.get(type)?.size ?? 0 }
}

class FakeWindow {
  innerWidth = 390
  navigator = { maxTouchPoints: 1 }
  readonly listeners = new Set<() => void>()
  addEventListener(_type: string, listener: () => void): void { this.listeners.add(listener) }
  removeEventListener(_type: string, listener: () => void): void { this.listeners.delete(listener) }
  resize(): void { for (const listener of [...this.listeners]) listener() }
}

function tabTree() {
  const panel = new FakeElement({ 'data-sidebar-right-panel': 'fullscreen' })
  const strip = new FakeElement({ 'data-dockkit-strip': 'pane-a' })
  const tabs = new FakeElement({ 'data-dockkit-strip-tabs': 'pane-a' })
  const tab = new FakeElement({ 'data-dockkit-tab': 'tab-a' })
  const title = new FakeElement()
  const close = new FakeElement({ 'data-dockkit-tab-close': 'tab-a' })
  const chrome = new FakeElement({ 'data-sidebar-right-toggle': '' })
  const body = new FakeElement()
  panel.appendChild(strip)
  panel.appendChild(body)
  strip.appendChild(tabs)
  strip.appendChild(chrome)
  tabs.appendChild(tab)
  tab.appendChild(title)
  tab.appendChild(close)
  return { panel, strip, tabs, tab, title, close, chrome, body }
}

function pointer(document: FakeDocument, target: FakeElement, pointerType = 'touch') {
  const event = {
    target, pointerType, stopped: false, prevented: false,
    stopPropagation() { this.stopped = true },
    preventDefault() { this.prevented = true },
  }
  document.emit('pointerdown', event)
  // 模拟上游冒泡阶段的拖拽启动；只有未被捕获层阻止的 press 才能进入。
  if (!event.stopped) target.drags += 1
  return event
}

function harness() {
  const document = new FakeDocument()
  const window = new FakeWindow()
  const controller = startMobileRightbarTabsDom({ document: document as unknown as Document, window })
  return { document, window, controller }
}

test('触摸标签及标题只阻断排序链路，保留浏览器原生滚动默认动作', (t) => {
  const { document, controller } = harness()
  t.after(() => controller.dispose())
  const tree = tabTree()
  for (const target of [tree.tabs, tree.tab, tree.title, tree.close]) {
    const event = pointer(document, target)
    assert.equal(event.stopped, true)
    assert.equal(event.prevented, false)
    assert.equal(target.drags, 0)
  }
  const style = [...document.head.children][0]
  assert.equal(style?.id, MOBILE_RIGHTBAR_TABS_STYLE_ID)
  assert.equal(document.documentElement.getAttribute(MOBILE_RIGHTBAR_TABS_ATTRIBUTE), 'on')
  // 三层 touch-action 必须全部放开，祖先的 none 也会阻止浏览器横向滚动。
  assert.match(style?.textContent ?? '', /\[data-dockkit-strip\],[\s\S]*\[data-dockkit-strip-tabs\],[\s\S]*\[data-dockkit-tab\][\s\S]*touch-action: pan-x !important/u)
})

test('标签短触摸的后续 click 及关闭按钮 click 不被拦截', (t) => {
  const { document, controller } = harness()
  t.after(() => controller.dispose())
  const tree = tabTree()
  for (const target of [tree.tab, tree.close]) {
    assert.equal(pointer(document, target).prevented, false)
    let blocked = false
    document.emit('click', { target, preventDefault: () => { blocked = true }, stopPropagation: () => { blocked = true } })
    if (!blocked) target.clicks += 1
    assert.equal(target.clicks, 1)
  }
  assert.equal(document.listenerCount('click'), 0)
})

test('移动视口下鼠标与手写笔仍进入原生标签拖拽', (t) => {
  const { document, controller } = harness()
  t.after(() => controller.dispose())
  for (const type of ['mouse', 'pen']) {
    const { tab } = tabTree()
    const event = pointer(document, tab, type)
    assert.equal(event.stopped, false)
    assert.equal(event.prevented, false)
    assert.equal(tab.drags, 1)
  }
})

test('右栏尾部控件、正文与其他位置的标签不受触摸拦截影响', (t) => {
  const { document, controller } = harness()
  t.after(() => controller.dispose())
  const tree = tabTree()
  const otherTabs = new FakeElement({ 'data-dockkit-strip-tabs': 'outside' })
  const otherTab = new FakeElement({ 'data-dockkit-tab': 'outside' })
  otherTabs.appendChild(otherTab)
  for (const target of [tree.chrome, tree.body, otherTab]) {
    assert.equal(pointer(document, target).stopped, false)
  }
})

test('会话切换后新建的标签条自动适配，refresh 不重复创建监听与样式', (t) => {
  const { document, controller } = harness()
  t.after(() => controller.dispose())
  assert.equal(pointer(document, tabTree().tab).stopped, true)
  assert.equal(controller.refresh(), true)
  assert.equal(controller.refresh(), true)
  assert.equal(document.listenerCount('pointerdown'), 1)
  assert.equal(document.head.children.size, 1)
})

test('宽屏、无触摸能力和无效视口不安装适配', () => {
  for (const [width, touchPoints] of [[1440, 1], [390, 0], [0, 1], [Number.NaN, 1]]) {
    const document = new FakeDocument()
    const window = new FakeWindow()
    window.innerWidth = width!
    window.navigator.maxTouchPoints = touchPoints!
    const controller = startMobileRightbarTabsDom({ document: document as unknown as Document, window })
    assert.equal(controller.refresh(), false)
    assert.equal(document.documentElement.getAttribute(MOBILE_RIGHTBAR_TABS_ATTRIBUTE), null)
    assert.equal(document.head.children.size, 0)
    assert.equal(document.listenerCount('pointerdown'), 0)
    controller.dispose()
  }
})

test('视口上限设置与横竖屏变化即时启停并恢复原生样式', (t) => {
  const document = new FakeDocument()
  const window = new FakeWindow()
  window.innerWidth = 700
  let maxPx = 1024
  const controller = startMobileRightbarTabsDom({ document: document as unknown as Document, window, mobileViewportMaxPx: () => maxPx })
  t.after(() => controller.dispose())
  assert.equal(controller.refresh(), true)
  maxPx = 500
  assert.equal(controller.refresh(), false)
  assert.equal(document.head.children.size, 0)
  assert.equal(document.listenerCount('pointerdown'), 0)
  assert.equal(document.documentElement.getAttribute(MOBILE_RIGHTBAR_TABS_ATTRIBUTE), null)

  window.innerWidth = 390
  window.resize()
  assert.equal(pointer(document, tabTree().tab).stopped, true)
  window.innerWidth = 1280
  window.resize()
  assert.equal(pointer(document, tabTree().tab).stopped, false)
  assert.equal(document.head.children.size, 0)
})

test('dispose 完整清理，后续 resize 与 refresh 不会重新启用', () => {
  const { document, window, controller } = harness()
  controller.dispose()
  controller.dispose()
  window.resize()
  assert.equal(controller.refresh(), false)
  assert.equal(document.listenerCount('pointerdown'), 0)
  assert.equal(window.listeners.size, 0)
  assert.equal(document.head.children.size, 0)
  assert.equal(document.documentElement.getAttribute(MOBILE_RIGHTBAR_TABS_ATTRIBUTE), null)
})
