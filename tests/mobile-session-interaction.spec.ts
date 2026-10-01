import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isShortMobileTap,
  startMobileSessionInteractionDom,
} from '../data/build/dist/client/mobile-session-interaction.js'

class FakeElement {
  readonly children = new Set<FakeElement>()
  blurCount = 0
  clickCount = 0
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
      if (selector === '[role="treeitem"][aria-selected]' && current.attrs.role === 'treeitem' && current.attrs['aria-selected'] !== undefined) return current
      if (selector === 'button, a, input, textarea, select, [contenteditable="true"]' && current.attrs.control === 'true') return current
    }
    return null
  }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null }
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
}

class FakeDocument {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  activeElement: FakeElement | null = null
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

test('短触摸判定拒绝长按与滑动', () => {
  const target = new FakeElement()
  assert.equal(isShortMobileTap({ point: { x: 10, y: 10, target }, at: 100 }, { point: { x: 11, y: 10, target }, at: 200 }), true)
  assert.equal(isShortMobileTap({ point: { x: 10, y: 10, target }, at: 100 }, { point: { x: 11, y: 10, target }, at: 900 }), false)
  assert.equal(isShortMobileTap({ point: { x: 10, y: 10, target }, at: 100 }, { point: { x: 30, y: 10, target }, at: 200 }), false)
})
