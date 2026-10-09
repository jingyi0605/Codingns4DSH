import assert from 'node:assert/strict'
import test from 'node:test'
import { startFileManagementDom } from '../src/client/file-management-dom.js'
import { createVirtualSessionId } from '../src/shared/contracts/peer-host.js'

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

function previewFixture(load: () => Promise<any>, sessionId = 'session-a', workspaceRoot?: string) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const root = new ElementStub()
  root.setAttribute('data-textpreview-url', `dsh-resource://file/session/${encodeURIComponent(sessionId)}/test.ts`)
  // 文件树和预览共存时也不能丢弃资源 URL 的会话身份。
  if (workspaceRoot !== undefined) root.closest = (() => ({ querySelector: () => ({ getAttribute: () => workspaceRoot }) })) as never
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
  const payloads: unknown[] = []
  const controller = startFileManagementDom({ async call(_channel, endpoint, payload) {
    calls.push(endpoint)
    payloads.push(payload)
    return { ok: true, value: { content: 'const value = 1' } }
  } }, { fileEditor: true, menuEnhancement: false }, load)
  return { root, body, calls, payloads, controller, button: root.querySelector('[data-file-management-edit]')!, dispose() {
    controller.dispose()
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  } }
}

test('远端编辑器与文件树共存时，读取和保存始终保留资源所属会话', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const sessionId = createVirtualSessionId('peer-a', 'session-a')
  const fixture = previewFixture(async () => ({ createFileEditor() {
    return { focus() {}, destroy() {}, state: { doc: { toString: () => '远端新内容' } } }
  } }), sessionId, '/与远端同名的本机目录')
  try {
    fixture.button.click()
    await tick()
    assert.deepEqual(fixture.payloads[0], { sessionId, path: 'test.ts' })
    const buttons = fixture.root.children[0]!.children.flatMap((element) => element.children)
    buttons.find((button) => button.title === '保存文件')!.click()
    await tick()
    assert.deepEqual(fixture.payloads[1], { sessionId, path: 'test.ts', content: '远端新内容' })
  } finally { fixture.dispose() }
})

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
