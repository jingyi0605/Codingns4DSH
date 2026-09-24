import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalRuntimeManager } from '../dist/host/terminal/runtime-manager.js'
import { CodingNsTerminalService } from '../dist/host/terminal/terminal-service.js'
import {
  InMemoryTerminalStorePersistence,
  CodingNsTerminalStore,
} from '../dist/host/terminal/terminal-store.js'
import {
  InMemoryTerminalProcessStorePersistence,
  TerminalProcessStore,
} from '../dist/host/terminal/terminal-process-store.js'
import { TerminalProcessService } from '../dist/host/terminal/terminal-process-service.js'
import { createTerminalProcessFeature } from '../dist/host/features/terminal-process.js'
import { CodingNsRpcTable } from '../dist/host/rpc-table.js'
import { FeatureResourceScopeImpl } from '../dist/features/registry.js'

class FakeRuntimeAdapter {
  runtimeTypes = ['local-pty']
  sessions = new Map()
  attachments = new Map()
  writes = []
  attachCount = 0
  nextPid = 1000

  async create({ session }) {
    const current = this.sessions.get(session.runtimeSessionKey)
    if (current) return this.identity(session, current.pid)
    const process = { pid: ++this.nextPid, session }
    this.sessions.set(session.runtimeSessionKey, process)
    return this.identity(session, process.pid)
  }

  async inspect(session) {
    const process = this.sessions.get(session.runtimeSessionKey)
    return this.identity(session, process?.pid ?? null, process !== undefined)
  }

  async attach(input) {
    this.attachCount += 1
    const id = `attachment-${this.attachments.size + 1}`
    this.attachments.set(id, input)
    return { attachmentId: id, identity: this.identity(input.session, this.sessions.get(input.session.runtimeSessionKey)?.pid ?? null) }
  }

  async write({ attachmentId, data }) {
    if (!this.attachments.has(attachmentId)) throw new Error('attach missing')
    this.writes.push(data)
  }
  async resize() {}
  async detach(id) { this.attachments.delete(id) }
  async terminate(session) { this.sessions.delete(session.runtimeSessionKey) }

  identity(session, pid, alive = pid !== null) {
    return { alive, runtimeSessionKey: session.runtimeSessionKey, runtimePid: pid, shellPid: pid }
  }
}

async function setup() {
  const adapter = new FakeRuntimeAdapter()
  const terminalService = new CodingNsTerminalService(
    new CodingNsTerminalStore(new InMemoryTerminalStorePersistence()),
    new TerminalRuntimeManager([adapter]),
    () => new Date('2026-09-23T00:00:00.000Z'),
  )
  await terminalService.initialize()
  const processService = new TerminalProcessService(
    new TerminalProcessStore(new InMemoryTerminalProcessStorePersistence()),
    {
      hostId: 'host-a',
      terminalService,
      resolveWorkspaceRoot: (workspaceId) => workspaceId === 'workspace-a' ? '/workspace/a' : null,
      now: () => new Date('2026-09-23T00:00:00.000Z'),
    },
  )
  await processService.initialize()
  return { adapter, terminalService, processService }
}

function profile() {
  return {
    id: 'dev', workspaceId: 'workspace-a', name: '开发服务', cwdRelative: 'web',
    command: '/usr/bin/node', args: ['server.js'], env: { NODE_ENV: 'development' },
    shell: { profileId: 'bash', path: '/bin/bash', args: ['-i'], name: 'bash' },
    runtimeType: 'local-pty', runtimeMode: 'pty',
  }
}

test('Host 先创建 pty 命令进程，再返回可附着终端和 ProcessInstance', async () => {
  const { adapter, processService } = await setup()
  await processService.createProfile(profile())
  const result = await processService.launch({ workspaceId: 'workspace-a', profileId: 'dev', dshSessionId: 'session-a', cols: 80, rows: 24 })

  assert.equal(result.instance.state, 'running')
  assert.equal(result.instance.resolvedCommand.cwd, '/workspace/a/web')
  assert.equal(result.instance.pid, 1001)
  assert.equal(result.terminal.id, result.instance.terminalId)
  const runtimeSession = [...adapter.sessions.values()][0].session
  assert.equal(runtimeSession.commandPath, '/usr/bin/node')
  assert.deepEqual(runtimeSession.commandArgs, ['server.js'])
  assert.deepEqual(runtimeSession.commandEnv, { NODE_ENV: 'development' })
})

test('调试快捷启动先创建交互 Shell，再写入命令并保留 Shell', async () => {
  const { adapter, processService } = await setup()
  await processService.createProfile(profile())
  const result = await processService.launch({ workspaceId: 'workspace-a', profileId: 'dev', cols: 80, rows: 24, commandMode: 'shell-input' })

  assert.equal(result.instance.state, 'running')
  assert.equal(result.instance.pid, null)
  assert.equal(result.terminal.title, 'bash-开发服务')
  const runtimeSession = [...adapter.sessions.values()][0].session
  assert.equal(runtimeSession.commandPath, undefined)
  assert.equal(runtimeSession.commandArgs, undefined)
  assert.deepEqual(runtimeSession.commandEnv, { NODE_ENV: 'development' })
  assert.deepEqual(adapter.writes, ["'/usr/bin/node' 'server.js'\n"])
  assert.equal(adapter.attachCount, 1)
  assert.equal(adapter.attachments.size, 1)
})

test('停止 ProcessInstance 才会结束它对应的终端运行时', async () => {
  const { adapter, processService } = await setup()
  await processService.createProfile(profile())
  const launched = await processService.launch({ workspaceId: 'workspace-a', profileId: 'dev', cols: 80, rows: 24 })
  const stopped = await processService.stop(launched.instance.id)

  assert.equal(stopped.state, 'exited')
  assert.equal(adapter.sessions.size, 0)
})

test('PTY 自然退出会同步收敛 ProcessInstance 终态', async () => {
  const { adapter, processService } = await setup()
  await processService.createProfile(profile())
  const launched = await processService.launch({ workspaceId: 'workspace-a', profileId: 'dev', cols: 80, rows: 24 })
  const monitor = [...adapter.attachments.values()][0]
  monitor.onExit(3)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(processService.getInstance(launched.instance.id)?.state, 'exited')
  assert.equal(processService.getInstance(launched.instance.id)?.exitCode, 3)
})

test('启动项工作目录不能越出 Workspace', async () => {
  const { processService } = await setup()
  await assert.rejects(
    processService.createProfile({ ...profile(), cwdRelative: '../outside' }),
    /Workspace 内相对路径/u,
  )
})

test('terminalProcess RPC 只转发启动意图并返回 Host 生成的实例', async () => {
  const { processService } = await setup()
  const rpc = new CodingNsRpcTable()
  const resources = new FeatureResourceScopeImpl()
  createTerminalProcessFeature().start({
    descriptor: createTerminalProcessFeature().descriptor,
    resources,
    services: { terminalProcesses: processService, rpc },
  })
  const target = rpc.resolve('terminalProcess/profile/create')
  assert.ok(target)
  await target.handler('profile/create', {
    id: 'dev', workspaceId: 'workspace-a', name: '开发服务', cwdRelative: 'web', command: '/usr/bin/node',
    args: ['server.js'], env: {}, runtimeType: 'local-pty', runtimeMode: 'pty',
    shell: { profileId: 'bash', path: '/bin/bash', args: ['-i'], name: 'bash' },
  })
  const launch = rpc.resolve('terminalProcess/launch')
  assert.ok(launch)
  const result = await launch.handler('launch', { workspaceId: 'workspace-a', profileId: 'dev', cols: 80, rows: 24 })
  assert.equal(result.instance.state, 'running')
  await resources.dispose()
})
