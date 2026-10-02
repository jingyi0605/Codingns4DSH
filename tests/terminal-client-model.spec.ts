import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  CodingNsTerminalView,
  CodingNsWebTerminals,
} from '../data/build/dist/client/terminal/model.js'

const environment = {
  cwd: '/workspace',
  maxInputBytes: 64 * 1024,
  maxCols: 500,
  maxRows: 200,
  scrollback: 1000,
}

const terminalInfo = {
  id: 'terminal-1',
  title: 'zsh',
  shell: { path: '/bin/zsh', args: ['-i'], name: 'zsh' },
  cwd: '/workspace',
  cols: 80,
  rows: 24,
  state: 'running',
  exitCode: null,
}

function success(value) {
  return { ok: true, value }
}

function createRemote(listed = false) {
  const calls = { create: 0, close: 0, environment: 0, list: 0, write: [], resize: [], followAborts: 0 }
  const remote = {
    async close() { calls.close += 1; return success(undefined) },
    async create() { calls.create += 1; return success(terminalInfo) },
    async environment() { calls.environment += 1; return success(environment) },
    async *follow(_sessionId, _id, _attachmentId, signal) {
      yield { type: 'snapshot', sequence: 0, screen: '$ ', info: terminalInfo }
      await new Promise((resolve) => {
        if (signal?.aborted) resolve(undefined)
        else signal?.addEventListener('abort', () => resolve(undefined), { once: true })
      })
      calls.followAborts += 1
    },
    async list() { calls.list += 1; return success(listed ? [terminalInfo] : []) },
    async rename() { return success(undefined) },
    async resize(_sessionId, _id, _attachmentId, cols, rows) {
      calls.resize.push([cols, rows])
      return success(undefined)
    },
    async shells() { return success([terminalInfo.shell]) },
    async write(_sessionId, _id, _attachmentId, data) {
      calls.write.push(data)
      return success(undefined)
    },
  }
  return { calls, remote }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('Client 视图卸载只 detach，不调用 Host close', async () => {
  const { calls, remote } = createRemote()
  const view = new CodingNsTerminalView('session-1', 'terminal-1', remote, true, '/bin/zsh')
  const unmount = view.mount()

  await waitFor(() => view.state.getSnapshot().render !== undefined, '终端 snapshot 未到达 Client')
  const render = view.state.getSnapshot().render
  assert.ok(render)
  view.acknowledge(render.revision)
  view.write('pwd\r')
  await waitFor(() => calls.write.length === 1, '终端输入未发送到 Host')

  unmount()
  await waitFor(() => calls.followAborts === 1, '终端 follow 未在视图卸载时 detach')
  assert.equal(calls.create, 1)
  assert.equal(calls.close, 0)

  await view.dispose()
  assert.equal(calls.close, 0)
})

test('Sidebar 显式关闭才结束 Host 终端', async () => {
  const { calls, remote } = createRemote(true)
  const service = new CodingNsWebTerminals(new Context(), remote)
  const view = service.view('session-1', 'tab-1', 'content-1', 'terminal-1')
  const unmount = view.mount()

  await waitFor(() => view.state.getSnapshot().render !== undefined, '恢复终端 snapshot 未到达 Client')
  const render = view.state.getSnapshot().render
  assert.ok(render)
  view.acknowledge(render.revision)

  service.close('session-1', 'tab-1', 'content-1', 'terminal-1')
  await waitFor(() => calls.close === 1, '显式关闭没有调用 Host close')
  assert.equal(calls.create, 0)
  assert.equal(view.state.getSnapshot().phase, 'closed')

  unmount()
  await service.dispose()
  assert.equal(calls.close, 1)
})

test('重复尺寸变化只向 Host 发送一次 resize', async () => {
  const { calls, remote } = createRemote(true)
  const view = new CodingNsTerminalView('session-1', 'terminal-1', remote, false)
  const unmount = view.mount()
  await waitFor(() => view.state.getSnapshot().render !== undefined, '终端 snapshot 未到达 Client')
  const render = view.state.getSnapshot().render
  assert.ok(render)
  view.acknowledge(render.revision)

  view.resize(80, 24)
  view.resize(80, 24)
  view.resize(80, 24)
  await waitFor(() => calls.resize.length === 1, '重复尺寸没有收敛为一次 resize')
  assert.deepEqual(calls.resize, [[80, 24]])

  unmount()
  await view.dispose()
})

test('终端 Remote 晚于 Client 注册时可以在就绪后重试', async () => {
  const { remote } = createRemote()
  let currentRemote
  const service = new CodingNsWebTerminals(new Context(), () => currentRemote)

  await assert.rejects(
    service.launchShells('session-1', new AbortController().signal),
    /终端服务尚未就绪，请稍后重试/u,
  )

  currentRemote = remote
  const result = await service.launchShells('session-1', new AbortController().signal)
  assert.deepEqual(result.shells, [terminalInfo.shell])
  await service.dispose()
})

test('Remote 注册竞态不会把持久化关闭请求显示成失败', async () => {
  const previousStorage = globalThis.localStorage
  const values = new Map<string, string>([
    ['dsh.codingns.terminal.close.v1', JSON.stringify([{ sessionId: 'session-1', id: 'terminal-1', title: '终端' }])],
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, String(value)) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  try {
    const { calls, remote } = createRemote(true)
    let currentRemote
    const service = new CodingNsWebTerminals(new Context(), () => currentRemote)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls.close, 0)
    assert.deepEqual(service.closeFailures.getSnapshot(), [])

    currentRemote = remote
    service.remoteReady()
    await waitFor(() => calls.close === 1, 'Remote 就绪后未冲刷关闭请求')
    assert.deepEqual(service.closeFailures.getSnapshot(), [])
    assert.equal(values.get('dsh.codingns.terminal.close.v1'), '[]')
    await service.dispose()
  } finally {
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
  }
})

test('恢复终端先解析工作区再读取工作区终端列表', async () => {
  const { calls, remote } = createRemote(true)
  const service = new CodingNsWebTerminals(new Context(), remote)
  const terminals = await service.recover('session-1')
  assert.deepEqual(terminals, [terminalInfo])
  assert.equal(calls.environment, 1)
  assert.equal(calls.list, 1)
  await service.dispose()
})

test('并发恢复同一会话只执行一次工作区查询', async () => {
  const { calls, remote } = createRemote(true)
  const service = new CodingNsWebTerminals(new Context(), remote)
  const [first, second] = await Promise.all([service.recover('session-1'), service.recover('session-1')])
  assert.deepEqual(first, second)
  assert.equal(calls.environment, 1)
  assert.equal(calls.list, 1)
  await service.dispose()
})

test('Client 在解析工作区后按工作区键复用终端绑定', async () => {
  const previousStorage = globalThis.localStorage
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, String(value)) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  try {
    const { remote } = createRemote(true)
    remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
    const service = new CodingNsWebTerminals(new Context(), remote)
    const first = service.view('session-a', 'tab-a', 'content-a')
    await first.refresh()
    const workspaceTerminals = await service.recover('session-b')
    assert.deepEqual(workspaceTerminals, [terminalInfo])
    const second = service.view('session-b', 'tab-b', 'content-b')
    assert.equal(second.id, first.id)
    await service.dispose()
  } finally {
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
  }
})

test('显式新建终端不会复用工作区已有 terminalId', async () => {
  const previousStorage = globalThis.localStorage
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, String(value)) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  try {
    const { calls, remote } = createRemote(true)
    const closed: string[] = []
    let nextId = 1
    remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
    remote.create = async (_sessionId, request) => {
      calls.create += 1
      return success({ ...terminalInfo, id: request.id ?? `terminal-created-${nextId++}` })
    }
    remote.close = async (_sessionId, id) => { calls.close += 1; closed.push(id); return success(undefined) }
    const service = new CodingNsWebTerminals(new Context(), remote)
    const first = service.view('session-a', 'tab-a', 'content-a')
    await first.refresh()
    const second = service.view('session-a', 'tab-b', 'content-b', undefined, undefined, true)
    await second.refresh()

    assert.notEqual(second.id, first.id)
    assert.equal(calls.create, 2)
    service.close('session-a', 'tab-b', 'content-b', second.id)
    await waitFor(() => calls.close === 1, '关闭第二个终端未调用 Host close')
    assert.deepEqual(closed, [second.id])
    assert.equal(values.get('dsh.codingns.terminal.binding.v1.' + JSON.stringify(['workspace', 'workspace-stable'])), first.id)
    await service.dispose()
  } finally {
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
  }
})

test('新建终端标签重载后仍恢复自身 terminalId', async () => {
  const previousStorage = globalThis.localStorage
  const values = new Map<string, string>([
    ['dsh.codingns.terminal.binding.v1.' + JSON.stringify(['workspace', 'workspace-stable']), 'terminal-1'],
    ['dsh.codingns.terminal.binding.v1.' + JSON.stringify(['session-a', 'content-b']), 'terminal-2'],
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, String(value)) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  try {
    const { calls, remote } = createRemote(true)
    remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
    remote.list = async () => success([{ ...terminalInfo, id: 'terminal-2' }])
    const service = new CodingNsWebTerminals(new Context(), remote)
    const view = service.view('session-a', 'tab-b', 'content-b', 'terminal-2', undefined, true)
    await view.refresh()

    assert.equal(view.id, 'terminal-2')
    assert.equal(calls.create, 0)
    assert.equal(view.state.getSnapshot().info?.id, 'terminal-2')
    await service.dispose()
  } finally {
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
  }
})

test('恢复已有 terminalId 时不会被工作区绑定覆盖', async () => {
  const previousStorage = globalThis.localStorage
  const values = new Map<string, string>([
    ['dsh.codingns.terminal.binding.v1.' + JSON.stringify(['workspace', 'workspace-stable']), 'terminal-1'],
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, String(value)) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  try {
    const { remote } = createRemote(true)
    remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
    remote.list = async () => success([{ ...terminalInfo, id: 'terminal-2' }])
    const service = new CodingNsWebTerminals(new Context(), remote)
    const view = service.view('session-a', 'tab-a', 'content-a', 'terminal-2')
    await view.refresh()

    assert.equal(view.id, 'terminal-2')
    assert.equal(view.state.getSnapshot().info?.id, 'terminal-2')
    await service.dispose()
  } finally {
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
  }
})

test('Client 首次渲染异步解析工作区时不会覆盖已有终端', async () => {
  const previousStorage = globalThis.localStorage
  const values = new Map<string, string>([
    ['dsh.codingns.terminal.binding.v1.' + JSON.stringify(['workspace', 'workspace-stable']), 'terminal-1'],
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, String(value)) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  try {
    const { calls, remote } = createRemote(true)
    remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
    const service = new CodingNsWebTerminals(new Context(), remote)
    const view = service.view('session-b', 'tab-b', 'content-b')

    await view.refresh()

    assert.equal(view.id, 'terminal-1')
    assert.equal(view.state.getSnapshot().info?.id, 'terminal-1')
    assert.equal(calls.create, 0)
    await service.dispose()
  } finally {
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
  }
})

test('工作区绑定刚被删除时，残留标签不会用显式 terminalId 重建已关闭终端', async () => {
  const { calls, remote } = createRemote(false)
  remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
  const service = new CodingNsWebTerminals(new Context(), remote)
  const view = service.view('session-b', 'tab-b', 'content-b', 'terminal-1')

  await view.refresh()

  assert.equal(calls.create, 0)
  assert.match(view.state.getSnapshot().error ?? '', /Host 中不存在该终端/u)
  await service.dispose()
})

test('Client 会把 0.1.7 早期带 contentId 的工作区键迁移为稳定键', async () => {
  const previousStorage = globalThis.localStorage
  const legacyKey = 'dsh.codingns.terminal.binding.v1.' + JSON.stringify(['workspace', 'workspace-stable', 'new-content'])
  const currentKey = 'dsh.codingns.terminal.binding.v1.' + JSON.stringify(['workspace', 'workspace-stable'])
  const values = new Map<string, string>([[legacyKey, 'terminal-1']])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, String(value)) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  try {
    const { remote } = createRemote(true)
    remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
    const service = new CodingNsWebTerminals(new Context(), remote)
    const view = service.view('session-a', 'tab-a', 'new-content')
    await view.refresh()
    assert.equal(view.id, 'terminal-1')
    assert.equal(values.get(currentKey), 'terminal-1')
    assert.equal(values.has(legacyKey), false)
    await service.dispose()
  } finally {
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
  }
})

test('DSH 0.1.5/0.1.6 缺少 workspaceId 时保持会话级终端显示逻辑', async () => {
  for (const dshVersion of ['0.1.5-rc.3', '0.1.6-alpha.2']) {
    const { calls, remote } = createRemote()
    remote.environment = async () => {
      // 旧版环境响应没有 workspaceId，Client 必须继续使用 session 绑定。
      const { workspaceId: _workspaceId, ...legacyEnvironment } = environment
      return success(legacyEnvironment)
    }
    const service = new CodingNsWebTerminals(new Context(), remote)
    const first = service.view(`${dshVersion}-session-a`, 'tab-a', 'content-a')
    await first.refresh()

    assert.equal(first.state.getSnapshot().info?.id, 'terminal-1')
    assert.equal(calls.create, 1)

    const second = service.view(`${dshVersion}-session-b`, 'tab-b', 'content-a')
    await second.refresh()
    assert.notEqual(second.id, first.id)
    assert.equal(calls.create, 2)
    await service.dispose()
  }
})
