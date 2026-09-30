import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isMobileSettingsViewport,
  MOBILE_SETTINGS_MODAL_ATTRIBUTE,
  MOBILE_SETTINGS_MODAL_STYLE_ID,
  startMobileSettingsModalDom,
} from '../data/build/dist/client/mobile-settings-modal-dom.js'

test('设置弹窗移动端视口判定遵守上限并拒绝非法值', () => {
  assert.equal(isMobileSettingsViewport(390, 1024), true)
  assert.equal(isMobileSettingsViewport(1024, 1024), true)
  assert.equal(isMobileSettingsViewport(1025, 1024), false)
  assert.equal(isMobileSettingsViewport(0, 1024), false)
  assert.equal(isMobileSettingsViewport(Number.NaN, 1024), false)
})

test('设置弹窗控制器只在窄屏标记宿主节点，停用后完全清理', () => {
  const dom = new FakeDocument()
  const panel = new FakeElement('div')
  panel.setAttribute('data-shortcut-modal', 'settings')
  dom.body.append(panel)

  const controller = startMobileSettingsModalDom({
    document: dom as unknown as Document,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver as unknown as typeof MutationObserver,
  })
  assert.equal(panel.getAttribute(MOBILE_SETTINGS_MODAL_ATTRIBUTE), 'on')
  assert.equal(dom.styleTags().some((tag) => tag.dataset.pluginCss === MOBILE_SETTINGS_MODAL_STYLE_ID), true)

  controller.dispose()
  assert.equal(panel.hasAttribute(MOBILE_SETTINGS_MODAL_ATTRIBUTE), false)
  assert.equal(dom.styleTags().length, 0)

  const desktop = new FakeDocument()
  const desktopPanel = new FakeElement('div')
  desktopPanel.setAttribute('data-shortcut-modal', 'settings')
  desktop.body.append(desktopPanel)
  const desktopController = startMobileSettingsModalDom({
    document: desktop as unknown as Document,
    window: { innerWidth: 1440 },
    MutationObserver: FakeObserver as unknown as typeof MutationObserver,
  })
  assert.equal(desktopPanel.hasAttribute(MOBILE_SETTINGS_MODAL_ATTRIBUTE), false)
  assert.equal(desktop.styleTags().length, 0)
  desktopController.dispose()
})

test('关闭移动端设置优化时不注入设置弹窗样式', () => {
  const dom = new FakeDocument()
  const panel = new FakeElement('div')
  panel.setAttribute('data-shortcut-modal', 'settings')
  dom.body.append(panel)

  const controller = startMobileSettingsModalDom({
    document: dom as unknown as Document,
    window: { innerWidth: 390 },
    enabled: () => false,
    MutationObserver: FakeObserver as unknown as typeof MutationObserver,
  })
  assert.equal(panel.hasAttribute(MOBILE_SETTINGS_MODAL_ATTRIBUTE), false)
  assert.equal(dom.styleTags().length, 0)
  controller.dispose()
})

class FakeElement {
  readonly tagName: string
  readonly dataset: Record<string, string> = {}
  readonly children: FakeElement[] = []
  parent: FakeElement | null = null
  private readonly attributes = new Map<string, string>()

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this
      this.children.push(node)
    }
  }

  appendChild(node: FakeElement): FakeElement {
    this.append(node)
    return node
  }

  remove(): void {
    if (this.parent === null) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  removeAttribute(name: string): void { this.attributes.delete(name) }

  querySelectorAll(selector: string): FakeElement[] { return findAll(this, selector) }
}

class FakeDocument {
  readonly documentElement = new FakeElement('html')
  readonly head = new FakeElement('head')
  readonly body = new FakeElement('body')

  constructor() { this.documentElement.append(this.head, this.body) }
  createElement(tagName: string): FakeElement { return new FakeElement(tagName) }
  querySelectorAll(selector: string): FakeElement[] { return findAll(this.documentElement, selector) }
  styleTags(): FakeElement[] { return this.head.children.filter((child) => child.tagName === 'STYLE') }
}

class FakeObserver {
  constructor(_callback: () => void) {}
  observe(_target: unknown, _options: unknown): void {}
  disconnect(): void {}
}

function findAll(root: FakeElement, selector: string): FakeElement[] {
  const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector)
  const found: FakeElement[] = []
  const visit = (node: FakeElement): void => {
    for (const child of node.children) {
      if (match === null) {
        if (child.tagName === selector.toUpperCase()) found.push(child)
      } else {
        const [, name, value] = match
        if (name !== undefined && (value === undefined ? child.hasAttribute(name) : child.getAttribute(name) === value)) found.push(child)
      }
      visit(child)
    }
  }
  visit(root)
  return found
}
