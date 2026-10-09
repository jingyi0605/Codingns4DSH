import assert from 'node:assert/strict'
import test from 'node:test'
import { startFileManagementDom } from '../src/client/file-management-dom.js'
import { createVirtualSessionId } from '../src/shared/contracts/peer-host.js'

/** 只回放文件树菜单事件；不打开浏览器，也不执行真实文件操作。 */
class MenuNode extends EventTarget {
  readonly children: MenuNode[] = []
  readonly style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  textContent = ''
  disabled = false
  parent: MenuNode | undefined
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  append(node: MenuNode) { this.children.push(node); node.parent = this }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1) }
  querySelector() { return null }
  querySelectorAll() { return [] }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')) }
}

test('文件树菜单固定来源会话，完整携带操作路径，并禁止跨 Host 粘贴', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const listeners = new Map<string, (event: unknown) => void>()
  const body = new MenuNode()
  const document = {
    body, createElement: () => new MenuNode(), querySelectorAll: () => [],
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 1000, innerHeight: 800, prompt: () => 'new.ts', confirm: () => true } })
  const calls: Array<{ endpoint: string; payload: any }> = []
  const controller = startFileManagementDom({ async call(_channel, endpoint, payload) {
    calls.push({ endpoint, payload })
    return { ok: true, value: { contentBase64: 'YQ==', fileName: 'test.ts' } }
  } }, { fileEditor: false, menuEnhancement: true })
  const open = (sessionId: string, path = 'test.ts') => {
    const owner = { sessionId }
    const panel = { getAttribute: (name: string) => name === 'data-files-root' ? 'C:\\repo' : null, querySelector: () => null, querySelectorAll: () => [] }
    const entry = {
      dataset: { filesPath: path, filesEntry: 'file' },
      closest: (selector: string): unknown => selector === '[data-sidebar-right-session]'
        ? { getAttribute: () => owner.sessionId }
        : selector === '[data-files-state="tree"]' ? panel : selector === '[data-sidebar-right-panel]' ? null : entry,
    }
    listeners.get('contextmenu')!({ target: entry, preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 })
    const menu = body.children.find((node) => node.getAttribute('role') === 'menu')!
    return { owner, button: (label: string) => menu.children.find((node) => node.textContent === label)! }
  }
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
  const first = createVirtualSessionId('peer-a', 'first')
  const second = createVirtualSessionId('peer-a', 'second')
  const other = createVirtualSessionId('peer-b', 'first')
  try {
    for (const [label, action] of [
      ['下载文件', 'download'], ['新建文件', 'create-file'], ['新建目录', 'create-directory'],
      ['重命名/移动', 'rename'], ['添加到 Git 排除', 'git-ignore'], ['删除', 'delete'],
    ]) {
      const menu = open(first)
      // 菜单弹出后前台切到了另一会话，原操作仍属于打开菜单时的面板。
      menu.owner.sessionId = other
      menu.button(label!).click()
      await tick()
      assert.equal(calls.at(-1)?.endpoint, `fileManagement/${action}`)
      assert.equal(calls.at(-1)?.payload.sessionId, first)
      assert.match(calls.at(-1)?.payload.path, /^C:\\repo\\/u)
    }
    for (const [label, action] of [['复制', 'copy'], ['剪切', 'move']]) {
      open(first).button(label!).click()
      const count = calls.length
      for (const target of [other, 'local-session']) {
        const paste = open(target).button('粘贴')
        assert.equal(paste.disabled, true)
        paste.click()
      }
      assert.equal(calls.length, count)
      const paste = open(second, 'folder/target.ts').button('粘贴')
      assert.equal(paste.disabled, false)
      paste.click()
      await tick()
      assert.equal(calls.at(-1)?.endpoint, `fileManagement/${action}`)
      assert.equal(calls.at(-1)?.payload.sessionId, second)
      assert.deepEqual(calls.at(-1)?.payload.paths, ['C:\\repo\\test.ts'])
    }
  } finally {
    controller.dispose()
    context.mock.timers.runAll()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
