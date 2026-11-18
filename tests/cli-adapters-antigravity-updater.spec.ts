import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { spawn } from 'node:child_process'
import { AntigravityAutoUpdater, antigravityCommandEnvironment } from '../src/host/cli-adapters/antigravity-updater.js'
import { AntigravityDriver } from '../src/host/cli-adapters/antigravity-driver.js'

function fixture() {
  let now = 1000
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const children: Array<EventEmitter & { killed: boolean }> = []
  const runSpawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { this.killed = true; return true },
    })
    children.push(child)
    return child
  }) as unknown as typeof spawn
  const updater = new AntigravityAutoUpdater(runSpawn, () => now, 'win32')
  return { updater, calls, children, runSpawn, advance() { now += 15 * 60_000 } }
}

test('Windows 自动更新使用隐藏的官方 update 入口，合并并发并按 15 分钟节流', () => {
  const f = fixture()
  try {
    const env = { PATH: 'test-path', AGY_CLI_DISABLE_AUTO_UPDATE: 'false' }
    f.updater.check('agy', env)
    f.updater.check('agy', env)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0], {
      command: 'agy', args: ['update'],
      options: { env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, windowsHide: true, shell: false, windowsVerbatimArguments: false, stdio: ['ignore', 'pipe', 'pipe'] },
    })
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'false')
    f.children[0]!.emit('close', 0)
    f.updater.check('agy', env)
    assert.equal(f.calls.length, 1)
    f.advance()
    f.updater.check('agy', env)
    assert.equal(f.calls.length, 2)
    f.updater.dispose()
    assert.equal(f.children[1]!.killed, true)
    f.advance()
    f.updater.check('agy', env)
    assert.equal(f.calls.length, 2)
  } finally { f.updater.dispose() }
})

test('更新失败不阻塞业务，之后可重试，切换安装路径可立即检查', () => {
  const f = fixture()
  try {
    f.updater.check('agy', {})
    f.children[0]!.emit('error', new Error('unavailable'))
    f.children[0]!.emit('close', -1)
    f.updater.check('agy', {})
    assert.equal(f.calls.length, 1)
    f.advance()
    f.updater.check('agy', {})
    f.children[1]!.emit('close', 1)
    f.updater.check('other-agy', {})
    assert.equal(f.calls.length, 3)
  } finally { f.updater.dispose() }
})

test('尊重用户显式禁用更新，非 Windows 不接管自动更新', () => {
  const f = fixture()
  try {
    f.updater.check('agy', { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' })
    assert.equal(f.calls.length, 0)
    for (const platform of ['linux', 'darwin']) {
      const updater = new AntigravityAutoUpdater(f.runSpawn, Date.now, platform)
      updater.check('agy', {})
      updater.dispose()
      const env = { PATH: 'test' }
      assert.equal(antigravityCommandEnvironment(env, platform), env)
    }
    assert.equal(f.calls.length, 0)
  } finally { f.updater.dispose() }
})

test('超时终止更新进程，释放和迟到的退出事件保持幂等', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  try {
    f.updater.check('agy', {})
    t.mock.timers.tick(5 * 60_000)
    assert.equal(f.children[0]!.killed, true)
    f.advance()
    f.updater.check('agy', {})
    f.children[0]!.emit('close', 0)
    f.updater.dispose()
    f.updater.dispose()
    assert.equal(f.children[1]!.killed, true)
  } finally { f.updater.dispose() }
})

test('同步启动失败可收敛，安装未找到时不运行更新', async () => {
  let attempts = 0
  const updater = new AntigravityAutoUpdater((() => { attempts++; throw new Error('spawn failed') }) as never, () => 1000, 'win32')
  updater.check('agy', {})
  updater.check('agy', {})
  assert.equal(attempts, 1)
  updater.dispose()
  const driver = new AntigravityDriver({
    binaries: ['missing-agy'],
    spawnSync: (() => ({ status: 1, stdout: '', stderr: '' })) as never,
    autoUpdater: { check() { attempts++ }, dispose() {} },
  })
  try { await driver.listModels() } finally { driver.dispose() }
  assert.equal(attempts, 1)
})

test('模型发现和每轮使用时触发更新检查，仅检测安装不更新，释放时停止更新器', async () => {
  const commands: string[] = []
  let disposed = false
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.5.9', stderr: '' })) as never,
    spawn: ((_command: string, args: readonly string[]) => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() { return true } })
      if (args.at(-1) === 'models') queueMicrotask(() => {
        stdout.end('gemini-3.8-flash\tGemini 3.8 Flash\n')
        stderr.end()
        child.emit('close', 0)
      })
      stdin.once('finish', () => {
        stdout.end(`${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok', conversation_id: 'test-agy' } })}\n`)
        stderr.end()
      })
      return child
    }) as never,
    resolveContextWindow: () => undefined,
    resolveModelId: () => null,
    autoUpdater: { check(command) { commands.push(command) }, dispose() { disposed = true } },
  })
  try {
    await driver.detect()
    assert.deepEqual(commands, [])
    await driver.listModels()
    assert.deepEqual(commands, ['fake-agy'])
    for (let round = 0; round < 2; round++) {
      const events = []
      for await (const event of driver.executeTurn({ sessionId: 'test', prompt: 'ok', messages: [] })) events.push(event)
      assert.ok(events.some(event => event.type === 'finish'))
    }
    assert.deepEqual(commands, ['fake-agy', 'fake-agy', 'fake-agy'])
  } finally { driver.dispose() }
  assert.equal(disposed, true)
})
