import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SpawnSyncOptions } from 'node:child_process'
import { WorkBuddyCliDriver } from '../data/build/dist/host/cli-adapters/codebuddy-driver.js'

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'wb-中文 & test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = join(root, 'Programs/WorkBuddy')
  const entry = join(app, 'resources/app.asar.unpacked/cli/bin/codebuddy')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, '#!/usr/bin/env node\nconsole.log(process.argv[2] === "--version" ? "2.156.0" : "--acp  Start ACP");\n')
  return { root, app, entry, runtime: win32.join(app, 'WorkBuddy.exe') }
}

function detected() {
  return { status: 0, stdout: '2.156.0\n--acp  Start ACP', stderr: '' } as never
}

test('WorkBuddy Windows 内置脚本通过同安装 Electron 探测，保留入口和配置根', async (t) => {
  const f = fixture(t)
  const calls: string[][] = []
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry, configRoot: join(f.root, 'config'),
    spawnSync: ((command: string, args: string[], options: SpawnSyncOptions) => {
      calls.push([command, ...args])
      assert.equal(options.shell, false)
      assert.equal(options.env?.ELECTRON_RUN_AS_NODE, '1')
      assert.equal(options.env?.WORKBUDDY_CONFIG_DIR, join(f.root, 'config'))
      assert.equal(options.env?.CODEBUDDY_CONFIG_DIR, join(f.root, 'config'))
      return detected()
    }) as never,
  })
  t.after(() => driver.dispose())
  assert.deepEqual(await driver.detect(), { installed: true, version: '2.156.0', command: f.entry })
  assert.deepEqual(calls, [[f.runtime, f.entry, '--version'], [f.runtime, f.entry, '--help']])
})

test('WorkBuddy Windows 显式运行时覆盖用于探测', async (t) => {
  const f = fixture(t)
  for (const option of [false, true]) {
    const driver = new WorkBuddyCliDriver({
      platform: 'win32', commandPath: f.entry,
      ...(option ? { workbuddyElectronPath: 'option.exe' } : {}),
      environment: { WORKBUDDY_ELECTRON_PATH: 'environment.exe' },
      spawnSync: ((command: string) => {
        assert.equal(command, option ? 'option.exe' : 'environment.exe')
        return detected()
      }) as never,
    })
    t.after(() => driver.dispose())
    assert.equal((await driver.detect()).installed, true)
  }
})

test('WorkBuddy Windows 缺少入口不启动进程，缺少运行时报告启动失败', async (t) => {
  const f = fixture(t)
  let calls = 0
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry,
    spawnSync: (() => {
      calls += 1
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('missing runtime'), { code: 'ENOENT' }) }
    }) as never,
  })
  t.after(() => driver.dispose())
  assert.equal((await driver.detect()).installed, false)
  assert.equal(driver.getDiscoveryFailure(), 'launch')
  rmSync(f.entry)
  assert.equal((await driver.detect()).installed, false)
  assert.equal(driver.getDiscoveryFailure(), undefined)
  assert.equal(calls, 1)
})

test('WorkBuddy Windows 保留 ACP 能力验证', async (t) => {
  const f = fixture(t)
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry,
    spawnSync: (() => ({ status: 0, stdout: '2.156.0', stderr: '' })) as never,
  })
  t.after(() => driver.dispose())
  assert.equal((await driver.detect()).installed, false)
  assert.equal(driver.getDiscoveryFailure(), 'protocol')
})

test('WorkBuddy Windows exe/cmd 入口保持直接探测', async (t) => {
  const f = fixture(t)
  for (const extension of ['.exe', '.cmd']) {
    const entry = f.entry + extension
    writeFileSync(entry, '')
    const driver = new WorkBuddyCliDriver({
      platform: 'win32', commandPath: entry,
      spawnSync: ((command: string, args: string[]) => {
        assert.equal(command, entry)
        assert.ok(args[0] === '--version' || args[0] === '--help')
        return detected()
      }) as never,
    })
    t.after(() => driver.dispose())
    assert.equal((await driver.detect()).installed, true)
  }
})

test('WorkBuddy Windows 真实进程处理无扩展名脚本与中文空格 & 路径', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t)
  // 使用 Node 作为假 Electron，保留真实 execFile 参数与文件布局。
  copyFileSync(process.execPath, f.runtime)
  const driver = new WorkBuddyCliDriver({ environment: {
    LOCALAPPDATA: f.root, PROGRAMFILES: join(f.root, 'absent'), WORKBUDDY_CLI_PATH: '', WORKBUDDY_ELECTRON_PATH: '',
  } })
  t.after(() => driver.dispose())
  assert.deepEqual(await driver.detect(), { installed: true, version: '2.156.0', command: f.entry })
  assert.equal(driver.getDiscoveryFailure(), undefined)
  rmSync(f.entry)
  assert.deepEqual(await driver.detect(), { installed: false, version: null, command: null })
  assert.equal(driver.getDiscoveryFailure(), undefined)
})

for (const discovery of ['override', 'pid', 'scan'] as const) {
test(`WorkBuddy Windows sidecar ${discovery} 发现并使用同安装运行时和资源路径`, { skip: discovery !== 'override' && process.platform !== 'win32' }, async (t) => {
  const f = fixture(t)
  const configRoot = join(f.root, 'config')
  const configHash = createHash('sha1').update(configRoot).digest('hex').slice(0, 12)
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\workbuddy-${configHash}-sidecar-control-deadbeef`
    : `/tmp/codingns-wb-${randomUUID()}.sock`
  if (discovery === 'pid') {
    const runtimeRoot = join(tmpdir(), 'wb', configHash)
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(join(runtimeRoot, 'sidecar.pid'), JSON.stringify({ controlPipeUuid: 'deadbeef' }))
    t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }))
  }
  let created: { command: string; args: string[]; env: Record<string, string> } | undefined
  const server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer.trim())
      if (request.method === 'session.create') created = request.params
      // 创建请求到达即结束测试，不启动外部会话或连接真实 ACP。
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'session.list' ? [] : {} }) + '\n')
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry, configRoot,
    ...(discovery === 'override' ? { sidecarSocketPath: socketPath } : {}), spawnSync: detected,
    environment: { WORKBUDDY_APP_PATH: '', WORKBUDDY_RESOURCES_PATH: '', WORKBUDDY_ELECTRON_PATH: '', WORKBUDDY_SIDECAR_SOCKET: '' },
  })
  t.after(() => driver.dispose())
  await assert.rejects(async () => {
    for await (const event of driver.executeTurn({ sessionId: 'test', messages: [], prompt: 'test' })) void event
  }, /sidecar 未返回 ACP 地址/u)
  assert.equal(created?.command, f.runtime)
  assert.equal(created?.args[0], f.entry)
  assert.equal(created?.args[1], '--serve')
  // 每轮回收进程后仍须能从产品历史恢复下一轮。
  assert.equal(created?.args.includes('--no-session-persistence'), false)
  assert.equal(created?.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(created?.env.WORKBUDDY_APP_PATH, win32.join(f.app, 'resources/app.asar'))
  assert.equal(created?.env.WORKBUDDY_RESOURCES_PATH, win32.join(f.app, 'resources'))
  assert.equal(created?.env.WORKBUDDY_CONFIG_DIR, created?.env.CODEBUDDY_CONFIG_DIR)
})
}
