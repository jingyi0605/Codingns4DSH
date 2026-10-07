import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CodingNsWebTerminals } from '../data/build/dist/client/terminal/model.js'
import { createTerminalSessionRecovery as createRecovery } from '../data/build/dist/client/terminal/recovery.js'

/** 仅伪造模型的工作区状态接口，恢复逻辑仍使用真实实现。 */
function createTerminalSessionRecovery(model, sidebar, kind, isAutoCreatePending?, workspaceForSession = (sessionId) => sessionId) {
  const states = new Map<string, boolean>()
  return createRecovery({
    ...model,
    scopeForSession: workspaceForSession,
    terminalCardOpen: (sessionId) => states.get(workspaceForSession(sessionId)),
    setTerminalCardOpen: (sessionId, open) => { states.set(workspaceForSession(sessionId), open) },
  }, sidebar, kind, isAutoCreatePending)
}

const terminal = (id: string) => ({
  id,
  title: '终端',
  shell: { path: '/bin/zsh', args: ['-i'], name: 'zsh' },
  cwd: '/workspace',
  cols: 80,
  rows: 24,
  state: 'running',
  exitCode: null,
})

test('工作区终端在新会话的 Sidebar 缺少标签时只补一个聚合页签', async () => {
  const tabs = new Map<string, { id: string; kind: string }[]>()
  const opened: Array<{ sessionId: string; terminalId: string }> = []
  let recoverCalls = 0
  const sidebar = {
    tabsIn: (sessionId: string) => tabs.get(sessionId) ?? [],
    openTabIn: (sessionId: string, kind: string, options?: { params?: { terminalId?: string } }) => {
      assert.equal(kind, 'terminal')
      const tab = { id: `tab-${opened.length + 1}`, kind }
      tabs.set(sessionId, [...(tabs.get(sessionId) ?? []), tab])
      opened.push({ sessionId, terminalId: options?.params?.terminalId ?? '' })
    },
  }
  const recovery = createTerminalSessionRecovery({
    async recover() {
      recoverCalls += 1
      return [terminal('workspace-terminal')]
    },
  }, sidebar, 'terminal')

  await Promise.all([recovery.ensure('session-a'), recovery.ensure('session-a')])
  await recovery.ensure('session-b')

  assert.equal(recoverCalls, 2)
  assert.deepEqual(opened, [
    { sessionId: 'session-a', terminalId: '' },
    { sessionId: 'session-b', terminalId: '' },
  ])
})

test('用户关闭聚合页签后不会被库存恢复逻辑重新打开', async () => {
  const tabs = new Map<string, { id: string; kind: string }[]>([
    ['session-a', [{ id: 'tab-a', kind: 'terminal' }]],
  ])
  let opened = 0
  const sidebar = {
    tabsIn: (sessionId: string) => tabs.get(sessionId) ?? [],
    openTabIn: (sessionId: string, kind: string) => {
      opened += 1
      tabs.set(sessionId, [{ id: `tab-${opened}`, kind }])
    },
  }
  const recovery = createTerminalSessionRecovery({
    async recover() { return [terminal('still-running')] },
  }, sidebar, 'terminal')

  await recovery.ensure('session-a')
  recovery.close('session-a', 'tab-a')
  tabs.set('session-a', [])
  await recovery.ensure('session-a')

  assert.equal(opened, 0, '用户主动关闭的聚合页签不应被自动补回')
})

test('恢复请求进行中关闭聚合页签也不会被重新打开', async () => {
  const tabs = new Map<string, { id: string; kind: string }[]>([
    ['session-a', [{ id: 'tab-a', kind: 'terminal' }]],
  ])
  let release: (value: readonly ReturnType<typeof terminal>[]) => void = () => undefined
  const listed = new Promise<readonly ReturnType<typeof terminal>[]>((resolve) => { release = resolve })
  let opened = 0
  const recovery = createTerminalSessionRecovery({
    async recover() { return listed },
  }, {
    tabsIn: (sessionId: string) => tabs.get(sessionId) ?? [],
    openTabIn: () => { opened += 1 },
  }, 'terminal')

  const pending = recovery.ensure('session-a')
  recovery.close('session-a', 'tab-a')
  tabs.set('session-a', [])
  release([terminal('still-running')])
  await pending

  assert.equal(opened, 0, '恢复请求等待期间关闭的聚合页签不应被重新打开')
})

test('已有带 terminalId 的 Sidebar 标签不会被恢复逻辑重复打开', async () => {
  let opened = 0
  const sidebar = {
    tabsIn: () => [{ id: 'tab-1', kind: 'terminal' }],
    tabDomain: {
      occurrence: () => ({ navigation: { getSnapshot: () => ({ params: { terminalId: 'workspace-terminal' } }) } }),
    },
    openTabIn: () => { opened += 1 },
  }
  const recovery = createTerminalSessionRecovery({
    async recover() { return [terminal('workspace-terminal')] },
  }, sidebar, 'terminal')

  await recovery.ensure('session-a')
  assert.equal(opened, 0)
})

test('旧版没有导航参数的终端标签仍按已有标签处理', async () => {
  let opened = 0
  const recovery = createTerminalSessionRecovery({
    async recover() { return [terminal('workspace-terminal')] },
  }, {
    tabsIn: () => [{ id: 'tab-1', kind: 'terminal' }],
    openTabIn: () => { opened += 1 },
  }, 'terminal')

  await recovery.ensure('session-a')
  assert.equal(opened, 0)
})

test('多终端库存仍然只补一个聚合页签', async () => {
  const opened: string[] = []
  const recovery = createTerminalSessionRecovery({
    async recover() { return [terminal('terminal-1'), terminal('terminal-2')] },
    boundTerminalId: (_sessionId, contentId) => contentId === 'content-old' ? 'terminal-1' : undefined,
  }, {
    tabsIn: () => [{ id: 'tab-old', kind: 'terminal', contentId: 'content-old' }],
    openTabIn: (_sessionId, _kind, options) => { opened.push(String(options?.params && (options.params as { terminalId?: string }).terminalId)) },
  }, 'terminal')

  await recovery.ensure('session-a')

  assert.deepEqual(opened, [])
})

test('Host 仍有库存时恢复流程保留现有聚合页签', async () => {
  const tabs = new Map<string, { id: string; kind: string }[]>([
    ['session-a', [{ id: 'tab-a', kind: 'terminal' }]],
    ['session-b', [{ id: 'tab-b', kind: 'terminal' }]],
  ])
  const closed: Array<{ sessionId: string; tabId: string }> = []
  const sidebar = {
    tabsIn: (sessionId: string) => tabs.get(sessionId) ?? [],
    tabDomain: {
      occurrence: (_sessionId: string, tab: { id: string }) => ({
        navigation: { getSnapshot: () => ({ params: { terminalId: tab.id === 'tab-a' || tab.id === 'tab-b' ? 'closed-terminal' : '' } }) },
      }),
    },
    closeIn: (sessionId: string, tabId: string) => {
      closed.push({ sessionId, tabId })
      tabs.set(sessionId, (tabs.get(sessionId) ?? []).filter((tab) => tab.id !== tabId))
    },
  }
  const recovery = createTerminalSessionRecovery({
    // Host 里还有别的活终端：列表非空才具备"这个标签确实不在列表里"的判断依据。
    async recover() { return [terminal('still-running')] },
  }, sidebar, 'terminal')

  await recovery.ensure('session-a')

  assert.deepEqual(closed, [])
  assert.deepEqual(tabs.get('session-a'), [{ id: 'tab-a', kind: 'terminal' }])
  assert.deepEqual(tabs.get('session-b'), [{ id: 'tab-b', kind: 'terminal' }])
})

test('Host 列表为空时移除聚合页签记录', async () => {
  const closed: Array<{ sessionId: string; tabId: string }> = []
  const sidebar = {
    // 用户点"新建终端"后刚出现的标签：还没有 terminalId 导航参数。
    tabsIn: () => [{ id: 'brand-new-tab', kind: 'terminal' }],
    closeIn: (sessionId: string, tabId: string) => { closed.push({ sessionId, tabId }) },
  }
  const recovery = createTerminalSessionRecovery({
    // 聚合页只由 Host 库存决定是否存在。
    async recover() { return [] },
    isTerminalRecoveryProtected: () => true,
  }, sidebar, 'terminal')

  await recovery.ensure('session-a')

  assert.deepEqual(closed, [{ sessionId: 'session-a', tabId: 'brand-new-tab' }])
})

test('Host 列表为空且标签没有创建中视图时会移除明确的残留标签', async () => {
  const closed: Array<{ sessionId: string; tabId: string }> = []
  const sidebar = {
    tabsIn: () => [{ id: 'tab-1', kind: 'terminal' }],
    tabDomain: {
      occurrence: () => ({ navigation: { getSnapshot: () => ({ params: { terminalId: 'term-being-created' } }) } }),
    },
    closeIn: (sessionId: string, tabId: string) => { closed.push({ sessionId, tabId }) },
  }
  const recovery = createTerminalSessionRecovery({
    async recover() { return [] },
  }, sidebar, 'terminal')

  await recovery.ensure('session-a')

  assert.deepEqual(closed, [{ sessionId: 'session-a', tabId: 'tab-1' }], 'Host 列表为空且没有创建中视图时应清理残留标签')
})

test('旧 autoCreate 导航参数不会永久阻止空库存清理', async () => {
  const closed: string[] = []
  const sidebar = {
    tabsIn: () => [{ id: 'tab-stale', kind: 'terminal' }],
    tabDomain: {
      occurrence: () => ({ navigation: { getSnapshot: () => ({ params: { autoCreate: true } }) } }),
    },
    closeIn: (_sessionId: string, tabId: string) => { closed.push(tabId) },
  }
  const recovery = createTerminalSessionRecovery({ async recover() { return [] } }, sidebar, 'terminal', () => false)

  await recovery.ensure('session-a')
  assert.deepEqual(closed, ['tab-stale'])
})

test('创建中的 autoCreate 页签在空库存响应期间保持打开', async () => {
  const closed: string[] = []
  const sidebar = {
    tabsIn: () => [{ id: 'tab-creating', kind: 'terminal' }],
    tabDomain: {
      occurrence: () => ({ navigation: { getSnapshot: () => ({ params: { autoCreate: true } }) } }),
    },
    closeIn: (_sessionId: string, tabId: string) => { closed.push(tabId) },
  }
  const recovery = createTerminalSessionRecovery({ async recover() { return [] } }, sidebar, 'terminal', () => true)

  await recovery.ensure('session-a')
  assert.deepEqual(closed, [])
})

test('失效恢复请求不会复用旧列表或覆盖新一代投影', async () => {
  let releaseFirst: (value: readonly ReturnType<typeof terminal>[]) => void = () => undefined
  let releaseSecond: (value: readonly ReturnType<typeof terminal>[]) => void = () => undefined
  const first = new Promise<readonly ReturnType<typeof terminal>[]>((resolve) => { releaseFirst = resolve })
  const second = new Promise<readonly ReturnType<typeof terminal>[]>((resolve) => { releaseSecond = resolve })
  let recoverCalls = 0
  const opened: string[] = []
  const tabs = new Map<string, { id: string; kind: string }[]>()
  const recovery = createTerminalSessionRecovery({
    async recover() {
      recoverCalls += 1
      return recoverCalls === 1 ? first : second
    },
  }, {
    tabsIn: (sessionId: string) => tabs.get(sessionId) ?? [],
    openTabIn: (sessionId: string, kind: string) => {
      opened.push(kind)
      tabs.set(sessionId, [{ id: `tab-${opened.length}`, kind }])
    },
  }, 'terminal')

  const stale = recovery.ensure('session-a')
  // 关闭终端产生库存修订时，当前 pending 必须失效并允许新一代查询启动。
  recovery.invalidate('session-a')
  const current = recovery.ensure('session-a')
  assert.equal(recoverCalls, 2)

  releaseFirst([terminal('closed-before-refresh')])
  await stale
  // 旧请求完成不能因为 finally 删除新 pending，也不能重复打开聚合页。
  const deduplicated = recovery.ensure('session-a')
  assert.strictEqual(deduplicated, current)
  assert.deepEqual(opened, [])

  releaseSecond([terminal('still-running')])
  await current
  assert.deepEqual(opened, ['terminal'])
})

test('原生会话布局尚未装配时打开无效，装配后仍可恢复终端卡片', async () => {
  let adopted = false
  const tabs: { id: string; kind: string }[] = []
  let opened = 0
  const recovery = createTerminalSessionRecovery({
    async recover() { return [terminal('still-running')] },
  }, {
    tabsIn: () => tabs,
    openTabIn: (_sessionId, kind) => {
      opened += 1
      if (adopted) tabs.push({ id: 'terminal-tab', kind })
    },
  }, 'terminal')

  await recovery.ensure('session-a')
  assert.deepEqual(tabs, [], '未装配的原生布局应让打开请求无效')
  adopted = true
  await recovery.ensure('session-a')
  await recovery.ensure('session-a')
  assert.equal(opened, 2, '打开未生效不能被记录为用户关闭，也不能在成功后重复打开')
  assert.deepEqual(tabs, [{ id: 'terminal-tab', kind: 'terminal' }])
})

test('同工作区会话共享终端卡片开关，新会话跟随且不同工作区不受影响', async () => {
  const tabs = new Map<string, { id: string; kind: string }[]>()
  let hostCloses = 0
  const model = new CodingNsWebTerminals(new Context(), {
    environment: async (sessionId) => ({ ok: true, value: {
      workspaceId: sessionId === 'session-c' ? 'workspace-other' : 'workspace-shared',
      cwd: '/workspace', maxInputBytes: 65536, maxCols: 500, maxRows: 200, scrollback: 1000,
    } }),
    list: async () => ({ ok: true, value: [terminal('terminal-1'), terminal('terminal-2')] }),
    close: async () => { hostCloses += 1; return { ok: true, value: undefined } },
  })
  let recovery
  const sidebar = {
    tabsIn: (sessionId) => tabs.get(sessionId) ?? [],
    openTabIn: (sessionId, kind) => { tabs.set(sessionId, [{ id: `tab-${sessionId}`, kind }]) },
    closeIn: (sessionId, tabId) => {
      // 与原生顺序一致：先调用关闭钩子，再提交布局移除。
      recovery.close(sessionId, tabId)
      tabs.set(sessionId, (tabs.get(sessionId) ?? []).filter((tab) => tab.id !== tabId))
    },
  }
  recovery = createRecovery(model, sidebar, 'terminal')
  try {
    await recovery.ensure('session-a')
    model.selectTerminal('session-a', 'terminal-2')
    await recovery.ensure('session-b')
    await recovery.ensure('session-c')
    assert.equal(model.selectedTerminalId('session-b'), 'terminal-2')
    assert.equal(tabs.get('session-b')?.length, 1)

    sidebar.closeIn('session-a', 'tab-session-a')
    assert.deepEqual(tabs.get('session-a'), [])
    assert.deepEqual(tabs.get('session-b'), [])
    assert.equal(tabs.get('session-c')?.length, 1)
    await recovery.ensure('session-new')
    assert.equal((tabs.get('session-new') ?? []).length, 0, '关闭的工作区卡片不能在新会话被自动打开')
    assert.equal(model.selectedTerminalId('session-new'), 'terminal-2', '隐藏卡片仍保留共享子终端选择')

    recovery.open('session-new')
    await recovery.ensure('session-new')
    await recovery.ensure('session-a')
    await recovery.ensure('session-b')
    assert.equal(tabs.get('session-a')?.length, 1)
    assert.equal(tabs.get('session-b')?.length, 1)
    assert.equal(tabs.get('session-new')?.length, 1)
    assert.equal(model.selectedTerminalId('session-a'), 'terminal-2')
    assert.equal(hostCloses, 0, '卡片同步只能修改布局，不能关闭 Host 进程')
  } finally {
    await model.dispose()
  }
})

test('自动清理空库存和旧多标签经过关闭钩子时，不关闭工作区卡片开关', async () => {
  const tabs = new Map<string, { id: string; kind: string }[]>([
    ['session-a', [{ id: 'tab-a', kind: 'terminal' }, { id: 'tab-old', kind: 'terminal' }]],
  ])
  let inventory = [terminal('still-running')]
  let recovery
  const sidebar = {
    tabsIn: (sessionId) => tabs.get(sessionId) ?? [],
    openTabIn: (sessionId, kind) => { tabs.set(sessionId, [{ id: 'restored', kind }]) },
    closeIn: (sessionId, tabId) => {
      recovery.close(sessionId, tabId)
      tabs.set(sessionId, (tabs.get(sessionId) ?? []).filter((tab) => tab.id !== tabId))
    },
  }
  recovery = createTerminalSessionRecovery({ async recover() { return inventory } }, sidebar, 'terminal')

  await recovery.ensure('session-a')
  assert.deepEqual(tabs.get('session-a'), [{ id: 'tab-a', kind: 'terminal' }])
  inventory = []
  await recovery.ensure('session-a')
  assert.deepEqual(tabs.get('session-a'), [])
  inventory = [terminal('another-running')]
  await recovery.ensure('session-a')
  assert.deepEqual(tabs.get('session-a'), [{ id: 'restored', kind: 'terminal' }])
})
