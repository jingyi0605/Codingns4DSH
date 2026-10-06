import assert from 'node:assert/strict'
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  TMUX_SERVER_SOCKET_NAME,
  TmuxTerminalBackend,
  tmuxSessionName,
} from '../data/build/dist/host/terminal/backends/tmux-backend.js'

const session = {
  runtimeSessionKey: 'host/workspace/session-1',
  runtimeType: 'tmux',
  shellPath: '/bin/zsh',
  shellArgs: ['-i'],
  cwd: '/tmp',
}

/** 每次测试一个独立服务器目录，绝不触碰用户正在使用的 tmux。 */
function serverDirectory() {
  return mkdtempSync(join(tmpdir(), 'codingns4dsh-tmux-test-'))
}

/** 命令参数里去掉 -S <socket> 前缀，便于断言真实子命令。 */
function subcommand(args) {
  const index = args.indexOf('-S')
  const rest = index === -1 ? [...args] : [...args.slice(0, index), ...args.slice(index + 2)]
  const config = rest.indexOf('-f')
  return config === -1 ? rest : [...rest.slice(0, config), ...rest.slice(config + 2)]
}

test('tmux backend 创建命名空间会话且重复创建不产生第二个会话', async () => {
  const directory = serverDirectory()
  const calls = []
  let alive = false
  const backend = new TmuxTerminalBackend({
    platform: 'linux',
    tmuxPath: '/usr/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(command, args) {
        calls.push([command, ...args])
        const args2 = subcommand(args)
        if (args2[0] === 'has-session') return { status: alive ? 0 : 1, stdout: '', stderr: alive ? '' : 'no server running' }
        if (args2[0] === 'new-session') alive = true
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  try {
    const first = await backend.create({ session })
    const second = await backend.create({ session })
    assert.equal(first.alive, true)
    assert.equal(second.alive, true)
    assert.equal(calls.filter((call) => subcommand(call).includes('new-session')).length, 1)
    assert.ok(calls.some((call) => call.includes(tmuxSessionName(session.runtimeSessionKey))))
    // 插件必须使用私有 socket，不能和用户自己的 tmux 抢默认 socket。
    assert.ok(calls.every((call) => call.includes('-S') && call.includes(join(directory, `${TMUX_SERVER_SOCKET_NAME}.sock`))))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('tmux 服务器选项在创建会话前写入：exit-empty off 与 status off', async () => {
  const directory = serverDirectory()
  const calls = []
  const backend = new TmuxTerminalBackend({
    platform: 'linux',
    tmuxPath: '/usr/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        const rest = subcommand(args)
        calls.push(rest)
        // has-session 返回"不存在"，否则 create 会直接复用而不建新会话。
        if (rest[0] === 'has-session') return { status: 1, stdout: '', stderr: 'no server running' }
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  try {
    await backend.create({ session })
    const options = calls.find((args) => args[0] === 'set-option')
    assert.ok(options, '必须显式写入服务器选项')
    assert.ok(options.includes('exit-empty') && options.includes('off'))
    assert.ok(options.includes('status') && options.includes('off'))
    const startIndex = calls.findIndex((args) => args[0] === 'start-server')
    const optionIndex = calls.findIndex((args) => args[0] === 'set-option')
    const createIndex = calls.findIndex((args) => args[0] === 'new-session')
    assert.ok(startIndex < optionIndex && optionIndex < createIndex)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('tmux 调试命令退出后保留交互 Shell，并包装真实退出码', async () => {
  const directory = serverDirectory()
  const calls = []
  const backend = new TmuxTerminalBackend({
    platform: 'linux',
    tmuxPath: '/usr/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        const rest = subcommand(args)
        calls.push(rest)
        if (rest[0] === 'has-session') return { status: 1, stdout: '', stderr: 'no server running' }
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  try {
    await backend.create({ session: { ...session, commandPath: 'pnpm', commandArgs: ['run', 'dev'] } })
    const create = calls.find((args) => args[0] === 'new-session')
    assert.ok(create)
    // 会话尺寸显式给定，避免 tmux 用默认 80x24 建窗后立刻重绘。
    assert.ok(create.includes('-x') && create.includes('-y'))
    // tmux 用 shellPath -c <script> 启动包装脚本。
    assert.equal(create.at(-3), '/bin/zsh')
    assert.equal(create.at(-2), '-c')
    const script = create.at(-1)
    // 调试命令退出后必须回到交互 Shell；不能用 exec，否则退出码包装不会执行。
    assert.match(script, /'pnpm' 'run' 'dev'; '\/bin\/zsh' '-i'/u)
    assert.doesNotMatch(script, /exec/u)
    // 包装必须把交互 Shell 的真实退出码写到插件私有目录。
    assert.match(script, /__codingns4dsh_exit=\$\?/u)
    assert.match(script, new RegExp(`${join(directory, 'exit')}/`, 'u'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('attach 客户端一律使用 ignore-size，尺寸只由 resize-window 决定', async () => {
  const directory = serverDirectory()
  let spawned = []
  const commands = []
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
    write() {},
    kill() {},
    pause() {},
    resume() {},
  }
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        const rest = subcommand(args)
        commands.push(rest)
        if (rest[0] === 'has-session') return { status: 0, stdout: '', stderr: '' }
        return { status: 0, stdout: '', stderr: '' }
      },
    },
    ptySpawner: (file, args) => { spawned = [file, ...args]; return fakePty },
    createAttachmentId: () => 'attach-1',
  })
  try {
    const attached = await backend.attach({ session, cols: 120, rows: 30, onData() {} })
    assert.ok(spawned.includes('ignore-size'), '客户端必须忽略自身尺寸')
    await backend.resize({ attachmentId: attached.attachmentId, cols: 140, rows: 40 })
    const resizeWindow = commands.find((args) => args[0] === 'resize-window')
    assert.ok(resizeWindow, '必须显式调整 tmux 窗口尺寸')
    assert.ok(resizeWindow.includes('140') && resizeWindow.includes('40'))
    assert.deepEqual(resized, [140, 40])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('新会话在 attach 之前锁定 window-size manual，避免客户端抢尺寸', async () => {
  const directory = serverDirectory()
  const commands = []
  const backend = new TmuxTerminalBackend({
    platform: 'linux',
    tmuxPath: '/usr/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        const rest = subcommand(args)
        commands.push(rest)
        if (rest[0] === 'has-session') return { status: 1, stdout: '', stderr: 'no current target' }
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  try {
    await backend.create({ session, cols: 100, rows: 30 })
    const sizing = commands.find((args) => args[0] === 'set-option' && args.includes('window-size'))
    assert.ok(sizing, '必须设置会话级 window-size')
    assert.ok(sizing.includes('manual'))
    assert.ok(sizing.includes(tmuxSessionName(session.runtimeSessionKey)))
    const createIndex = commands.findIndex((args) => args[0] === 'new-session')
    const sizeIndex = commands.findIndex((args) => args[0] === 'set-option' && args.includes('window-size'))
    assert.ok(createIndex < sizeIndex, '尺寸策略必须在会话创建后立刻锁定')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('服务器存活但没有任何会话时（exit-empty off）不视为运行时故障', async () => {
  const directory = serverDirectory()
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        const rest = subcommand(args)
        // 服务器活着但一个会话都没有：tmux 会报 "no current target"。
        if (rest[0] === 'has-session') return { status: 1, stdout: '', stderr: 'no current target' }
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  try {
    const identity = await backend.inspect(session)
    assert.equal(identity.alive, false)
    assert.equal(identity.exitCode, null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('tmux detach 只结束临时 client，显式关闭才结束持久 session', async () => {
  const directory = serverDirectory()
  const commands = []
  let killed = 0
  let written = ''
  const fakePty = {
    pid: 21,
    cols: 120,
    rows: 30,
    process: 'tmux',
    handleFlowControl: false,
    onData() { return { dispose() {} } },
    onExit() { return { dispose() {} } },
    resize() {},
    clear() {},
    write(data) { written += data },
    kill() { killed += 1 },
    pause() {},
    resume() {},
  }
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        const rest = subcommand(args)
        commands.push(rest)
        if (rest[0] === 'has-session') return { status: 0, stdout: '', stderr: '' }
        return { status: 0, stdout: '', stderr: '' }
      },
    },
    ptySpawner: () => fakePty,
    createAttachmentId: () => 'attach-1',
  })
  try {
    const attached = await backend.attach({ session, cols: 120, rows: 30, onData() {} })
    await backend.write({ attachmentId: attached.attachmentId, data: 'pwd\r' })
    await backend.detach(attached.attachmentId)
    assert.equal(written, 'pwd\r')
    assert.equal(killed, 1)
    assert.equal(commands.some((args) => args[0] === 'kill-session'), false)
    await backend.terminate(session)
    assert.equal(commands.some((args) => args[0] === 'kill-session'), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('sendInput 使用服务器 send-keys，不建立额外客户端', async () => {
  const directory = serverDirectory()
  const commands = []
  let spawnCount = 0
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        commands.push(subcommand(args))
        return { status: 0, stdout: '', stderr: '' }
      },
    },
    ptySpawner: () => { spawnCount += 1; throw new Error('不应创建 tmux 客户端') },
  })
  try {
    await backend.sendInput(session, "pnpm run dev\n")
    const sendKeys = commands.find((args) => args[0] === 'send-keys')
    assert.ok(sendKeys)
    assert.ok(sendKeys.includes('-l'))
    assert.ok(sendKeys.includes("pnpm run dev\n"))
    assert.equal(spawnCount, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('会话消失时用包装 Shell 写下的真实退出码，而不是 attach 客户端退出码', async () => {
  const directory = serverDirectory()
  const name = tmuxSessionName(session.runtimeSessionKey)
  // 退出码文件由 create 时创建目录；这里先模拟服务器选项写入已发生。
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        const rest = subcommand(args)
        if (rest[0] === 'has-session') return { status: 1, stdout: '', stderr: 'no server running' }
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  try {
    // 先建一次会话让目录就绪，再写入"包装 Shell 记录的退出码"。
    await backend.create({ session: { ...session, runtimeSessionKey: 'warmup' } })
    writeFileSync(join(directory, 'exit', `${name}.exit`), '7')
    const identity = await backend.inspect(session)
    assert.equal(identity.alive, false)
    assert.equal(identity.exitCode, 7)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('服务器被外部结束且没有退出码时不得伪造成进程退出', async () => {
  const directory = serverDirectory()
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run(_command, args) {
        const rest = subcommand(args)
        if (rest[0] === 'has-session') {
          return { status: 1, stdout: '', stderr: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  })
  try {
    const identity = await backend.inspect(session)
    assert.equal(identity.alive, false)
    // 没有包装 Shell 的退出码时必须是 null，上层据此判定"运行时丢失"。
    assert.equal(identity.exitCode, null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('tmux backend 在非 POSIX 平台明确拒绝运行', async () => {
  const backend = new TmuxTerminalBackend({ platform: 'win32', tmuxPath: '/tmux' })
  await assert.rejects(() => backend.inspect(session), { code: 'TERMINAL_PLATFORM_UNSUPPORTED' })
})

test('tmux 检查不会把权限或 socket 故障误判为会话丢失', async () => {
  const directory = serverDirectory()
  const backend = new TmuxTerminalBackend({
    platform: 'linux',
    tmuxPath: '/usr/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run: () => ({ status: 1, stdout: '', stderr: 'permission denied' }),
    },
  })
  try {
    await assert.rejects(() => backend.inspect(session), /tmux 会话检查失败/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('宿主机重启后 tmux socket 消失时视为会话已丢失并可幂等关闭', async () => {
  const directory = serverDirectory()
  const socketError = 'error connecting to /private/tmp/tmux-501/default (No such file or directory)'
  const backend = new TmuxTerminalBackend({
    platform: 'darwin',
    tmuxPath: '/opt/homebrew/bin/tmux',
    serverDirectory: directory,
    commandRunner: {
      run: (_command, args) => subcommand(args)[0] === 'has-session'
        ? { status: 1, stdout: '', stderr: socketError }
        : { status: 1, stdout: '', stderr: socketError },
    },
  })
  try {
    const identity = await backend.inspect(session)
    assert.equal(identity.alive, false)
    await backend.terminate(session)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('真实 tmux 会话可创建、跨检查保持身份并显式关闭', { skip: !canUseTmux() }, async () => {
  const tmuxPath = findTmux()
  assert.notEqual(tmuxPath, null)
  const directory = serverDirectory()
  const realSession = {
    ...session,
    shellPath: process.platform === 'linux' ? '/bin/bash' : session.shellPath,
    runtimeSessionKey: `integration-${process.pid}-${Date.now()}`,
  }
  const backend = new TmuxTerminalBackend({ platform: process.platform, tmuxPath: tmuxPath ?? undefined, serverDirectory: directory })
  const name = tmuxSessionName(realSession.runtimeSessionKey)
  const socket = join(directory, `${TMUX_SERVER_SOCKET_NAME}.sock`)
  try {
    assert.equal((await backend.create({ session: realSession })).alive, true)
    const identity1 = spawnSync(tmuxPath, ['-S', socket, 'display-message', '-p', '-t', name, '#{session_id}'], { encoding: 'utf8' }).stdout.trim()
    assert.equal((await backend.inspect(realSession)).alive, true)
    const identity2 = spawnSync(tmuxPath, ['-S', socket, 'display-message', '-p', '-t', name, '#{session_id}'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(identity2, identity1)
    // 真实 tmux 必须带上我们的全局选项，否则状态栏会画进用户屏幕。
    const status = spawnSync(tmuxPath, ['-S', socket, 'show-options', '-g', 'status'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(status, 'status off')
    const exitEmpty = spawnSync(tmuxPath, ['-S', socket, 'show-options', '-g', 'exit-empty'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(exitEmpty, 'exit-empty off')
    await backend.terminate(realSession)
    assert.equal((await backend.inspect(realSession)).alive, false)
    // 关闭最后一个会话后服务器必须仍然存活（exit-empty off）。
    const alive = spawnSync(tmuxPath, ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' })
    assert.equal(alive.status, 0)
  } finally {
    // 即使断言失败，也只回收本用例的独立服务器，不能留下孤儿进程。
    killTestServer(tmuxPath, socket, directory)
  }
})

test('真实 tmux：关闭最后一个终端不会让服务器退出', { skip: !canUseTmux() }, async () => {
  const tmuxPath = findTmux()
  assert.notEqual(tmuxPath, null)
  const directory = serverDirectory()
  const socket = join(directory, `${TMUX_SERVER_SOCKET_NAME}.sock`)
  const first = { ...session, shellPath: '/bin/sh', shellArgs: ['-i'], runtimeSessionKey: `keep-${process.pid}-${Date.now()}` }
  const backend = new TmuxTerminalBackend({ platform: process.platform, tmuxPath: tmuxPath ?? undefined, serverDirectory: directory })
  try {
    await backend.create({ session: first })
    await backend.terminate(first)
    const alive = spawnSync(tmuxPath, ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' })
    assert.equal(alive.status, 0, '服务器必须在没有会话时继续存活')
    // 服务器存活时仍然可以继续创建新终端。
    const second = { ...first, runtimeSessionKey: `${first.runtimeSessionKey}-2` }
    assert.equal((await backend.create({ session: second })).alive, true)
    await backend.terminate(second)
  } finally {
    killTestServer(tmuxPath, socket, directory)
  }
  assert.equal(existsSync(socket), false)
})

/**
 * 关掉测试服务器并删除目录。
 *
 * `exit-empty off` 之后服务器不会自己退出，测试必须显式收尾，否则每次跑测试都会
 * 在临时目录里留下一个孤儿 tmux 服务器。
 */
function killTestServer(tmuxPath, socket, directory, run = spawnSync, env = process.env) {
  try {
    run(tmuxPath, ['-S', socket, 'kill-server'], { encoding: 'utf8', timeout: 3_000, env })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function findTmux() {
  for (const path of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux']) {
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {}
  }
  return null
}

/**
 * 在独立服务器里探测可用性，禁止连接继承 TMUX 指向的当前终端或用户默认服务器。
 * 沙箱可能允许找到二进制但禁止访问 socket；此时跳过真实集成测试。
 */
function canUseTmux(tmuxPath = findTmux(), run = spawnSync, env = process.env) {
  if (tmuxPath === null) return false
  const directory = serverDirectory()
  const socket = join(directory, `${TMUX_SERVER_SOCKET_NAME}.sock`)
  try {
    // 空服务器会按默认 exit-empty 策略立即退出；创建一个测试会话才是真实探测。
    // -f /dev/null 保证不执行用户自己的 tmux 配置。
    const started = run(tmuxPath, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'availability', '/bin/sh'], {
      encoding: 'utf8', timeout: 3_000, env,
    })
    return started.status === 0
  } finally {
    // 启动失败或超时也可能留下服务器，收尾必须始终使用同一个测试 socket。
    killTestServer(tmuxPath, socket, directory, run, env)
  }
}
