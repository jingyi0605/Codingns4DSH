import assert from 'node:assert/strict'
import { accessSync, constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  TmuxTerminalBackend,
  tmuxSessionName,
} from '../dist/host/terminal/backends/tmux-backend.js'

const session = {
  runtimeSessionKey: 'host/workspace/session-1',
  runtimeType: 'tmux',
  shellPath: '/bin/zsh',
  shellArgs: ['-i'],
  cwd: '/tmp',
}

test('tmux backend 创建命名空间会话且重复创建不产生第二个会话', async () => {
  const calls = []
  let alive = false
  const backend = new TmuxTerminalBackend({
    platform: 'linux',
    tmuxPath: '/usr/bin/tmux',
    commandRunner: {
      run(command, args) {
        calls.push([command, ...args])
        if (args[0] === 'has-session') return { status: alive ? 0 : 1, stdout: '', stderr: alive ? '' : 'no server running' }
        if (args[0] === 'new-session') alive = true
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  const first = await backend.create({ session })
  const second = await backend.create({ session })
  assert.equal(first.alive, true)
  assert.equal(second.alive, true)
  assert.equal(calls.filter((call) => call[1] === 'new-session').length, 1)
  assert.ok(calls.some((call) => call.includes(tmuxSessionName(session.runtimeSessionKey))))
})

test('tmux 调试命令退出后保留交互 Shell', async () => {
  const calls: string[][] = []
  let alive = false
  const backend = new TmuxTerminalBackend({
    platform: 'linux',
    tmuxPath: '/usr/bin/tmux',
    commandRunner: {
      run(_command, args) {
        calls.push([...args])
        if (args[0] === 'has-session') return { status: alive ? 0 : 1, stdout: '', stderr: alive ? '' : 'no server running' }
        if (args[0] === 'new-session') alive = true
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  await backend.create({ session: { ...session, commandPath: 'pnpm', commandArgs: ['run', 'dev'] } })
  const create = calls.find((args) => args[0] === 'new-session')
  assert.ok(create)
  assert.deepEqual(create?.slice(-4), ['/bin/zsh', '-i', '-c', "'pnpm' 'run' 'dev'; exec '/bin/zsh' '-i'"])
})

test('tmux detach 只结束临时 client，显式关闭才结束持久 session', async () => {
  const commands = []
  let killed = 0
  let written = ''
  let resized = [0, 0]
  const fakePty = {
    pid: 21,
    cols: 120,
    rows: 30,
    process: 'tmux',
    handleFlowControl: false,
    onData() { return { dispose() {} } },
    onExit() { return { dispose() {} } },
    resize(cols, rows) { resized = [cols, rows] },
    clear() {},
    write(data) { written += data },
    kill() { killed += 1 },
    pause() {},
    resume() {},
  }
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    commandRunner: {
      run(_command, args) {
        commands.push([...args])
        return { status: 0, stdout: '', stderr: '' }
      },
    },
    ptySpawner: () => fakePty,
    createAttachmentId: () => 'attach-1',
  })
  const attached = await backend.attach({ session, cols: 120, rows: 30, onData() {} })
  await backend.write({ attachmentId: attached.attachmentId, data: 'pwd\r' })
  await backend.resize({ attachmentId: attached.attachmentId, cols: 140, rows: 40 })
  await backend.detach(attached.attachmentId)
  assert.equal(written, 'pwd\r')
  assert.deepEqual(resized, [140, 40])
  assert.equal(killed, 1)
  assert.equal(commands.some((args) => args[0] === 'kill-session'), false)
  await backend.terminate(session)
  assert.equal(commands.some((args) => args[0] === 'kill-session'), true)
})

test('tmux backend 在非 POSIX 平台明确拒绝运行', async () => {
  const backend = new TmuxTerminalBackend({ platform: 'win32', tmuxPath: '/tmux' })
  await assert.rejects(() => backend.inspect(session), { code: 'TERMINAL_PLATFORM_UNSUPPORTED' })
})

test('tmux 检查不会把权限或 socket 故障误判为会话丢失', async () => {
  const backend = new TmuxTerminalBackend({
    platform: 'linux',
    tmuxPath: '/usr/bin/tmux',
    commandRunner: {
      run: () => ({ status: 1, stdout: '', stderr: 'permission denied' }),
    },
  })
  await assert.rejects(() => backend.inspect(session), /tmux 会话检查失败/u)
})

test('宿主机重启后 tmux socket 消失时视为会话已丢失并可幂等关闭', async () => {
  const socketError = 'error connecting to /private/tmp/tmux-501/default (No such file or directory)'
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    commandRunner: {
      run: (_command, args) => args[0] === 'has-session'
        ? { status: 1, stdout: '', stderr: socketError }
        : { status: 1, stdout: '', stderr: socketError },
    },
  })

  const identity = await backend.inspect(session)
  assert.equal(identity.alive, false)
  await backend.terminate(session)
})

test('真实 tmux 会话可创建、跨检查保持身份并显式关闭', { skip: findTmux() === null }, async () => {
  const tmuxPath = findTmux()
  assert.notEqual(tmuxPath, null)
  const realSession = { ...session, runtimeSessionKey: `integration-${process.pid}-${Date.now()}` }
  const backend = new TmuxTerminalBackend({ platform: process.platform, tmuxPath: tmuxPath ?? undefined })
  try {
    assert.equal((await backend.create({ session: realSession })).alive, true)
    const name = tmuxSessionName(realSession.runtimeSessionKey)
    const identity1 = spawnSync(tmuxPath, ['display-message', '-p', '-t', name, '#{session_id}'], { encoding: 'utf8' }).stdout.trim()
    assert.equal((await backend.inspect(realSession)).alive, true)
    const identity2 = spawnSync(tmuxPath, ['display-message', '-p', '-t', name, '#{session_id}'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(identity2, identity1)
  } finally {
    await backend.terminate(realSession)
  }
  assert.equal((await backend.inspect(realSession)).alive, false)
})

function findTmux() {
  for (const path of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux']) {
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {}
  }
  return null
}
