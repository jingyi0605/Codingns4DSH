import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalSessionRecovery } from '../data/build/dist/client/terminal/recovery.js'

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

test('工作区终端在新会话的 Sidebar 缺少标签时只补一次并复用 Host 身份', async () => {
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
    { sessionId: 'session-a', terminalId: 'workspace-terminal' },
    { sessionId: 'session-b', terminalId: 'workspace-terminal' },
  ])
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

test('Host 已关闭终端时恢复流程会移除其它会话的残留标签', async () => {
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

  assert.deepEqual(closed, [{ sessionId: 'session-a', tabId: 'tab-a' }])
  assert.deepEqual(tabs.get('session-a'), [])
  assert.deepEqual(tabs.get('session-b'), [{ id: 'tab-b', kind: 'terminal' }])
})

test('Host 列表为空时不做任何残留标签清理（新建终端的竞态）', async () => {
  const closed: Array<{ sessionId: string; tabId: string }> = []
  const sidebar = {
    // 用户点"新建终端"后刚出现的标签：还没有 terminalId 导航参数。
    tabsIn: () => [{ id: 'brand-new-tab', kind: 'terminal' }],
    closeIn: (sessionId: string, tabId: string) => { closed.push({ sessionId, tabId }) },
  }
  const recovery = createTerminalSessionRecovery({
    // Host 列表此刻为空：view 的 create 还在进行中。
    async recover() { return [] },
  }, sidebar, 'terminal')

  await recovery.ensure('session-a')

  assert.deepEqual(closed, [], '新建终端不能因为 Host 列表暂时为空就被关闭')
})

test('Host 列表为空时带 terminalId 的标签同样保留', async () => {
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

  assert.deepEqual(closed, [], 'Host 列表为空不构成"该终端已关闭"的证据')
})
