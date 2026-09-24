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
    const second = service.view('session-b', 'tab-b', 'content-a')
    assert.equal(second.id, first.id)
    await service.dispose()
  } finally {
    if (previousStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
  }
})
