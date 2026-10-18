import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement, ReactNode } from 'react'
import { resolveFileCopyPaths, startFileManagementDom } from '../src/client/file-management-dom.js'
import {
  FILE_VIEWER_COPY_PATH_MENU_ID,
  FileTabCopyPathMenuItems,
  fileCopyPathsForTab,
  registerFileViewerCopyPathMenu,
} from '../src/client/file-viewer-copy-path-menu.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** 只回放路径菜单事件；不打开浏览器，也不读写真实剪贴板。 */
class MenuNode extends EventTarget {
  readonly children: MenuNode[] = []
  readonly style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  textContent = ''
  disabled = false
  parent: MenuNode | undefined
  value = ''
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  append(node: MenuNode) { this.children.push(node); node.parent = this }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1) }
  focus() {}
  select() {}
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')) }
}

function matchesSelector(node: { getAttribute(name: string): string | null }, selector: string): boolean {
  return selector.split(',').map((part) => part.trim()).some((part) => {
    const tokens = [...part.matchAll(/\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]/gu)]
    if (tokens.length === 0) return false
    return tokens.every(([, name, value]) => {
      const actual = node.getAttribute(name!)
      return actual !== null && (value === undefined || actual === value)
    })
  })
}

function previewTree() {
  const filesRoot = '/Users/me/repo'
  const relative = 'src/app.ts'
  const absolute = `${filesRoot}/${relative}`
  const sessionId = 'session-preview'
  const panel = {
    getAttribute: (name: string) => name === 'data-sidebar-right-panel' ? 'push' : name === 'data-sidebar-right-session' ? sessionId : null,
    querySelector: (selector: string) => selector.includes('data-files-root') ? tree : null,
    querySelectorAll: () => [],
  }
  const tree = {
    getAttribute: (name: string) => name === 'data-files-state' ? 'tree' : name === 'data-files-root' ? filesRoot : null,
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const preview = {
    getAttribute: (name: string) => name === 'data-textpreview-url'
      ? `dsh-resource://file/session/${sessionId}/${relative}?mode=text`
      : name === 'data-document-preview' ? 'text' : null,
  }
  const pathLabel = {
    getAttribute: (name: string) => name === 'data-textpreview-path' ? 'true' : name === 'data-path-label' ? '' : name === 'title' ? absolute : null,
  }
  const directory = { getAttribute: () => null }
  const filename = { getAttribute: () => null }
  const body = { getAttribute: (name: string) => name === 'data-textpreview-body' ? 'true' : null }
  const entry = {
    dataset: { filesPath: relative, filesEntry: 'file' },
    getAttribute: (name: string) => name === 'data-files-entry' ? 'file' : name === 'data-files-path' ? relative : null,
  }
  const closestFor = (origin: { getAttribute(name: string): string | null }, selector: string) => {
    const chain = origin === directory || origin === filename
      ? [origin, pathLabel, preview, panel]
      : origin === pathLabel
        ? [pathLabel, preview, panel]
        : origin === body
          ? [body, preview, panel]
          : origin === entry
            ? [entry, tree, panel]
            : [origin]
    return chain.find((node) => matchesSelector(node, selector)) ?? null
  }
  for (const node of [directory, filename, pathLabel, body, entry]) {
    ;(node as { closest: (selector: string) => unknown }).closest = (selector: string) => closestFor(node, selector)
  }
  return { filesRoot, relative, absolute, sessionId, panel, tree, preview, pathLabel, directory, filename, body, entry }
}

function installMenuDocument() {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const listeners = new Map<string, (event: unknown) => void>()
  const body = new MenuNode()
  const copied: string[] = []
  const document = {
    body,
    createElement: () => new MenuNode(),
    querySelector: (selector: string) => selector.includes('data-files-root') ? { getAttribute: () => '/Users/me/repo' } : null,
    querySelectorAll: () => [],
    execCommand: (command: string) => command === 'copy',
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 1000, innerHeight: 800 } })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => { copied.push(text) } } },
  })
  return {
    listeners,
    body,
    copied,
    restore() {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else Reflect.deleteProperty(globalThis, 'document')
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
      else Reflect.deleteProperty(globalThis, 'navigator')
    },
  }
}

function openMenuFrom(listeners: Map<string, (event: unknown) => void>, target: unknown) {
  let prevented = false
  listeners.get('contextmenu')!({
    target,
    preventDefault() { prevented = true },
    stopPropagation() {},
    clientX: 24,
    clientY: 48,
  })
  return prevented
}

function menuOf(body: MenuNode) {
  return body.children.find((node) => node.getAttribute('role') === 'menu')
}

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

test('resolveFileCopyPaths 从资源路径、查看器标题和工作区根目录合成相对与绝对路径', () => {
  assert.equal(resolveFileCopyPaths({}), undefined)
  assert.deepEqual(resolveFileCopyPaths({
    resourcePath: 'src/app.ts',
    workspaceRoot: '/Users/me/repo',
  }), { relative: 'src/app.ts', absolute: '/Users/me/repo/src/app.ts' })
  assert.deepEqual(resolveFileCopyPaths({
    displayPath: '/Users/me/repo/src/app.ts',
    workspaceRoot: '/Users/me/repo',
  }), { relative: 'src/app.ts', absolute: '/Users/me/repo/src/app.ts' })
  assert.deepEqual(resolveFileCopyPaths({
    resourcePath: 'src/app.ts',
    displayPath: '/Users/me/repo/src/app.ts',
    resourceAbsolutePath: '/Users/me/repo/src/app.ts',
    workspaceRoot: '/Users/me/repo',
  }), { relative: 'src/app.ts', absolute: '/Users/me/repo/src/app.ts' })
  assert.deepEqual(resolveFileCopyPaths({
    resourcePath: 'src\\app.ts',
    workspaceRoot: 'C:\\repo',
  }), { relative: 'src\\app.ts', absolute: 'C:\\repo\\src\\app.ts' })
})

test('文件查看器路径标签右键只提供复制相对/绝对路径，正文和关闭菜单增强时不拦截', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const env = installMenuDocument()
  const fixture = previewTree()
  const controller = startFileManagementDom({ async call() { throw new Error('复制路径不应请求 RPC') } }, {
    fileEditor: false,
    menuEnhancement: true,
  })
  try {
    for (const origin of [fixture.pathLabel, fixture.directory, fixture.filename]) {
      env.body.children.length = 0
      assert.equal(openMenuFrom(env.listeners, origin), true)
      const menu = menuOf(env.body)!
      assert.equal(menu.getAttribute('data-file-management-menu'), 'preview')
      assert.deepEqual(menu.children.map((item) => item.textContent), ['复制相对路径', '复制绝对路径'])
    }

    env.body.children.length = 0
    assert.equal(openMenuFrom(env.listeners, fixture.body), false)
    assert.equal(menuOf(env.body), undefined)

    env.body.children.length = 0
    assert.equal(openMenuFrom(env.listeners, fixture.entry), true)
    const treeMenu = menuOf(env.body)!
    assert.equal(treeMenu.getAttribute('data-file-management-menu'), 'tree')
    assert.ok(treeMenu.children.length > 2)
    assert.ok(treeMenu.children.some((item) => item.textContent === '复制相对路径'))
    assert.ok(treeMenu.children.some((item) => item.textContent === '复制绝对路径'))

    env.body.children.length = 0
    openMenuFrom(env.listeners, fixture.filename)
    menuOf(env.body)!.children.find((item) => item.textContent === '复制相对路径')!.click()
    await tick()
    assert.deepEqual(env.copied, [fixture.relative])

    env.copied.length = 0
    openMenuFrom(env.listeners, fixture.directory)
    menuOf(env.body)!.children.find((item) => item.textContent === '复制绝对路径')!.click()
    await tick()
    assert.deepEqual(env.copied, [fixture.absolute])

    controller.setOptions({ fileEditor: false, menuEnhancement: false })
    env.body.children.length = 0
    assert.equal(openMenuFrom(env.listeners, fixture.pathLabel), false)
    assert.equal(menuOf(env.body), undefined)
  } finally {
    controller.dispose()
    context.mock.timers.runAll()
    env.restore()
  }
})

test('文件标签右键 extras 注册复制路径项，非文件标签不渲染', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const env = installMenuDocument()
  const registrations: Array<{ options: Record<string, unknown>; component: (props: any) => ReactElement | null }> = []
  const slots = {
    inject(name: string, callback: () => () => void) {
      assert.equal(name, 'sidebar.right.tab.menu.item')
      return callback()
    },
    register(options: Record<string, unknown>, component: (props: any) => ReactElement | null) {
      registrations.push({ options, component })
      return () => { registrations.length = 0 }
    },
  }
  const dispose = registerFileViewerCopyPathMenu(slots)
  const fileTab = {
    tab: { contentId: 'dsh-resource://file/session/session-preview/src/app.ts?mode=text' },
    dismiss() { dismissed += 1 },
    sessionId: 'session-preview',
  }
  let dismissed = 0
  const renderer = createHookRenderer(FileTabCopyPathMenuItems, fileTab)
  try {
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0]?.options.id, FILE_VIEWER_COPY_PATH_MENU_ID)
    assert.equal(registrations[0]?.options.order, 80)
    assert.equal(registerFileViewerCopyPathMenu(undefined)() , undefined)

    assert.deepEqual(fileCopyPathsForTab(fileTab), {
      relative: 'src/app.ts',
      absolute: '/Users/me/repo/src/app.ts',
    })
    assert.equal(fileCopyPathsForTab({ tab: { contentId: 'dsh-resource://terminal/session/session-preview/1' } }), undefined)

    const items = renderer.render()
    const relative = elementWhere(items, (element) => element.props['data-file-copy-path'] === 'relative')
    const absolute = elementWhere(items, (element) => element.props['data-file-copy-path'] === 'absolute')
    assert.equal(relative?.props.role, 'menuitem')
    assert.equal(absolute?.props.role, 'menuitem')
    assert.equal(relative?.props.children, '复制相对路径')
    assert.equal(absolute?.props.children, '复制绝对路径')

    relative!.props.onClick()
    await tick()
    assert.equal(dismissed, 1)
    assert.deepEqual(env.copied, ['src/app.ts'])

    env.copied.length = 0
    absolute!.props.onClick()
    await tick()
    assert.equal(dismissed, 2)
    assert.deepEqual(env.copied, ['/Users/me/repo/src/app.ts'])

    const other = createHookRenderer(FileTabCopyPathMenuItems, { tab: { contentId: 'dsh-resource://terminal/session/session-preview/1' }, dismiss() {} })
    try { assert.equal(other.render(), null) } finally { other.dispose() }
  } finally {
    renderer.dispose()
    dispose()
    context.mock.timers.runAll()
    env.restore()
  }
})
