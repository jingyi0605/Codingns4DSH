import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalPtyTerminalBackend } from '../data/build/dist/host/terminal/backends/local-pty-backend.js'
import { TerminalRuntimeManager } from '../data/build/dist/host/terminal/runtime-manager.js'

const session = {
  runtimeSessionKey: 'local-session-1',
  runtimeType: 'local-pty',
  shellPath: '/bin/zsh',
  shellArgs: ['-i'],
  cwd: '/tmp',
}

function createFakePty() {
  let dataListener = () => {}
  let exitListener = () => {}
  const calls = []
  return {
    calls,
    emitData(data) { dataListener(data) },
    emitExit(exitCode) { exitListener({ exitCode }) },
    pty: {
      pid: 42,
      cols: 120,
      rows: 30,
      process: 'zsh',
      handleFlowControl: false,
      onData(listener) { dataListener = listener; return { dispose() { dataListener = () => {} } } },
      onExit(listener) { exitListener = listener; return { dispose() { exitListener = () => {} } } },
      resize(cols, rows) { calls.push(`resize:${cols}x${rows}`) },
      clear() {},
      write(data) { calls.push(`write:${data}`) },
      kill() { calls.push('kill') },
      pause() {},
      resume() {},
    },
  }
}

test('本机 PTY 创建 shell 并复用同一运行时', async () => {
  const fake = createFakePty()
  const spawns = []
  const backend = new LocalPtyTerminalBackend({
    platform: 'darwin',
    ptySpawner(file, args, options) { spawns.push({ file, args, options }); return fake.pty },
  })

  const first = await backend.create({ session, cols: 80, rows: 24 })
  const second = await backend.create({ session, cols: 100, rows: 40 })

  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].file, '/bin/zsh')
  assert.deepEqual(spawns[0].args, ['-i'])
  assert.equal(first.shellPid, 42)
  assert.deepEqual(second, first)
})

test('detach 只释放订阅，显式 terminate 才结束本机 PTY', async () => {
  const fake = createFakePty()
  const output = []
  const backend = new LocalPtyTerminalBackend({
    platform: 'linux',
    ptySpawner: () => fake.pty,
    createAttachmentId: () => 'attach-local',
  })
  await backend.create({ session })
  const attached = await backend.attach({ session, cols: 80, rows: 24, onData: (data) => output.push(data) })
  fake.emitData('first')
  await backend.write({ attachmentId: attached.attachmentId, data: 'pwd\r' })
  await backend.detach(attached.attachmentId)
  fake.emitData('stale')

  assert.deepEqual(output, ['first'])
  assert.equal(fake.calls.includes('kill'), false)
  assert.equal((await backend.inspect(session)).alive, true)

  await backend.terminate(session)
  assert.equal(fake.calls.filter((call) => call === 'kill').length, 1)
  assert.equal((await backend.inspect(session)).alive, false)
})

test('attach 回放创建后产生的早期输出', async () => {
  const fake = createFakePty()
  const output = []
  const backend = new LocalPtyTerminalBackend({
    platform: 'linux',
    ptySpawner: () => fake.pty,
    createAttachmentId: () => 'attach-replay',
  })
  await backend.create({ session })
  fake.emitData('prompt> ')

  await backend.attach({ session, cols: 80, rows: 24, onData: (data) => output.push(data) })

  assert.deepEqual(output, ['prompt> '])
})

test('PTY 自然退出通知所有 attach 并清理运行时', async () => {
  const fake = createFakePty()
  const exits = []
  let nextId = 0
  const backend = new LocalPtyTerminalBackend({
    platform: 'win32',
    ptySpawner: () => fake.pty,
    createAttachmentId: () => `attach-${++nextId}`,
  })
  await backend.create({ session })
  const first = await backend.attach({ session, cols: 80, rows: 24, onData() {}, onExit: (code) => exits.push(code) })
  const second = await backend.attach({ session, cols: 80, rows: 24, onData() {}, onExit: (code) => exits.push(code) })
  fake.emitExit(7)

  assert.deepEqual(exits, [7, 7])
  assert.equal((await backend.inspect(session)).alive, false)
  await assert.rejects(() => backend.write({ attachmentId: first.attachmentId, data: 'x' }), { code: 'TERMINAL_ATTACHMENT_NOT_FOUND' })
  await assert.rejects(() => backend.resize({ attachmentId: second.attachmentId, cols: 90, rows: 30 }), { code: 'TERMINAL_ATTACHMENT_NOT_FOUND' })
})

test('runtime manager dispose 结束全部进程内 PTY', async () => {
  const first = createFakePty()
  const second = createFakePty()
  const queue = [first.pty, second.pty]
  const backend = new LocalPtyTerminalBackend({ platform: 'linux', ptySpawner: () => queue.shift() })
  const manager = new TerminalRuntimeManager([backend])
  await manager.create({ ...session })
  await manager.create({ ...session, runtimeSessionKey: 'local-session-2' })

  await manager.dispose()

  assert.equal(first.calls.filter((call) => call === 'kill').length, 1)
  assert.equal(second.calls.filter((call) => call === 'kill').length, 1)
})

test('本机 PTY 拒绝错误 runtime 类型和不支持的平台', async () => {
  const backend = new LocalPtyTerminalBackend({ platform: 'freebsd' })
  await assert.rejects(() => backend.inspect(session), { code: 'TERMINAL_PLATFORM_UNSUPPORTED' })
  const supported = new LocalPtyTerminalBackend({ platform: 'linux' })
  await assert.rejects(() => supported.inspect({ ...session, runtimeType: 'tmux' }), { code: 'TERMINAL_PLATFORM_UNSUPPORTED' })
})
