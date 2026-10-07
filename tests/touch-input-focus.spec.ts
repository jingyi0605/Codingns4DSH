import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldGuardTouchInput, startTouchInputFocusGuard } from '../data/build/dist/client/touch-input-focus.js'

class FakeEventTarget {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string, event: unknown): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event) }
}

/** 用原生方法计数验证拦截发生在 focus 调用之前，并模拟真实 focusin/focusout 时序。 */
function createHarness(width = 1366, agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15', points = 5) {
  const document = Object.assign(new FakeEventTarget(), { activeElement: null as FakeElement | null })
  class FakeElement {
    readonly ownerDocument = document
    readonly children: FakeElement[] = []
    control: FakeElement | null = null
    focusCount = 0
    blurCount = 0
    focusOptions: FocusOptions | undefined
    disabled = false
    readOnly = false
    readonly tagName: string
    readonly attrs: Record<string, string>
    readonly parentElement: FakeElement | null
    constructor(tagName = 'DIV', attrs: Record<string, string> = {}, parentElement: FakeElement | null = null) {
      this.tagName = tagName
      this.attrs = attrs
      this.parentElement = parentElement
      parentElement?.children.push(this)
    }
    getAttribute(name: string): string | null { return this.attrs[name] ?? null }
    matches(selector: string): boolean {
      if (selector.startsWith('.')) return (this.attrs.class ?? '').split(' ').includes(selector.slice(1))
      const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector)
      if (attribute) return attribute[2] === undefined ? this.attrs[attribute[1]!] !== undefined : this.attrs[attribute[1]!] === attribute[2]
      return this.tagName.toLowerCase() === selector
    }
    closest(selector: string): FakeElement | null {
      for (let node: FakeElement | null = this; node !== null; node = node.parentElement) {
        if (selector.split(',').some((part) => node!.matches(part.trim()))) return node
      }
      return null
    }
    querySelector(selector: string): FakeElement | null {
      const [tag, className] = selector.split('.')
      return this.children.find((child) => child.tagName.toLowerCase() === tag && child.matches('.' + className)) ?? null
    }
    focus(options?: FocusOptions): void {
      this.focusCount += 1
      this.focusOptions = options
      if (document.activeElement === this) return
      const previous = document.activeElement
      document.activeElement = this
      if (previous !== null) document.emit('focusout', { target: previous, relatedTarget: this })
      document.emit('focusin', { target: this })
    }
    blur(): void {
      this.blurCount += 1
      if (document.activeElement !== this) return
      document.activeElement = null
      document.emit('focusout', { target: this, relatedTarget: null })
    }
  }
  const window = Object.assign(new FakeEventTarget(), { innerWidth: width, navigator: { userAgent: agent, maxTouchPoints: points }, HTMLElement: FakeElement })
  const original = FakeElement.prototype.focus
  const controller = startTouchInputFocusGuard({ window, document })
  const tap = (target: FakeElement, type = 'pointerdown') => document.emit(type, { target, isTrusted: true })
  return { document, window, Element: FakeElement, controller, original, tap }
}

test('iPad 横屏和桌面模式不受 1024px 限制，普通 Mac 与宽屏触摸 PC 保留原生行为', () => {
  const window = { innerWidth: 1366, navigator: { userAgent: 'iPad', maxTouchPoints: 5 } }
  assert.equal(shouldGuardTouchInput(window), true)
  window.navigator.userAgent = 'Macintosh'
  assert.equal(shouldGuardTouchInput(window), true)
  window.navigator.maxTouchPoints = 0
  assert.equal(shouldGuardTouchInput(window), false)
  window.navigator.userAgent = 'Windows NT'
  window.navigator.maxTouchPoints = 5
  assert.equal(shouldGuardTouchInput(window), false)
})

test('会话恢复及弹窗自动 focus 在调用原生方法前被拒绝，普通按钮仍可聚焦', (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  for (const input of [new h.Element('INPUT'), new h.Element('TEXTAREA'), new h.Element('DIV', { contenteditable: 'true' })]) {
    input.focus()
    assert.equal(input.focusCount, 0)
  }
  const button = new h.Element('BUTTON')
  h.tap(button)
  button.focus({ preventScroll: true })
  assert.equal(button.focusCount, 1)
  assert.deepEqual(button.focusOptions, { preventScroll: true })
  const dialogInput = new h.Element('INPUT')
  dialogInput.focus()
  assert.equal(dialogInput.focusCount, 0)
  h.tap(dialogInput)
  dialogInput.focus()
  assert.equal(h.document.activeElement, dialogInput)
})

test('真实点按文本框、搜索框、对话框及可编辑子文本都允许输入，授权只属于同一个组件', (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  for (const input of [new h.Element('INPUT'), new h.Element('INPUT', { type: 'search' }), new h.Element('TEXTAREA'), new h.Element('DIV', { contenteditable: 'plaintext-only' })]) {
    h.tap(input, 'touchstart')
    input.focus()
    assert.equal(h.document.activeElement, input)
    const other = new h.Element('INPUT')
    other.focus()
    assert.equal(other.focusCount, 0)
    input.blur()
  }
  const editor = new h.Element('DIV', { contenteditable: 'true' })
  const text = new h.Element('SPAN', {}, editor)
  h.tap(text)
  editor.focus({ preventScroll: true })
  assert.equal(h.document.activeElement, editor)
})

test('点击输入框标签允许对应输入，脚本合成的点击不能授权', (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  const input = new h.Element('INPUT')
  h.document.emit('pointerdown', { target: input, isTrusted: false })
  h.document.emit('click', { target: input, isTrusted: false })
  input.focus()
  assert.equal(input.focusCount, 0)
  const label = new h.Element('LABEL')
  label.control = input
  h.tap(label, 'click')
  input.focus()
  assert.equal(h.document.activeElement, input)
})

test('添加、权限和发送按钮保留原有点击链路，但不得重新唤起 Composer 键盘', (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  const card = new h.Element('DIV', { 'data-composer-card': '' })
  const input = new h.Element('DIV', { contenteditable: 'true', 'data-composer-input': 'true' }, card)
  const button = new h.Element('BUTTON', {}, card)
  h.tap(input)
  input.focus()
  h.tap(button)
  assert.equal(input.blurCount, 0)
  input.focus()
  assert.equal(input.focusCount, 1)
  input.blur()
  h.tap(button, 'click')
  input.focus()
  assert.equal(h.document.activeElement, null)
})

test('编辑器内部不可编辑按钮不会继承外层输入许可，按钮原生焦点不受影响', (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  const editor = new h.Element('DIV', { contenteditable: 'true' })
  const decorator = new h.Element('SPAN', { contenteditable: 'false' }, editor)
  const button = new h.Element('BUTTON', {}, decorator)
  h.tap(button)
  button.focus()
  editor.focus()
  assert.equal(button.focusCount, 1)
  assert.equal(editor.focusCount, 0)
})

test('失焦、非输入区点按及许可过期后都需要再次直接点击输入框', (t) => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const h = createHarness()
  t.after(() => h.controller.dispose())
  const input = new h.Element('INPUT')
  h.tap(input)
  input.focus()
  input.blur()
  input.focus()
  assert.equal(input.focusCount, 1)
  h.tap(input)
  h.tap(new h.Element('DIV'))
  input.focus()
  assert.equal(input.focusCount, 1)
  h.tap(input)
  now += 701
  input.focus()
  assert.equal(input.focusCount, 1)
})

test('原生 autofocus 立即失焦，迟到微任务不撤销之后真实点击的输入焦点', async (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  const input = new h.Element('INPUT')
  h.original.call(input)
  assert.equal(h.document.activeElement, null)
  assert.equal(input.blurCount, 1)
  h.tap(input)
  input.focus()
  await Promise.resolve()
  assert.equal(h.document.activeElement, input)
  assert.equal(input.blurCount, 1)
})

test('触摸轻微抖动保留点击许可，滚动、拖动及取消不会授权自动输入', (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  const input = new h.Element('TEXTAREA')
  const touch = (x: number) => ({ target: input, isTrusted: true, touches: [{ clientX: x, clientY: 10 }] })
  h.document.emit('touchstart', touch(10))
  h.document.emit('touchmove', touch(11))
  input.focus()
  assert.equal(input.focusCount, 1)
  input.blur()
  h.document.emit('touchstart', touch(10))
  h.document.emit('touchmove', touch(30))
  input.focus()
  assert.equal(input.focusCount, 1)
  h.tap(input)
  h.document.emit('touchcancel', {})
  input.focus()
  assert.equal(input.focusCount, 1)
})

test('终端自动恢复不能聚焦隐藏输入，明确点按终端文字面板仍可输入', (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  const terminal = new h.Element('DIV', { class: 'xterm' })
  const screen = new h.Element('DIV', { class: 'xterm-screen' }, terminal)
  const canvas = new h.Element('CANVAS', {}, screen)
  const input = new h.Element('TEXTAREA', { class: 'xterm-helper-textarea' }, terminal)
  input.focus()
  assert.equal(input.focusCount, 0)
  h.tap(canvas)
  input.focus()
  assert.equal(h.document.activeElement, input)
})

test('切到后台撤销许可，普通桌面无需保护，销毁后恢复原生方法和全部监听', (t) => {
  const h = createHarness()
  t.after(() => h.controller.dispose())
  const input = new h.Element('INPUT')
  h.tap(input)
  input.focus()
  h.window.emit('blur', {})
  input.focus()
  assert.equal(h.document.activeElement, null)
  assert.equal(input.focusCount, 1)
  h.controller.dispose()
  assert.equal(h.Element.prototype.focus, h.original)
  assert.ok([...h.document.listeners.values()].every((listeners) => listeners.size === 0))
  assert.ok([...h.window.listeners.values()].every((listeners) => listeners.size === 0))
  input.focus()
  assert.equal(input.focusCount, 2)
  const desktop = createHarness(1366, 'Macintosh', 0)
  t.after(() => desktop.controller.dispose())
  assert.equal(desktop.Element.prototype.focus, desktop.original)
  assert.equal(desktop.document.listeners.size, 0)
  const desktopInput = new desktop.Element('INPUT')
  desktopInput.focus()
  assert.equal(desktop.document.activeElement, desktopInput)
})

test('手机退出窄屏时恢复原生 focus，iPad 横竖屏切换始终保留保护', (t) => {
  for (const [agent, guardedAfterResize] of [['Android', false], ['Macintosh', true]] as const) {
    const h = createHarness(390, agent)
    t.after(() => h.controller.dispose())
    const input = new h.Element('INPUT')
    h.window.innerWidth = 1366
    h.window.emit('resize', {})
    input.focus()
    assert.equal(input.focusCount, guardedAfterResize ? 0 : 1)
  }
})
