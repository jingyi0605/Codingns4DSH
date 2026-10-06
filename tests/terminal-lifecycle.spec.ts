import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalRuntimeManager } from '../data/build/dist/host/terminal/runtime-manager.js'
import { CodingNsTerminalService } from '../data/build/dist/host/terminal/terminal-service.js'
import {
  CodingNsTerminalStore,
  InMemoryTerminalStorePersistence,
} from '../data/build/dist/host/terminal/terminal-store.js'

class FakeRuntimeAdapter {
  runtimeTypes = ['tmux']
  sessions = new Set()
  /** 模拟 backend 从持久 shell 拿到的真实退出码；缺失表示运行时丢失。 */
  exits = new Map()
  attachments = new Map()
  resizes = []
  terminated = []
  detached = []
  /** capture-pane -J 合并后的历史文本。 */
  history = ''
  captures = []
  nextAttachment = 0

  async create({ session }) {
    this.sessions.add(session.runtimeSessionKey)
    this.exits.delete(session.runtimeSessionKey)
    return this.identity(session)
  }

  async inspect(session) {
    return this.identity(session)
  }

  async attach(input) {
    const attachmentId = `runtime-attach-${++this.nextAttachment}`
    this.attachments.set(attachmentId, input)
    return { attachmentId, identity: this.identity(input.session) }
  }

  async captureHistory(session, lines) {
    this.captures.push([session.runtimeSessionKey, lines])
    return this.history
  }

  async write({ attachmentId, data }) {
    const attachment = this.attachments.get(attachmentId)
    if (!attachment) throw new Error('attach missing')
    attachment.lastInput = data
  }

  async resize({ attachmentId, cols, rows }) {
    const attachment = this.attachments.get(attachmentId)
    if (!attachment) throw new Error('attach missing')
    this.resizes.push([cols, rows])
    attachment.lastSize = { cols, rows }
  }

  async detach(attachmentId) {
    this.detached.push(attachmentId)
    this.attachments.delete(attachmentId)
  }

  async terminate(session) {
    this.terminated.push(session.runtimeSessionKey)
    this.sessions.delete(session.runtimeSessionKey)
    this.exits.delete(session.runtimeSessionKey)
  }

  identity(session) {
    const alive = this.sessions.has(session.runtimeSessionKey)
    const exitCode = this.exits.get(session.runtimeSessionKey)
    return {
      alive,
      runtimeSessionKey: session.runtimeSessionKey,
      runtimePid: null,
      shellPid: null,
      ...(alive ? {} : { exitCode: exitCode ?? null }),
      ...(alive ? {} : { detail: '持久终端运行时不存在' }),
    }
  }
}

async function setup() {
  const adapter = new FakeRuntimeAdapter()
  const manager = new TerminalRuntimeManager([adapter])
  const store = new CodingNsTerminalStore(new InMemoryTerminalStorePersistence())
  const service = new CodingNsTerminalService(store, manager, () => new Date('2026-09-22T00:00:00.000Z'))
  await service.initialize()
  const scope = { hostId: 'host-a', workspaceId: 'workspace-a', dshSessionId: 'session-a' }
  await service.create({
    scope,
    terminalId: 'terminal-a',
    runtimeType: 'tmux',
    shell: { profileId: 'zsh', path: '/bin/zsh', args: ['-i'], name: 'zsh' },
    cwd: '/workspace/a',
    cols: 80,
    rows: 24,
  })
  return { adapter, service, identity: { ...scope, terminalId: 'terminal-a' } }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await sleep(20)
  }
}

test('follow 第一帧始终是 snapshot，后续输出序号连续', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.value.type, 'snapshot')

  const runtimeAttachment = [...adapter.attachments.values()][0]
  runtimeAttachment.onData('hello')
  const second = await iterator.next()
  assert.deepEqual(second.value, { type: 'state', info: { ...second.value.info, controllerId: 'browser-a' } })
  const third = await iterator.next()
  assert.deepEqual(third.value, { type: 'output', sequence: 1, data: 'hello' })
  controller.abort()
  await iterator.return()
})

test('Host 常驻连接供多个会话复用，新增 follow 立即收到当前状态', async () => {
  const { adapter, service, identity } = await setup()
  const firstController = new AbortController()
  const first = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: firstController.signal })[Symbol.asyncIterator]()
  assert.equal((await first.next()).value.type, 'snapshot')
  assert.equal((await first.next()).value.type, 'state')
  const resident = [...adapter.attachments.values()][0]
  resident.onData('before-second')
  assert.deepEqual((await first.next()).value, { type: 'output', sequence: 1, data: 'before-second' })

  const secondController = new AbortController()
  const second = service.follow({ identity, attachmentId: 'browser-b', generation: 'generation-b', signal: secondController.signal })[Symbol.asyncIterator]()
  const secondSnapshot = await second.next()
  assert.equal(secondSnapshot.value.type, 'snapshot')
  assert.equal(secondSnapshot.value.screen, 'before-second')
  assert.equal((await second.next()).value.type, 'state')
  // 第二个浏览器订阅不能再创建一个 tmux/local-pty backend attachment。
  assert.equal(adapter.attachments.size, 1)
  resident.onData('shared-output')
  assert.deepEqual((await first.next()).value, { type: 'output', sequence: 2, data: 'shared-output' })
  assert.deepEqual((await second.next()).value, { type: 'output', sequence: 1, data: 'shared-output' })

  firstController.abort()
  secondController.abort()
  await first.return()
  await second.return()
  assert.equal(adapter.attachments.size, 1, '浏览器订阅结束不能释放 Host 常驻连接')
  await service.dispose()
})

test('插件卸载只 detach，不 terminate 持久运行时', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await service.dispose()
  controller.abort()
  await iterator.return()

  assert.equal(adapter.detached.length, 1)
  assert.deepEqual(adapter.terminated, [])
  assert.equal(adapter.sessions.size, 1)
})

test('相同终端尺寸不会重复触发 backend resize', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()

  await service.resize(identity, 'browser-a', 80, 24)
  await service.resize(identity, 'browser-a', 80, 24)
  await service.resize(identity, 'browser-a', 100, 30)
  assert.deepEqual(adapter.resizes, [[100, 30]])

  controller.abort()
  await iterator.return()
})

test('窗口列宽变化后重放合并后的历史，客户端才能按新宽度重排', async () => {
  const { adapter, service, identity } = await setup()
  adapter.history = '历史行一\n历史行二\n历史行三'
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, 'snapshot')
  assert.equal((await iterator.next()).value.type, 'state')

  const capturesBefore = adapter.captures.length
  await service.resize(identity, 'browser-a', 100, 30)
  assert.equal((await iterator.next()).value.type, 'state')
  // tmux 不会重排已输出的历史；必须重新抓取 -J 合并后的长逻辑行并作为
  // snapshot 重放，浏览器端 xterm 才有机会按新列宽整体重排。
  await waitFor(() => adapter.captures.length > capturesBefore)
  const reflow = await iterator.next()
  assert.equal(reflow.value.type, 'snapshot')
  assert.equal(reflow.value.screen, '历史行一\r\n历史行二\r\n历史行三')

  controller.abort()
  await iterator.return()
})

test('列宽变化与大幅行高变化触发历史重放，±1 行可视抖动不重放', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()

  // ±1 行的可视区域抖动（移动端地址栏收放）不触发重放，避免频繁重置浏览位置。
  const stableCaptures = adapter.captures.length
  await service.resize(identity, 'browser-a', 80, 23)
  assert.equal((await iterator.next()).value.type, 'state')
  await service.resize(identity, 'browser-a', 80, 24)
  assert.equal((await iterator.next()).value.type, 'state')
  await sleep(450)
  assert.equal(adapter.captures.length, stableCaptures, '±1 行抖动不应触发历史重放')

  // 大幅行高变化（虚拟键盘收放）同样会让 tmux 重绘可见区域，把旧列宽的历史物理行
  // 重新带回客户端、覆盖上一次重排；必须调度重放，让重排放置在最后一次屏幕重绘
  // 之后，否则屏幕底部会残留旧列宽的“提前换行”行。
  await service.resize(identity, 'browser-a', 80, 40)
  assert.equal((await iterator.next()).value.type, 'state')
  await waitFor(() => adapter.captures.length > stableCaptures)
  // 重放以 snapshot 帧推送，浏览器据此按新尺寸整体重排。
  const reflow = await iterator.next()
  assert.equal(reflow.value.type, 'snapshot')

  controller.abort()
  await iterator.return()
})

test('同一工作区的另一个 DSH session 可以恢复已有终端', async () => {
  const { service, identity } = await setup()
  const listed = service.listSession('host-a', 'session-b', 'workspace-a')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, identity.terminalId)
  const resolved = service.findIdentity('host-a', 'session-b', identity.terminalId, 'workspace-a')
  assert.deepEqual(resolved, { ...identity, dshSessionId: 'session-b' })
})

test('generation 释放后旧 backend 回调不能再写入输出流', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  const runtimeAttachment = [...adapter.attachments.values()][0]

  await service.detachGeneration('generation-a')
  runtimeAttachment.onData('stale')
  controller.abort()
  const ended = await iterator.next()
  assert.equal(ended.done, true)
})

test('只有显式 close 才结束运行时，重复 close 保持幂等', async () => {
  const { adapter, service, identity } = await setup()
  await service.close(identity)
  await service.close(identity)

  assert.equal(adapter.terminated.length, 1)
  assert.equal(service.listSession('host-a', 'session-a').length, 0)
})

test('恢复以 backend 实际状态为准，丢失运行时不会偷偷重建', async () => {
  const { adapter, service } = await setup()
  adapter.sessions.clear()
  adapter.exits.clear()
  await service.recover()

  const terminal = service.listSession('host-a', 'session-a')[0]
  // 没有可信退出码时只能报告"运行时丢失"，不能伪造成进程退出。
  assert.equal(terminal.state, 'lost')
  assert.match(terminal.error, /不存在|丢失/u)
})

test('shell 自然退出先发送 exited 状态再结束 follow 流', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  const runtimeAttachment = [...adapter.attachments.values()][0]
  // 真实 backend 在 attach 客户端结束时会同步 inspect：会话消失且包装 Shell
  // 写下了退出码 7，服务必须据此判定 exited。
  adapter.sessions.clear()
  adapter.exits.set(runtimeAttachment.session.runtimeSessionKey, 7)
  runtimeAttachment.onExit(0)

  const exited = await iterator.next()
  assert.equal(exited.value.type, 'state')
  assert.equal(exited.value.info.state, 'exited')
  assert.equal(exited.value.info.exitCode, 7)
  assert.equal((await iterator.next()).done, true)
})

test('Host resident 连接断开但运行时仍在时保留 follow 并重绑控制', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  const runtimeAttachment = [...adapter.attachments.values()][0]
  // Host resident 客户端以 1 退出，但持久 Shell 还活着。
  runtimeAttachment.onExit(1)

  // Shell 仍存活时，Host 重新建立 resident；已有浏览器流不能被提前结束。
  for (let attempt = 0; attempt < 100 && adapter.nextAttachment < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(adapter.nextAttachment, 2)
  const replacement = [...adapter.attachments.values()][0]
  assert.notEqual(replacement, runtimeAttachment)
  // 旧 attachment 的迟到退出回调不能影响已经建立的新 resident。
  runtimeAttachment.onExit(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(adapter.attachments.size, 1)
  replacement.onData('restored-screen')
  const restored = await iterator.next()
  assert.equal(restored.value.type, 'snapshot')
  assert.equal(restored.value.screen, 'restored-screen')
  replacement.onData('still-alive')
  await new Promise((resolve) => setTimeout(resolve, 120))
  const output = await iterator.next()
  assert.equal(output.value.type, 'output')
  await service.write(identity, 'browser-a', 'echo')
  assert.equal(replacement.lastInput, 'echo')

  controller.abort()
  assert.equal((await iterator.next()).done, true)
  const listed = service.listSession('host-a', 'session-a')[0]
  assert.equal(listed.state, 'running')
  assert.equal(listed.exitCode, null)
})

test('Host resident 重连期间输入等待控制权恢复，不误报 attach 无控制权', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  const runtimeAttachment = [...adapter.attachments.values()][0]

  let releaseHistory
  const historyReady = new Promise((resolve) => { releaseHistory = resolve })
  let historyStarted = false
  const captureHistory = adapter.captureHistory.bind(adapter)
  adapter.captureHistory = async (session, lines) => {
    if (adapter.nextAttachment >= 2 && !historyStarted) {
      historyStarted = true
      await historyReady
    }
    return captureHistory(session, lines)
  }

  runtimeAttachment.onExit(1)
  await waitFor(() => historyStarted)
  const replacement = [...adapter.attachments.values()][0]
  let settled = false
  const write = service.write(identity, 'browser-a', 'echo')
  void write.then(() => { settled = true }, () => { settled = true })
  await sleep(20)
  assert.equal(settled, false, '重连期间输入不应立即失败')

  releaseHistory()
  await write
  assert.equal(replacement.lastInput, 'echo')

  controller.abort()
  await iterator.return()
})

test('attach 客户端断开且运行时消失时报告 lost，不借用客户端退出码', async () => {
  const { adapter, service, identity } = await setup()
  const controller = new AbortController()
  const iterator = service.follow({ identity, attachmentId: 'browser-a', generation: 'generation-a', signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  const runtimeAttachment = [...adapter.attachments.values()][0]
  adapter.sessions.clear()
  runtimeAttachment.onExit(1)

  const state = await iterator.next()
  assert.equal(state.value.type, 'state')
  assert.equal(state.value.info.state, 'lost')
  assert.equal(state.value.info.exitCode, null)
  assert.match(state.value.info.error, /运行时|丢失|中断/u)
})

test('重命名终端不会污染持久 shell 元数据', async () => {
  const { service, identity } = await setup()
  await service.rename(identity, '构建终端')
  const terminal = service.listSession('host-a', 'session-a')[0]
  assert.equal(terminal.title, '构建终端')
  assert.equal(terminal.shell.name, 'zsh')
  assert.deepEqual(terminal.shell.args, ['-i'])
})

test('运行时丢失后同一 terminalId 可以重建并保留工作区身份', async () => {
  const { adapter, service, identity } = await setup()
  const before = service.getRecord(identity)
  adapter.sessions.clear()
  adapter.exits.clear()

  const rebuilt = await service.create({
    scope: { hostId: 'host-a', workspaceId: 'workspace-a', dshSessionId: 'session-a' },
    terminalId: identity.terminalId,
    runtimeType: 'tmux',
    shell: { profileId: 'zsh', path: '/bin/zsh', args: ['-i'], name: 'zsh' },
    cwd: '/workspace/a',
    cols: 100,
    rows: 30,
  })

  assert.equal(rebuilt.id, identity.terminalId)
  assert.equal(rebuilt.state, 'running')
  assert.equal(rebuilt.exitCode, null)
  const after = service.getRecord(identity)
  assert.notEqual(after?.runtimeSessionKey, before?.runtimeSessionKey, '重建必须换新的 runtimeSessionKey')
  assert.equal(after?.state, 'running')
  // 旧运行时已经被清理，不能再有残留 attach。
  assert.equal(adapter.sessions.size, 1)
  assert.equal(adapter.attachments.size, 1)
})

test('已关闭的终端不允许用相同标识重建', async () => {
  const { service, identity } = await setup()
  await service.close(identity)
  await assert.rejects(() => service.create({
    scope: { hostId: 'host-a', workspaceId: 'workspace-a', dshSessionId: 'session-a' },
    terminalId: identity.terminalId,
    runtimeType: 'tmux',
    shell: { profileId: 'zsh', path: '/bin/zsh', args: ['-i'], name: 'zsh' },
    cwd: '/workspace/a',
    cols: 80,
    rows: 24,
  }), /已关闭/u)
})

test('recover 用真实退出码收敛为 exited，而不是一律 lost', async () => {
  const { adapter, service, identity } = await setup()
  const record = service.getRecord(identity)
  adapter.sessions.clear()
  adapter.exits.set(record.runtimeSessionKey, 42)
  await service.recover()

  const terminal = service.listSession('host-a', 'session-a')[0]
  assert.equal(terminal.state, 'exited')
  assert.equal(terminal.exitCode, 42)
})
