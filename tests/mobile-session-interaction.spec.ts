import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isShortMobileTap,
  startMobileSessionInteractionDom,
} from '../data/build/dist/client/mobile-session-interaction.js'
import { startMobileSidebarGestures } from '../data/build/dist/client/mobile-sidebar-gestures.js'
import {
  MOBILE_RIGHTBAR_VISIBILITY_ATTRIBUTE,
  notifyMobileRightbarManualOpen,
} from '../data/build/dist/client/mobile-rightbar-visibility.js'

class FakeElement {
  readonly children = new Set<FakeElement>()
  blurCount = 0
  clickCount = 0
  id = ''
  textContent = ''
  readonly attrs: Record<string, string | null>
  readonly parent: FakeElement | null
  constructor(attrs: Record<string, string | null> = {}, parent: FakeElement | null = null) {
    this.attrs = attrs
    this.parent = parent
    parent?.children.add(this)
  }
  closest(selector: string): FakeElement | null {
    for (let current: FakeElement | null = this; current !== null; current = current.parent) {
      if (selector === '[data-composer-input="true"]' && current.attrs['data-composer-input'] === 'true') return current
      if (selector === '[data-composer-card]' && current.attrs['data-composer-card'] !== undefined) return current
      if (selector === '[data-sidebar-right-expand]' && current.attrs['data-sidebar-right-expand'] !== undefined) return current
      if (selector === '[data-sidebar-right-toggle]' && current.attrs['data-sidebar-right-toggle'] !== undefined) return current
      if (selector === '[role="treeitem"][aria-selected]' && current.attrs.role === 'treeitem' && current.attrs['aria-selected'] !== undefined) return current
      if (selector === 'button, a, input, textarea, select, [contenteditable="true"]' && current.attrs.control === 'true') return current
    }
    return null
  }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null }
  setAttribute(name: string, value: string): void { this.attrs[name] = value }
  removeAttribute(name: string): void { delete this.attrs[name] }
  appendChild(child: FakeElement): void { this.children.add(child) }
  remove(): void { this.parent?.children.delete(this) }
  contains(node: unknown): boolean {
    if (node === this) return true
    return node instanceof FakeElement && (node.parent === this || this.children.has(node) || [...this.children].some((child) => child.contains(node)))
  }
  blur(): void { this.blurCount += 1 }
  click(): void { this.clickCount += 1 }
}

class FakeWindow {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  innerWidth = 390
  navigator = { maxTouchPoints: 1 }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  activeElement: FakeElement | null = null
  readonly documentElement = new FakeElement()
  readonly head = new FakeElement()
  readonly expandButton = new FakeElement({ 'data-sidebar-right-expand': '', 'aria-keyshortcuts': 'Control+Shift+Y' })
  readonly sessionView = new FakeElement({ 'data-sidebar-right-session': 'session-a' })
  createElement(): FakeElement { return new FakeElement({}, this.head) }
  querySelector(selector: string): FakeElement | null {
    if (selector === '[data-sidebar-right-expand], [data-sidebar-right-toggle]') return this.expandButton
    if (selector === '[data-sidebar-right-session]:not([data-sidebar-right-panel]):not([hidden])') return this.sessionView
    return null
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
  dispatchEvent(event: Event): boolean { this.emit(event.type, event); return true }
}

class FakeMutationObserver {
  disconnected = false
  readonly callback: () => void
  constructor(callback: () => void) { this.callback = callback }
  observe(): void {}
  disconnect(): void { this.disconnected = true }
  commit(): void { if (!this.disconnected) this.callback() }
}

/** 模拟挂载通知先到、Store 与 React 的 DOM 提交随后到达的真实时序。 */
function createRightbarHarness(width = 390) {
  const window = new FakeWindow()
  window.innerWidth = width
  const document = new FakeDocument()
  const mountedListeners = new Set<() => void>()
  const observers: FakeMutationObserver[] = []
  let expanded = false
  let available = true
  let toggleCount = 0
  const sidebarRight = {
    isExpanded: () => available && expanded,
    toggleExpanded: () => {
      if (!available) throw new Error('sidebarRight: no session surface is mounted')
      expanded = !expanded
      toggleCount += 1
    },
    mounted: {
      listeners: mountedListeners,
      subscribe(listener: () => void) {
        // 原生 ObservableSnapshot 可能依赖接收者，不能把 subscribe 拆出来调用。
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    },
  }
  class Observer extends FakeMutationObserver {
    constructor(callback: () => void) { super(callback); observers.push(this) }
  }
  const controller = startMobileSessionInteractionDom({
    window, document, sidebarRight, MutationObserver: Observer as unknown as typeof MutationObserver,
  })
  return {
    window, document, sidebarRight, controller, observers, mountedListeners,
    get expanded() { return expanded },
    set expanded(value: boolean) { expanded = value },
    get available() { return available },
    set available(value: boolean) { available = value },
    get toggleCount() { return toggleCount },
    get visibility() { return document.documentElement.getAttribute(MOBILE_RIGHTBAR_VISIBILITY_ATTRIBUTE) },
    commit() { for (const observer of observers) observer.commit() },
    mount() { for (const listener of [...mountedListeners]) listener() },
    openManually() {
      document.emit('click', { target: document.expandButton, isTrusted: true })
      expanded = true
      this.commit()
    },
  }
}

test('移动端短触摸只触发一次会话点击，并屏蔽双击重命名', () => {
  const row = new FakeElement({ role: 'treeitem', 'aria-selected': 'false' })
  const title = new FakeElement({}, row)
  const window = new FakeWindow()
  const document = new FakeDocument()
  const controller = startMobileSessionInteractionDom({ window, document })
  let prevented = 0
  document.emit('touchstart', { target: title, touches: [{ clientX: 10, clientY: 10 }] })
  document.emit('touchend', { target: title, changedTouches: [{ clientX: 11, clientY: 10 }], preventDefault: () => { prevented += 1 } })
  assert.equal(row.clickCount, 1)
  assert.equal(prevented, 1)

  let stopped = 0
  document.emit('click', { target: title, preventDefault: () => { prevented += 1 }, stopImmediatePropagation: () => { stopped += 1 } })
  document.emit('dblclick', { target: title, preventDefault: () => { prevented += 1 }, stopImmediatePropagation: () => { stopped += 1 } })
  assert.equal(row.clickCount, 1)
  assert.equal(stopped, 2)
  controller.dispose()
})

test('Composer 只在用户点按输入框时保留焦点', () => {
  const composer = new FakeElement({ 'data-composer-input': 'true' })
  const row = new FakeElement({ role: 'treeitem', 'aria-selected': 'false' })
  const title = new FakeElement({}, row)
  const window = new FakeWindow()
  const document = new FakeDocument()
  const controller = startMobileSessionInteractionDom({ window, document })
  document.activeElement = composer
  document.emit('touchstart', { target: title, touches: [{ clientX: 10, clientY: 10 }] })
  document.emit('focusin', { target: composer })
  assert.ok(composer.blurCount >= 2)

  const before = composer.blurCount
  document.emit('touchstart', { target: composer, touches: [{ clientX: 20, clientY: 20 }] })
  document.emit('focusin', { target: composer })
  assert.equal(composer.blurCount, before)
  controller.dispose()
})

test('点击 Composer 内的添加按钮不应被全局失焦逻辑拦截', () => {
  const composerSurface = new FakeElement({ 'data-composer-card': '' })
  const composerInput = new FakeElement({ 'data-composer-input': 'true' }, composerSurface)
  const addButton = new FakeElement({ control: 'true' }, composerSurface)
  const window = new FakeWindow()
  const document = new FakeDocument()
  const controller = startMobileSessionInteractionDom({ window, document })
  document.activeElement = composerInput

  document.emit('pointerdown', { target: addButton })
  document.emit('touchstart', { target: addButton, touches: [{ clientX: 20, clientY: 20 }] })

  assert.equal(composerInput.blurCount, 0)
  controller.dispose()
})

test('短触摸判定拒绝长按与滑动', () => {
  const target = new FakeElement()
  assert.equal(isShortMobileTap({ point: { x: 10, y: 10, target }, at: 100 }, { point: { x: 11, y: 10, target }, at: 200 }), true)
  assert.equal(isShortMobileTap({ point: { x: 10, y: 10, target }, at: 100 }, { point: { x: 11, y: 10, target }, at: 900 }), false)
  assert.equal(isShortMobileTap({ point: { x: 10, y: 10, target }, at: 100 }, { point: { x: 30, y: 10, target }, at: 200 }), false)
})

test('移动端切换会话后收起右栏，桌面端不注册该逻辑', () => {
  let expanded = false
  let toggleCount = 0
  let mountedListener: (() => void) | undefined
  const sidebarRight = {
    isExpanded: () => expanded,
    toggleExpanded: () => { expanded = !expanded; toggleCount += 1 },
    mounted: {
      subscribe: (listener: () => void) => {
        mountedListener = listener
        return () => { mountedListener = undefined }
      },
    },
  }
  const mobileWindow = new FakeWindow()
  const mobileDocument = new FakeDocument()
  const mobileController = startMobileSessionInteractionDom({ window: mobileWindow, document: mobileDocument, sidebarRight })
  expanded = true
  mountedListener?.()
  assert.equal(expanded, false)
  assert.equal(toggleCount, 1)
  mobileController.dispose()

  const desktopWindow = new FakeWindow()
  desktopWindow.innerWidth = 1280
  const desktopDocument = new FakeDocument()
  expanded = true
  toggleCount = 0
  mountedListener = undefined
  const desktopController = startMobileSessionInteractionDom({ window: desktopWindow, document: desktopDocument, sidebarRight })
  mountedListener?.()
  assert.equal(expanded, true)
  assert.equal(toggleCount, 0)
  desktopController.dispose()
})

test('新建或切换会话后，晚到且重复的标签恢复都不能自动展开右栏', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const harness = createRightbarHarness()
  t.after(() => harness.controller.dispose())
  harness.available = false
  harness.mount()
  assert.equal(harness.visibility, 'blocked')

  // 远端工作区读取超过旧实现的 240ms 重试窗口后，Git 标签才恢复。
  setTimeout(() => {
    harness.available = true
    harness.expanded = true
    harness.commit()
  }, 1_000)
  t.mock.timers.tick(1_000)
  assert.equal(harness.expanded, false)
  assert.equal(harness.toggleCount, 1)
  assert.equal(harness.visibility, 'blocked')

  harness.expanded = true
  harness.commit()
  assert.equal(harness.expanded, false)
  assert.equal(harness.toggleCount, 2)
})

test('手动按钮呼出保持显示，原生关闭后即使同一轮恢复标签也不能重新展开', (t) => {
  const harness = createRightbarHarness()
  t.after(() => harness.controller.dispose())
  harness.openManually()
  harness.commit()
  assert.equal(harness.expanded, true)
  assert.equal(harness.visibility, 'allowed')
  assert.equal(harness.toggleCount, 0)

  const closeButton = new FakeElement({ 'data-sidebar-right-toggle': '' })
  harness.document.emit('click', { target: closeButton, isTrusted: true })
  assert.equal(harness.visibility, 'blocked')
  // 宿主先关闭，后台任务同一轮又展开；显示许可仍应被撤销。
  harness.expanded = false
  harness.expanded = true
  harness.commit()
  assert.equal(harness.expanded, false)
})

test('有效手势先授予许可再展开，反向手势关闭后后台恢复仍被阻止', (t) => {
  const harness = createRightbarHarness()
  const gestures = startMobileSidebarGestures({
    window: harness.window,
    document: harness.document,
    ports: { sidebarRight: harness.sidebarRight },
    settings: () => ({ sidebarGestures: true, sidebarGestureMapping: 'swipe-inward', sidebarGestureEdge: 'avoid', sidebarGestureDistancePercent: 40 }),
    onRightbarOpen: () => notifyMobileRightbarManualOpen(harness.document),
  })
  t.after(() => { gestures.dispose(); harness.controller.dispose() })
  const touch = (x: number, timeStamp: number) => ({ touches: [{ clientX: x, clientY: 300 }], timeStamp })
  harness.window.emit('touchstart', touch(300, 0))
  harness.window.emit('touchmove', touch(280, 10))
  assert.equal(harness.visibility, 'blocked')
  harness.window.emit('touchmove', touch(70, 50))
  assert.equal(harness.visibility, 'allowed')
  harness.commit()
  assert.equal(harness.expanded, true)
  assert.equal(harness.toggleCount, 1)

  harness.window.emit('touchend', {})
  harness.window.emit('touchstart', touch(70, 100))
  harness.window.emit('touchmove', touch(300, 150))
  harness.commit()
  assert.equal(harness.expanded, false)
  assert.equal(harness.visibility, 'blocked')
  harness.expanded = true
  harness.commit()
  assert.equal(harness.expanded, false)
})

test('手动呼出只对当前会话有效，新建、切换和 Store 延迟接管都撤销许可', (t) => {
  const harness = createRightbarHarness()
  t.after(() => harness.controller.dispose())
  harness.openManually()
  harness.mount()
  assert.equal(harness.expanded, false)
  assert.equal(harness.visibility, 'blocked')

  harness.openManually()
  harness.available = false
  harness.mount()
  harness.available = true
  harness.expanded = true
  harness.commit()
  assert.equal(harness.expanded, false)
  assert.equal(harness.visibility, 'blocked')
})

test('会话通知缺失时仍通过可见 SessionView 的 DOM 变化撤销旧许可', (t) => {
  const harness = createRightbarHarness()
  t.after(() => harness.controller.dispose())
  harness.openManually()
  // 模拟 mounted 通知未发出；仅可见会话根节点改变。
  harness.document.sessionView.setAttribute('data-sidebar-right-session', 'session-b')
  harness.expanded = true
  harness.commit()
  assert.equal(harness.expanded, false)
  assert.equal(harness.visibility, 'blocked')
})

test('普通鼠标切换会话也收起右栏，会话菜单控件保留当前显示', (t) => {
  const harness = createRightbarHarness()
  t.after(() => harness.controller.dispose())
  const row = new FakeElement({ role: 'treeitem', 'aria-selected': 'false' })
  const menu = new FakeElement({ control: 'true' }, row)
  harness.openManually()
  harness.document.emit('click', { target: menu, isTrusted: true })
  assert.equal(harness.expanded, true)
  harness.document.emit('click', { target: row, isTrusted: true })
  assert.equal(harness.expanded, false)
  assert.equal(harness.visibility, 'blocked')
})

test('iOS 已被抑制的延迟会话 click 不会撤销随后手动呼出的许可', (t) => {
  const harness = createRightbarHarness()
  t.after(() => harness.controller.dispose())
  const row = new FakeElement({ role: 'treeitem', 'aria-selected': 'false' })
  harness.document.emit('touchstart', { target: row, touches: [{ clientX: 20, clientY: 30 }] })
  harness.document.emit('touchend', { target: row, changedTouches: [{ clientX: 20, clientY: 30 }] })
  // 通过另一条手动路径呼出，避免额外的原生 click 清理延迟点击标记。
  notifyMobileRightbarManualOpen(harness.document)
  harness.expanded = true
  harness.commit()
  let stopped = 0
  harness.document.emit('click', { target: row, isTrusted: true, stopImmediatePropagation: () => { stopped += 1 } })
  assert.equal(stopped, 1)
  assert.equal(harness.expanded, true)
  assert.equal(harness.visibility, 'allowed')
})

test('宿主自定义快捷键可以手动呼出，合成按钮 click 不授予许可', (t) => {
  const harness = createRightbarHarness()
  t.after(() => harness.controller.dispose())
  harness.document.emit('click', { target: harness.document.expandButton, isTrusted: false })
  assert.equal(harness.visibility, 'blocked')
  harness.document.emit('keydown', { key: 'Y', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isTrusted: true })
  assert.equal(harness.visibility, 'blocked')
  harness.document.emit('keydown', { key: 'Y', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isTrusted: true })
  harness.expanded = true
  harness.commit()
  assert.equal(harness.expanded, true)
  assert.equal(harness.visibility, 'allowed')
})

test('手动呼出未被宿主执行时，不会遗留许可给后续后台恢复', async (t) => {
  const harness = createRightbarHarness()
  t.after(() => harness.controller.dispose())
  harness.document.emit('click', { target: harness.document.expandButton, isTrusted: true })
  assert.equal(harness.visibility, 'allowed')
  // 模拟模态窗口或失效的 Store 拦截了宿主动作。
  await Promise.resolve()
  assert.equal(harness.visibility, 'blocked')
  harness.expanded = true
  harness.commit()
  assert.equal(harness.expanded, false)
})

test('退出移动视口或销毁控制器会移除样式、观察器与会话订阅，重新进入默认收起', (t) => {
  const harness = createRightbarHarness(1280)
  t.after(() => harness.controller.dispose())
  assert.equal(harness.document.head.children.size, 0)
  assert.equal(harness.mountedListeners.size, 0)
  assert.equal(harness.observers.length, 0)
  harness.expanded = true
  harness.mount()
  assert.equal(harness.expanded, true)

  harness.window.innerWidth = 390
  harness.window.emit('resize', {})
  assert.equal(harness.expanded, false)
  assert.equal(harness.visibility, 'blocked')
  assert.equal(harness.document.head.children.size, 1)
  harness.openManually()
  harness.window.innerWidth = 1280
  harness.window.emit('resize', {})
  assert.equal(harness.expanded, true)
  assert.equal(harness.visibility, null)
  assert.equal(harness.document.head.children.size, 0)
  assert.equal(harness.mountedListeners.size, 0)
  assert.equal(harness.observers[0]?.disconnected, true)

  harness.window.innerWidth = 390
  harness.window.emit('resize', {})
  assert.equal(harness.expanded, false)
  harness.controller.dispose()
  assert.equal(harness.visibility, null)
  assert.equal(harness.document.head.children.size, 0)
  assert.equal(harness.mountedListeners.size, 0)
  assert.equal(harness.observers[1]?.disconnected, true)
})
