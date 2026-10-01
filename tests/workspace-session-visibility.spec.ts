import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKSPACE_SESSION_HIDDEN_ATTRIBUTE,
  WORKSPACE_SESSION_HIDDEN_FILTER_CHECK_ATTRIBUTE,
  WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE,
  WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE,
  WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE,
  startWorkspaceSessionVisibilityDom,
} from '../data/build/dist/client/workspace-session-visibility-dom.js'
import { loadWorkspaceRecords } from '../data/build/dist/client/workspace-session-archive-dom.js'

test('工作区基线读取保留标题并兼容缺少标题的旧记录', async () => {
  const records = await loadWorkspaceRecords({
    workspace: {
      async *follow() {
        yield {
          type: 'baseline',
          value: {
            items: [
              { workspaceId: 'workspace-a', path: '/repo/a', title: '项目 A', sessionIds: [] },
              { workspaceId: 'workspace-b', path: '/repo/b', sessionIds: [] },
            ],
            archivedSessionIds: [],
          },
        }
      },
    },
  })
  assert.deepEqual(records.map((record) => ({ id: record.workspaceId, title: record.title })), [
    { id: 'workspace-a', title: '项目 A' },
    { id: 'workspace-b', title: '/repo/b' },
  ])
})

test('工作区菜单隐藏动作与筛选恢复列表不破坏原生菜单', async () => {
  const root = new FakeElement('div')
  root.setAttribute('role', 'tree')
  const filterTrigger = new FakeElement('button')
  filterTrigger.setAttribute('aria-label', '视图选项')
  let openFilterMenu = null
  filterTrigger.addEventListener('click', (event) => {
    if (!event.programmatic) return
    openFilterMenu?.remove()
    openFilterMenu = null
  })
  const workspaceA = workspaceRow('workspace-a', '项目 A')
  const workspaceB = workspaceRow('workspace-b', '项目 B')
  root.append(filterTrigger, workspaceA.container, workspaceB.container)
  const dom = new FakeDocument(root)
  const remote = {
    workspace: {
      async *follow() {
        yield {
          type: 'baseline',
          value: {
            items: [
              { workspaceId: 'workspace-a', path: '/repo/a', title: '项目 A', sessionIds: [] },
              { workspaceId: 'workspace-b', path: '/repo/b', title: '项目 B', sessionIds: [] },
            ],
            archivedSessionIds: [],
          },
        }
      },
    },
  }
  let observer
  class FakeObserver {
    constructor(callback) {
      this.callback = callback
      observer = this
    }
    observe() {}
    disconnect() {}
    trigger(target) { this.callback([{ target }], this) }
  }
  const persisted = []
  const controller = startWorkspaceSessionVisibilityDom({
    document: dom,
    MutationObserver: FakeObserver,
    remote,
    hiddenWorkspaceIds: ['workspace-b'],
    onHiddenWorkspaceIdsChange(ids) { persisted.push([...ids]) },
  })
  await nextTurn()

  assert.equal(workspaceB.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), true)
  assert.equal(workspaceA.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), false)
  assert.equal(dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`), null)

  // DSH 可能在 pointerdown 与 click 之间挂载 Portal 菜单；pointerdown
  // 不应提前触发插件扫描并丢失筛选菜单上下文。
  filterTrigger.dispatch('pointerdown')
  const filterMenu = new FakeElement('div')
  filterMenu.textContent = '分组方式 排序方式 筛选会话'
  filterMenu.append(
    menuItem('按工作区'),
    menuItem('最近更新'),
    menuItem('全部对话'),
  )
  root.appendChild(filterMenu)
  openFilterMenu = filterMenu
  observer.trigger(filterMenu)
  await nextTurn()
  filterTrigger.dispatch('click')
  await nextTurn()
  const showHiddenAction = filterMenu.querySelector(`[${WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE}]`)
  assert.ok(showHiddenAction)
  assert.equal(showHiddenAction.querySelector(`[${WORKSPACE_SESSION_HIDDEN_FILTER_CHECK_ATTRIBUTE}]`), null)
  showHiddenAction.dispatch('click')
  await timerTurn()
  await nextTurn()
  assert.equal(filterMenu.parentElement, null)

  const footer = dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`)
  assert.ok(footer)
  assert.match(footer.querySelector('button').textContent, /隐藏的工作区 1/u)
  // 其他 DOM 控制器触发扫描时，恢复入口必须复用原节点，避免与归档入口
  // 的 MutationObserver 互相删除和重建，形成主线程死循环。
  observer.trigger(root)
  await nextTurn()
  assert.equal(dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`), footer)

  filterMenu.remove()
  // 过滤菜单关闭时，Portal 可能暂时保留一个不可见的旧节点；打开工作区菜单
  // 时必须选择当前可见菜单，不能把“显示隐藏的工作区”注入旧节点。
  const staleFilterMenu = new FakeElement('div')
  staleFilterMenu.setAttribute('role', 'menu')
  staleFilterMenu.setAttribute('aria-hidden', 'true')
  staleFilterMenu.textContent = '分组方式 排序方式 筛选会话'
  staleFilterMenu.append(menuItem('按工作区'), menuItem('最近更新'), menuItem('全部对话'))
  root.appendChild(staleFilterMenu)
  workspaceA.menuTrigger.dispatch('click')
  const menu = new FakeElement('div')
  menu.setAttribute('role', 'menu')
  root.appendChild(menu)
  observer.trigger(menu)
  await nextTurn()
  const hideAction = menu.querySelector(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`)
  assert.ok(hideAction)
  assert.equal(staleFilterMenu.querySelector(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`), null)
  assert.equal(menu.querySelector(`[${WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE}]`), null)
  hideAction.dispatch('click')
  await timerTurn()
  await nextTurn()
  assert.deepEqual(persisted.at(-1), ['workspace-b', 'workspace-a'])
  assert.equal(workspaceA.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), true)
  assert.equal(menu.parentElement, root)
  menu.remove()
  staleFilterMenu.remove()

  const currentFooter = dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`)
  const toggle = currentFooter?.querySelector('button')
  assert.ok(toggle)
  toggle.dispatch('click')
  const restore = currentFooter?.querySelector('[role="menuitem"]')
  assert.ok(restore)
  restore.dispatch('click')
  await nextTurn()
  assert.deepEqual(persisted.at(-1), ['workspace-b'])
  assert.equal(workspaceA.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), false)

  const reopenedFilterMenu = new FakeElement('div')
  reopenedFilterMenu.textContent = '分组方式 排序方式 筛选会话'
  reopenedFilterMenu.append(
    menuItem('按工作区'),
    menuItem('最近更新'),
    menuItem('全部对话'),
  )
  root.appendChild(reopenedFilterMenu)
  openFilterMenu = reopenedFilterMenu
  observer.trigger(reopenedFilterMenu)
  await nextTurn()
  filterTrigger.dispatch('click')
  await nextTurn()
  const checkedAction = reopenedFilterMenu.querySelector(`[${WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE}]`)
  assert.ok(checkedAction)
  assert.ok(checkedAction.querySelector(`[${WORKSPACE_SESSION_HIDDEN_FILTER_CHECK_ATTRIBUTE}]`))
  checkedAction.dispatch('click')
  await timerTurn()
  await nextTurn()
  assert.equal(reopenedFilterMenu.parentElement, null)
  assert.equal(dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`), null)

  controller.dispose()
  assert.equal(workspaceB.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), false)
  assert.equal(dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`), null)
})

function workspaceRow(id, title) {
  const container = new FakeElement('section')
  const header = new FakeElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('aria-expanded', 'true')
  attachWorkspaceFiber(header, id)
  const menuTrigger = new FakeElement('button')
  menuTrigger.setAttribute('aria-haspopup', 'menu')
  menuTrigger.setAttribute('aria-label', `${title} 菜单`)
  header.append(menuTrigger)
  const session = new FakeElement('div')
  session.setAttribute('role', 'treeitem')
  container.append(header, session)
  return { container, header, menuTrigger }
}

function menuItem(label) {
  const item = new FakeElement('button')
  item.setAttribute('role', 'menuitem')
  item.textContent = label
  return item
}

function attachWorkspaceFiber(element, workspaceId) {
  Object.defineProperty(element, '__reactFiber$test', {
    configurable: true,
    value: { memoizedProps: { workspace: { workspaceId } } },
  })
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

function timerTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = {}
    this.hidden = false
    this.textContent = ''
    this.title = ''
    this.listeners = new Map()
  }
  append(...children) { for (const child of children) this.appendChild(child) }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child }
  insertBefore(child, before) { child.parentElement = this; const index = before === null ? -1 : this.children.indexOf(before); if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); return child }
  remove() { if (this.parentElement === null) return; this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)) }
  addEventListener(type, listener) { const handlers = this.listeners.get(type) ?? []; handlers.push(listener); this.listeners.set(type, handlers) }
  dispatch(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this, ...event }) }
  click() { this.dispatch('click', { programmatic: true }) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector) {
    const matches = []
    const visit = (node) => {
      if (selectorMatches(node, selector)) matches.push(node)
      for (const child of node.children) visit(child)
    }
    visit(this)
    return matches
  }
  closest(selector) { let current = this; while (current !== null) { if (selectorMatches(current, selector)) return current; current = current.parentElement } return null }
}

class FakeDocument {
  constructor(root) {
    this.documentElement = new FakeElement('html')
    this.body = new FakeElement('body')
    this.documentElement.appendChild(this.body)
    this.body.appendChild(root)
  }
  createElement(tagName) { return new FakeElement(tagName) }
  querySelector(selector) { return this.documentElement.querySelector(selector) }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector) }
}

function selectorMatches(element, selector) {
  return selector.split(',').some((part) => {
    const value = part.trim()
    if (value === 'button') return element.tagName === 'BUTTON'
    if (value === '[role="button"]') return element.getAttribute('role') === 'button'
    if (value === '[role="menu"]') return element.getAttribute('role') === 'menu'
    if (value === '[role="menuitem"]') return element.getAttribute('role') === 'menuitem'
    if (value === '[role="treeitem"][aria-expanded]') return element.getAttribute('role') === 'treeitem' && element.hasAttribute('aria-expanded')
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(value)
    return attribute !== null && element.hasAttribute(attribute[1]) && (attribute[2] === undefined || element.getAttribute(attribute[1]) === attribute[2])
  })
}
