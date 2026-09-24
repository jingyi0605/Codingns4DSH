import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CodingNsTerminalStore,
  InMemoryTerminalStorePersistence,
} from '../data/build/dist/host/terminal/terminal-store.js'

function record(overrides = {}) {
  return {
    hostId: 'host-a',
    workspaceId: 'workspace-a',
    dshSessionId: 'session-a',
    terminalId: 'terminal-a',
    runtimeSessionKey: 'runtime-a',
    runtimeType: 'tmux',
    shellPath: '/bin/zsh',
    cwd: '/workspace/a',
    title: 'zsh',
    cols: 80,
    rows: 24,
    state: 'running',
    exitCode: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  }
}

test('终端存储按 Host、工作区和 terminal 隔离，不按 DSH session 分裂记录', async () => {
  const persistence = new InMemoryTerminalStorePersistence()
  const store = new CodingNsTerminalStore(persistence)
  await store.load()
  await store.put(record())
  await store.put(record({ dshSessionId: 'session-b', updatedAt: '2026-09-22T00:00:02.000Z' }))
  await store.put(record({ hostId: 'host-b', runtimeSessionKey: 'runtime-b' }))
  await store.put(record({ workspaceId: 'workspace-b', runtimeSessionKey: 'runtime-c' }))

  assert.equal(store.list({ hostId: 'host-a', workspaceId: 'workspace-a', dshSessionId: 'session-a' }).length, 1)
  assert.equal(store.get({ hostId: 'host-a', workspaceId: 'workspace-a', dshSessionId: 'session-a', terminalId: 'terminal-a' })?.dshSessionId, 'session-b')
  assert.equal(store.list({ hostId: 'host-a', workspaceId: 'workspace-a', dshSessionId: 'session-b' }).length, 1)
  assert.equal(store.list({ hostId: 'host-b', workspaceId: 'workspace-a', dshSessionId: 'session-a' })[0].runtimeSessionKey, 'runtime-b')
})

test('终端持久记录不接受 generation、订阅或控制凭据作为契约字段', async () => {
  const persistence = new InMemoryTerminalStorePersistence({
    version: 1,
    records: [{
      ...record(),
      generation: 'stale-generation',
      subscriptionId: 'stale-subscription',
      hostToken: 'secret',
    }],
  })
  const store = new CodingNsTerminalStore(persistence)
  await store.load()
  await store.patch(record(), { updatedAt: '2026-09-22T00:00:01.000Z' })

  const serialized = JSON.stringify(persistence.snapshot())
  assert.doesNotMatch(serialized, /generation|subscriptionId|runtimeAttachmentId|hostToken/u)
})

test('工作区主键迁移时同名旧 session 记录保留最新一条', async () => {
  const persistence = new InMemoryTerminalStorePersistence({
    version: 1,
    records: [
      record({ dshSessionId: 'session-a', runtimeSessionKey: 'runtime-old', updatedAt: '2026-09-22T00:00:00.000Z' }),
      record({ dshSessionId: 'session-b', runtimeSessionKey: 'runtime-new', updatedAt: '2026-09-22T00:00:01.000Z' }),
    ],
  })
  const store = new CodingNsTerminalStore(persistence)
  await store.load()
  assert.equal(store.list({ hostId: 'host-a', workspaceId: 'workspace-a' }).length, 1)
  assert.equal(store.list()[0].runtimeSessionKey, 'runtime-new')
})

test('基线模式允许在内存记录中使用 local-pty runtime', async () => {
  const store = new CodingNsTerminalStore(new InMemoryTerminalStorePersistence())
  await store.load()
  await store.put(record({ runtimeType: 'local-pty' }))
  assert.equal(store.get(record())?.runtimeType, 'local-pty')
})

test('关闭中状态与最终关闭状态按顺序持久化并可在重建后读取', async () => {
  const persistence = new InMemoryTerminalStorePersistence()
  const first = new CodingNsTerminalStore(persistence)
  await first.load()
  await first.put(record())
  await first.patch(record(), { state: 'closing', updatedAt: '2026-09-22T00:00:01.000Z' })
  await first.patch(record(), { state: 'closed', updatedAt: '2026-09-22T00:00:02.000Z' })

  const restored = new CodingNsTerminalStore(persistence)
  await restored.load()
  assert.equal(restored.get(record()).state, 'closed')
})
