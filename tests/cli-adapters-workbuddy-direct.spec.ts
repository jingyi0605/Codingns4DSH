import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SpawnOptions, spawn } from 'node:child_process'
import { WorkBuddyCliDriver } from '../data/build/dist/host/cli-adapters/codebuddy-driver.js'

function fixture(t: { after(fn: () => void): void }, lite = false) {
  const root = mkdtempSync(join(tmpdir(), 'codingns-wb-中文 & direct-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = join(root, 'WorkBuddy')
  const entry = join(app, 'resources/app.asar.unpacked/cli/bin/codebuddy')
  const dist = join(dirname(dirname(entry)), 'dist')
  mkdirSync(dirname(entry), { recursive: true })
  mkdirSync(dist)
  writeFileSync(entry, '')
  writeFileSync(join(dist, lite ? 'codebuddy-lite-wb.mjs' : 'codebuddy-headless.js'), '')
  return { root, app, entry, runtime: win32.join(app, 'WorkBuddy.exe'), configRoot: join(root, 'config') }
}

function acpHarness(holdPrompt = false, interaction?: 'permission' | 'question') {
  const launches: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  const requests: Array<{ id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }> = []
  let closed = 0
  const run = ((command: string, args: readonly string[], options: SpawnOptions) => {
    launches.push({ command, args, options })
    const child = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let promptId: number | string | undefined
    const stdin = { write(data: string) {
      const request = JSON.parse(data) as (typeof requests)[number]
      requests.push(request)
      if (request.id === undefined) return true
      if (request.id === 'native-permission' || request.id === 'native-question') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })}\n`)
        return true
      }
      if (request.method === 'session/prompt') {
        promptId = request.id
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } })}\n`)
        if (interaction === 'permission') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'native-permission', method: 'session/request_permission', params: {
            options: [{ optionId: 'native-allow', kind: 'allow_once' }, { optionId: 'native-deny', kind: 'reject_once' }],
            toolCall: { title: 'Run command', toolCallId: 'call-1' },
          } })}\n`)
          return true
        }
        if (interaction === 'question') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'native-question', method: 'elicitation/create', params: {
            mode: 'form', message: 'Choose a mode', requestedSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['safe', 'fast'] } } },
          } })}\n`)
          return true
        }
        if (holdPrompt) return true
      }
      const result = request.method === 'session/new' || request.method === 'session/load'
        ? { sessionId: 'native-workbuddy-session' }
        : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
      if (request.method === 'session/cancel' && promptId !== undefined) {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } })}\n`)
      }
      return true
    } }
    return Object.assign(child, { stdout, stderr, stdin, kill() {
      closed += 1
      stdout.end()
      stderr.end()
      queueMicrotask(() => child.emit('close', 0))
      return true
    } })
  }) as typeof spawn
  return { launches, requests, run, closed: () => closed }
}

function detected() {
  return { status: 0, stdout: '2.165.0\n--acp  Start ACP', stderr: '' } as never
}

test('WorkBuddy 默认直接启动同安装 Electron，无桌面 sidecar 也能完成首轮及恢复', async (t) => {
  const f = fixture(t)
  const acp = acpHarness()
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry, configRoot: f.configRoot,
    environment: { WORKBUDDY_ELECTRON_PATH: '', WORKBUDDY_SIDECAR_SOCKET: '' },
    spawnSync: detected, spawn: acp.run,
  })
  t.after(() => driver.dispose())
  const events = []
  for await (const event of driver.executeTurn({ sessionId: 'direct', messages: [], prompt: 'first' })) events.push(event)
  for await (const event of driver.executeTurn({ sessionId: 'direct', providerSessionId: 'native-workbuddy-session', messages: [], prompt: 'second' })) events.push(event)
  assert.equal(acp.launches.length, 2)
  for (const launch of acp.launches) {
    assert.equal(launch.command, f.runtime)
    assert.equal(launch.options.shell, false)
    assert.equal(launch.args[0], '--eval')
    assert.equal(launch.args[2], f.entry)
    assert.ok(launch.args[1]?.includes('electron_browser_workbuddy_storage'))
    assert.ok(launch.args.includes('--acp'))
    assert.equal(launch.args.includes('--no-session-persistence'), false)
    assert.equal(launch.options.env?.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(launch.options.env?.WORKBUDDY_CONFIG_DIR, f.configRoot)
    assert.equal(launch.options.env?.CODEBUDDY_CONFIG_DIR, f.configRoot)
  }
  assert.equal(acp.requests.filter((request) => request.method === 'session/new').length, 1)
  assert.equal(acp.requests.find((request) => request.method === 'session/load')?.params?.sessionId, 'native-workbuddy-session')
  assert.equal(events.filter((event) => event.type === 'text-delta' && event.text === 'OK').length, 2)
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
  assert.equal(acp.closed(), 2)
})

test('WorkBuddy 直连模式的精简包保持 stdio 并完成原生服务就绪配置', async (t) => {
  const f = fixture(t, true)
  const acp = acpHarness()
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry, configRoot: f.configRoot,
    environment: { WORKBUDDY_ELECTRON_PATH: '', WORKBUDDY_SIDECAR_SOCKET: '' },
    spawnSync: detected, spawn: acp.run,
  })
  t.after(() => driver.dispose())
  for await (const event of driver.executeTurn({ sessionId: 'lite', messages: [], prompt: 'first' })) void event
  const launch = acp.launches[0]!
  assert.equal(launch.command, f.runtime)
  assert.ok(launch.args.includes('--acp'))
  assert.ok(launch.args.includes('--serve'))
  assert.equal(launch.args[launch.args.indexOf('--host') + 1], '127.0.0.1')
  assert.equal(launch.args[launch.args.indexOf('--port') + 1], '0')
  assert.equal(launch.args[launch.args.indexOf('--auth') + 1], 'password')
  assert.equal(launch.options.env?.CODEBUDDY_FORCE_LITE_WB_BUNDLE, '1')
  assert.ok(launch.options.env?.CODEBUDDY_GATEWAY_PASSWORD)
  assert.equal(launch.args.includes(launch.options.env!.CODEBUDDY_GATEWAY_PASSWORD!), false)
})

test('WorkBuddy 同时包含多套 bundle 时优先使用桌面专属精简入口', async (t) => {
  const f = fixture(t, true)
  writeFileSync(join(dirname(dirname(f.entry)), 'dist/codebuddy-headless.js'), '')
  const acp = acpHarness()
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry, configRoot: f.configRoot,
    environment: { WORKBUDDY_ELECTRON_PATH: '' }, spawnSync: detected, spawn: acp.run,
  })
  t.after(() => driver.dispose())
  for await (const event of driver.executeTurn({ sessionId: 'bundles', messages: [], prompt: 'first' })) void event
  assert.equal(acp.launches[0]?.options.env?.CODEBUDDY_FORCE_LITE_WB_BUNDLE, '1')
  assert.ok(acp.launches[0]?.args.includes('--serve'))
})

test('WorkBuddy 直连取消关闭本轮进程，下一轮仍可恢复原生会话', async (t) => {
  const f = fixture(t)
  const acp = acpHarness(true)
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry, configRoot: f.configRoot,
    environment: { WORKBUDDY_ELECTRON_PATH: '' }, spawnSync: detected, spawn: acp.run,
  })
  t.after(() => driver.dispose())
  const stream = driver.executeTurn({ sessionId: 'cancel', messages: [], prompt: 'first' })[Symbol.asyncIterator]()
  assert.equal((await stream.next()).value?.type, 'session-binding')
  assert.equal((await stream.next()).value?.type, 'text-delta')
  await driver.interrupt('cancel')
  assert.deepEqual((await stream.next()).value, { type: 'finish', reason: 'cancel' })
  assert.equal((await stream.next()).done, true)
  assert.ok(acp.requests.some((request) => request.method === 'session/cancel' && request.params?.sessionId === 'native-workbuddy-session'))
  assert.equal(acp.closed(), 1)
  const resumed = driver.executeTurn({ sessionId: 'cancel', providerSessionId: 'native-workbuddy-session', messages: [], prompt: 'second' })[Symbol.asyncIterator]()
  assert.equal((await resumed.next()).value?.type, 'session-binding')
  await resumed.return?.()
  assert.equal(acp.launches.length, 2)
  assert.equal(acp.closed(), 2)
})

test('WorkBuddy 直连取消信号释放等待中的进程与请求', async (t) => {
  const f = fixture(t)
  const acp = acpHarness(true)
  const controller = new AbortController()
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry, configRoot: f.configRoot,
    environment: { WORKBUDDY_ELECTRON_PATH: '' }, spawnSync: detected, spawn: acp.run,
  })
  t.after(() => driver.dispose())
  const stream = driver.executeTurn({ sessionId: 'abort', messages: [], prompt: 'first', signal: controller.signal })[Symbol.asyncIterator]()
  await stream.next()
  await stream.next()
  controller.abort()
  await assert.rejects(stream.next(), /取消/u)
  assert.equal(acp.closed(), 1)
})

for (const interaction of ['permission', 'question'] as const) {
  test(`WorkBuddy 直连模式保留原生 ${interaction} 请求与结构化应答`, async (t) => {
    const f = fixture(t)
    const acp = acpHarness(false, interaction)
    const driver = new WorkBuddyCliDriver({
      platform: 'win32', commandPath: f.entry, configRoot: f.configRoot,
      environment: { WORKBUDDY_ELECTRON_PATH: '' }, spawnSync: detected, spawn: acp.run,
    })
    t.after(() => driver.dispose())
    const events = []
    for await (const event of driver.executeTurn({ sessionId: interaction, messages: [], prompt: 'first' })) {
      events.push(event)
      if (event.type === 'permission-request') await driver.respondPermission(interaction, { requestId: event.requestId, approved: false })
      if (event.type === 'question-request') await driver.respondQuestion(interaction, { requestId: event.requestId, answers: [{ id: 'mode', selected: ['safe'] }] })
    }
    const reply = acp.requests.find((request) => request.id === `native-${interaction}`)
    assert.deepEqual(reply?.result, interaction === 'permission'
      ? { outcome: { outcome: 'selected', optionId: 'native-deny' } }
      : { action: 'accept', content: { mode: 'safe' } })
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
    assert.equal(acp.closed(), 1)
  })
}

test('WorkBuddy 并发直连回合使用独立进程并分别释放', async (t) => {
  const f = fixture(t)
  const acp = acpHarness(true)
  const driver = new WorkBuddyCliDriver({
    platform: 'win32', commandPath: f.entry, configRoot: f.configRoot,
    environment: { WORKBUDDY_ELECTRON_PATH: '' }, spawnSync: detected, spawn: acp.run,
  })
  t.after(() => driver.dispose())
  const streams = ['parallel-1', 'parallel-2'].map((sessionId) => driver.executeTurn({ sessionId, messages: [], prompt: sessionId })[Symbol.asyncIterator]())
  await Promise.all(streams.map((stream) => stream.next()))
  assert.equal(acp.launches.length, 2)
  await streams[0]!.return?.()
  assert.equal(acp.closed(), 1)
  assert.equal((await streams[1]!.next()).value?.type, 'text-delta')
  await streams[1]!.return?.()
  assert.equal(acp.closed(), 2)
})

test('WorkBuddy 直连真实进程保留中文空格及 & 路径中的 eval 与脚本参数', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t)
  copyFileSync(process.execPath, f.runtime)
  writeFileSync(f.entry, String.raw`
    if (process.argv.includes('--version')) { console.log('2.165.0'); process.exit(0); }
    if (process.argv.includes('--help')) { console.log('--acp'); process.exit(0); }
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      if (request.method === 'session/prompt') process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OK'}}}})+'\n');
      const result = request.method === 'session/new' ? {sessionId:'real-process-session'} : request.method === 'session/prompt' ? {stopReason:'end_turn'} : {};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    });
  `)
  const driver = new WorkBuddyCliDriver({
    commandPath: f.entry, configRoot: f.configRoot, environment: { WORKBUDDY_ELECTRON_PATH: '' },
  })
  t.after(() => driver.dispose())
  const events = []
  for await (const event of driver.executeTurn({ sessionId: 'native-argv', cwd: f.root, messages: [], prompt: 'first', signal: AbortSignal.timeout(10_000) })) events.push(event)
  assert.equal(events.some((event) => event.type === 'text-delta' && event.text === 'OK'), true)
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
})

test('WorkBuddy 配置根不会继承独立 CodeBuddy 的目录', () => {
  const driver = new WorkBuddyCliDriver({ environment: { WORKBUDDY_CONFIG_DIR: '', CODEBUDDY_CONFIG_DIR: 'other-codebuddy-root' } })
  assert.notEqual(driver.configDirectory, 'other-codebuddy-root')
  driver.dispose()
})
