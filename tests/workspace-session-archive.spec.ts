import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadWorkspaceArchivedSessions,
  startWorkspaceSessionArchiveDom,
  WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE,
} from '../data/build/dist/client/workspace-session-archive-dom.js'

test('归档摘要按工作区路径过滤并按最近归档时间倒序', async () => {
  const calls: string[] = []
  const remote = {
    workspace: {
      async *follow() {
        yield {
          type: 'baseline',
          value: {
            items: [
              { workspaceId: 'workspace-a', path: '/work/a', sessionIds: ['active-a'], title: 'A', createdAt: '', updatedAt: '' },
              { workspaceId: 'workspace-b', path: '/work/b', sessionIds: [], title: 'B', createdAt: '', updatedAt: '' },
            ],
            archivedSessionIds: ['archived-a-1', 'archived-a-2', 'archived-b-1'],
          },
        }
      },
      async unarchiveSession(input: { sessionId: string }) {
        calls.push(input.sessionId)
      },
    },
    session: {
      async list() {
        return {
          items: [
            { sessionId: 'archived-a-1', updatedAt: 1_700_000_000_000, cwd: '/work/a/project', projections: { values: { title: '较早会话' } } },
            { sessionId: 'archived-a-2', updatedAt: 1_800_000_000_000, cwd: '/work/a', projections: { values: { title: '最近会话' } } },
            { sessionId: 'archived-b-1', updatedAt: 1_900_000_000_000, cwd: '/work/b', projections: { values: { title: 'B 会话' } } },
            { sessionId: 'other', updatedAt: 2_000_000_000_000, cwd: '/other', projections: { values: { title: '不应出现' } } },
          ],
        }
      },
    },
  }

  const result = await loadWorkspaceArchivedSessions(remote, () => 1)
  assert.deepEqual(result.get('workspace-a'), [
    { sessionId: 'archived-a-2', title: '最近会话', archivedAt: 1_800_000_000_000, workspaceId: 'workspace-a' },
    { sessionId: 'archived-a-1', title: '较早会话', archivedAt: 1_700_000_000_000, workspaceId: 'workspace-a' },
  ])
  assert.deepEqual(result.get('workspace-b'), [
    { sessionId: 'archived-b-1', title: 'B 会话', archivedAt: 1_900_000_000_000, workspaceId: 'workspace-b' },
  ])
  assert.equal(result.has('other'), false)
  await remote.workspace.unarchiveSession({ sessionId: 'archived-a-2' })
  assert.deepEqual(calls, ['archived-a-2'])
})

test('归档摘要兼容没有工作目录的单工作区会话', async () => {
  const result = await loadWorkspaceArchivedSessions({
    workspace: {
      async *follow() {
        yield { type: 'baseline', value: { items: [{ workspaceId: 'only', path: '/work', sessionIds: [] }], archivedSessionIds: ['archived'] } }
      },
    },
    session: {
      async list() {
        return { items: [{ sessionId: 'archived', updatedAt: 0, projections: { values: { title: null } } }] }
      },
    },
  }, () => 123)

  assert.deepEqual(result.get('only'), [{ sessionId: 'archived', title: 'archived', archivedAt: 123, workspaceId: 'only' }])
})

test('归档摘要兼容 DSH RemoteResult 并优先使用工作区成员关系', async () => {
  const result = await loadWorkspaceArchivedSessions({
    workspace: {
      async *follow() {
        yield {
          type: 'baseline',
          value: {
            items: [{ workspaceId: 'workspace-a', path: '/work/a', sessionIds: ['archived'] }],
            archivedSessionIds: ['archived'],
          },
        }
      },
    },
    session: {
      async list() {
        return {
          ok: true,
          value: {
            items: [{ sessionId: 'archived', updatedAt: 1_800_000_000_000, projections: { values: { title: '成员会话' } } }],
          },
        }
      },
    },
  }, () => 123)

  assert.deepEqual(result.get('workspace-a'), [{
    sessionId: 'archived',
    title: '成员会话',
    archivedAt: 1_800_000_000_000,
    workspaceId: 'workspace-a',
  }])
})

test('未注入的 Cordis Remote namespace 不应阻断归档模块启动', async () => {
  const remote = new Proxy({}, {
    get(_target, property) {
      throw new Error(`cannot get property ${String(property)} without inject`)
    },
  })

  await assert.doesNotReject(() => loadWorkspaceArchivedSessions(remote))
})

test('归档入口位于工作区会话末尾并跟随工作区折叠', async () => {
  const header = new FakeArchiveElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('aria-expanded', 'true')
  Object.defineProperty(header, '__reactFiber$archive', {
    value: { memoizedProps: { group: { workspaceId: 'workspace-a' } } },
  })
  const sessionOne = new FakeArchiveElement('div')
  sessionOne.setAttribute('role', 'treeitem')
  sessionOne.textContent = '会话一'
  const sessionTwo = new FakeArchiveElement('div')
  sessionTwo.setAttribute('role', 'treeitem')
  sessionTwo.textContent = '会话二'
  const more = new FakeArchiveElement('button')
  more.textContent = '展开其余 27 个会话'
  const group = new FakeArchiveElement('section')
  group.append(header, sessionOne, sessionTwo, more)
  const document = new FakeArchiveDocument(group)
  const controller = startWorkspaceSessionArchiveDom({
    document,
    remote: {
      workspace: {
        async *follow() {
          yield { type: 'baseline', value: { items: [{ workspaceId: 'workspace-a', path: '/work', sessionIds: [] }], archivedSessionIds: [] } }
        },
      },
      session: {
        async list() {
          return { ok: true, value: { items: [] } }
        },
      },
    },
  })

  await nextArchiveTurn()
  const entry = group.children[group.children.length - 2]
  assert.equal(entry.getAttribute(WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE), '')
  assert.equal(group.children.indexOf(more), group.children.length - 1)
  assert.equal(entry.hidden, false)

  header.setAttribute('aria-expanded', 'false')
  controller.refresh()
  await nextArchiveTurn()
  const collapsedEntry = group.children[group.children.length - 2]
  assert.equal(collapsedEntry.getAttribute(WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE), '')
  assert.equal(collapsedEntry.hidden, true)
  assert.equal(collapsedEntry.style.display, 'none')
  assert.equal(group.children.indexOf(more), group.children.length - 1)

  more.remove()
  header.setAttribute('aria-expanded', 'true')
  controller.refresh()
  await nextArchiveTurn()
  const shortListEntry = group.children[group.children.length - 1]
  assert.equal(shortListEntry.getAttribute(WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE), '')
  assert.equal(group.children.indexOf(shortListEntry), group.children.length - 1)
  assert.equal(shortListEntry.hidden, false)
  controller.dispose()
})

function nextArchiveTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

class FakeArchiveElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.style = {}
    this.hidden = false
    this.textContent = ''
  }

  setAttribute(name, value) { this.attributes.set(name, value) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  querySelectorAll(selector) {
    const nodes = collectArchiveNodes(this)
    if (selector === 'button') return nodes.filter((node) => node.tagName === 'BUTTON')
    if (selector === '[role="treeitem"]') return nodes.filter((node) => node.getAttribute('role') === 'treeitem')
    return []
  }
  append(...children) { for (const child of children) this.appendChild(child) }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child }
  insertBefore(child, before) {
    child.parentElement = this
    const index = before === null ? -1 : this.children.indexOf(before)
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }
  addEventListener() {}
  remove() {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }
}

class FakeArchiveDocument {
  constructor(group) {
    this.body = new FakeArchiveElement('body')
    this.documentElement = new FakeArchiveElement('html')
    this.body.appendChild(group)
  }

  createElement(tagName) { return new FakeArchiveElement(tagName) }

  querySelectorAll(selector) {
    const nodes = collectArchiveNodes(this.body)
    if (selector === 'button') return nodes.filter((node) => node.tagName === 'BUTTON')
    if (selector === '[role="treeitem"][aria-expanded]') return nodes.filter((node) => node.getAttribute('role') === 'treeitem' && node.getAttribute('aria-expanded') !== null)
    if (selector === `[${WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE}]`) return nodes.filter((node) => node.getAttribute(WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE) !== null)
    return []
  }

  querySelector() { return null }
}

function collectArchiveNodes(root) {
  return [root, ...root.children.flatMap((child) => collectArchiveNodes(child))]
}
