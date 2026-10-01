import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DELEGATE_MENU_PROXY_ATTRIBUTE,
  DELEGATE_MENU_ROW_ATTRIBUTE,
  DELEGATE_POPUP_LOGO_ATTRIBUTE,
  DELEGATE_UI_STYLE_ID,
  setDelegatePopupOptions,
  startDelegateUiDom,
} from '../data/build/dist/client/delegate-ui-dom.js'

/**
 * `/委派` 界面增强的 DOM 测试。
 *
 * 只覆盖插件真正依赖的 DOM 契约：`/` 菜单的 listbox/option/sectionTitle 结构，
 * 以及委派弹层的搜索框 + option + labelText 结构。
 */

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

class FakeObserver {
  constructor(callback: (records: unknown[], observer: FakeObserver) => void) {
    this.callback = callback
    this.disconnected = false
  }

  callback: (records: unknown[], observer: FakeObserver) => void
  disconnected: boolean

  observe(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  trigger(): void {
    this.callback([], this)
  }
}

class FakeElement {
  constructor(tagName: string, ownerDocument?: FakeDocument) {
    this.tagName = tagName.toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.attributes = new Map()
    this.listeners = new Map()
    this.parent = null
  }

  tagName: string
  ownerDocument: FakeDocument | undefined
  children: FakeElement[]
  attributes: Map<string, string>
  listeners: Map<string, Array<(event: unknown) => void>>
  parent: FakeElement | null
  private ownText = ''

  /** 与真实 DOM 一致：没有自有文本时聚合子节点文本。 */
  get textContent(): string {
    if (this.ownText !== '') return this.ownText
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.ownText = value
    this.children = []
  }

  get parentNode(): FakeElement | null {
    return this.parent
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  get nextSibling(): FakeElement | null {
    if (this.parent === null) return null
    const index = this.parent.children.indexOf(this)
    return this.parent.children[index + 1] ?? null
  }

  get nextElementSibling(): FakeElement | null {
    return this.nextSibling
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parent = this
    this.children.push(child)
    return child
  }

  insertBefore<T extends FakeElement>(child: T, reference: FakeElement | null): T {
    child.parent = this
    if (reference === null) {
      this.children.push(child)
      return child
    }
    const index = this.children.indexOf(reference)
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  remove(): void {
    if (this.parent === null) return
    const index = this.parent.children.indexOf(this)
    if (index >= 0) this.parent.children.splice(index, 1)
    this.parent = null
  }

  cloneNode(deep?: boolean): FakeElement {
    const copy = new FakeElement(this.tagName, this.ownerDocument)
    for (const [name, value] of this.attributes) copy.attributes.set(name, value)
    // 真实 DOM 里文本是子节点；这里的 ownText 是节点自身文本，深浅拷贝都要保留，
    // 否则克隆行的标题会丢失（deep 只决定是否继续复制子树）。
    copy.ownText = this.ownText
    if (deep === true) for (const child of this.children) copy.appendChild(child.cloneNode(true))
    return copy
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatchEvent(event: { type: string; preventDefault?: () => void; stopPropagation?: () => void }): boolean {
    // 浏览器事件天然带这两个方法；测试传入的裸对象补齐，避免转发逻辑误报。
    const normalized = {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...event,
    }
    for (const listener of this.listeners.get(normalized.type) ?? []) listener(normalized)
    return true
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector)
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    return findAll(this, selector)
  }
}

class FakeMouseEvent {
  type: string
  init: { bubbles?: boolean; cancelable?: boolean } | undefined

  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean }) {
    this.type = type
    this.init = init
  }

  preventDefault(): void {}
  stopPropagation(): void {}
}

class FakeDocument {
  documentElement = new FakeElement('html')
  head = new FakeElement('head')
  body = new FakeElement('body')
  defaultView = { MouseEvent: FakeMouseEvent }

  constructor() {
    this.documentElement.ownerDocument = this
    this.head.ownerDocument = this
    this.body.ownerDocument = this
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    return findAll(this.body, selector).concat(findAll(this.head, selector))
  }
}

/** 支持 tag、[attr]、[attr="v"]、[attr^="v"]、[attr*="v"] 与 tag[attr="v"]。 */
function matchesSelector(element: FakeElement, selector: string): boolean {
  const parsed = parseSelector(selector)
  if (parsed === null) return false
  if (parsed.tag !== undefined && element.tagName !== parsed.tag.toUpperCase()) return false
  for (const test of parsed.tests) {
    const value = element.getAttribute(test.name)
    if (value === null) return false
    if (test.op === undefined) continue
    if (test.op === '=' && value !== test.value) return false
    if (test.op === '^=' && !value.startsWith(test.value ?? '')) return false
    if (test.op === '*=' && !value.includes(test.value ?? '')) return false
  }
  return true
}

function parseSelector(selector: string): { tag?: string; tests: Array<{ name: string; op?: string; value?: string }> } | null {
  const match = /^([A-Za-z][A-Za-z0-9-]*)?((?:\[[^\]]*\])*)$/u.exec(selector.trim())
  if (match === null) return null
  const tests: Array<{ name: string; op?: string; value?: string }> = []
  for (const raw of match[2]?.match(/\[[^\]]*\]/gu) ?? []) {
    const body = raw.slice(1, -1)
    const attr = /^([^=^$*~|]+)(?:([\^$*~|]?=)"([^"]*)")?$/u.exec(body)
    if (attr === null) return null
    tests.push({
      name: attr[1]!,
      ...(attr[2] === undefined ? {} : { op: attr[2] }),
      ...(attr[3] === undefined ? {} : { value: attr[3] }),
    })
  }
  return { ...(match[1] === undefined ? {} : { tag: match[1] }), tests }
}

function findAll(root: FakeElement, selector: string): FakeElement[] {
  const found: FakeElement[] = []
  const visit = (node: FakeElement): void => {
    for (const child of node.children) {
      if (matchesSelector(child, selector)) found.push(child)
      visit(child)
    }
  }
  visit(root)
  return found
}

function element(dom: FakeDocument, tagName: string, attributes: Record<string, string> = {}): FakeElement {
  const node = dom.createElement(tagName)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  return node
}

/** 构造 `/` 菜单：添加分类（file/goal/plan/feedback）+ 指令分类（委派）。 */
function slashMenu(dom: FakeDocument, label = '委派'): { listbox: FakeElement; delegateRow: FakeElement } {
  const listbox = element(dom, 'div', { role: 'listbox' })
  const viewport = element(dom, 'div')
  listbox.appendChild(viewport)
  viewport.appendChild(element(dom, 'div', { class: 'x_sectionTitle' })).textContent = '添加'
  for (const [index, name] of ['文件', '目标', '计划', '反馈'].entries()) {
    viewport.appendChild(menuRow(dom, `dsh-slash-option-command-${index}`, name))
  }
  viewport.appendChild(element(dom, 'div', { class: 'x_sectionTitle' })).textContent = '指令'
  const delegateRow = menuRow(dom, 'dsh-slash-option-command-99', label)
  viewport.appendChild(delegateRow)
  dom.body.appendChild(listbox)
  return { listbox, delegateRow }
}

function menuRow(dom: FakeDocument, id: string, label: string): FakeElement {
  const row = element(dom, 'button', { role: 'option', id, 'aria-selected': 'false' })
  const name = element(dom, 'span', { class: 'x_itemName' })
  name.textContent = label
  row.appendChild(name)
  return row
}

/** 构造委派弹层：card > input(placeholder) + listbox > option > label > labelText。 */
function delegatePopup(dom: FakeDocument, labels: readonly string[], placeholder = '搜索外部 Agent'): FakeElement {
  const card = element(dom, 'div')
  card.appendChild(element(dom, 'input', { placeholder }))
  const listbox = element(dom, 'div', { role: 'listbox' })
  for (const [index, label] of labels.entries()) {
    const row = element(dom, 'div', { role: 'option' })
    const wrap = element(dom, 'span', { class: 'x_label' })
    const text = element(dom, 'span', { class: 'x_labelText' })
    text.textContent = label
    wrap.appendChild(text)
    row.appendChild(wrap)
    row.setAttribute('data-index', String(index))
    listbox.appendChild(row)
  }
  card.appendChild(listbox)
  dom.body.appendChild(card)
  return listbox
}

const ICONS: Record<string, string> = { codex: 'data:image/png;base64,CODEX', gemini: 'data:image/png;base64,GEMINI' }

test('委派菜单行被搬进「添加」分类，真实行隐藏且不被移动', async () => {
  const dom = new FakeDocument()
  const { listbox, delegateRow } = slashMenu(dom)
  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: FakeObserver as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
  })
  await nextTurn()
  try {
    // 真实行仍留在原分类，只被标记隐藏（绝不移动 React 拥有的节点）。
    assert.equal(delegateRow.hasAttribute(DELEGATE_MENU_ROW_ATTRIBUTE), true)
    const viewport = listbox.children[0]!
    assert.equal(delegateRow.parent, viewport, '真实行必须仍在原视口内，不能被移动')
    assert.equal(viewport.children.at(-1), delegateRow, '真实行仍留在指令分类末尾')

    const proxies = listbox.querySelectorAll(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)
    assert.equal(proxies.length, 1)
    const proxy = proxies[0]!
    // 代理行紧跟添加分类的最后一行，位于指令分类标题之前。
    const order = viewport.children.map((child) => child.getAttribute('class') === 'x_sectionTitle' ? `#${child.textContent}` : (child.textContent ?? ''))
    assert.deepEqual(order, ['#添加', '文件', '目标', '计划', '反馈', '委派', '#指令', '委派'])
    assert.equal(proxy.getAttribute('id'), null, '克隆行不能复制真实行的 DOM id')
  } finally {
    controller.dispose()
  }
})

test('点击「添加」分类里的委派行会转发交互到真实行', async () => {
  const dom = new FakeDocument()
  const { listbox, delegateRow } = slashMenu(dom)
  const seen: string[] = []
  delegateRow.addEventListener('mousedown', () => seen.push('mousedown'))
  delegateRow.addEventListener('mousemove', () => seen.push('mousemove'))
  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: FakeObserver as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
  })
  await nextTurn()
  try {
    const proxy = listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)!
    proxy.dispatchEvent({ type: 'mousedown' })
    proxy.dispatchEvent({ type: 'mousemove' })
    assert.deepEqual(seen, ['mousedown', 'mousemove'], '代理行必须把选择与高亮都转发给真实行')
  } finally {
    controller.dispose()
  }
})

test('真实行被高亮时，添加分类里的克隆行同步高亮', async () => {
  const dom = new FakeDocument()
  const { listbox, delegateRow } = slashMenu(dom)
  const observer = new FakeObserver(() => undefined)
  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: class {
      constructor(callback: (records: unknown[], observer: FakeObserver) => void) {
        observer.callback = callback
      }
      observe(): void {}
      disconnect(): void {}
    } as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
  })
  await nextTurn()
  try {
    const proxy = listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)!
    assert.equal(proxy.getAttribute('data-active'), 'false')

    delegateRow.setAttribute('aria-selected', 'true')
    observer.trigger()
    await nextTurn()
    assert.equal(proxy.getAttribute('data-active'), 'true')
    assert.equal(proxy.getAttribute('aria-selected'), 'true')

    delegateRow.setAttribute('aria-selected', 'false')
    observer.trigger()
    await nextTurn()
    assert.equal(proxy.getAttribute('data-active'), 'false')
  } finally {
    controller.dispose()
  }
})

test('委派弹层的适配器行带上对应 Provider 图标', async () => {
  const dom = new FakeDocument()
  const listbox = delegatePopup(dom, ['Command Code', 'Codex', 'Gemini CLI'])
  setDelegatePopupOptions([
    { id: 'command-code', label: 'Command Code', detail: '1.73.2' },
    { id: 'codex', label: 'Codex', detail: '0.159.2' },
    { id: 'gemini', label: 'Gemini CLI', detail: '0.43.0' },
  ])
  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: FakeObserver as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
    iconUrlForAdapter: (adapterId) => ICONS[adapterId],
  })
  await nextTurn()
  try {
    const rows = listbox.querySelectorAll('[role="option"]')
    assert.equal(rows.length, 3)
    // 只有插件提供图标的适配器会插图标；未知/无图标行保持原样。
    assert.equal(rows[0]!.querySelector(`[${DELEGATE_POPUP_LOGO_ATTRIBUTE}]`), null)
    assert.equal(rows[1]!.querySelector(`[${DELEGATE_POPUP_LOGO_ATTRIBUTE}]`)?.getAttribute('src'), ICONS.codex)
    assert.equal(rows[2]!.querySelector(`[${DELEGATE_POPUP_LOGO_ATTRIBUTE}]`)?.getAttribute('src'), ICONS.gemini)
    // 图标必须插在行首，且不打断文本节点。
    assert.equal(rows[1]!.firstChild?.getAttribute(DELEGATE_POPUP_LOGO_ATTRIBUTE), 'codex')
    assert.equal(rows[1]!.querySelector('[class*="labelText"]')?.textContent, 'Codex')
  } finally {
    controller.dispose()
  }
})

test('界面增强对不认识的菜单结构完全静默，停用后移除全部插件节点', async () => {
  const dom = new FakeDocument()
  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: FakeObserver as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
  })
  await nextTurn()
  // 没有菜单/弹层时不产生任何节点。
  assert.equal(dom.body.children.length, 0)

  const { listbox, delegateRow } = slashMenu(dom)
  controller.refresh()
  await nextTurn()
  const proxy = listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)
  assert.notEqual(proxy, null)

  controller.dispose()
  assert.equal(delegateRow.hasAttribute(DELEGATE_MENU_ROW_ATTRIBUTE), false, '停用后必须恢复真实行')
  assert.equal(listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`), null)
  assert.equal(dom.querySelector(`style[data-plugin-css="${DELEGATE_UI_STYLE_ID}"]`), null, '样式属于 head，不在 body 中')
  assert.equal(dom.head.querySelector(`style[data-plugin-css="${DELEGATE_UI_STYLE_ID}"]`), null)
})

test('输入过滤词后菜单没有分类标题，委派入口必须保持可见', async () => {
  const dom = new FakeDocument()
  // rankByName 路径：只有扁平候选行，没有 sectionTitle。
  const listbox = element(dom, 'div', { role: 'listbox' })
  const viewport = element(dom, 'div')
  listbox.appendChild(viewport)
  const delegateRow = menuRow(dom, 'dsh-slash-option-command-99', '委派')
  viewport.appendChild(delegateRow)
  dom.body.appendChild(listbox)

  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: FakeObserver as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
  })
  await nextTurn()
  try {
    // 无法放置代理行时绝不能隐藏真实行，否则委派入口会凭空消失。
    assert.equal(delegateRow.hasAttribute(DELEGATE_MENU_ROW_ATTRIBUTE), false)
    assert.equal(listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`), null)
  } finally {
    controller.dispose()
  }
})

test('菜单重新打开后代理行会跟随新的真实行重建', async () => {
  const dom = new FakeDocument()
  const first = slashMenu(dom)
  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: FakeObserver as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
  })
  await nextTurn()
  try {
    const proxyBefore = first.listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)
    assert.notEqual(proxyBefore, null)

    // 模拟 DSH 关闭并重开菜单：旧 DOM 整体被替换，行节点是全新的。
    first.listbox.remove()
    const second = slashMenu(dom)
    controller.refresh()
    await nextTurn()

    const proxyAfter = second.listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)
    assert.notEqual(proxyAfter, null, '新菜单必须重新注入代理行')
    assert.equal(second.delegateRow.hasAttribute(DELEGATE_MENU_ROW_ATTRIBUTE), true)
  } finally {
    controller.dispose()
  }
})

test('代理行不能被插件自己的隐藏规则命中，否则委派入口会整个消失', async () => {
  const dom = new FakeDocument()
  const { listbox } = slashMenu(dom)
  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: FakeObserver as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
  })
  await nextTurn()
  try {
    const proxy = listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)!
    // 克隆会复制真实行的标记；代理行若带着它，就会被 display:none 一起隐藏。
    assert.equal(
      proxy.hasAttribute(DELEGATE_MENU_ROW_ATTRIBUTE),
      false,
      '代理行不能继承隐藏真实行的标记',
    )
    // 隐藏规则本身也必须排除代理行，作为第二道保险。
    const css = dom.head.querySelector('style')?.textContent ?? ''
    assert.ok(css.includes(`:not([${DELEGATE_MENU_PROXY_ATTRIBUTE}])`), '隐藏规则必须排除代理行')
  } finally {
    controller.dispose()
  }
})

test('克隆行不能继承原生高亮类，高亮只由 data-active 驱动', async () => {
  const dom = new FakeDocument()
  const listbox = element(dom, 'div', { role: 'listbox' })
  const viewport = element(dom, 'div')
  listbox.appendChild(viewport)
  viewport.appendChild(element(dom, 'div', { class: 'x_sectionTitle' })).textContent = '添加'
  viewport.appendChild(menuRow(dom, 'dsh-slash-option-command-0', '文件'))
  viewport.appendChild(element(dom, 'div', { class: 'x_sectionTitle' })).textContent = '指令'
  // 真实行此刻正被高亮（CSS Modules 哈希类名），克隆会把它一起复制过来。
  const delegateRow = menuRow(dom, 'dsh-slash-option-command-99', '委派')
  delegateRow.setAttribute('class', '_3e4SsG_item _3e4SsG_active')
  delegateRow.setAttribute('aria-selected', 'true')
  viewport.appendChild(delegateRow)
  dom.body.appendChild(listbox)

  const controller = startDelegateUiDom({
    document: dom as never,
    MutationObserver: FakeObserver as never,
    menuLabel: () => '委派',
    popupPlaceholder: () => '搜索外部 Agent',
  })
  await nextTurn()
  try {
    const proxy = listbox.querySelector(`[${DELEGATE_MENU_PROXY_ATTRIBUTE}]`)!
    // 克隆时真实行是激活的，但克隆行必须从「未激活」开始，靠同步逻辑驱动。
    assert.equal(proxy.getAttribute('data-active'), 'true', '当前激活状态应立即同步')
    assert.equal(
      (proxy.getAttribute('class') ?? '').includes('_active'),
      false,
      '克隆行不能带原生高亮类，否则取消高亮后仍会保持高亮',
    )
  } finally {
    controller.dispose()
  }
})
