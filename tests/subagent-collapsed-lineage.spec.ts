import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CollapsedSubagentLineage, createSubagentSessionsActions, partitionSubagentEntries, registerCollapsedSubagentLineage, shouldRefreshSubagentCatalog } from '../src/client/subagent-collapsed-lineage.js'
import { subagentCollapsedLineageFeature } from '../src/client/features/subagent-collapsed-lineage.js'

test('停止子 Agent 只进入默认收起分组，运行中和诊断项保持可见', () => {
  const result = partitionSubagentEntries([
    { kind: 'child', id: 'running', mode: 'continuable', activity: 'running', hasChildren: false },
    { kind: 'child', id: 'stopped', mode: 'continuable', activity: 'inactive', hasChildren: false },
    { kind: 'diagnostic', id: 'broken', reason: 'corrupt' },
  ])
  assert.deepEqual(result.running.map(entry => entry.id), ['running'])
  assert.deepEqual(result.inactive.map(entry => entry.id), ['stopped'])
  assert.deepEqual(result.diagnostics.map(entry => entry.id), ['broken'])
})

test('明确的 idle 摘要覆盖滞后的 running 目录态，避免停止项继续显示为运行中', () => {
  const result = partitionSubagentEntries([
    { kind: 'child', id: 'stopped', mode: 'one-shot', activity: 'running', hasChildren: false },
  ], {
    stopped: { id: 'stopped', running: false },
  })
  assert.deepEqual(result.running, [])
  assert.deepEqual(result.inactive.map(entry => entry.id), ['stopped'])
})

test('子智能体目录打开时会补拉摘要已经计数但目录尚未加载的父会话', () => {
  assert.equal(shouldRefreshSubagentCatalog(undefined, 1), true)
  assert.equal(shouldRefreshSubagentCatalog({ state: 'loading', entries: [] }, 1), true)
  assert.equal(shouldRefreshSubagentCatalog({ state: 'ready', entries: [] }, 1), true)
  assert.equal(shouldRefreshSubagentCatalog({ state: 'ready', entries: [{ kind: 'child' }] }, 1), false)
  assert.equal(shouldRefreshSubagentCatalog({ state: 'ready', entries: [{ kind: 'diagnostic' }] }, 1), true)
  assert.equal(shouldRefreshSubagentCatalog({ state: 'ready', entries: [] }, 0), false)
})

test('根会话不在 lineage 重复渲染目录入口，计数只由 header.actions 提供', () => {
  const markup = renderToStaticMarkup(createElement(CollapsedSubagentLineage, {
    lineageSessionId: 'root',
    useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { root: { id: 'root', origin: 'root' } } }),
    openChild: () => undefined,
    refresh: () => undefined,
    setCatalogOpen: () => undefined,
    t: ((key: string) => key) as never,
  } as never))
  assert.equal(markup, '')
})

test('停止子 Agent 投影默认启用且不提供设置开关，避免被外部 Agent 模块状态误关', () => {
  assert.equal(subagentCollapsedLineageFeature.descriptor.enabledByDefault, true)
  assert.equal(subagentCollapsedLineageFeature.descriptor.ui, undefined)
  assert.equal(subagentCollapsedLineageFeature.descriptor.minimumDshVersion, '0.2.0-rc.2')
})

test('子 Agent UI 覆盖使用低优先级且复用 DSH Session Controller 动作', () => {
  const registrations: Array<{ readonly options: Record<string, unknown> }> = []
  const fakeSlots = {
    inject(_name: string, callback: () => () => void) {
      const dispose = callback()
      return () => { dispose() }
    },
    register(options: Record<string, unknown>) {
      registrations.push({ options })
      return () => undefined
    },
  }
  const locale = { register: () => () => undefined }
  const opened: unknown[] = []
  const refreshed: string[] = []
  const catalogOpen: Array<[string, boolean]> = []
  const dispose = registerCollapsedSubagentLineage(fakeSlots as never, locale as never, {
    openChild: (address) => { opened.push(address) },
    refresh: (sessionId) => { refreshed.push(sessionId) },
    setSubagentCatalogOpen: (sessionId, open) => { catalogOpen.push([sessionId, open]) },
  })
  assert.deepEqual(registrations.map((item) => item.options.name), [
    'conversation.session.header.lineage',
    'conversation.session.header.actions',
  ])
  assert.equal(registrations[0]?.options.priority, -1)
  assert.equal(registrations[1]?.options.priority, -1)
  assert.equal(registrations[1]?.options.id, 'subagent-catalog')
  const injected = (registrations[1]?.options.inject as () => Record<string, (...args: never[]) => void>)()
  injected.openChild('child-address')
  injected.refresh('parent')
  injected.setCatalogOpen('parent', true)
  assert.deepEqual(opened, ['child-address'])
  assert.deepEqual(refreshed, ['parent'])
  assert.deepEqual(catalogOpen, [['parent', true]])
  dispose()
})

test('DSH 0.2.1 动作适配使用 uiWorkspace.openSession 和 sessions.refreshProjections', () => {
  const opened: unknown[] = []
  const refreshed: string[] = []
  const actions = createSubagentSessionsActions({
    refreshProjections: (sessionId: string) => { refreshed.push(sessionId) },
  }, {
    openSession: (address: unknown) => { opened.push(address) },
  })
  assert.ok(actions)
  actions.openChild('child-address')
  actions.refresh('parent')
  actions.setSubagentCatalogOpen('parent', true)
  assert.deepEqual(opened, ['child-address'])
  assert.deepEqual(refreshed, ['parent'])
})

test('旧版 DSH 动作适配仍保留 openSubagent 和 refreshSubagents', () => {
  const opened: unknown[] = []
  const refreshed: string[] = []
  const actions = createSubagentSessionsActions({
    openSubagent: (address: unknown) => { opened.push(address) },
    refreshSubagents: (sessionId: string) => { refreshed.push(sessionId) },
    setSubagentCatalogOpen: () => undefined,
  }, undefined)
  assert.ok(actions)
  actions.openChild('child-address')
  actions.refresh('parent')
  assert.deepEqual(opened, ['child-address'])
  assert.deepEqual(refreshed, ['parent'])
})

test('原生侧栏动作使用 DSH subagentchat 资源地址并保留父子路由参数', () => {
  const opened: Array<{ address: string; options?: Readonly<Record<string, unknown>> }> = []
  const actions = createSubagentSessionsActions({
    refreshProjections: () => undefined,
  }, {
    openSession: () => undefined,
  }, {
    openResource: (address: string, options?: Readonly<Record<string, unknown>>) => { opened.push({ address, options }) },
  })
  assert.ok(actions?.openChildAside)
  actions.openChildAside!({ parentSessionId: 'parent/1', childSessionId: 'child 2', mode: 'one-shot' })
  assert.equal(opened[0]?.address, 'dsh-resource://subagentchat/session/child%202?parent=parent%2F1&mode=one-shot')
  assert.deepEqual(opened[0]?.options, { kind: 'subagentchat', preferNewPane: true })
})
