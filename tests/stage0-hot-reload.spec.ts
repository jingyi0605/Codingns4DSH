import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { createRequire } from 'node:module'
import { reloadScript } from '../scripts/stage0-client-hmr.mjs'
import { registerStage0DevHmr } from '../data/build/dist/host/stage0-dev-hmr.js'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const stage0Script = join(repositoryRoot, 'scripts/run-dsh-stage0.sh')
const packageId = '@jingyi0605/codingns4dsh'
const unixOnly = { skip: process.platform === 'win32' }
const require = createRequire(import.meta.url)
const yaml = createRequire(require.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml')

/** 所有进程都是临时目录里的假入口；不启动真实 DSH 或编译器。 */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'codingns-stage0-watch-'))
  const bin = join(root, 'bin')
  const events = join(root, 'events.jsonl')
  const home = join(root, 'home')
  const launcher = join(root, 'launcher.mjs')
  mkdirSync(bin)
  mkdirSync(join(home, 'profiles/stage0'), { recursive: true })
  writeFileSync(join(home, 'profiles/stage0/package.json'), '{"name":"stage0"}')
  writeFileSync(launcher, `
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.CODINGNS_TEST_EVENTS, JSON.stringify({ role: 'dsh', pid: process.pid, args: process.argv.slice(2) }) + '\\n')
console.log('codingns-test-dsh-started')
if (process.env.CODINGNS_TEST_DSH_KEEP_ALIVE === '1') setInterval(() => {}, 1000)
else process.exit(Number(process.env.CODINGNS_TEST_DSH_CODE ?? '17'))
`)
  const pnpm = join(bin, 'pnpm')
  writeFileSync(pnpm, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const role = process.argv[3]
const record = (value) => appendFileSync(process.env.CODINGNS_TEST_EVENTS, JSON.stringify(value) + '\\n')
record({ role, pid: process.pid, args: process.argv.slice(2) })
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
record({ role: role + '-child', pid: child.pid })
setTimeout(() => {
  if (process.env.CODINGNS_TEST_WATCH_FAIL === role) process.exit(23)
  record({ role: role + '-ready' })
  console.log(role === 'tsc' ? 'Found 0 errors. Watching for file changes.' : '✔ Build complete in 12ms')
  if (process.env.CODINGNS_TEST_WATCH_LATE_FAIL === role) setTimeout(() => process.exit(24), 500)
}, role === 'tsc' ? 40 : 200)
setInterval(() => {}, 1000)
`)
  chmodSync(pnpm, 0o755)
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(root, 'user-home'),
    DSH_STAGE0_LAUNCHER: launcher,
    DSH_STAGE0_HOME: home,
    CODINGNS4DSH_STAGE0_STATE_DIR: join(root, 'state'),
    CODINGNS_TEST_EVENTS: events,
  }
  // 不能继承测试调用方关闭 watch 的设置或故障注入参数。
  delete env.DSH_STAGE0_WATCH
  delete env.CODINGNS_TEST_WATCH_FAIL
  delete env.CODINGNS_TEST_WATCH_LATE_FAIL
  delete env.CODINGNS_TEST_DSH_KEEP_ALIVE
  return {
    root, env, launcher,
    events: () => readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function verifyCleanup(events: Array<{ pid?: number }>) {
  const pids = events.flatMap((event) => event.pid === undefined ? [] : [event.pid])
  // 派生进程被系统回收需要一个短窗口，断言真正退出，而不只检查 kill 是否调用。
  for (let attempt = 0; attempt < 30 && pids.some(isAlive); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.deepEqual(pids.filter(isAlive), [])
}

test('默认启动等待两种编译完成，透传退出码并清理监听及派生进程', unixOnly, async () => {
  const fixture = createFixture()
  try {
    const result = spawnSync('/bin/bash', [stage0Script], { env: fixture.env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 17, result.stderr)
    const events = fixture.events()
    const roles = events.map((event) => event.role)
    assert.ok(roles.indexOf('dsh') > roles.indexOf('tsc-ready'))
    assert.ok(roles.indexOf('dsh') > roles.indexOf('tsdown-ready'))
    assert.match(result.stderr, /首次编译成功/u)
    await verifyCleanup(events)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('编译监听启动失败时不启动 DSH，并清理其他监听', unixOnly, async () => {
  const fixture = createFixture()
  fixture.env.CODINGNS_TEST_WATCH_FAIL = 'tsdown'
  try {
    const result = spawnSync('/bin/bash', [stage0Script], { env: fixture.env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 23, result.stderr)
    const events = fixture.events()
    assert.equal(events.some((event) => event.role === 'dsh'), false)
    await verifyCleanup(events)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('运行中的编译监听失败会停止 DSH，避免继续使用旧代码', unixOnly, async () => {
  const fixture = createFixture()
  fixture.env.CODINGNS_TEST_WATCH_LATE_FAIL = 'tsdown'
  fixture.env.CODINGNS_TEST_DSH_KEEP_ALIVE = '1'
  try {
    const result = spawnSync('/bin/bash', [stage0Script], { env: fixture.env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 24, result.stderr)
    const events = fixture.events()
    assert.equal(events.some((event) => event.role === 'dsh'), true)
    await verifyCleanup(events)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('SIGTERM 关闭 Stage0 时同时清理编译器和派生进程', unixOnly, async () => {
  const fixture = createFixture()
  fixture.env.CODINGNS_TEST_DSH_KEEP_ALIVE = '1'
  const child = spawn('/bin/bash', [stage0Script], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(poll); reject(new Error(output)) }, 5000)
      const poll = setInterval(() => {
        if (!output.includes('codingns-test-dsh-started')) return
        clearTimeout(timeout)
        clearInterval(poll)
        resolve()
      }, 20)
    })
    child.kill('SIGTERM')
    const [code] = await closed
    assert.equal(code, 143, output)
    assert.match(output, /SIGTERM/u)
    await verifyCleanup(fixture.events())
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('配置查询、帮助和插件管理自动跳过监听，参数原样传给 DSH', unixOnly, () => {
  for (const args of [['--dump-config'], ['--dump-config-schema'], ['--dump-default-config'], ['--help'], ['plugin', '--profile', 'stage0', 'list']]) {
    const fixture = createFixture()
    try {
      const result = spawnSync('/bin/bash', [stage0Script, ...args], { env: fixture.env, encoding: 'utf8', timeout: 5000 })
      assert.equal(result.status, 17, result.stderr)
      const events = fixture.events()
      assert.deepEqual(events.map((event) => event.role), ['dsh'])
      for (const argument of args) assert.ok(events[0].args.includes(argument))
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }
})

test('DSH_STAGE0_WATCH=0 支持外部监听，非法值在启动前失败', unixOnly, () => {
  for (const value of ['0', 'invalid']) {
    const fixture = createFixture()
    fixture.env.DSH_STAGE0_WATCH = value
    try {
      const result = spawnSync('/bin/bash', [stage0Script], { env: fixture.env, encoding: 'utf8', timeout: 5000 })
      assert.equal(result.status, value === '0' ? 17 : 1, result.stderr)
      if (value === '0') assert.deepEqual(fixture.events().map((event) => event.role), ['dsh'])
      else assert.match(result.stderr, /只接受 0 或 1/u)
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }
})

test('Stage0 patch 经原生 patch 算法后保留终端隔离并监听 Host 产物', () => {
  const patches = yaml.load(readFileSync(join(repositoryRoot, 'dsh-stage0.patch.yml'), 'utf8'), { schema: entryListSchema })
  const entries = [
    { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' },
    { id: 'ui-sidebar-terminal', name: '@deepseek-ai/dsh-client-ui-sidebar-terminal' },
    { id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' },
    { id: 'hmr', name: '@deepseek-ai/dsh-hmr', config: { root: [] } },
  ]
  const warnings: string[] = []
  const result = applyEntryPatches(entries, patches, (warning) => warnings.push(warning))
  assert.deepEqual(warnings, [])
  for (const id of ['terminal-controller', 'ui-sidebar-terminal', 'client-hmr']) {
    assert.equal(result.find((entry) => entry.id === id)?.disabled, true)
  }
  const config = result.find((entry) => entry.id === 'hmr')?.config
  assert.deepEqual(config.root, ['data/build/dist'])
  assert.ok(config.ignored.includes('data/build/dist/client/**'))
  assert.equal(config.ignored.includes('data'), false)
  assert.ok(config.debounce >= 500)
  assert.match(config.base.__jsExpr, /CODINGNS4DSH_STAGE0_REPO_URL/u)
})

test('Stage0 runtime passes a file URL to the Host HMR configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-stage0-url-'))
  const launcher = join(root, 'launcher.mjs')
  writeFileSync(launcher, 'console.log(process.env.CODINGNS4DSH_STAGE0_REPO_URL)')
  try {
    const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/stage0-runtime.mjs'), launcher], {
      env: { ...process.env, CODINGNS4DSH_STAGE0_WATCH: '0' },
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fileURLToPath(result.stdout.trim()), repositoryRoot)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 用浏览器假对象执行真实注入脚本，验证不会进入局部模块重载。 */
function createBrowser() {
  let message: (event: { data: string }) => void
  let pagehide: () => void
  let reloaded = 0
  let closed = 0
  let timer = 0
  const pending = new Map<number, () => void>()
  runInNewContext(reloadScript, {
    EventSource: class {
      constructor(path: string) { assert.equal(path, 'plugins/events') }
      addEventListener(name: string, callback: typeof message) { assert.equal(name, 'message'); message = callback }
      close() { closed += 1 }
    },
    location: { reload: () => { reloaded += 1 } },
    addEventListener(name: string, callback: () => void) { assert.equal(name, 'pagehide'); pagehide = callback },
    setTimeout(callback: () => void) { pending.set(++timer, callback); return timer },
    clearTimeout(id: number) { pending.delete(id) },
  })
  return {
    send(frame: unknown) { message({ data: JSON.stringify(frame) }) },
    sendRaw(data: string) { message({ data }) },
    flush() { for (const callback of pending.values()) callback(); pending.clear() },
    hide() { pagehide() },
    pending: () => pending.size,
    reloaded: () => reloaded,
    closed: () => closed,
  }
}

function graph(rev: string) { return { type: 'graph', graph: { entries: [{ id: packageId, rev }] } } }

test('首个图和重复版本不会刷新；连续重建合并为一次整页刷新', () => {
  const browser = createBrowser()
  browser.send(graph('v1'))
  browser.send(graph('v1'))
  browser.send({ type: 'rebuilt', id: '@other/plugin', rev: 'v2' })
  browser.sendRaw('{bad json')
  browser.send(null)
  assert.equal(browser.pending(), 0)
  browser.send(graph('v2'))
  browser.send({ type: 'rebuilt', id: packageId, rev: 'v2' })
  browser.send({ type: 'rebuilt', id: packageId, rev: 'v3' })
  assert.equal(browser.pending(), 1)
  browser.flush()
  assert.equal(browser.reloaded(), 1)
  assert.equal(browser.closed(), 1)
})

test('重连后的新图会刷新；离开页面取消刷新并关闭事件流', () => {
  const browser = createBrowser()
  browser.send(graph('v1'))
  browser.send(graph('v2'))
  assert.equal(browser.pending(), 1)
  browser.hide()
  browser.flush()
  assert.equal(browser.reloaded(), 0)
  assert.equal(browser.closed(), 1)
})

test('Stage0 HMR 桥复用目标运行时的官方 Host transport 并注入刷新脚本', unixOnly, async () => {
  const fixture = createFixture()
  const previous = process.env.CODINGNS4DSH_STAGE0_LAUNCHER
  try {
    const pkg = join(fixture.root, 'node_modules/@deepseek-ai/dsh-client-hmr')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"type":"module","exports":"./index.js"}')
    writeFileSync(join(pkg, 'index.js'), 'export function apply(ctx, config) { ctx.transportConfig = config }')
    process.env.CODINGNS4DSH_STAGE0_LAUNCHER = fixture.launcher
    const { apply } = await import(pathToFileURL(join(repositoryRoot, 'scripts/stage0-client-hmr.mjs')).href)
    let inject: (table: unknown[]) => void
    const ctx = { on(event: string, listener: typeof inject) { assert.equal(event, 'webserver/index-inject'); inject = listener } } as any
    await apply(ctx)
    assert.deepEqual(ctx.transportConfig, { pollIntervalMs: 500 })
    const table: any[] = []
    inject(table)
    assert.equal(table[0].kind, 'script')
    assert.equal(table[0].text, reloadScript)
  } finally {
    if (previous === undefined) delete process.env.CODINGNS4DSH_STAGE0_LAUNCHER
    else process.env.CODINGNS4DSH_STAGE0_LAUNCHER = previous
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('开发桥只为 Stage0 注册，不在其他 Profile 加载开发脚本', () => {
  const names = ['CODINGNS4DSH_PROFILE_NAME', 'CODINGNS4DSH_STAGE0_REPO_ROOT', 'CODINGNS4DSH_STAGE0_LAUNCHER']
  const previous = names.map((name) => process.env[name])
  let registrations = 0
  const ctx = { inject() { registrations += 1 } } as any
  try {
    process.env.CODINGNS4DSH_STAGE0_REPO_ROOT = repositoryRoot
    process.env.CODINGNS4DSH_STAGE0_LAUNCHER = join(repositoryRoot, 'fake-launcher.mjs')
    for (const profile of ['desktop', 'web', '']) {
      process.env.CODINGNS4DSH_PROFILE_NAME = profile
      registerStage0DevHmr(ctx)
    }
    assert.equal(registrations, 0)
    process.env.CODINGNS4DSH_PROFILE_NAME = 'stage0'
    registerStage0DevHmr(ctx)
    assert.equal(registrations, 1)
    delete process.env.CODINGNS4DSH_STAGE0_REPO_ROOT
    registerStage0DevHmr(ctx)
    assert.equal(registrations, 1)
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
})
