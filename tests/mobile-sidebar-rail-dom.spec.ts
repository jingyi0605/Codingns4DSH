import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MOBILE_SIDEBAR_BUTTON_ATTRIBUTE,
  MOBILE_SIDEBAR_COLUMN_ATTRIBUTE,
  MOBILE_SIDEBAR_DIAGNOSTIC_STRUCTURE_MISSING,
  MOBILE_SIDEBAR_DIAGNOSTIC_TOGGLE_MISSING,
  MOBILE_SIDEBAR_FRAME_ATTRIBUTE,
  MOBILE_SIDEBAR_GRID_STATE_ATTRIBUTE,
  MOBILE_SIDEBAR_LEADING_CLEARANCE_PX,
  MOBILE_SIDEBAR_MODE_ATTRIBUTE,
  MOBILE_SIDEBAR_STYLE_ID,
  MOBILE_SIDEBAR_TOGGLE_LABEL,
  hideLeadingGridTrack,
  hasHostLeadingToggle,
  isMobileSidebarViewport,
  isRightbarOccupied,
  startMobileSidebarRailDom,
} from '../data/build/dist/client/mobile-sidebar-rail-dom.js'
import { FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from '../data/build/dist/client/mobile-sidebar-logo.js'

const GRID = '56px minmax(0px, 1fr) minmax(0px, 0px)'

test('网格改写只收掉第一条轨道，其余原样保留', () => {
  assert.equal(hideLeadingGridTrack(GRID), '0px minmax(0px, 1fr) minmax(0px, 0px)')
  assert.equal(hideLeadingGridTrack('  280px minmax(400px, 1fr) minmax(0px, 175px)'), '0px minmax(400px, 1fr) minmax(0px, 175px)')
  // 认不出的写法必须保持原样，不能把宿主网格改坏。
  assert.equal(hideLeadingGridTrack(''), undefined)
  assert.equal(hideLeadingGridTrack('minmax(0px, 1fr)'), undefined)
  assert.equal(hideLeadingGridTrack('56px'), undefined)
})

test('移动端视口判定按上限收敛，非法输入一律不生效', () => {
  assert.equal(isMobileSidebarViewport(390, 1024), true)
  assert.equal(isMobileSidebarViewport(1024, 1024), true)
  assert.equal(isMobileSidebarViewport(1025, 1024), false)
  assert.equal(isMobileSidebarViewport(0, 1024), false)
  assert.equal(isMobileSidebarViewport(390, 0), false)
  assert.equal(isMobileSidebarViewport(Number.NaN, 1024), false)
})

test('宿主自带入口时不再重复放置唤起按钮', async () => {
  // 结构探测：`shell.leading` 座位里有按钮才算宿主已提供入口。
  assert.equal(hasHostLeadingToggle({ querySelector: () => null }), false)
  const seatWithoutButton = { querySelector: (selector) => (selector === '[data-shell-leading]' ? { querySelector: () => null } : null) }
  assert.equal(hasHostLeadingToggle(seatWithoutButton), false)
  const seatWithButton = { querySelector: (selector) => (selector === '[data-shell-leading]' ? { querySelector: () => ({}) } : null) }
  assert.equal(hasHostLeadingToggle(seatWithButton), true)

  const dom = new FakeDocument()
  const frame = appFrame(dom)
  frame.style.gridTemplateColumns = GRID
  frame.setAttribute('data-sidebar-collapsed', '')
  const seat = new FakeElement('div')
  seat.setAttribute('data-shell-leading', '')
  seat.appendChild(new FakeElement('button'))
  frame.appendChild(seat)
  const controller = startMobileSidebarRailDom({
    document: dom,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
    toggleSidebar: () => undefined,
  })
  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)', '轨道仍然要收为 0')
  assert.equal(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null, '宿主已有入口时不得重复注入按钮')
  assert.equal(frame.style.getPropertyValue('--dsh-frame-leading-clearance'), '', '宿主自会设置让位变量，插件不得覆盖')
  controller.dispose()
})

test('窄屏收起态下收窄轨道并挂出插件自有 logo 按钮，停用后完全还原', async () => {
  const dom = new FakeDocument()
  const frame = appFrame(dom)
  frame.style.gridTemplateColumns = GRID
  frame.setAttribute('data-sidebar-collapsed', '')
  const toggles = []
  const controller = startMobileSidebarRailDom({
    document: dom,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
    toggleSidebar: () => toggles.push(1),
  })
  const observer = FakeObserver.last

  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)')
  assert.equal(frame.getAttribute(MOBILE_SIDEBAR_GRID_STATE_ATTRIBUTE), 'on')
  assert.equal(frame.style.getPropertyValue('--dsh-frame-leading-clearance'), `${MOBILE_SIDEBAR_LEADING_CLEARANCE_PX}px`)
  assert.equal(dom.documentElement.getAttribute(MOBILE_SIDEBAR_MODE_ATTRIBUTE), 'on')
  assert.equal(frame.hasAttribute(MOBILE_SIDEBAR_FRAME_ATTRIBUTE), true)
  assert.equal(dom.querySelector(`[${MOBILE_SIDEBAR_COLUMN_ATTRIBUTE}]`) !== null, true)
  assert.equal(dom.styleTags().some((tag) => tag.dataset.pluginCss === MOBILE_SIDEBAR_STYLE_ID), true)

  // 唤起入口必须是插件自建、直接挂在 body 上的按钮，而不是侧栏列内部的原生节点：
  // 侧栏列已被收成 0 宽，内部节点会被裁掉。
  const button = dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`)
  assert.ok(button, '必须存在唤起按钮')
  assert.equal(button.parentElement, dom.body, '按钮必须直接挂在 body 上，避免被 0 宽侧栏列裁剪')
  assert.equal(button.getAttribute('aria-label'), MOBILE_SIDEBAR_TOGGLE_LABEL)
  const svg = button.querySelector('svg')
  assert.ok(svg, '按钮必须内联鲸鱼 SVG')
  assert.equal(svg.getAttribute('viewBox'), `0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`)
  assert.equal(svg.querySelector('path').getAttribute('d'), FISH_LOGO_PATH, '图形必须与 DSH 官方 logo 完全一致')

  // 点击只调用 DSH 布局服务，不自行改状态。
  button.dispatch('click')
  assert.deepEqual(toggles, [1])

  // 样式必须用 visibility 隐藏侧栏列；display:none 会让后续网格项错位。
  const css = dom.styleTags().map((tag) => tag.textContent).join('')
  assert.match(css, /visibility:hidden/)
  assert.equal(css.includes('display:none'), false, '不能用 display:none 隐藏网格项')

  // 宿主重绘后插件必须补写，否则 56px 轨道会短暂回来。
  frame.style.gridTemplateColumns = GRID
  observer.trigger({ target: frame, addedNodes: [], removedNodes: [] })
  await nextTurn()
  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)')

  controller.dispose()
  assert.equal(frame.style.gridTemplateColumns, GRID, '停用后必须写回宿主自己的网格值')
  assert.equal(frame.hasAttribute(MOBILE_SIDEBAR_GRID_STATE_ATTRIBUTE), false)
  assert.equal(frame.style.getPropertyValue('--dsh-frame-leading-clearance'), '')
  assert.equal(dom.documentElement.hasAttribute(MOBILE_SIDEBAR_MODE_ATTRIBUTE), false)
  assert.equal(dom.styleTags().length, 0, '停用后不能残留插件样式')
  assert.equal(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null, '停用后必须移除唤起按钮')
})

test('展开态与超宽视口都保持宿主原生外观，且不显示唤起按钮', async () => {
  const dom = new FakeDocument()
  const frame = appFrame(dom)
  frame.style.gridTemplateColumns = GRID
  // 未收起：DSH 自己会画出完整侧栏，插件不碰网格、也不该出现按钮。
  const controller = startMobileSidebarRailDom({
    document: dom,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
    toggleSidebar: () => undefined,
  })
  assert.equal(frame.style.gridTemplateColumns, GRID)
  assert.equal(frame.style.getPropertyValue('--dsh-frame-leading-clearance'), '')
  assert.equal(dom.documentElement.getAttribute(MOBILE_SIDEBAR_MODE_ATTRIBUTE), 'on')
  assert.equal(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null, '展开态不需要唤起按钮')
  controller.dispose()

  // 桌面宽度：整块零副作用，连样式标签都不注入。
  const desktop = new FakeDocument()
  const desktopFrame = appFrame(desktop)
  desktopFrame.style.gridTemplateColumns = GRID
  desktopFrame.setAttribute('data-sidebar-collapsed', '')
  const desktopController = startMobileSidebarRailDom({
    document: desktop,
    window: { innerWidth: 1440 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
  })
  assert.equal(desktopFrame.style.gridTemplateColumns, GRID)
  assert.equal(desktop.documentElement.hasAttribute(MOBILE_SIDEBAR_MODE_ATTRIBUTE), false)
  assert.equal(desktop.styleTags().length, 0)
  assert.equal(desktop.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null)
  desktopController.dispose()
})

test('React 重建侧栏子树后重新解析并补回隐藏，按钮不被误删', async () => {
  const dom = new FakeDocument()
  const frame = appFrame(dom)
  frame.style.gridTemplateColumns = GRID
  frame.setAttribute('data-sidebar-collapsed', '')
  const controller = startMobileSidebarRailDom({
    document: dom,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
    toggleSidebar: () => undefined,
  })
  const observer = FakeObserver.last

  // 宿主重建侧栏列：旧节点被摘掉，新节点上没有插件标记。
  const column = frame.children[0]
  column.remove()
  const freshColumn = new FakeElement('div')
  freshColumn.appendChild(new FakeElement('div'))
  frame.children.unshift(freshColumn)
  freshColumn.parent = frame
  observer.trigger({ target: freshColumn, addedNodes: [freshColumn], removedNodes: [column] })
  await nextTurn()

  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)')
  assert.equal(freshColumn.hasAttribute(MOBILE_SIDEBAR_COLUMN_ATTRIBUTE), true, '新侧栏列必须重新打标记')
  assert.equal(column.hasAttribute(MOBILE_SIDEBAR_COLUMN_ATTRIBUTE), false, '旧节点的标记必须清理')
  assert.equal(dom.querySelectorAll(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`).length, 1, '按钮必须仍然只有一个')
  controller.dispose()
  assert.equal(frame.style.gridTemplateColumns, GRID)
})

test('点击展开后宿主写入的宽度必须原样保留，不能被折叠基线覆盖', async () => {
  const dom = new FakeDocument()
  const frame = appFrame(dom)
  frame.style.gridTemplateColumns = GRID
  frame.setAttribute('data-sidebar-collapsed', '')
  const controller = startMobileSidebarRailDom({
    document: dom,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
    toggleSidebar: () => undefined,
  })
  const observer = FakeObserver.last
  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)')

  // 用户点击 logo：DSH 切换 narrowExpanded 并重绘为展开宽度，同时摘掉折叠标记。
  const EXPANDED = '280px minmax(0px, 1fr) minmax(0px, 0px)'
  frame.style.gridTemplateColumns = EXPANDED
  frame.removeAttribute('data-sidebar-collapsed')
  observer.trigger({ target: frame, addedNodes: [], removedNodes: [] })
  await nextTurn()

  // 关键回归：插件不得把折叠态基线（56px）写回去，否则侧栏按展开宽度渲染却被窄列裁掉。
  assert.equal(frame.style.gridTemplateColumns, EXPANDED, '展开宽度必须原样保留')
  assert.equal(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null, '展开后收起唤起按钮')
  assert.equal(frame.style.getPropertyValue('--dsh-frame-leading-clearance'), '')

  // 再次折叠：仍应正常收窄。
  frame.style.gridTemplateColumns = GRID
  frame.setAttribute('data-sidebar-collapsed', '')
  observer.trigger({ target: frame, addedNodes: [], removedNodes: [] })
  await nextTurn()
  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)')

  // 停用插件时同样不能覆盖宿主当前值。
  frame.style.gridTemplateColumns = EXPANDED
  frame.removeAttribute('data-sidebar-collapsed')
  controller.dispose()
  assert.equal(frame.style.gridTemplateColumns, EXPANDED)
})

test('右栏显示时 logo 自动让位，右栏关闭后恢复', async () => {
  // 判据：全屏直接算占用；否则看 `data-rightbar-collapsed` 是否存在。
  assert.equal(isRightbarOccupied(undefined), false)
  assert.equal(isRightbarOccupied({ hasAttribute: (n) => n === 'data-rightbar-collapsed' }), false)
  assert.equal(isRightbarOccupied({ hasAttribute: () => false }), true)
  assert.equal(isRightbarOccupied({ hasAttribute: (n) => n === 'data-rightbar-fullscreen' }), true)

  const dom = new FakeDocument()
  const frame = appFrame(dom)
  frame.style.gridTemplateColumns = GRID
  frame.setAttribute('data-sidebar-collapsed', '')
  frame.setAttribute('data-rightbar-collapsed', '')
  const controller = startMobileSidebarRailDom({
    document: dom,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
    toggleSidebar: () => undefined,
  })
  const observer = FakeObserver.last
  // 右栏未显示：左栏收起且只有 logo，正常显示。
  assert.ok(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), '右栏未显示时应显示 logo')

  // 用户打开右栏：DSH 摘掉 data-rightbar-collapsed。logo 必须让位，否则盖住右栏标签。
  frame.removeAttribute('data-rightbar-collapsed')
  observer.trigger({ target: frame, addedNodes: [], removedNodes: [], attributeName: 'data-rightbar-collapsed' })
  await nextTurn()
  assert.equal(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null, '右栏显示时 logo 必须隐藏')
  assert.equal(frame.style.getPropertyValue('--dsh-frame-leading-clearance'), '', 'logo 让位时不应再占用标题空间')
  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)', '左栏隐藏不受右栏影响')

  // 右栏全屏同样让位。
  frame.setAttribute('data-rightbar-fullscreen', '')
  observer.trigger({ target: frame, addedNodes: [], removedNodes: [], attributeName: 'data-rightbar-fullscreen' })
  await nextTurn()
  assert.equal(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null, '右栏全屏时 logo 也必须隐藏')

  // 关闭右栏：logo 恢复，左栏仍保持隐藏。
  frame.removeAttribute('data-rightbar-fullscreen')
  frame.setAttribute('data-rightbar-collapsed', '')
  observer.trigger({ target: frame, addedNodes: [], removedNodes: [], attributeName: 'data-rightbar-collapsed' })
  await nextTurn()
  assert.ok(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), '右栏关闭后 logo 必须恢复')
  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)')
  controller.dispose()
})

test('设置关闭时立即还原，结构不匹配时给出诊断且零改动', async () => {
  const dom = new FakeDocument()
  const frame = appFrame(dom)
  frame.style.gridTemplateColumns = GRID
  frame.setAttribute('data-sidebar-collapsed', '')
  let enabled = true
  const diagnostics = []
  const controller = startMobileSidebarRailDom({
    document: dom,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: enabled, mobileViewportMaxPx: 1024 }),
    toggleSidebar: () => undefined,
    onDiagnostic: (code) => diagnostics.push(code),
  })
  assert.equal(frame.style.gridTemplateColumns, '0px minmax(0px, 1fr) minmax(0px, 0px)')

  enabled = false
  controller.refresh()
  assert.equal(frame.style.gridTemplateColumns, GRID)
  assert.equal(dom.documentElement.hasAttribute(MOBILE_SIDEBAR_MODE_ATTRIBUTE), false)
  assert.equal(dom.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null)
  controller.dispose()

  // 没有应用框架时不能写任何属性，只报一次诊断。
  const empty = new FakeDocument()
  const emptyController = startMobileSidebarRailDom({
    document: empty,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
    onDiagnostic: (code) => diagnostics.push(code),
  })
  emptyController.refresh()
  assert.deepEqual(diagnostics, [MOBILE_SIDEBAR_DIAGNOSTIC_STRUCTURE_MISSING])
  assert.equal(empty.documentElement.hasAttribute(MOBILE_SIDEBAR_MODE_ATTRIBUTE), false)
  assert.equal(empty.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`), null)
  emptyController.dispose()

  // 缺少布局服务：按钮仍要出现（用户至少能看到入口），但报出可解释诊断。
  const noToggle = new FakeDocument()
  const noToggleFrame = appFrame(noToggle)
  noToggleFrame.style.gridTemplateColumns = GRID
  noToggleFrame.setAttribute('data-sidebar-collapsed', '')
  const noToggleDiagnostics = []
  const noToggleController = startMobileSidebarRailDom({
    document: noToggle,
    window: { innerWidth: 390 },
    MutationObserver: FakeObserver,
    settings: () => ({ hideSidebarOnMobile: true, mobileViewportMaxPx: 1024 }),
    onDiagnostic: (code) => noToggleDiagnostics.push(code),
  })
  assert.ok(noToggle.querySelector(`[${MOBILE_SIDEBAR_BUTTON_ATTRIBUTE}]`))
  assert.deepEqual(noToggleDiagnostics, [MOBILE_SIDEBAR_DIAGNOSTIC_TOGGLE_MISSING])
  noToggleController.dispose()
})

function appFrame(dom) {
  const frame = new FakeElement('div')
  const column = new FakeElement('div')
  column.appendChild(new FakeElement('div'))
  const overlay = new FakeElement('div')
  overlay.setAttribute('data-shell-overlay', '')
  frame.append(column, overlay)
  // DSH 在右栏不占轨道时会写这个属性；默认按“右栏未显示”构造，
  // 需要验证右栏占用时再由用例显式摘掉它。
  frame.setAttribute('data-rightbar-collapsed', '')
  dom.body.appendChild(frame)
  return frame
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class FakeObserver {
  static last
  constructor(callback) {
    this.callback = callback
    FakeObserver.last = this
  }
  observe() {}
  disconnect() {}
  trigger(record) {
    this.callback([{ addedNodes: [], removedNodes: [], target: this, ...record }], this)
  }
}

class FakeStyle {
  constructor() {
    this.gridTemplateColumns = ''
    this.properties = new Map()
  }
  setProperty(name, value) {
    this.properties.set(name, String(value))
  }
  getPropertyValue(name) {
    return this.properties.get(name) ?? ''
  }
  removeProperty(name) {
    this.properties.delete(name)
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.textContent = ''
    this.style = new FakeStyle()
    this.parent = null
    this.listeners = new Map()
  }
  get firstElementChild() {
    return this.children[0] ?? null
  }
  get parentElement() {
    return this.parent
  }
  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }
  remove() {
    if (this.parent === null) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
  contains(node) {
    if (node === this) return true
    return this.children.some((child) => child.contains?.(node) === true)
  }
  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this })
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  hasAttribute(name) {
    return this.attributes.has(name)
  }
  querySelector(selector) {
    return findAll(this, selector)[0] ?? null
  }
  querySelectorAll(selector) {
    return findAll(this, selector)
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html')
    this.head = new FakeElement('head')
    this.body = new FakeElement('body')
    this.documentElement.append(this.head, this.body)
  }
  createElement(tagName) {
    return new FakeElement(tagName)
  }
  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName)
  }
  querySelector(selector) {
    return findAll(this.documentElement, selector)[0] ?? null
  }
  querySelectorAll(selector) {
    return findAll(this.documentElement, selector)
  }
  styleTags() {
    return this.head.children.filter((child) => child.tagName === 'STYLE')
  }
}

function findAll(root, selector) {
  const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector)
  const found = []
  const visit = (node) => {
    for (const child of node.children) {
      if (attribute === null) {
        if (child.tagName === selector.toUpperCase()) found.push(child)
      } else {
        const [, name, value] = attribute
        if (value === undefined ? child.hasAttribute(name) : child.getAttribute(name) === value) found.push(child)
      }
      visit(child)
    }
  }
  visit(root)
  return found
}
