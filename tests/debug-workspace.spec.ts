import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DebugWorkspaceService } from '../data/build/dist/host/debug.js'
import { parseDebugConfig } from '../data/build/dist/shared/index.js'

function config() {
  return {
    version: 1,
    profiles: [{
      id: 'frontend', name: '前端', cwdRelative: '.', command: 'pnpm', args: ['dev'], env: {},
      shell: { profileId: 'bash', path: '/bin/bash', args: ['-i'], name: 'bash' },
      runtimeType: 'local-pty', port: 5173, proxy: { enabled: true },
    }],
  }
}

function fakeTerminal() {
  const calls: { profile?: unknown; launch?: unknown; stop: number; deleteProfile: number } = { stop: 0, deleteProfile: 0 }
  const instance = { id: 'instance-1', workspaceId: 'workspace-a', profileId: 'frontend', terminalId: 'terminal-1', runtimeSessionKey: null, state: 'running', pid: 42, resolvedCommand: { command: 'pnpm', args: ['dev'], cwd: '/workspace' }, exitCode: null, startedAt: new Date().toISOString(), stoppedAt: null }
  let active = true
  return {
    calls,
    service: {
      async createProfile(value: unknown) { calls.profile = value; return value },
      async launch(value: unknown) { calls.launch = value; return { instance, terminal: { id: 'terminal-1' } } },
      listInstances() { return active ? [instance] : [] },
      getInstance() { return instance },
      async stop() { calls.stop += 1; active = false; return { ...instance, state: 'exited' } },
      async deleteProfile() { calls.deleteProfile += 1; return true },
    } as never,
  }
}

test('Spec003 配置拒绝越界路径和秘密环境变量', () => {
  assert.throws(() => parseDebugConfig({ ...config(), profiles: [{ ...config().profiles[0], cwdRelative: '../outside' }] }), /相对路径/u)
  assert.throws(() => parseDebugConfig({ ...config(), profiles: [{ ...config().profiles[0], env: { API_TOKEN: 'secret' } }] }), /秘密/u)
})

test('Spec003 读取配置并把启动参数交给已有 PTY 服务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-'))
  try {
    const terminal = fakeTerminal()
    const service = new DebugWorkspaceService({ resolveWorkspaceRoot: () => root, terminalProcesses: terminal.service })
    await service.saveConfig('workspace-a', config())
    const loaded = await service.getConfig('workspace-a')
    assert.equal(loaded.profiles[0]?.port, 5173)
    const result = await service.launch({ workspaceId: 'workspace-a', profileId: 'frontend', cols: 80, rows: 24 })
    assert.equal(result.instance.id, 'instance-1')
    assert.equal((terminal.calls.profile as { command: string }).command, 'pnpm')
    assert.deepEqual(terminal.calls.launch, { workspaceId: 'workspace-a', profileId: 'frontend', cols: 80, rows: 24, commandMode: 'shell-input' })
    assert.match(await readFile(join(root, '.codingns', 'debug.json'), 'utf8'), /"version": 1/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Spec003 可以单独更新和删除启动配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-'))
  try {
    const terminal = fakeTerminal()
    const service = new DebugWorkspaceService({ resolveWorkspaceRoot: () => root, terminalProcesses: terminal.service })
    await service.saveConfig('workspace-a', config())
    const updated = await service.updateProfile('workspace-a', 'frontend', { ...config().profiles[0], name: '后端' })
    assert.equal(updated.profiles[0]?.name, '后端')
    await terminal.service.stop('instance-1')
    const deleted = await service.deleteProfile('workspace-a', 'frontend')
    assert.deepEqual(deleted.profiles, [])
    assert.equal(terminal.calls.deleteProfile, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Spec003 结束端口进程不会调用终端停止逻辑', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-'))
  try {
    const terminal = fakeTerminal()
    const inspector = {
      async inspect() { return { pid: 101, startToken: 'start-a', command: 'node server.js', cwd: '/workspace' } },
      async terminate() {},
    }
    const service = new DebugWorkspaceService({ resolveWorkspaceRoot: () => root, terminalProcesses: terminal.service, portInspector: inspector })
    await service.saveConfig('workspace-a', config())
    const check = await service.checkPort('workspace-a', 'frontend')
    await service.killPortProcess('workspace-a', check.id)
    assert.equal(terminal.calls.stop, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Spec003 端口身份变化时拒绝结束，身份一致时才结束', async () => {
  const observations = [
    { pid: 100, startToken: 'start-a', command: 'node server.js', cwd: '/workspace' },
    { pid: 101, startToken: 'start-b', command: 'node other.js', cwd: '/workspace' },
    { pid: 101, startToken: 'start-b', command: 'node other.js', cwd: '/workspace' },
    { pid: 101, startToken: 'start-b', command: 'node other.js', cwd: '/workspace' },
  ]
  const terminated: number[] = []
  const inspector = {
    async inspect() { return observations.shift() ?? null },
    async terminate(value: { pid: number }) { terminated.push(value.pid) },
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-'))
  try {
    const service = new DebugWorkspaceService({ resolveWorkspaceRoot: () => root, terminalProcesses: fakeTerminal().service, portInspector: inspector })
    await service.saveConfig('workspace-a', config())
    const first = await service.checkPort('workspace-a', 'frontend')
    await assert.rejects(() => service.terminatePort('workspace-a', first.id), /已变化/u)
    const second = await service.checkPort('workspace-a', 'frontend')
    const stopped = await service.terminatePort('workspace-a', second.id)
    assert.equal(stopped.listening, false)
    assert.deepEqual(terminated, [101])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Spec003 代理绑定必须引用正在运行实例和已监听端口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-'))
  try {
    const terminal = fakeTerminal()
    const service = new DebugWorkspaceService({
      resolveWorkspaceRoot: () => root,
      terminalProcesses: terminal.service,
      portInspector: { async inspect() { return { pid: 42, startToken: 'x', command: null, cwd: null } }, async terminate() {} },
    })
    await service.saveConfig('workspace-a', config())
    const binding = await service.enableProxy('workspace-a', 'frontend', 'instance-1')
    assert.equal(binding.workspaceId, 'workspace-a')
    assert.equal(binding.instanceId, 'instance-1')
    assert.match(binding.url, /^\/api\/codingns\/debug-proxy\?slug=/u)
    assert.equal(service.getProxy(binding.id)?.port, 5173)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Spec003 端口被其他进程复用时拒绝创建代理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-'))
  try {
    const terminal = fakeTerminal()
    const service = new DebugWorkspaceService({
      resolveWorkspaceRoot: () => root,
      terminalProcesses: terminal.service,
      portInspector: { async inspect() { return { pid: 99, startToken: 'other', command: null, cwd: null } }, async terminate() {} },
    })
    await service.saveConfig('workspace-a', config())
    await assert.rejects(() => service.enableProxy('workspace-a', 'frontend', 'instance-1'), /当前运行实例/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Spec003 内部代理只转发已绑定回环服务并过滤升级头', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-'))
  const originalFetch = globalThis.fetch
  try {
    const terminal = fakeTerminal()
    const service = new DebugWorkspaceService({
      resolveWorkspaceRoot: () => root,
      terminalProcesses: terminal.service,
      portInspector: { async inspect() { return { pid: 42, startToken: 'x', command: null, cwd: null } }, async terminate() {} },
    })
    await service.saveConfig('workspace-a', config())
    const binding = await service.enableProxy('workspace-a', 'frontend', 'instance-1')
    let target = ''
    globalThis.fetch = (async (input, init) => {
      target = String(input)
      assert.equal(init?.method, 'GET')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('connection'), null)
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/event-stream', connection: 'close', location: '/login' } })
    }) as typeof fetch
    const response = await service.handleProxyRequest(new Request(`http://dsh${binding.url}&path=${encodeURIComponent('/events?x=1')}`, { headers: { connection: 'keep-alive' } }))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ok')
    assert.equal(target, 'http://127.0.0.1:5173/events?x=1')
    assert.equal(response.headers.get('connection'), null)
    assert.match(response.headers.get('location') ?? '', /path=%2Flogin/u)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('Spec003 代理请求发现同 PID 身份变化时立即失效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-debug-'))
  try {
    const terminal = fakeTerminal()
    let current = { pid: 42, startToken: 'before', command: null, cwd: null }
    const service = new DebugWorkspaceService({
      resolveWorkspaceRoot: () => root,
      terminalProcesses: terminal.service,
      portInspector: { async inspect() { return current }, async terminate() {} },
    })
    await service.saveConfig('workspace-a', config())
    const binding = await service.enableProxy('workspace-a', 'frontend', 'instance-1')
    current = { ...current, startToken: 'after' }
    const response = await service.handleProxyRequest(new Request(`http://dsh${binding.url}`))
    assert.equal(response.status, 404)
    assert.equal(service.getProxy(binding.id), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
