import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureResourceScopeImpl } from '../dist/features/index.js'
import { CodingNsCliSessionStore } from '../dist/host/cli-adapters/session-store.js'
import {
  workspaceSessionEnhancementFeature,
} from '../dist/client/features/workspace-session-enhancement.js'
import {
  clearSessionAdapters,
  fetchSessionAdapters,
  publishSessionAdapter,
  replaceSessionAdapters,
  sessionAdapterId,
  sessionAdapterSnapshot,
  subscribeSessionAdapters,
} from '../dist/client/session-adapter-cache.js'
import {
  installProviderIcons,
  providerIconUrl,
  providerVisual,
} from '../dist/client/provider-icons.js'
import { resolveDshSessionId } from '../dist/client/workspace-session-fiber.js'
import {
  WORKSPACE_SESSION_LOGO_ATTRIBUTE,
  startWorkspaceSessionLogoDom,
} from '../dist/client/workspace-session-logo-dom.js'

const KNOWN_ADAPTERS = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['command-code', 'Command Code'],
  ['gemini', 'Gemini CLI'],
  ['grok', 'Grok'],
  ['kimi', 'Kimi'],
  ['opencode', 'OpenCode'],
  ['pi', 'Pi'],
  ['dsh', 'DeepSeek Harness'],
]

test('Host 会话映射只返回 sessionId 和 adapterId', () => {
  const store = new CodingNsCliSessionStore()
  store.upsert('session-secret', {
    adapterId: 'codex',
    providerSessionId: 'provider-secret',
    rawStoreRef: '/private/session.jsonl',
    cwd: '/private/project',
    title: '私有标题',
    modelId: 'private-model',
    lastError: 'private-error',
  })

  const bindings = store.adapterBindings()
  assert.deepEqual(bindings, [{ sessionId: 'session-secret', adapterId: 'codex' }])
  assert.deepEqual(Object.keys(bindings[0]).sort(), ['adapterId', 'sessionId'])
  assert.doesNotMatch(JSON.stringify(bindings), /provider-secret|session\.jsonl|private-model|私有标题/u)
})

test('Client 映射读取会丢弃非法记录和 Host-only 字段', async () => {
  const calls = []
  const bindings = await fetchSessionAdapters({
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload })
      return {
        ok: true,
        value: [
          { sessionId: ' session-1 ', adapterId: ' codex ', providerSessionId: '不得进入 Client' },
          { sessionId: '', adapterId: 'kimi' },
          { sessionId: 'session-2', adapterId: 42 },
        ],
      }
    },
  })

  assert.deepEqual(calls, [{ channel: '/codingns', endpoint: 'cli/session/adapter-map', payload: {} }])
  assert.deepEqual(bindings, [{ sessionId: 'session-1', adapterId: 'codex' }])
  assert.deepEqual(Object.keys(bindings[0]).sort(), ['adapterId', 'sessionId'])
})

test('会话映射缓存支持整批替换、增量更新、通知和清空', () => {
  clearSessionAdapters()
  let notifications = 0
  const unsubscribe = subscribeSessionAdapters(() => { notifications += 1 })

  replaceSessionAdapters([
    { sessionId: 'session-1', adapterId: 'codex' },
    { sessionId: 'session-2', adapterId: 'kimi' },
  ])
  assert.deepEqual(sessionAdapterSnapshot(), { 'session-1': 'codex', 'session-2': 'kimi' })
  assert.equal(sessionAdapterId('session-1'), 'codex')
  assert.equal(notifications, 1)

  replaceSessionAdapters([
    { sessionId: 'session-1', adapterId: 'codex' },
    { sessionId: 'session-2', adapterId: 'kimi' },
  ])
  publishSessionAdapter('session-1', 'codex')
  publishSessionAdapter('', 'grok')
  assert.equal(notifications, 1, '无变化或非法更新不应触发重扫')

  publishSessionAdapter('session-1', 'grok')
  assert.equal(sessionAdapterId('session-1'), 'grok')
  assert.equal(notifications, 2)

  replaceSessionAdapters([{ sessionId: 'session-3', adapterId: 'pi' }])
  assert.deepEqual(sessionAdapterSnapshot(), { 'session-3': 'pi' })
  assert.equal(notifications, 3)

  clearSessionAdapters()
  assert.deepEqual(sessionAdapterSnapshot(), {})
  assert.equal(notifications, 4)
  unsubscribe()
  publishSessionAdapter('session-4', 'dsh')
  assert.equal(notifications, 4)
  clearSessionAdapters()
})

test('Provider 映射覆盖九个已知适配器且未知值使用中性占位', () => {
  const icons = Object.fromEntries(KNOWN_ADAPTERS.map(([adapterId]) => [adapterId, `asset:${adapterId}`]))
  installProviderIcons(icons)

  for (const [adapterId, displayName] of KNOWN_ADAPTERS) {
    assert.deepEqual(providerVisual(adapterId), {
      adapterId,
      displayName,
      iconUrl: `asset:${adapterId}`,
    })
    assert.equal(providerIconUrl(adapterId), `asset:${adapterId}`)
  }
  assert.deepEqual(providerVisual(undefined), {
    adapterId: null,
    displayName: '未绑定 Agent',
    iconUrl: undefined,
  })
  assert.deepEqual(providerVisual('future-agent'), {
    adapterId: 'future-agent',
    displayName: '未知 Agent（future-agent）',
    iconUrl: undefined,
  })
  assert.notEqual(providerVisual('future-agent').displayName, 'Codex')
  installProviderIcons({})
})

test('Fiber 解析只接受有限深度内的 node.id 或 result.id', () => {
  const grouped = new FakeElement('div')
  attachFiber(grouped, { node: { id: ' grouped-session ' } })
  assert.equal(resolveDshSessionId(grouped), 'grouped-session')

  const search = new FakeElement('button')
  attachFiber(search, { result: { id: 'search-session' } }, 31)
  assert.equal(resolveDshSessionId(search), 'search-session')

  const tooDeep = new FakeElement('div')
  attachFiber(tooDeep, { node: { id: 'hidden-session' } }, 32)
  assert.equal(resolveDshSessionId(tooDeep), undefined)

  const blank = new FakeElement('div')
  attachFiber(blank, { node: { id: ' ' } })
  assert.equal(resolveDshSessionId(blank), undefined)
  assert.equal(resolveDshSessionId(new FakeElement('div')), undefined)
})

test('DOM 注入覆盖分组、平铺、搜索、DSH 默认值、重复扫描和完整清理', async () => {
  clearSessionAdapters()
  installProviderIcons({
    codex: 'data:image/png;base64,Y29kZXg=',
    dsh: 'data:image/svg+xml;base64,ZHNo',
  })
  const grouped = sessionRow('div', 'grouped', false)
  const flat = sessionRow('div', 'flat', false)
  const search = sessionRow('button', 'search', true)
  const unresolved = new FakeElement('div')
  unresolved.appendChild(new FakeElement('span'))
  const dom = new FakeDocument([grouped.row, flat.row, search.row, unresolved])
  publishSessionAdapter('grouped', 'codex')
  publishSessionAdapter('flat', 'unknown-agent')
  let observer

  class FakeObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observer = this
    }

    observe(target, options) {
      this.target = target
      this.options = options
    }

    disconnect() {
      this.disconnected = true
    }

    trigger() {
      this.callback([], this)
    }
  }

  const controller = startWorkspaceSessionLogoDom({
    document: dom,
    MutationObserver: FakeObserver,
  })

  const groupedLogo = grouped.row.children[0]
  assert.equal(groupedLogo.hasAttribute(WORKSPACE_SESSION_LOGO_ATTRIBUTE), true)
  assert.equal(groupedLogo.children[0].tagName, 'IMG')
  assert.equal(groupedLogo.children[0].alt, '')
  assert.equal(groupedLogo.children[0].attributes.get('aria-hidden'), 'true')
  assert.equal(groupedLogo.title, 'Codex')
  assert.equal(groupedLogo.style.width, '16px')
  assert.equal(groupedLogo.style.height, '16px')
  assert.equal(groupedLogo.style.flex, '0 0 16px')
  assert.equal(grouped.row.children[1], grouped.status, 'Logo 必须位于状态点之前')

  const flatLogo = flat.row.children[0]
  assert.equal(flatLogo.textContent, '?')
  assert.equal(flatLogo.title, '未知 Agent（unknown-agent）')
  assert.equal(flat.row.children[1], flat.status)

  const searchLogo = search.titleLine.children[0]
  assert.equal(searchLogo.children[0].tagName, 'IMG')
  assert.equal(searchLogo.children[0].src, 'data:image/svg+xml;base64,ZHNo')
  assert.equal(searchLogo.title, 'DeepSeek Harness')
  assert.equal(search.titleLine.children[1], search.status, '搜索结果 Logo 必须位于标题行状态点之前')
  assert.equal(unresolved.children.length, 1, '无法解析 sessionId 的行不得修改')

  controller.refresh()
  await nextTurn()
  assert.equal(dom.querySelectorAll(`[${WORKSPACE_SESSION_LOGO_ATTRIBUTE}]`).length, 3, '重复扫描不得重复注入')

  const added = sessionRow('div', 'added', false)
  dom.rows.push(added.row)
  observer.trigger()
  await nextTurn()
  assert.equal(added.row.children[0].title, 'DeepSeek Harness', '新增的原生 DSH 会话应显示 DSH Logo')

  controller.dispose()
  assert.equal(observer.disconnected, true)
  assert.equal(dom.querySelectorAll(`[${WORKSPACE_SESSION_LOGO_ATTRIBUTE}]`).length, 0)
  clearSessionAdapters()
  installProviderIcons({})
})

test('模块总开关释放资源，子开关实时启停并保留设置值', async () => {
  clearSessionAdapters()
  let value = {
    workspaceSessionEnhancement: { showAdapterLogo: true, showArchivedSessions: true, showSubscriptionUsage: true },
  }
  const listeners = new Set()
  const calls = []
  let subscriptionRegistrations = 0
  let subscriptionDisposals = 0
  const slots = {
    inject(_name, register) {
      register()
      subscriptionRegistrations += 1
      return () => { subscriptionDisposals += 1 }
    },
    register() {
      return () => undefined
    },
  }
  const settings = {
    getSnapshot() {
      return { status: 'ready', writable: true, value }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const services = {
    settings,
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        return { ok: true, value: [{ sessionId: 'session-module', adapterId: 'kimi' }] }
      },
    },
    slots,
  }
  const resources = new FeatureResourceScopeImpl()

  workspaceSessionEnhancementFeature.start({
    descriptor: workspaceSessionEnhancementFeature.descriptor,
    resources,
    services,
  })
  await nextTurn()
  assert.equal(calls.length, 1)
  assert.equal(sessionAdapterId('session-module'), 'kimi')
  assert.equal(subscriptionRegistrations, 1)

  value = { workspaceSessionEnhancement: { showAdapterLogo: false, showArchivedSessions: true, showSubscriptionUsage: true } }
  for (const listener of [...listeners]) listener()
  assert.equal(sessionAdapterId('session-module'), undefined)
  assert.equal(value.workspaceSessionEnhancement.showAdapterLogo, false, '停用只清理资源，不改写设置值')
  assert.equal(subscriptionRegistrations, 1, '关闭 Logo 子项不应影响订阅子项')

  value = { workspaceSessionEnhancement: { showAdapterLogo: true, showArchivedSessions: true, showSubscriptionUsage: false } }
  for (const listener of [...listeners]) listener()
  await nextTurn()
  assert.equal(calls.length, 2)
  assert.equal(sessionAdapterId('session-module'), 'kimi')
  assert.equal(subscriptionDisposals, 1)

  value = { workspaceSessionEnhancement: { showAdapterLogo: true, showArchivedSessions: true, showSubscriptionUsage: true } }
  for (const listener of [...listeners]) listener()
  assert.equal(subscriptionRegistrations, 2)

  await resources.dispose()
  assert.equal(listeners.size, 0)
  assert.equal(sessionAdapterId('session-module'), undefined)
  assert.equal(subscriptionDisposals, 2)
  assert.equal(value.workspaceSessionEnhancement.showAdapterLogo, true)
})

function attachFiber(row, props, wrappers = 0) {
  let fiber = { memoizedProps: props }
  for (let index = 0; index < wrappers; index += 1) {
    fiber = { memoizedProps: {}, return: fiber }
  }
  Object.defineProperty(row, '__reactFiber$test', { configurable: true, value: fiber })
}

function sessionRow(tagName, sessionId, search) {
  const row = new FakeElement(tagName)
  row.setAttribute('role', 'treeitem')
  const titleLine = new FakeElement('div')
  const status = new FakeElement('span')
  status.setAttribute('data-native-status', '')
  const title = new FakeElement('span')
  title.textContent = sessionId
  titleLine.appendChild(status)
  titleLine.appendChild(title)
  if (search) row.appendChild(titleLine)
  else {
    row.appendChild(status)
    row.appendChild(title)
  }
  attachFiber(row, search ? { result: { id: sessionId } } : { node: { id: sessionId } })
  return { row, titleLine, status }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.style = {}
    this.parent = null
    this.title = ''
    this.textContent = ''
    this.src = ''
    this.alt = ''
  }

  get firstChild() {
    return this.children[0] ?? null
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  insertBefore(child, before) {
    child.parent = this
    if (before === null) this.children.push(child)
    else this.children.splice(this.children.indexOf(before), 0, child)
    return child
  }

  setAttribute(name, value) {
    this.attributes.set(name, value)
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  querySelector(selector) {
    return findAll(this, selector)[0] ?? null
  }

  remove() {
    if (this.parent === null) return
    const index = this.parent.children.indexOf(this)
    if (index >= 0) this.parent.children.splice(index, 1)
    this.parent = null
  }
}

class FakeDocument {
  constructor(rows) {
    this.rows = rows
    this.documentElement = new FakeElement('html')
  }

  createElement(tagName) {
    return new FakeElement(tagName)
  }

  querySelectorAll(selector) {
    if (selector === '[role="treeitem"]') return this.rows
    return this.rows.flatMap((row) => findAll(row, selector))
  }
}

function findAll(root, selector) {
  const attribute = /^\[([^\]]+)\]$/u.exec(selector)?.[1]
  if (attribute === undefined) return []
  const matches = []
  const visit = (node) => {
    if (node.hasAttribute(attribute)) matches.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return matches
}
