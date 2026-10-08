import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'
import childProcess, { type SpawnSyncOptions } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { windowsCommandEnvironment } from '../src/host/cli-adapters/windows-command-environment.js'

// 在独立测试进程内切换平台分支；所有系统命令都拦截，绝不操作 Desktop 或真实安装。
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { value: 'win32' })
after(() => { Object.defineProperty(process, 'platform', platformDescriptor) })
// 使用项目统一的 .js 导入约定：完整测试读取产物，源码回归由 source-loader 在内存转换。
// 不能直读 .ts，否则 Node 22 的类型擦除无法处理驱动中的构造函数参数属性。
const { runAsyncCommand, resolveCommandPath, commandEnvironment, invalidateCommandEnvironment, prepareWindowsCommandEnvironment } = await import('../src/host/cli-adapters/process-utils.js')
const { detectBinary } = await import('../src/host/cli-adapters/binary-detection.js')
const { StandardStreamDriver } = await import('../src/host/cli-adapters/standard-stream-driver.js')
const { QoderCliDriver } = await import('../src/host/cli-adapters/qoder-driver.js')
const { CodeBuddyCliDriver } = await import('../src/host/cli-adapters/codebuddy-driver.js')
const { JsonRpcProcess } = await import('../src/host/cli-adapters/json-rpc-process.js')
const { CodingNsCliAdapterRegistry } = await import('../src/host/cli-adapters/registry.js')
beforeEach(() => invalidateCommandEnvironment())

const missing = { status: 1, stdout: '', stderr: '' }
const version = { status: 0, stdout: 'probe 1.2.3', stderr: '' }
const snapshot = { machine: { Path: 'C:\\Windows;C:\\Node' }, user: { Path: 'C:\\Users\\用户\\AppData\\Roaming\\npm' } }
const snapshotResult = () => ({ status: 0, stdout: JSON.stringify(snapshot), stderr: '' })
const isPowerShell = (command: string) => /powershell\.exe$/iu.test(command)
const isWhere = (command: string) => /where\.exe$/iu.test(command)

test('真实异步执行器在系统进程边界保留 cmd 引号，普通 exe 不启用原样参数', async (t) => {
  const calls: Array<{ file: string; args: string[]; windowsVerbatimArguments: boolean }> = []
  // 拦截最后的原生 spawn，保留 runAsyncCommand → execFile → Node 参数归一化全链路。
  t.mock.method(childProcess.ChildProcess.prototype, 'spawn', function(this: any, options: any) {
    calls.push({ file: options.file, args: options.args, windowsVerbatimArguments: options.windowsVerbatimArguments })
    this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = new PassThrough()
    process.nextTick(() => {
      this.stdout.end(isPowerShell(options.file) ? snapshotResult().stdout : 'probe 1.2.3')
      this.stderr.end(); this.emit('close', 0, null)
    })
    return 0
  })
  const command = 'C:\\Program Files\\Agents\\测试 & 工具.cmd'
  const result = await runAsyncCommand(childProcess.spawnSync, command, ['--version'], { shell: true })
  assert.equal(result.status, 0)
  const invocation = calls.find((call) => /cmd\.exe$/iu.test(call.file))!
  assert.equal(invocation.windowsVerbatimArguments, true)
  assert.deepEqual(invocation.args.slice(1), ['/d', '/s', '/c', `""${command}" --version"`])
  await runAsyncCommand(childProcess.spawnSync, 'C:\\Agents\\probe.exe', ['--version'])
  assert.equal(calls.at(-1)?.windowsVerbatimArguments, false)
  assert.equal(calls.filter((call) => isPowerShell(call.file)).length, 1)
})

test('PATH 补充保留调用方优先级，展开注册表变量，去重且不覆盖其他环境', () => {
  const base = { Path: 'C:\\Custom;C:\\Windows;', TOKEN: 'host-only', SDK_HOME: 'D:\\SDK' }
  const machine = { PATH: 'c:\\WINDOWS\\;C:\\Node', SDK_HOME: 'C:\\OldSDK', TOKEN: 'registry-token' }
  const user = { path: '%SDK_HOME%\\bin;"C:\\Users\\用户\\npm";c:/node' }
  const env = windowsCommandEnvironment(base, { machine, user }, 'C:\\Tools')
  assert.equal(env.PATH, 'C:\\Tools;C:\\Custom;C:\\Windows;C:\\Node;D:\\SDK\\bin;C:\\Users\\用户\\npm')
  assert.deepEqual(Object.keys(env).filter((key) => key.toLowerCase() === 'path'), ['PATH'])
  assert.equal(env.TOKEN, 'host-only'); assert.equal(env.SDK_HOME, 'D:\\SDK')
  assert.equal(base.Path, 'C:\\Custom;C:\\Windows;', '不能修改调用方对象')
  const cycle = windowsCommandEnvironment({ PATH: '%A%', A: '%B%', B: '%A%' })
  assert.match(cycle.PATH!, /%[AB]%/u)
  assert.equal(windowsCommandEnvironment({ PATH: 'C:\\Inherited', Path: 'D:\\Explicit' }).PATH, 'D:\\Explicit')
})

test('注册表快照并发只读一次，重新检测后刷新，where 使用补充后的环境', async () => {
  let reads = 0
  const calls: SpawnSyncOptions[] = []
  const run = ((command: string, _args: string[], options: SpawnSyncOptions) => {
    if (isPowerShell(command)) { reads++; return { status: 0, stdout: JSON.stringify({ machine: {}, user: { PATH: `C:\\New${reads}` } }), stderr: '' } }
    assert.ok(isWhere(command)); calls.push(options)
    return { status: 0, stdout: 'C:\\New1\\probe\r\nC:\\New1\\probe.cmd\r\nD:\\Old\\probe.exe\r\n', stderr: '' }
  }) as never
  const results = await Promise.all([resolveCommandPath('probe', run), resolveCommandPath('probe', run)])
  assert.deepEqual(results, ['C:\\New1\\probe.cmd', 'C:\\New1\\probe.cmd'])
  assert.equal(reads, 1)
  assert.ok(calls.every((options) => options.env?.PATH?.includes('C:\\New1')))
  invalidateCommandEnvironment()
  await prepareWindowsCommandEnvironment(run)
  assert.equal(reads, 2)
  assert.ok(commandEnvironment('probe').PATH?.includes('C:\\New2'))
  assert.equal(commandEnvironment('probe').PATH?.includes('C:\\New1'), false)
})

test('系统环境读取不可用时仍可检测当前 PATH 上的命令', async () => {
  const run = ((command: string) => isPowerShell(command) ? missing : version) as never
  assert.equal((await detectBinary({ binaries: ['probe'], spawnSync: run })).installed, true)
})

test('产品覆盖项保留 Host 自定义 PATH，完整环境不恢复已过滤的变量', async (t) => {
  const key = 'CODINGNS_TEST_FILTERED'
  const previous = process.env[key]
  process.env[key] = 'must-not-return'
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  const calls: SpawnSyncOptions[] = []
  const run = ((command: string, _args: string[], options: SpawnSyncOptions) => {
    if (isPowerShell(command)) return missing
    calls.push(options); return version
  }) as never
  await detectBinary({ binaries: ['probe'], spawnSync: run, environment: { CODINGNS_TEST_SETTING: 'custom' } })
  const env = calls[0]!.env!
  for (const entry of (process.env.PATH ?? process.env.Path ?? '').split(';').filter(Boolean)) assert.ok(env.PATH?.includes(entry))
  assert.equal(env.CODINGNS_TEST_SETTING, 'custom')
  await runAsyncCommand(run, 'probe', ['--version'], { shell: true, env: { Path: 'D:\\Explicit' } })
  assert.equal(calls[1]!.env?.PATH, 'D:\\Explicit')
  assert.equal(calls[1]!.env?.[key], undefined)
})

test('重新检测过程中迟到的旧注册表快照不能覆盖新 PATH', async (t) => {
  const pending: Array<(path: string) => void> = []
  t.mock.method(childProcess.ChildProcess.prototype, 'spawn', function(this: any, options: any) {
    assert.ok(isPowerShell(options.file))
    this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = new PassThrough()
    pending.push((path) => {
      this.stdout.end(JSON.stringify({ machine: {}, user: { Path: path } }))
      this.stderr.end(); this.emit('close', 0, null)
    })
    return 0
  })
  const old = prepareWindowsCommandEnvironment()
  await new Promise((resolve) => setImmediate(resolve))
  invalidateCommandEnvironment()
  const fresh = prepareWindowsCommandEnvironment()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pending.length, 2)
  pending[1]!('C:\\Fresh')
  await fresh
  pending[0]!('C:\\Old')
  await old
  assert.ok(commandEnvironment('probe').PATH?.includes('C:\\Fresh'))
  assert.equal(commandEnvironment('probe').PATH?.includes('C:\\Old'), false)
})

test('Windows 非零缺失退出码仍进入路径兜底，Standard 与 CodeBuddy 均可恢复', async () => {
  for (const status of [1, 9009]) {
    invalidateCommandEnvironment()
    const calls: string[] = []
    const run = ((command: string, args: string[]) => {
      calls.push(command)
      if (isPowerShell(command)) return snapshotResult()
      if (isWhere(command)) return { status: 0, stdout: 'C:\\Agents\\probe.cmd', stderr: '' }
      if (command === 'C:\\Agents\\probe.cmd') return args[0] === '--help' ? { status: 0, stdout: '--acp', stderr: '' } : version
      return { ...missing, status }
    }) as never
    class ProbeDriver extends StandardStreamDriver {
      constructor() { super({ id: 'probe', name: 'Probe' }, { binaries: ['probe'] }, { spawnSync: run }) }
    }
    const standard = new ProbeDriver()
    const codebuddy = new CodeBuddyCliDriver({ binaries: ['probe'], spawnSync: run, environment: { HOME: 'C:\\Fixture' } })
    assert.equal((await standard.detect()).installed, true)
    assert.equal((await codebuddy.detect()).installed, true)
    assert.ok(calls.some(isWhere))
    standard.dispose(); codebuddy.dispose()
  }
})

test('Qoder 别名与 cmd 探测使用新 PATH，后续版本刷新不复用失效入口', async (t) => {
  const previousToken = process.env.QODERCN_PERSONAL_ACCESS_TOKEN
  process.env.QODERCN_PERSONAL_ACCESS_TOKEN = 'must-not-cross-region'
  t.after(() => { if (previousToken === undefined) delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN; else process.env.QODERCN_PERSONAL_ACCESS_TOKEN = previousToken })
  let selected = 'qodercli.cmd'
  const run = ((command: string, _args: string[], options: SpawnSyncOptions) => {
    if (isPowerShell(command)) return snapshotResult()
    if (isWhere(command)) return missing
    if (command !== selected) return { ...missing, status: 9009 }
    assert.equal(options.shell, true)
    assert.ok(options.env?.PATH?.includes('AppData\\Roaming\\npm'))
    assert.equal(options.env?.QODERCN_PERSONAL_ACCESS_TOKEN, undefined)
    assert.equal(options.env?.QODER_PERSONAL_ACCESS_TOKEN, 'fixture-token')
    return version
  }) as never
  const driver = new QoderCliDriver({ spawnSync: run, environment: { Path: 'C:\\Stale', QODER_PERSONAL_ACCESS_TOKEN: 'fixture-token', QODERCN_PERSONAL_ACCESS_TOKEN: 'wrong' } })
  assert.equal((await driver.detect()).command, 'qodercli.cmd')
  selected = 'qodercli'
  assert.equal((await driver.detect()).command, 'qodercli')
  driver.dispose()
})

test('发现结果区分命令不存在、启动失败、超时、版本格式不匹配，并允许别名恢复', async () => {
  for (const [result, failure] of [
    [{ status: null, stdout: '', stderr: '', error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }, undefined],
    [{ ...missing, status: 1, stderr: 'secret-value' }, 'launch'],
    [{ ...missing, status: null, signal: 'SIGKILL' }, 'timeout'],
    [{ status: 0, stdout: 'development build', stderr: '' }, 'version'],
  ] as const) {
    const run = ((command: string) => isPowerShell(command) ? snapshotResult() : result) as never
    const detection = await detectBinary({ binaries: ['C:\\Agents\\probe.exe'], spawnSync: run })
    assert.equal(detection.installed, false)
    assert.equal(detection.detectionFailure, failure)
    assert.equal(JSON.stringify(detection).includes('secret-value'), false)
  }
  const recovered = await detectBinary({ binaries: ['old', 'new'], spawnSync: ((command: string) => {
    if (isPowerShell(command)) return snapshotResult()
    return command === 'new' ? version : { ...missing, status: 2 }
  }) as never })
  assert.equal(recovered.installed, true)
  assert.equal(recovered.detectionFailure, undefined)
  const missingShell = await detectBinary({ binaries: ['not-installed'], spawnSync: ((command: string) => {
    if (isPowerShell(command)) return snapshotResult()
    return { ...missing, error: Object.assign(new Error('not recognized'), { code: 1 }) }
  }) as never })
  assert.deepEqual(missingShell, { installed: false, version: null, command: null })
})

test('JSON-RPC 启动不会被驱动缓存的旧 Path 覆盖补充环境', async () => {
  await prepareWindowsCommandEnvironment(((command: string) => isPowerShell(command) ? snapshotResult() : missing) as never)
  let environment: Record<string, string> | undefined
  const rpc = new JsonRpcProcess({ command: 'C:\\Agents\\probe.cmd', env: { Path: 'C:\\Stale', CUSTOM: 'preserve' }, spawn: ((_command: string, _args: string[], options: any) => {
    environment = options.env
    throw new Error('fixture-stop')
  }) as never })
  await assert.rejects(rpc.request('initialize', {}), /fixture-stop/u)
  assert.ok(environment?.PATH?.includes('AppData\\Roaming\\npm'))
  assert.equal(environment?.CUSTOM, 'preserve')
  assert.deepEqual(Object.keys(environment!).filter((key) => key.toLowerCase() === 'path'), ['PATH'])
  rpc.dispose()
})

test('瞬时探测失败后复用上次可用 CLI，实际启动仍带有修复的 PATH', async (t) => {
  let fail = false
  let environment: Record<string, string> | undefined
  class ProbeDriver extends StandardStreamDriver {
    protected buildArgs(): readonly string[] { return [] }
    constructor() {
      super({ id: 'probe', name: 'Probe' }, { binaries: ['probe'] }, {
        spawnSync: ((command: string) => {
          if (isPowerShell(command)) return snapshotResult()
          if (isWhere(command)) return missing
          return fail ? { status: null, signal: 'SIGKILL', stdout: '', stderr: '' } : version
        }) as never,
        spawn: ((_command: string, _args: string[], options: any) => {
          environment = options.env
          throw new Error('fixture-stop')
        }) as never,
      })
    }
  }
  const driver = new ProbeDriver()
  const registry = new CodingNsCliAdapterRegistry([driver])
  t.after(() => registry.dispose())
  await registry.refreshCatalog()
  fail = true
  const failed = (await registry.refreshCatalog())[0]!
  assert.equal(failed.installed, true)
  assert.equal(failed.detectionState, 'error')
  await assert.rejects(async () => {
    for await (const _chunk of driver.executeTurn({ sessionId: 'fixture', prompt: 'test', messages: [] })) { /* 消费启动结果。 */ }
  }, /fixture-stop/u)
  assert.ok(environment?.PATH?.includes('AppData\\Roaming\\npm'))
})
