import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { DoubaoApp } from '../src/host/cli-adapters/doubao-app.js'

const target = { url: 'doubao://doubao-background/', webSocketDebuggerUrl: 'ws://127.0.0.1:9225/devtools/page/test' }

function runtimeFixture(options: { readonly processList?: string; readonly discoveredPath?: string; readonly registryPath?: string; readonly initialReady?: boolean } = {}) {
  let ready = options.initialReady === true
  const spawns: Array<{ readonly file: string; readonly args: readonly string[]; readonly options: unknown }> = []
  const commands: Array<{ readonly file: string; readonly args: readonly string[] }> = []
  const access = async (path: string): Promise<void> => {
    if (path === 'C:\\Apps\\Doubao\\Doubao.exe' || path === options.discoveredPath || path === options.registryPath) return
    throw new Error('ENOENT')
  }
  const exec = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    commands.push({ file, args })
    if (file.toLowerCase().endsWith('tasklist.exe')) return { stdout: options.processList ?? 'INFO: No tasks are running which match the specified criteria.\r\n', stderr: '' }
    if (file.toLowerCase().endsWith('reg.exe') && args.includes('/s')) return { stdout: `    DisplayIcon    REG_SZ    \"${options.registryPath ?? ''}\",0\r\n`, stderr: '' }
    if (file.toLowerCase().endsWith('where.exe')) return { stdout: `${options.discoveredPath ?? ''}\r\n`, stderr: '' }
    return { stdout: '', stderr: '' }
  }
  const spawn = (file: string, args: string[], spawnOptions: any): ChildProcess => {
    spawns.push({ file, args, options: spawnOptions })
    ready = true
    const child = new EventEmitter() as ChildProcess
    child.unref = () => child
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  const fetch = async (): Promise<Response> => {
    if (!ready) throw new TypeError('connect ECONNREFUSED')
    return new Response(JSON.stringify([target]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { runtime: { access, exec, spawn, fetch, sleep: async () => undefined }, spawns, commands }
}

test('Windows 安装发现和按需启动不在 detect 阶段拉起豆包', async () => {
  const fixture = runtimeFixture()
  const app = new DoubaoApp({
    CODINGNS_DOUBAO_APP_PATH: 'C:\\Apps\\Doubao\\Doubao.exe',
  }, 'win32', fixture.runtime)

  const detection = await app.detect()
  assert.deepEqual(detection, { installed: true, runtimeState: 'installed', version: null, command: 'C:\\Apps\\Doubao\\Doubao.exe' })
  assert.equal(fixture.spawns.length, 0)
  await assert.rejects(app.connect(false), /只读探测不会启动 App/u)
  assert.equal(fixture.spawns.length, 0)

  await (app as unknown as { launch(): Promise<void> }).launch()
  assert.equal(fixture.spawns.length, 1)
  assert.equal(fixture.spawns[0]?.file, 'C:\\Apps\\Doubao\\Doubao.exe')
  assert.deepEqual(fixture.spawns[0]?.args, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9225'])
  assert.deepEqual(fixture.spawns[0]?.options, { detached: true, windowsHide: true, stdio: 'ignore' })
})

test('Windows 未配置路径时可通过 PATH 发现 Doubao.exe', async () => {
  const fixture = runtimeFixture({ discoveredPath: 'C:\\Users\\dev\\AppData\\Local\\Doubao\\Doubao.exe' })
  const app = new DoubaoApp({ SystemRoot: 'C:\\Windows' }, 'win32', fixture.runtime)
  const detection = await app.detect()
  assert.equal(detection.installed, true)
  assert.equal(detection.command, 'C:\\Users\\dev\\AppData\\Local\\Doubao\\Doubao.exe')
  assert.equal(fixture.spawns.length, 0)
  assert.ok(fixture.commands.some(({ file }) => file.toLowerCase().endsWith('where.exe')))
})

test('已有豆包调试端口时检测标记为 ready，且不启动新进程', async () => {
  const fixture = runtimeFixture({ initialReady: true })
  const app = new DoubaoApp({
    CODINGNS_DOUBAO_APP_PATH: 'C:\\Apps\\Doubao\\Doubao.exe',
  }, 'win32', fixture.runtime)
  const detection = await app.detect()
  assert.deepEqual(detection, { installed: true, runtimeState: 'ready', version: null, command: 'C:\\Apps\\Doubao\\Doubao.exe' })
  assert.equal(fixture.spawns.length, 0)
})

test('Windows 可通过卸载注册表的 DisplayIcon 发现版本化安装入口', async () => {
  const fixture = runtimeFixture({ registryPath: 'C:\\Users\\dev\\AppData\\Local\\Doubao\\app-1.2.3\\Doubao.exe' })
  const app = new DoubaoApp({ SystemRoot: 'C:\\Windows' }, 'win32', fixture.runtime)
  const detection = await app.detect()
  assert.equal(detection.installed, true)
  assert.equal(detection.runtimeState, 'installed')
  assert.equal(detection.command, 'C:\\Users\\dev\\AppData\\Local\\Doubao\\app-1.2.3\\Doubao.exe')
})

test('Windows 不会把无关卸载项的 DisplayIcon 误认成豆包', async () => {
  const fixture = runtimeFixture({ registryPath: 'C:\\Program Files\\Other\\Other.exe' })
  const app = new DoubaoApp({ SystemRoot: 'C:\\Windows' }, 'win32', fixture.runtime)
  const detection = await app.detect()
  assert.equal(detection.installed, false)
  assert.equal(detection.runtimeState, 'missing')
})

test('Windows 已有普通豆包进程时不重复启动', async () => {
  const fixture = runtimeFixture({ processList: '"Doubao.exe","1234","Console","1","10,000 K"\r\n' })
  const app = new DoubaoApp({
    CODINGNS_DOUBAO_APP_PATH: 'C:\\Apps\\Doubao\\Doubao.exe',
  }, 'win32', fixture.runtime)
  await assert.rejects((app as unknown as { launch(): Promise<void> }).launch(), /已经运行但未开启调试端口/u)
  assert.equal(fixture.spawns.length, 0)
})
