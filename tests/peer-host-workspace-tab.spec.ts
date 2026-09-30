import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE,
  PEER_HOST_WORKSPACE_TAB_ATTRIBUTE,
  PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE,
  startPeerHostWorkspaceTab,
} from '../data/build/dist/client/peer-host-workspace-tab.js'

/**
 * 构造一个与 DSH browse 对话框同构的假 DOM。
 *
 * 结构取自 @deepseek-ai/dsh-client-ui-directory-picker-browse：
 * `[role=dialog] > [class*=_editorScope] > [class*=_header] > [class*=_title]`
 * 以及同层的 `[class*=_crumbBar]`、`[class*=_content]`、`[class*=_footerBar]`。
 */
function fakeDialogDocument() {
  const dialog = new FakeElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')

  const editorScope = new FakeElement('div')
  editorScope.setAttribute('class', 'ZuhsRW_editorScope')

  const header = new FakeElement('div')
  header.setAttribute('class', 'ZuhsRW_header')
  const title = new FakeElement('h2')
  title.setAttribute('class', 'ZuhsRW_title')
  title.textContent = '选择工作区目录'
  header.appendChild(title)

  const crumbBar = new FakeElement('div')
  crumbBar.setAttribute('class', 'ZuhsRW_crumbBar')
  const content = new FakeElement('div')
  content.setAttribute('class', 'ZuhsRW_content')
  const footerBar = new FakeElement('div')
  footerBar.setAttribute('class', 'ZuhsRW_footerBar')

  editorScope.append(header, crumbBar, content, footerBar)
  dialog.appendChild(editorScope)

  const document = new FakeDocument(dialog)
  return { document, dialog, editorScope, header, title, crumbBar, content, footerBar }
}

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = []
  return {
    calls,
    api: {
      async list() { calls.push('list'); return overrides.list ?? [] },
      async workspaceCandidates(hostId: string) { calls.push(`candidates:${hostId}`); return overrides.candidates ?? [] },
      async setWorkspaceVisibility(hostId: string, workspaceId: string, visible: boolean) {
        calls.push(`visibility:${hostId}:${workspaceId}:${visible}`)
      },
    } as never,
  }
}

function readyRecord(id = 'peer-1', displayName = '开发机') {
  return {
    id,
    ownerUserId: 'user-1',
    displayName,
    route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080' },
    status: 'ready',
    pluginId: '@jingyi0605/codingns4dsh',
    pluginVersion: '0.2.0',
    dshVersion: '0.2.0-rc.1',
    apiCompatibility: 'peer-host-v1',
    fingerprint: null,
    lastCheckedAt: 1,
    lastErrorCode: null,
    color: '#1677ff',
    visibleWorkspaceIds: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

test('在原生对话框里注入标签页，原生主体结构保持不动', () => {
  const dom = fakeDialogDocument()
  const { api } = fakeApi()
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })

  const tabs = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0]?.getAttribute('role'), 'tablist')
  // 标签栏插在标题之后，而不是替换标题。
  assert.equal(dom.header.children[0], dom.title)
  assert.equal(dom.header.children[1], tabs[0])
  // 原生区域一个都没有被移除：主体仍是 DSH 自己的组件。
  assert.equal(dom.header.children.includes(dom.title), true)
  assert.equal(dom.editorScope.children.includes(dom.crumbBar), true)
  assert.equal(dom.editorScope.children.includes(dom.content), true)
  assert.equal(dom.editorScope.children.includes(dom.footerBar), true)
  assert.equal(dom.editorScope.children.includes(dom.header), true)

  controller.dispose()
  assert.equal(dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`).length, 0)
  assert.equal(dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]`).length, 0)
})

test('标签页使用注入样式表与 DSH 主题令牌，不依赖内联样式', () => {
  const dom = fakeDialogDocument()
  const { api } = fakeApi({ list: [readyRecord()] })
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })

  // 样式表必须注入：交互态（hover/focus-visible/disabled）只能由 CSS 表达。
  const style = dom.document.querySelectorAll('style').find((node) => node.getAttribute('data-plugin-css') !== null)
  assert.notEqual(style, undefined)
  const css = style?.textContent ?? ''
  // 全部走 DSH 主题令牌，明暗主题自动跟随。
  assert.match(css, /--dsw-alias-label-secondary/u)
  assert.match(css, /--dsw-radius-sm/u)
  assert.match(css, /--dsw-focus-ring-width/u)
  // 原生对话框使用 13px/20px 正文与 .5px 描边，插件必须对齐。
  assert.match(css, /font-size:13px/u)
  assert.match(css, /\.5px solid var\(--dsw-alias-border-l4\)/u)
  // 交互态确实被定义，而不是只有静态外观。
  assert.match(css, /:hover/u)
  assert.match(css, /:focus-visible/u)
  assert.match(css, /:disabled/u)

  // 注入节点用类名而不是内联样式。
  const tabs = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]
  assert.equal(tabs?.getAttribute('class'), 'codingns4dsh-peer-host-tabs')
  // 标签栏自身没有内联外观样式：颜色、圆角、hover 全在样式表里。
  assert.equal(tabs?.style.getPropertyValue('background'), '')
  const panel = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]`)[0]
  assert.equal(panel?.getAttribute('class'), 'codingns4dsh-peer-host-panel')
  // 选中态由 aria-selected 表达，视觉交给样式表。
  assert.equal(tabs?.children[0]?.getAttribute('aria-selected'), 'true')
  assert.equal(tabs?.children[1]?.getAttribute('aria-selected'), 'false')

  controller.dispose()
  // 停用后样式表必须移除，不在页面里留垃圾。
  assert.equal(dom.document.querySelectorAll('style').some((node) => node.getAttribute('data-plugin-css') !== null), false)
})

test('Host 芯片通过自定义属性传递配色，并单独展示状态徽标', async () => {
  const dom = fakeDialogDocument()
  const { api } = fakeApi({ list: [{ ...readyRecord(), color: '#f5222d' }, { ...readyRecord('peer-2', '构建机'), status: 'session_required', color: null }] })
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })
  const remoteTab = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]?.children[1]
  await click(remoteTab as FakeElement)

  const chips = dom.dialog.querySelectorAll('[data-codingns-peer-host-tab-host]')
  assert.equal(chips.length, 2)
  // 颜色以 --codingns-host-color 下传，避免内联写死 border/background。
  assert.equal(chips[0]?.style.getPropertyValue('--codingns-host-color'), '#f5222d')
  // 未配置颜色时按名称推导稳定色。
  assert.match(chips[1]?.style.getPropertyValue('--codingns-host-color') ?? '', /^#[0-9a-f]{6}$/u)
  // 状态作为独立徽标，不混进 Host 名称。
  assert.equal(chips[0]?.textContent, '开发机')
  assert.match(chips[1]?.textContent ?? '', /构建机/u)
  assert.match(chips[1]?.textContent ?? '', /需要登录/u)
  controller.dispose()
})

test('默认停在“本机文件夹”，不预先读取远端数据', () => {
  const dom = fakeDialogDocument()
  const { api, calls } = fakeApi()
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })

  assert.equal(dom.dialog.getAttribute(PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE), 'local')
  const panel = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]`)[0]
  assert.equal(panel?.style.display, 'none')
  // 打开对话框本身不应该产生任何 RPC。
  assert.deepEqual(calls, [])
  controller.dispose()
})

test('切到“远程 HOST”才读取 Host 与候选工作区，并可登记可见性', async () => {
  const dom = fakeDialogDocument()
  const { api, calls } = fakeApi({
    list: [readyRecord()],
    candidates: [{ workspaceId: 'workspace-1', displayName: '项目 A', path: '/Users/dev/project-a', sessionCount: 2 }],
  })
  const added: string[] = []
  const controller = startPeerHostWorkspaceTab({
    api,
    document: dom.document as never,
    MutationObserver: undefined,
    onWorkspaceAdded: (peerHostId, workspaceId) => { added.push(`${peerHostId}:${workspaceId}`) },
  })

  const remoteTab = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]?.children[1]
  assert.equal(remoteTab?.textContent, '远程 HOST')
  await click(remoteTab as FakeElement)
  assert.deepEqual(calls, ['list'])

  const hostButton = dom.dialog.querySelectorAll('[data-codingns-peer-host-tab-host]')[0]
  assert.equal(hostButton?.textContent, '开发机')
  await click(hostButton as FakeElement)
  assert.deepEqual(calls, ['list', 'candidates:peer-1'])

  const candidate = dom.dialog.querySelectorAll('[data-codingns-peer-host-tab-candidate]')[0]
  assert.equal(candidate?.getAttribute('data-codingns-peer-host-tab-candidate'), 'workspace-1')
  await click(candidate as FakeElement)
  assert.equal(calls.at(-1), 'visibility:peer-1:workspace-1:true')
  assert.deepEqual(added, ['peer-1:workspace-1'])

  // 面板上给出成功反馈，用户知道关闭后会发生什么。
  const status = dom.dialog.querySelectorAll('[role="status"]').map((node) => node.textContent)
  assert.ok(status.some((text) => text?.includes('已添加')))
  controller.dispose()
})

test('尚未登记 Host 时给出可操作提示，而不是空白面板', async () => {
  const dom = fakeDialogDocument()
  const { api } = fakeApi({ list: [] })
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })
  const remoteTab = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]?.children[1]
  await click(remoteTab as FakeElement)

  const text = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]`)[0]?.textContent ?? ''
  assert.match(text, /尚未登记其他 Host/u)
  controller.dispose()
})

test('未就绪的 Host 仍然列出，并说明该去做什么', async () => {
  const dom = fakeDialogDocument()
  const { api, calls } = fakeApi({ list: [{ ...readyRecord(), status: 'session_required' }] })
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })
  const remoteTab = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]?.children[1]
  await click(remoteTab as FakeElement)

  // 只列 ready 会让"需要登录"的 Host 凭空消失，用户会以为配置丢了。
  const hostButton = dom.dialog.querySelectorAll('[data-codingns-peer-host-tab-host]')[0]
  assert.notEqual(hostButton, undefined)
  assert.match(hostButton?.textContent ?? '', /开发机/u)
  assert.match(hostButton?.textContent ?? '', /需要登录/u)
  assert.equal(hostButton?.getAttribute('data-codingns-peer-host-tab-status'), 'session_required')

  await click(hostButton as FakeElement)
  const text = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]`)[0]?.textContent ?? ''
  // 给出可操作指引，而不是只说不能用。
  assert.match(text, /重新登录/u)
  assert.match(text, /编辑/u)
  // 未就绪的 Host 不发注定失败的代理请求。
  assert.deepEqual(calls, ['list'])
  controller.dispose()
})

test('被禁用的 Host 不出现在标签页里', async () => {
  const dom = fakeDialogDocument()
  const { api } = fakeApi({ list: [{ ...readyRecord(), status: 'disabled' }] })
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })
  const remoteTab = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]?.children[1]
  await click(remoteTab as FakeElement)

  // 用户显式禁用的 Host 不应再出现在选择列表里。
  assert.equal(dom.dialog.querySelectorAll('[data-codingns-peer-host-tab-host]').length, 0)
  const text = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]`)[0]?.textContent ?? ''
  assert.match(text, /尚未登记其他 Host/u)
  controller.dispose()
})

test('读取 Host 失败时显示错误，不伪装成空列表', async () => {
  const dom = fakeDialogDocument()
  const api = {
    async list() { throw new Error('目标 Host 不可达') },
    async workspaceCandidates() { return [] },
    async setWorkspaceVisibility() {},
  }
  const controller = startPeerHostWorkspaceTab({ api: api as never, document: dom.document as never, MutationObserver: undefined })
  const remoteTab = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]?.children[1]
  await click(remoteTab as FakeElement)

  const alerts = dom.dialog.querySelectorAll('[role="alert"]').map((node) => node.textContent)
  assert.ok(alerts.some((text) => text?.includes('目标 Host 不可达')))
  controller.dispose()
})

test('dispose 移除注入节点但保留原生对话框本体', () => {
  const dom = fakeDialogDocument()
  const { api } = fakeApi()
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })
  controller.dispose()

  // 原生对话框必须还在：停用 PeerHost 模块不能把 DSH 的对话框删掉。
  assert.equal(dom.document.body.children.includes(dom.dialog), true)
  assert.equal(dom.dialog.getAttribute(PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE), null)
  assert.equal(dom.dialog.getAttribute('role'), 'dialog')
  assert.equal(dom.header.children[0], dom.title)
})

test('React 重建原生子树后重新注入，并保留用户已选的标签', async () => {
  const dom = fakeDialogDocument()
  const { api } = fakeApi({ list: [readyRecord()], candidates: [] })
  const controller = startPeerHostWorkspaceTab({ api, document: dom.document as never, MutationObserver: undefined })

  const remoteTab = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]?.children[1]
  await click(remoteTab as FakeElement)
  assert.equal(dom.dialog.getAttribute(PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE), 'remote')

  // 模拟 React 整体替换 editorScope 内容：标签栏与面板随之脱离文档。
  const staleTabBar = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)[0]
  const stalePanel = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]`)[0]
  staleTabBar?.remove()
  stalePanel?.remove()
  dom.header.remove()

  const freshHeader = new FakeElement('div')
  freshHeader.setAttribute('class', 'ZuhsRW_header')
  const freshTitle = new FakeElement('h2')
  freshTitle.setAttribute('class', 'ZhuisRW_title')
  freshTitle.setAttribute('class', 'ZuhsRW_title')
  freshHeader.appendChild(freshTitle)
  dom.editorScope.appendChild(freshHeader)
  dom.header = freshHeader

  controller.refresh()
  await settle()

  const tabs = dom.dialog.querySelectorAll(`[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`)
  assert.equal(tabs.length, 1)
  // 重新注入后仍在"远程 HOST"，不会因为一次原生重渲染把用户弹回本机标签。
  assert.equal(dom.dialog.getAttribute(PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE), 'remote')
  controller.dispose()
})

/** 触发假元素的 click 监听并等待内部异步链完成。 */
async function click(element: FakeElement): Promise<void> {
  const handler = element.listeners.get('click')
  if (handler === undefined) throw new Error('元素没有 click 监听')
  handler({ preventDefault() {}, stopPropagation() {} })
  await settle()
}

function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

class FakeElement {
  ownerDocument: FakeDocument | undefined
  tagName: string
  children: FakeElement[] = []
  parentElement: FakeElement | null = null
  attributes = new Map<string, string>()
  style = new FakeStyleDeclaration()
  /**
   * 与真实 DOM 一致：`dataset.pluginCss` 读写 `data-plugin-css` 属性。
   *
   * 用 Proxy 而不是普通对象，否则 `style.dataset.pluginCss = x` 只写到内存字段，
   * 样式表的标记属性永远不会出现在 DOM 上，测试会误报"样式没注入"。
   */
  dataset = new Proxy({} as Record<string, string>, {
    get: (_target, key: string) => this.attributes.get(`data-${camelToKebab(key)}`) ?? undefined,
    set: (_target, key: string, value: string) => {
      this.attributes.set(`data-${camelToKebab(key)}`, value)
      return true
    },
    has: (_target, key: string) => this.attributes.has(`data-${camelToKebab(key)}`),
  })
  listeners = new Map<string, (event: unknown) => void>()
  hidden = false
  isConnected = true
  disabled = false
  ownText = ''

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  /** 与真实 DOM 一致：textContent 聚合整棵子树的文本。 */
  get textContent(): string {
    return `${this.ownText}${this.children.map((child) => child.textContent).join('')}`
  }

  set textContent(value: string) {
    this.ownText = value
    this.children = []
  }

  /** 与真实 DOM 一致：className 读写 `class` 属性，否则样式类断言会落空。 */
  get className(): string { return this.attributes.get('class') ?? '' }

  set className(value: string) { this.attributes.set('class', value) }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  addEventListener(name: string, handler: (event: unknown) => void): void { this.listeners.set(name, handler) }
  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this
    child.ownerDocument = this.ownerDocument
    this.children.push(child)
    return child
  }
  append(...children: FakeElement[]): void { for (const child of children) this.appendChild(child) }
  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    child.parentElement = this
    child.ownerDocument = this.ownerDocument
    const index = before === null ? -1 : this.children.indexOf(before)
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  remove(): void {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
    this.isConnected = false
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this
    while (current !== null) {
      if (matches(current, selector)) return current
      current = current.parentElement
    }
    return null
  }

  querySelectorAll(selector: string): FakeElement[] {
    return collect(this).filter((node) => node !== this && matches(node, selector))
  }

  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }
}

/** 只实现本模块用到的几种选择器，够用即可，不做通用 CSS 引擎。 */
function matches(element: FakeElement, selector: string): boolean {
  if (selector === 'style') return element.tagName === 'STYLE'
  // `style[data-plugin-css="..."]`：标签 + 属性组合，dispose 用它精确移除样式表。
  const tagged = /^([a-z]+)\[([^=\]]+)="([^"]*)"\]$/u.exec(selector)
  if (tagged !== null) {
    return element.tagName === tagged[1]!.toUpperCase() && element.getAttribute(tagged[2]!) === tagged[3]
  }
  if (selector === '[role="dialog"]') return element.getAttribute('role') === 'dialog'
  if (selector === `[${PEER_HOST_WORKSPACE_TAB_ATTRIBUTE}]`) return element.getAttribute(PEER_HOST_WORKSPACE_TAB_ATTRIBUTE) !== null
  if (selector === `[${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]`) return element.getAttribute(PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE) !== null
  if (selector === '[role="alert"]') return element.getAttribute('role') === 'alert'
  if (selector === '[role="status"]') return element.getAttribute('role') === 'status'
  if (selector === '[data-codingns-peer-host-tab-host]') return element.getAttribute('data-codingns-peer-host-tab-host') !== null
  if (selector === '[data-codingns-peer-host-tab-candidate]') return element.getAttribute('data-codingns-peer-host-tab-candidate') !== null
  const classMatch = /^\[class\*="([^"]+)"\]$/u.exec(selector)
  if (classMatch !== null) return (element.getAttribute('class') ?? '').includes(classMatch[1]!)
  return false
}

/**
 * 忠实模拟 `CSSStyleDeclaration` 的两个关键行为，否则测试无法复现真实缺陷：
 *
 * 1. 数字索引以可枚举属性暴露（`style[0] === 'minHeight'`），因此 `{ ...style }`
 *    会把它们一并展开；
 * 2. 给数字索引赋值会抛 `Indexed property setter is not supported`，与浏览器一致。
 *
 * 真实浏览器里 `Object.assign(el.style, { ...el.style, color })` 正是因此崩溃。
 */
class FakeStyleDeclaration {
  private readonly values = new Map<string, string>()

  constructor() {
    for (const [index, name] of [['0', 'minHeight'], ['1', 'padding']] as const) {
      Object.defineProperty(this, index, {
        get: () => name,
        set: () => { throw new TypeError("Failed to set an indexed property on 'CSSStyleDeclaration': Indexed property setter is not supported.") },
        enumerable: true,
        configurable: true,
      })
    }
  }

  setProperty(name: string, value: string): void { this.values.set(name, value) }
  getPropertyValue(name: string): string { return this.values.get(name) ?? '' }
}

class FakeDocument {
  body = new FakeElement('body')
  documentElement = new FakeElement('html')
  head = new FakeElement('head')

  constructor(root: FakeElement) {
    this.body.ownerDocument = this
    this.documentElement.ownerDocument = this
    this.head.ownerDocument = this
    this.body.appendChild(root)
    // 与真实文档一致：head 与 body 都是 documentElement 的子节点，
    // 否则 document.querySelector 找不到注入的样式表。
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName)
    element.ownerDocument = this
    return element
  }
  querySelectorAll(selector: string): FakeElement[] { return this.documentElement.querySelectorAll(selector) }
  querySelector(selector: string): FakeElement | null { return this.documentElement.querySelector(selector) }
}

function collect(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => collect(child))]
}

/** `pluginCss` → `plugin-css`；dataset 属性名的真实映射规则。 */
function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)
}
