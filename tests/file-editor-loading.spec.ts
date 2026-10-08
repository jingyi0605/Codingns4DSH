import assert from 'node:assert/strict'
import test from 'node:test'
import { startFileManagementDom } from '../src/client/file-management-dom.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** 只模拟预览需要的节点和事件，不加载浏览器或 CodeMirror。 */
class ElementStub extends EventTarget {
  readonly children: ElementStub[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string> = {}
  parentElement: ElementStub | null = null
  isConnected = true
  disabled = false
  textContent = ''
  readonly tagName: string
  constructor(tagName = 'div') { super(); this.tagName = tagName }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  removeAttribute(name: string) { this.attributes.delete(name) }
  append(...elements: ElementStub[]) { for (const element of elements) { element.parentElement = this; this.children.push(element) } }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1)
    this.parentElement = null
  }
  replaceWith(next: ElementStub) { const parent = this.parentElement; this.remove(); parent?.append(next) }
  closest() { return null }
  querySelector(selector: string): ElementStub | null {
    const attribute = /^\[([^=\]]+)/u.exec(selector)?.[1]
    for (const child of this.children) {
      if (attribute ? child.attributes.has(attribute) : child.tagName === selector) return child
      const nested = child.querySelector(selector)
      if (nested) return nested
    }
    return null
  }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')) }
}

function previewFixture(load: () => Promise<any>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const root = new ElementStub()
  root.setAttribute('data-textpreview-url', 'dsh-resource://file/session/session-a/test.ts')
  root.setAttribute('data-textpreview-state', 'text')
  const header = new ElementStub()
  const path = new ElementStub()
  path.setAttribute('data-textpreview-path', 'true')
  header.append(path)
  const body = new ElementStub()
  body.setAttribute('data-textpreview-body', 'true')
  root.append(header, body)
  const document = Object.assign(new EventTarget(), {
    body: new ElementStub(),
    querySelectorAll: () => [root],
    createElement: (tag: string) => new ElementStub(tag),
  })
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true })
  const calls: string[] = []
  const controller = startFileManagementDom({ async call(_channel, endpoint) {
    calls.push(endpoint)
    return { ok: true, value: { content: 'const value = 1' } }
  } }, { fileEditor: true, menuEnhancement: false }, load)
  return { root, body, calls, controller, button: root.querySelector('[data-file-management-edit]')!, dispose() {
    controller.dispose()
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  } }
}

test('文件编辑点击才加载，失败保留预览和错误，重试能创建编辑器', async () => {
  let loads = 0
  let created = 0
  let destroyed = 0
  const fixture = previewFixture(async () => {
    if (++loads === 1) throw new Error('分块下载失败')
    return { createFileEditor(_parent: unknown, content: string, path: string) {
      assert.equal(content, 'const value = 1')
      assert.equal(path, 'test.ts')
      created++
      return { focus() {}, destroy() { destroyed++ } }
    } }
  })
  try {
    assert.equal(loads, 0)
    assert.deepEqual(fixture.calls, [])
    fixture.button.click()
    fixture.button.click()
    await tick()
    assert.equal(loads, 1, '重复点击合并到当前加载')
    assert.notEqual(fixture.body.style.display, 'none')
    const error = fixture.root.querySelector('[data-file-management-load-error]')!
    assert.equal(error.textContent, '分块下载失败')
    assert.equal(error.getAttribute('role'), 'alert')
    error.querySelector('button')!.click()
    await tick()
    assert.equal(created, 1)
    assert.equal(fixture.body.style.display, 'none')
    assert.equal(fixture.root.querySelector('[data-file-management-load-error]'), null)
    fixture.controller.dispose()
    assert.equal(destroyed, 1)
    assert.equal(fixture.body.style.display, '')
  } finally { fixture.dispose() }
})

for (const mode of ['dispose', 'disable', 'close', 'replace']) {
  test(`文件引擎加载期间 ${mode} 后不挂载旧预览`, async () => {
    let resolve!: (engine: any) => void
    let created = 0
    const fixture = previewFixture(() => new Promise((done) => { resolve = done }))
    try {
      fixture.button.click()
      if (mode === 'dispose') fixture.controller.dispose()
      if (mode === 'disable') fixture.controller.setOptions({ fileEditor: false, menuEnhancement: false })
      if (mode === 'close') fixture.root.isConnected = false
      if (mode === 'replace') fixture.root.setAttribute('data-textpreview-url', 'dsh-resource://file/session/session-a/other.ts')
      resolve({ createFileEditor() { created++; return { focus() {}, destroy() {} } } })
      await tick()
      assert.equal(created, 0)
      assert.notEqual(fixture.body.style.display, 'none')
    } finally { fixture.dispose() }
  })
}
