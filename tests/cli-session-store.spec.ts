import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'

test('Host 会话索引串行持久化并支持归档筛选', async () => {
  const writes = []
  const store = new CodingNsCliSessionStore({ persistence: { async write(records) { writes.push(records) } } })
  store.upsert('dsh-1', { adapterId: 'codex', providerSessionId: 'thread-1', title: '修复登录', status: 'active' })
  store.upsert('dsh-2', { adapterId: 'kimi', title: '整理文档' })
  store.archive('dsh-2')
  await store.flush()

  assert.equal(writes.length, 3)
  assert.deepEqual(store.list().map((record) => record.dshSessionId), ['dsh-1'])
  assert.deepEqual(store.list({ includeArchived: true }).map((record) => record.dshSessionId), ['dsh-2', 'dsh-1'])
  assert.equal(store.get('dsh-1')?.providerSessionId, 'thread-1')
  store.upsert('dsh-1', {
    adapterId: 'codex',
    providerState: 'missing',
    providerCheckedAt: '2026-09-22T00:00:00.000Z',
    providerStateReason: '原始文件不存在',
  })
  assert.equal(store.get('dsh-1')?.providerState, 'missing')
  const activityTime = store.get('dsh-1')?.updatedAt
  store.updateProviderState('dsh-1', {
    state: 'available',
    checkedAt: '2026-09-22T00:01:00.000Z',
  })
  assert.equal(store.get('dsh-1')?.updatedAt, activityTime)
  assert.equal(store.get('dsh-1')?.providerStateReason, undefined)
  store.upsert('dsh-1', { adapterId: 'gemini' })
  assert.equal(store.get('dsh-1')?.providerSessionId, undefined)
  assert.equal(store.get('dsh-1')?.providerState, undefined)
})

test('SessionStore 恢复时清理遗留 active，并在 Provider 重绑时丢弃旧探测状态', () => {
  const persisted = [{
    dshSessionId: 'dsh-restarted',
    adapterId: 'codex',
    providerSessionId: 'thread-old',
    rawStoreRef: '/old/rollout.jsonl',
    status: 'active',
    providerState: 'missing',
    providerCheckedAt: '2026-09-22T00:00:00.000Z',
    providerStateReason: '旧记录不存在',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  }] as const
  const store = new CodingNsCliSessionStore({
    settings: {
      get() { return { cliSessions: persisted } },
      async update() {},
    } as never,
  })

  assert.equal(store.get('dsh-restarted')?.status, 'idle')
  store.sync([{ ...persisted[0], status: 'active' }])
  assert.equal(store.get('dsh-restarted')?.status, 'active')
  store.upsert('dsh-restarted', { adapterId: 'codex', providerSessionId: 'thread-new' })
  const rebound = store.get('dsh-restarted')
  assert.equal(rebound?.providerSessionId, 'thread-new')
  assert.equal(rebound?.rawStoreRef, undefined)
  assert.equal(rebound?.providerState, undefined)
  assert.equal(rebound?.providerCheckedAt, undefined)
  assert.equal(rebound?.providerStateReason, undefined)
})

test('Registry 同适配器重绑 Provider 身份时不继承旧原始路径', () => {
  const store = new CodingNsCliSessionStore()
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
  }], {}, { sessionStore: store })
  registry.setSession('dsh-rebind', {
    adapterId: 'fake',
    providerSessionId: 'provider-old',
    rawStoreRef: '/old/session.jsonl',
  })
  store.updateProviderState('dsh-rebind', {
    state: 'missing',
    checkedAt: '2026-09-22T00:00:00.000Z',
    reason: '旧会话不存在',
  })

  assert.deepEqual(registry.setSession('dsh-rebind', {
    adapterId: 'fake',
    providerSessionId: 'provider-new',
  }), {
    adapterId: 'fake',
    providerSessionId: 'provider-new',
  })
  assert.equal(store.get('dsh-rebind')?.rawStoreRef, undefined)
  assert.equal(store.get('dsh-rebind')?.providerState, undefined)
})

test('Registry 在 session-binding 和完成时更新持久化会话摘要', async () => {
  const store = new CodingNsCliSessionStore()
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'session-binding', providerSessionId: 'provider-1' }
      yield { type: 'text-delta', text: '完成' }
      yield { type: 'finish', reason: 'stop' }
    },
  }], {}, { sessionStore: store })

  registry.setSession('dsh-1', { adapterId: 'fake', modelId: 'm1' })
  const chunks = []
  for await (const chunk of registry.execute({ sessionId: 'dsh-1', adapterId: 'fake', messages: [], prompt: '修复登录', cwd: '/workspace' })) chunks.push(chunk)
  await store.flush()

  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.deepEqual(registry.getSession('dsh-1'), { adapterId: 'fake', modelId: 'm1', providerSessionId: 'provider-1' })
  assert.deepEqual(store.get('dsh-1'), {
    dshSessionId: 'dsh-1', adapterId: 'fake', modelId: 'm1', providerSessionId: 'provider-1',
    title: '修复登录', cwd: '/workspace', status: 'idle',
    providerState: 'available', providerCheckedAt: store.get('dsh-1')?.providerCheckedAt,
    createdAt: store.get('dsh-1')?.createdAt, updatedAt: store.get('dsh-1')?.updatedAt,
  })
})

test('Registry 同一轮重复绑定时保留首次确认的原始路径', async () => {
  const store = new CodingNsCliSessionStore()
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'session-binding', providerSessionId: 'provider-1', rawStoreRef: '/new/session.jsonl' }
      yield { type: 'session-binding', providerSessionId: 'provider-1' }
      yield { type: 'finish', reason: 'stop' }
    },
  }], {}, { sessionStore: store })
  registry.setSession('dsh-repeat-binding', { adapterId: 'fake' })

  for await (const _chunk of registry.execute({
    sessionId: 'dsh-repeat-binding',
    adapterId: 'fake',
    messages: [],
    prompt: '继续',
  })) { /* 消费标准流 */ }

  assert.equal(store.get('dsh-repeat-binding')?.rawStoreRef, '/new/session.jsonl')
})

test('Registry 连续确认 Provider 会话缺失并在恢复前阻止错误关联', async () => {
  const store = new CodingNsCliSessionStore()
  let probes = 0
  let executions = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async probeSession() {
      probes += 1
      return { state: 'missing', reason: '原始会话不存在' }
    },
    async *executeTurn() {
      executions += 1
      yield { type: 'finish', reason: 'stop' }
    },
  }], {}, { sessionStore: store, providerProbeTtlMs: 0, missingConfirmationDelayMs: 0 })
  registry.setSession('dsh-missing', { adapterId: 'fake', providerSessionId: 'provider-missing' })

  const records = await registry.listSessions()
  assert.equal(probes, 2)
  assert.equal(records[0]?.providerState, 'missing')
  assert.equal(records[0]?.providerStateReason, '原始会话不存在')
  assert.equal(records[0]?.rawStoreRef, undefined)

  await assert.rejects(async () => {
    for await (const _chunk of registry.execute({
      sessionId: 'dsh-missing',
      adapterId: 'fake',
      messages: [],
      prompt: '继续',
    })) { /* 不会进入驱动 */ }
  }, /原始会话已删除/u)
  assert.equal(executions, 0)
})

test('Registry 先归档 DSH 原生会话再保留插件绑定 tombstone', async () => {
  const store = new CodingNsCliSessionStore()
  store.upsert('dsh-archived', { adapterId: 'fake', providerSessionId: 'provider-1' })
  const calls: string[] = []
  const registry = new CodingNsCliAdapterRegistry([], {}, {
    sessionStore: store,
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return undefined },
      list() { return [] },
      async listRemote() { return [] },
      async ensure() { return null },
      async flush() {},
      async archive(sessionId) { calls.push(`native:${sessionId}`); return true },
      subscribe() { return () => {} },
    },
  })
  const archived = await registry.archiveSession('dsh-archived')
  calls.push(`store:${archived?.status ?? ''}`)
  assert.deepEqual(calls, ['native:dsh-archived', 'store:archived'])
  assert.equal(store.get('dsh-archived')?.providerSessionId, 'provider-1')
  assert.equal(store.list().length, 0)
  assert.equal(store.list({ includeArchived: true }).length, 1)
})

test('Registry 在 DSH 原生归档失败时不修改插件索引', async () => {
  const store = new CodingNsCliSessionStore()
  store.upsert('dsh-not-archived', { adapterId: 'fake', providerSessionId: 'provider-1' })
  const registry = new CodingNsCliAdapterRegistry([], {}, {
    sessionStore: store,
    nativeSessions: {
      available: false,
      store: undefined,
      controller: undefined,
      get() { return undefined },
      list() { return [] },
      async listRemote() { return [] },
      async ensure() { return null },
      async flush() {},
      async archive() { return false },
      subscribe() { return () => {} },
    },
  })

  await assert.rejects(registry.archiveSession('dsh-not-archived'), /原生会话归档服务不可用/u)
  assert.equal(store.get('dsh-not-archived')?.status, 'idle')
  assert.equal(store.list().length, 1)
})

test('Registry 用会话级状态阻止执行与归档并发穿透', async () => {
  const store = new CodingNsCliSessionStore()
  let releaseExecution: (() => void) | undefined
  let executionStarted: (() => void) | undefined
  const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve })
  const executionReady = new Promise<void>((resolve) => { executionStarted = resolve })
  let releaseArchive: (() => void) | undefined
  let archiveStarted: (() => void) | undefined
  const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve })
  const archiveReady = new Promise<void>((resolve) => { archiveStarted = resolve })
  let nativeArchiveCalls = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      executionStarted?.()
      await executionGate
      yield { type: 'finish', reason: 'stop' } as const
    },
  }], {}, {
    sessionStore: store,
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return undefined },
      list() { return [] },
      async listRemote() { return [] },
      async ensure() { return null },
      async flush() {},
      async archive() {
        nativeArchiveCalls += 1
        archiveStarted?.()
        await archiveGate
        return true
      },
      subscribe() { return () => {} },
    },
  })

  registry.setSession('executing', { adapterId: 'fake' })
  const iterator = registry.execute({ sessionId: 'executing', adapterId: 'fake', messages: [], prompt: '执行' })[Symbol.asyncIterator]()
  const firstChunk = iterator.next()
  await executionReady
  await assert.rejects(registry.archiveSession('executing'), /正在执行/u)
  assert.equal(nativeArchiveCalls, 0)
  releaseExecution?.()
  await firstChunk
  await iterator.return?.()

  registry.setSession('archiving', { adapterId: 'fake' })
  const archivePromise = registry.archiveSession('archiving')
  await archiveReady
  await assert.rejects(async () => {
    for await (const _chunk of registry.execute({ sessionId: 'archiving', adapterId: 'fake', messages: [], prompt: '执行' })) {
      // 归档锁会在进入驱动前拒绝。
    }
  }, /正在归档/u)
  releaseArchive?.()
  assert.equal((await archivePromise)?.status, 'archived')
})

test('归档 tombstone 不会被延迟完成事件改回 idle', () => {
  const store = new CodingNsCliSessionStore()
  store.upsert('archived-tombstone', { adapterId: 'fake' })
  store.archive('archived-tombstone')
  store.upsert('archived-tombstone', { adapterId: 'fake', status: 'idle' })
  assert.equal(store.get('archived-tombstone')?.status, 'archived')
})

test('Registry 对 Provider 探测设置超时并限制列表探测并发', async () => {
  const store = new CodingNsCliSessionStore()
  let active = 0
  let maxActive = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async probeSession(input) {
      if (input.providerSessionId === 'hang') return new Promise(() => {})
      if (input.providerSessionId === 'throws') throw new Error('probe failed')
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return { state: 'available', reason: 'ok' }
    },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
  }], {}, {
    sessionStore: store,
    providerProbeTtlMs: 0,
    providerProbeTimeoutMs: 25,
    providerProbeConcurrency: 2,
  })
  for (let index = 0; index < 5; index += 1) {
    registry.setSession(`dsh-${index}`, { adapterId: 'fake', providerSessionId: `provider-${index}` })
  }
  registry.setSession('dsh-hang', { adapterId: 'fake', providerSessionId: 'hang' })
  registry.setSession('dsh-throws', { adapterId: 'fake', providerSessionId: 'throws' })

  const records = await registry.listSessions()
  assert.equal(maxActive, 2)
  assert.equal(records.find((record) => record.dshSessionId === 'dsh-hang')?.providerState, 'unreachable')
  assert.match(records.find((record) => record.dshSessionId === 'dsh-hang')?.providerStateReason ?? '', /超过 25ms/u)
  assert.equal(records.find((record) => record.dshSessionId === 'dsh-throws')?.providerState, 'unknown')
})

test('Registry 重绑期间的新 Provider 探测不会被旧身份的在途探测阻塞', async () => {
  const store = new CodingNsCliSessionStore()
  let releaseOld: (() => void) | undefined
  let oldStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => { oldStarted = resolve })
  const oldProbe = new Promise<void>((resolve) => { releaseOld = resolve })
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async probeSession(input) {
      if (input.providerSessionId === 'provider-old') {
        oldStarted?.()
        await oldProbe
      }
      return { state: 'available', reason: String(input.providerSessionId) } as const
    },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } as const },
  }], {}, { sessionStore: store, providerProbeTtlMs: 0, providerProbeTimeoutMs: 1_000 })
  registry.setSession('dsh-rebind-probe', { adapterId: 'fake', providerSessionId: 'provider-old' })

  const firstList = registry.listSessions()
  await started
  registry.setSession('dsh-rebind-probe', { adapterId: 'fake', providerSessionId: 'provider-new' })
  const secondList = await registry.listSessions()
  assert.equal(secondList[0]?.providerState, 'available')
  assert.equal(secondList[0]?.providerStateReason, 'provider-new')

  releaseOld?.()
  await firstList
  assert.equal(store.get('dsh-rebind-probe')?.providerStateReason, 'provider-new')
})
