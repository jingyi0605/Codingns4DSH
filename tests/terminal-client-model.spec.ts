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

test('Client 收到恢复首帧后清理 attach 控制权瞬态错误', async () => {
  const { remote } = createRemote()
  let releaseSecondFrame
  const secondFrame = new Promise((resolve) => { releaseSecondFrame = resolve })
  let followCount = 0
  remote.follow = async function* (_sessionId, _id, _attachmentId, signal) {
    yield { type: 'snapshot', sequence: 0, screen: '$ ', info: terminalInfo }
    if (followCount++ === 0) {
      await secondFrame
      yield { type: 'snapshot', sequence: 1, screen: '$ ', info: terminalInfo }
    }
    await new Promise((resolve) => {
      if (signal?.aborted) resolve(undefined)
      else signal?.addEventListener('abort', () => resolve(undefined), { once: true })
    })
  }
  let rejectFirstWrite = true
  remote.write = async () => {
    if (rejectFirstWrite) {
      rejectFirstWrite = false
      throw new Error('当前 attach 没有终端输入控制权')
    }
    return success(undefined)
  }

  const view = new CodingNsTerminalView('session-1', 'terminal-1', remote, true, '/bin/zsh')
  const unmount = view.mount()
  await waitFor(() => view.state.getSnapshot().render !== undefined, '终端 snapshot 未到达 Client')
  view.acknowledge(view.state.getSnapshot().render.revision)
  view.write('pwd\r')
  await waitFor(() => view.state.getSnapshot().phase === 'failed', '未记录 attach 控制权错误')
  releaseSecondFrame()
  await waitFor(() => view.state.getSnapshot().phase === 'connected' && view.state.getSnapshot().error === undefined, '恢复首帧未清理瞬态错误')
  assert.equal(view.state.getSnapshot().writable, true)

  unmount()
  await view.dispose()
})

test('聚合页常驻视图的多个挂载引用只建立一次 follow', async () => {
  const { calls, remote } = createRemote(true)
  const view = new CodingNsTerminalView('session-1', 'terminal-1', remote, false, '/bin/zsh')
  const firstUnmount = view.mount()
  const secondUnmount = view.mount()

  await waitFor(() => view.state.getSnapshot().render !== undefined, '常驻终端 snapshot 未到达 Client')
  const render = view.state.getSnapshot().render
  assert.ok(render)
  view.acknowledge(render.revision)
  assert.equal(calls.environment, 1)
  assert.equal(calls.list, 1)

  firstUnmount()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.followAborts, 0, '仍有挂载引用时不应释放 Host follow')

  secondUnmount()
  await waitFor(() => calls.followAborts === 1, '最后一个挂载引用释放后应 detach Host follow')
  await view.dispose()
})

test('聚合终端视图卸载 DOM 后保留 Host follow，重新打开无需重新连接', async () => {
  const { calls, remote } = createRemote(true)
  const service = new CodingNsWebTerminals(new Context(), remote)
  const view = service.viewForTerminal('session-1', 'terminal-1', '/bin/zsh')
  const unmount = view.mount()

  await waitFor(() => view.state.getSnapshot().render !== undefined, '聚合终端 snapshot 未到达 Client')
  const render = view.state.getSnapshot().render
  assert.ok(render)
  view.acknowledge(render.revision)

  // 聚合页切换或右栏隐藏会卸载 DOM，但模型仍由工作区库存持有。
  unmount()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.followAborts, 0, '聚合视图卸载 DOM 不应释放 Host follow')

  const remount = view.mount()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.followAborts, 0, '重新打开聚合页不应重新建立连接')
  remount()

  await service.dispose()
  assert.equal(calls.followAborts, 1, '服务销毁时才释放聚合视图的 Host follow')
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

test('旧 Sidebar 关闭路径完成后会刷新共享工作区库存', async () => {
  let closed = false
  const { remote } = createRemote(true)
  remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
  remote.list = async () => success(closed ? [] : [terminalInfo])
  remote.close = async () => { closed = true; return success(undefined) }
  const service = new CodingNsWebTerminals(new Context(), remote)
  await service.recover('session-b')
  assert.deepEqual(service.inventoryForSession('session-b'), [terminalInfo])

  service.close('session-a', 'tab-1', 'content-1', terminalInfo.id)
  await waitFor(() => service.inventoryForSession('session-b').length === 0, '旧 Sidebar 关闭后共享库存未刷新')
  await service.dispose()
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

test('force 尺寸声明在尺寸相同时也会重发一次 resize', async () => {
  const { calls, remote } = createRemote(true)
  const view = new CodingNsTerminalView('session-1', 'terminal-1', remote, false)
  const unmount = view.mount()
  await waitFor(() => view.state.getSnapshot().render !== undefined, '终端 snapshot 未到达 Client')
  const render = view.state.getSnapshot().render
  assert.ok(render)
  view.acknowledge(render.revision)

  view.resize(80, 24)
  await waitFor(() => calls.resize.length === 1, '首次 resize 未发送')
  // 尺寸没变时普通 resize 会被去重；force 用于视图重新可见时夺回尺寸所有权，
  // 保证 tmux 窗口被其它客户端改写后还能回到本视图的宽度。
  view.resize(80, 24)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.resize.length, 1)
  view.resize(80, 24, { force: true })
  await waitFor(() => calls.resize.length === 2, 'force resize 未重发')
  assert.deepEqual(calls.resize, [[80, 24], [80, 24]])

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

test('聚合终端使用工作区库存快照直连，不重复读取环境和列表', async () => {
  const { calls, remote } = createRemote(true)
  remote.environment = async () => { calls.environment += 1; return success({ ...environment, workspaceId: 'workspace-stable' }) }
  const service = new CodingNsWebTerminals(new Context(), remote)
  await service.recover('session-1')

  const view = service.viewForTerminal('session-1', terminalInfo.id, terminalInfo.shell.path)
  const unmount = view.mount()
  await waitFor(() => view.state.getSnapshot().render !== undefined, '库存快照终端未能直接连接')

  assert.equal(calls.environment, 1)
  assert.equal(calls.list, 1)
  assert.equal(view.state.getSnapshot().info?.id, terminalInfo.id)
  unmount()
  await service.dispose()
})

test('切换会话时即使环境快照尚未到达也直接恢复运行中的终端', async () => {
  const { calls, remote } = createRemote(true)
  remote.environment = async () => { calls.environment += 1; return success({ ...environment, workspaceId: 'workspace-stable' }) }
  const service = new CodingNsWebTerminals(new Context(), remote)
  await service.recover('session-1')

  // 模拟新会话刚切入：库存已有 workspace terminal，但该 session 的环境请求尚未完成。
  ;(service as unknown as { environments: Map<string, unknown>; workspaceIds: Map<string, string> }).environments.clear()
  ;(service as unknown as { environments: Map<string, unknown>; workspaceIds: Map<string, string> }).workspaceIds.set('session-2', 'workspace-stable')
  const view = service.viewForTerminal('session-2', terminalInfo.id, terminalInfo.shell.path)
  const unmount = view.mount()
  await waitFor(() => view.state.getSnapshot().render !== undefined, '环境快照缺失时终端未能直接恢复')

  assert.equal(calls.environment, 1)
  assert.equal(view.state.getSnapshot().info?.id, terminalInfo.id)
  unmount()
  await service.dispose()
})

test('同一会话重复恢复复用已缓存的终端环境', async () => {
  const { calls, remote } = createRemote(true)
  remote.environment = async () => { calls.environment += 1; return success({ ...environment, workspaceId: 'workspace-stable' }) }
  const service = new CodingNsWebTerminals(new Context(), remote)

  await service.recover('session-1')
  await service.recover('session-1')

  assert.equal(calls.environment, 1)
  assert.equal(calls.list, 2)
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

test('关闭终端刷新工作区库存时会使其他会话的旧列表响应失效', async () => {
  let releaseStale: ((value: readonly (typeof terminalInfo)[]) => void) | undefined
  const staleList = new Promise<readonly (typeof terminalInfo)[]>((resolve) => { releaseStale = resolve })
  const listCalls = new Map<string, number>()
  const { remote } = createRemote(false)
  remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
  remote.list = async (sessionId) => {
    const count = (listCalls.get(sessionId) ?? 0) + 1
    listCalls.set(sessionId, count)
    if (sessionId === 'session-a' && count === 1) return success(await staleList)
    return success([])
  }
  const service = new CodingNsWebTerminals(new Context(), remote)
  const staleRecovery = service.recover('session-a')
  await waitFor(() => listCalls.get('session-a') === 1, '会话 A 的旧列表请求未挂起')
  await service.recover('session-b')
  await service.refreshInventory('session-b')
  releaseStale?.([terminalInfo])
  await staleRecovery

  assert.deepEqual(service.inventoryForSession('session-a'), [])
  assert.deepEqual(service.inventoryForSession('session-b'), [])
  await service.dispose()
})

test('工作区尚未解析时刷新也会阻止旧列表覆盖共享库存', async () => {
  let releaseEnvironment: (() => void) | undefined
  const pendingEnvironment = new Promise<void>((resolve) => { releaseEnvironment = resolve })
  let environmentStarted = false
  const listCalls = new Map<string, number>()
  const { remote } = createRemote(false)
  remote.environment = async (sessionId) => {
    if (sessionId === 'session-a' && !environmentStarted) {
      environmentStarted = true
      await pendingEnvironment
    }
    return success({ ...environment, workspaceId: 'workspace-stable' })
  }
  remote.list = async (sessionId) => {
    const count = (listCalls.get(sessionId) ?? 0) + 1
    listCalls.set(sessionId, count)
    if (sessionId === 'session-a') return success(count === 1 ? [terminalInfo] : [])
    return success(count === 1 ? [terminalInfo] : [])
  }
  const service = new CodingNsWebTerminals(new Context(), remote)
  await service.recover('session-b')
  const staleRecovery = service.recover('session-a')
  await waitFor(() => environmentStarted, '会话 A 的工作区查询未挂起')

  await service.refreshInventory('session-b')
  releaseEnvironment?.()
  const recovered = await staleRecovery

  assert.deepEqual(recovered, [])
  assert.deepEqual(service.inventoryForSession('session-a'), [])
  assert.deepEqual(service.inventoryForSession('session-b'), [])
  await service.dispose()
})

test('同一聚合页连续新建终端会保留独立身份并可单独关闭', async () => {
  const active = new Map<string, typeof terminalInfo>()
  const { remote } = createRemote(false)
  remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
  remote.list = async () => success([...active.values()])
  remote.create = async (_sessionId, request) => {
    const info = { ...terminalInfo, id: request.id }
    active.set(info.id, info)
    return success(info)
  }
  remote.close = async (_sessionId, id) => { active.delete(id); return success(undefined) }
  const service = new CodingNsWebTerminals(new Context(), remote)

  const first = await service.createTerminal('session-1')
  const second = await service.createTerminal('session-1')
  assert.notEqual(first.id, second.id)
  assert.deepEqual(service.inventoryForSession('session-1').map((item) => item.id), [first.id, second.id])

  await service.closeTerminal('session-1', first.id)
  assert.deepEqual(service.inventoryForSession('session-1').map((item) => item.id), [second.id])
  await service.dispose()
})

test('共享库存按 terminalId 去重，避免同一记录显示多份', async () => {
  const { remote } = createRemote(false)
  remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
  remote.list = async () => success([terminalInfo, { ...terminalInfo, title: '重复记录' }])
  const service = new CodingNsWebTerminals(new Context(), remote)

  const terminals = await service.recover('session-1')
  assert.deepEqual(terminals.map((item) => item.id), [terminalInfo.id])
  assert.equal(service.inventoryForSession('session-1').length, 1)
  await service.dispose()
})

test('Client 重启后再次新建终端不会复用上一次 terminalId', async () => {
  const active = new Map<string, typeof terminalInfo>()
  const { remote } = createRemote(false)
  remote.environment = async () => success({ ...environment, workspaceId: 'workspace-stable' })
  remote.list = async () => success([...active.values()])
  remote.create = async (_sessionId, request) => {
    const info = { ...terminalInfo, id: request.id }
    active.set(info.id, info)
    return success(info)
  }
  remote.close = async (_sessionId, id) => { active.delete(id); return success(undefined) }

  const firstClient = new CodingNsWebTerminals(new Context(), remote)
  const first = await firstClient.createTerminal('session-1')
  await firstClient.dispose()

  const restartedClient = new CodingNsWebTerminals(new Context(), remote)
  const second = await restartedClient.createTerminal('session-1')
  assert.notEqual(second.id, first.id)
  assert.deepEqual(restartedClient.inventoryForSession('session-1').map((item) => item.id), [first.id, second.id])
  await restartedClient.dispose()
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

test('聚合终端从后台切回时复用保活连接而不是停在读取终端环境', async () => {
  const { calls, remote } = createRemote(true)
  const service = new CodingNsWebTerminals(new Context(), remote)
  const view = service.viewForTerminal('session-1', terminalInfo.id, terminalInfo.shell.path)
  const unmount = view.mount()

  await waitFor(() => view.state.getSnapshot().render !== undefined, '聚合终端 snapshot 未到达 Client')
  view.acknowledge(view.state.getSnapshot().render.revision)
  assert.equal(view.state.getSnapshot().phase, 'connected')
  assert.equal(view.state.getSnapshot().writable, true)
  const environmentCalls = calls.environment
  const listCalls = calls.list

  // 切到别的会话时 DSH 只隐藏右栏子树：模型解除挂载引用，保活连接必须保留。
  unmount()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.followAborts, 0, '后台期间不应释放 Host follow')

  // 切回该会话：终端必须立刻恢复可输入，而不是停在“正在读取终端环境”。
  const remount = view.mount()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(view.state.getSnapshot().phase, 'connected', '切回会话后终端停在非连接状态')
  assert.equal(view.state.getSnapshot().writable, true, '切回会话后终端不可输入')
  assert.equal(calls.environment, environmentCalls, '切回会话不应重新读取终端环境')
  assert.equal(calls.list, listCalls, '切回会话不应重新读取终端库存')
  assert.equal(calls.followAborts, 0, '切回会话不应重建连接')

  remount()
  await service.dispose()
})

test('显式重连会释放保活连接并重新读取 Host 状态', async () => {
  const { calls, remote } = createRemote(true)
  const service = new CodingNsWebTerminals(new Context(), remote)
  const view = service.viewForTerminal('session-1', terminalInfo.id, terminalInfo.shell.path)
  const unmount = view.mount()

  await waitFor(() => view.state.getSnapshot().render !== undefined, '聚合终端 snapshot 未到达 Client')
  const firstRevision = view.state.getSnapshot().render.revision
  view.acknowledge(firstRevision)

  await view.refresh({ force: true })

  await waitFor(() => calls.followAborts === 1, '强制刷新没有释放旧连接')
  await waitFor(() => (view.state.getSnapshot().render?.revision ?? 0) > firstRevision, '强制刷新后没有重新连接')
  assert.equal(view.state.getSnapshot().phase, 'connected')
  assert.equal(calls.environment, 2)
  assert.equal(calls.list, 2)

  unmount()
  await service.dispose()
})

test('重建终端会释放旧 follow 并重新建立连接', async () => {
  const { calls, remote } = createRemote(true)
  const service = new CodingNsWebTerminals(new Context(), remote)
  const view = service.viewForTerminal('session-1', terminalInfo.id, terminalInfo.shell.path)
  const unmount = view.mount()

  await waitFor(() => view.state.getSnapshot().render !== undefined, '聚合终端 snapshot 未到达 Client')
  const firstRevision = view.state.getSnapshot().render.revision
  view.acknowledge(firstRevision)

  await view.rebuild()

  await waitFor(() => calls.followAborts === 1, '重建没有释放旧连接')
  await waitFor(() => (view.state.getSnapshot().render?.revision ?? 0) > firstRevision, '重建后没有重新连接')
  assert.equal(view.state.getSnapshot().phase, 'connected')
  assert.equal(calls.create, 1)

  unmount()
  await service.dispose()
})

test('不可见的聚合视图完成加载后不会停在读取终端环境', async () => {
  const { remote } = createRemote(true)
  const service = new CodingNsWebTerminals(new Context(), remote)
  const view = service.viewForTerminal('session-1', terminalInfo.id, terminalInfo.shell.path)

  // 加载尚未完成就切走：此时还没有保活连接，状态不能停在 loading。
  const unmount = view.mount()
  unmount()
  await waitFor(() => view.state.getSnapshot().phase === 'disconnected', '不可见视图停在了 loading')

  await service.dispose()
})

test('加载请求悬挂时会超时失败，不会永久停在读取终端环境', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { remote } = createRemote(true)
  // 模拟页面在后台被冻结后请求永远不返回。
  remote.environment = () => new Promise(() => {})
  const view = new CodingNsTerminalView('session-1', 'terminal-1', remote, true, '/bin/zsh')
  const unmount = view.mount()

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(view.state.getSnapshot().phase, 'loading')

  t.mock.timers.tick(20_001)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(view.state.getSnapshot().phase, 'failed', '悬挂的加载请求没有超时')
  assert.match(String(view.state.getSnapshot().error), /超时/u)

  unmount()
  await view.dispose()
})
