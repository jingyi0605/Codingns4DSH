import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AssistantBackground } from '../src/host/features/assistant-background.js'
import { AssistantIndexUpdates, isAssistantIndexEvent } from '../src/host/features/assistant-index-updates.js'
import { FeatureRegistry } from '../src/features/index.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createGlobalVoiceRpcFeature } from '../src/host/features/global-voice-rpc.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import { memoryAssistantConversationStorage } from './assistant-fixtures.js'

test('后台共享已完成快照，并发显式刷新只执行一次读取', async () => {
  let scans = 0
  const background = new AssistantBackground({ read: async () => ++scans, publish() {}, cadence: () => ({ remote: false, active: false }) })
  const first = await Promise.all(Array.from({ length: 12 }, () => background.read()))
  assert.equal(scans, 1)
  assert.ok(first.every((value) => value === first[0]))
  await background.read(); await background.read()
  assert.equal(scans, 1)
  await Promise.all([background.read(true), background.read(true)])
  assert.equal(scans, 2)
  assert.equal(background.snapshot()?.revision, 2)
  background.dispose()
})

test('范围切换真实中止信号，旧服务迟到结果丢弃且新范围读取串行', async () => {
  let release!: () => void
  let oldSignal!: AbortSignal
  let scans = 0
  const published: number[] = []
  const background = new AssistantBackground({
    read: async (signal) => {
      const value = ++scans
      if (value === 1) { oldSignal = signal; await new Promise<void>((resolve) => { release = resolve }) }
      return value
    }, publish: (value) => { published.push(value) }, cadence: () => ({ remote: false, active: false }),
  })
  const old = background.read()
  const rejected = assert.rejects(old, /范围已变化/u)
  await setImmediate()
  background.invalidate()
  const next = background.read()
  assert.equal(oldSignal.aborted, true)
  assert.equal(scans, 1, '底层服务未结束前不启动第二次全量扫描')
  release(); await rejected
  assert.equal((await next).value, 2)
  assert.deepEqual(published, [2])
  background.dispose()
})

test('远端活跃五秒、空闲三十秒、本地六十秒，失败退避封顶两分钟', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let scans = 0
  let cadence = { remote: true, active: true, failed: false }
  const background = new AssistantBackground({ read: async () => ++scans, publish() {}, cadence: () => cadence })
  background.setEnabled(true)
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await setImmediate() }
  await advance(0); assert.equal(scans, 1)
  await advance(4_999); assert.equal(scans, 1)
  cadence = { remote: true, active: false, failed: false }
  await advance(1); assert.equal(scans, 2)
  await advance(29_999); assert.equal(scans, 2)
  cadence.failed = true
  await advance(1); assert.equal(scans, 3)
  for (const delay of [10_000, 20_000, 40_000, 80_000, 120_000, 120_000]) {
    const previous = scans
    await advance(delay - 1); assert.equal(scans, previous)
    await advance(1); assert.equal(scans, previous + 1)
  }
  cadence = { remote: false, active: false, failed: false }
  await advance(120_000)
  const previous = scans
  await advance(59_999); assert.equal(scans, previous)
  await advance(1); assert.equal(scans, previous + 1)
  background.setEnabled(false)
  await advance(180_000); assert.equal(scans, previous + 1)
  background.setEnabled(true)
  await advance(0); assert.equal(scans, previous + 2)
  background.dispose()
  await advance(180_000); assert.equal(scans, previous + 2)
})

test('读取期间到达的本地事件不会被完成后的低频定时器覆盖', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: () => void
  let scans = 0
  const background = new AssistantBackground({ read: async () => {
    const value = ++scans
    if (value === 1) await new Promise<void>((resolve) => { release = resolve })
    return value
  }, publish() {}, cadence: () => ({ remote: false, active: false }) })
  background.setEnabled(true)
  t.mock.timers.tick(0); await setImmediate()
  background.request(5_000)
  release(); await setImmediate()
  t.mock.timers.tick(4_999); await setImmediate(); assert.equal(scans, 1)
  t.mock.timers.tick(1); await setImmediate(); assert.equal(scans, 2)
  background.dispose()
})

test('原生高频片段与运行时上下文提前排除，暂停不吞掉待索引版本', async (t) => {
  for (const event of [null, { type: 'assistant/live-chunk' }, { type: 'step/end' }, { type: 'user/message', data: { source: { kind: 'runtime-context' } } }]) assert.equal(isAssistantIndexEvent(event), false)
  assert.equal(isAssistantIndexEvent({ type: 'turn/end' }), true)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0
  const updates = new AssistantIndexUpdates(async () => { runs++ }, () => 'idle')
  updates.setEnabled(false); updates.schedule(); t.mock.timers.tick(10_000); await setImmediate()
  assert.equal(runs, 0)
  updates.setEnabled(true); t.mock.timers.tick(5_000); await setImmediate()
  assert.equal(runs, 1)
  updates.dispose()
})

test('持续事件只能提前刷新，不能无限推迟元数据兜底', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let scans = 0
  const background = new AssistantBackground({ read: async () => ++scans, publish() {}, cadence: () => ({ remote: false, active: false }) })
  t.after(() => background.dispose())
  background.setEnabled(true)
  t.mock.timers.tick(0); await setImmediate()
  assert.equal(scans, 1)
  for (let second = 1; second <= 61; second++) {
    t.mock.timers.tick(1_000); await setImmediate()
    background.request(5_000)
  }
  assert.ok(scans >= 12, `持续事件不应饿死刷新，实际仅 ${scans} 次`)
})

async function hostFixture(t: TestContext, options: { enabled?: boolean; initialized?: boolean; managed?: string[]; remote?: boolean; remoteSession?: boolean; holdList?: boolean; holdModel?: boolean } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let enabled = options.enabled ?? true
  let initialized = options.initialized ?? true
  let managed = options.managed ?? ['w1']
  let watch!: () => void
  let scans = 0
  let workspaceScans = 0
  let titles = 0
  let remoteScans = 0
  let models = 0
  let remoteFailed = false
  let releaseList!: () => void
  let releaseModel!: () => void
  let listGate = options.holdList ? new Promise<void>((resolve) => { releaseList = resolve }) : undefined
  let modelGate = options.holdModel ? new Promise<void>((resolve) => { releaseModel = resolve }) : undefined
  const listSignals: AbortSignal[] = []
  const modelSignals: AbortSignal[] = []
  const events = new Map<string, (...args: any[]) => void>()
  const rpc = new CodingNsRpcTable()
  const services = {
    rpc, dshVersion: '0.2.1-alpha.1',
    settings: { get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, modules: { globalVoiceAssistant: enabled }, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant,
      profile: { name: '测试助理', initialized, createdAt: initialized ? 1 : null }, managedWorkspaceIds: managed } }), watch: (listener: () => void) => { watch = listener; return () => {} } },
    events: { on: (name: string, handler: (...args: any[]) => void) => { events.set(name, handler); return () => { events.delete(name) } } },
    ...(options.remote ? { assistantGateway: { async list(_managed: readonly string[], signal: AbortSignal) {
      remoteScans++; listSignals.push(signal)
      await listGate
      signal.throwIfAborted()
      if (remoteFailed) throw new Error('测试远端断线')
      return { sessions: options.remoteSession ? [{ sessionId: 'remote-session', hostId: 'peer', workspaceId: 'w1', workspaceName: '远端项目', title: '远端任务', activity: 'idle', running: false, completed: true, waiting: null, updatedAt: 1, summary: null }] : [], archivedSessionIds: [], volatile: true }
    }, workspaces: async () => [{ workspaceId: 'remote', name: '远端项目', path: null }] } } : {}),
    dshContext: { get(name: string) {
      if (name === 'workspaceRegistry') return { archivedSessionIds: [], list() { workspaceScans++; return [
        { id: 'w1', displayName: '项目一', sessionIds: ['s1'] }, { id: 'w2', displayName: '项目二', sessionIds: ['s2'] },
      ] } }
      if (name === 'agents') return { get: () => ({ status: 'idle' }) }
      if (name === 'sessionController') return { async list(_args: unknown, signal: AbortSignal) {
        scans++; listSignals.push(signal)
        if (!options.remote) await listGate
        signal.throwIfAborted()
        return { items: ['s1', 's2'].map((id) => ({ sessionId: id, running: false, blank: false, title: `任务-${id}`, updatedAt: 1 })) }
      } }
      if (name === 'sessionQuery') return { readTitle: async (id: string) => { titles++; return `任务-${id}` }, readSurface: async (id: string) => `正文-${id}` }
      if (name === 'llm') return { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'model', name: '模型' }], async *stream(request: any) {
        models++; modelSignals.push(request.signal); await modelGate
        const entry = JSON.parse(request.system.split('<索引事实>\n')[1].split('\n</索引事实>')[0]).sessions[0]
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ schemaVersion: 1, sessions: [{ hostId: entry.hostId, sessionId: entry.sessionId,
          objective: { text: entry.title, evidence: [{ source: 'title', quote: entry.title }] }, progress: [], blockers: [], pendingTasks: [], nextActions: [], openQuestions: [],
        }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
      return undefined
    } },
  } as unknown as CodingNsHostServices
  const registry = new FeatureRegistry(services)
  registry.register(createGlobalVoiceRpcFeature({ conversationStorage: memoryAssistantConversationStorage() }))
  await registry.reconcile(['globalVoiceRpc'])
  t.after(async () => { releaseList?.(); releaseModel?.(); await registry.reconcile([]) })
  return {
    call: async (action: string, payload: unknown = {}) => rpc.resolve(`assistant/${action}`)!.handler(action, payload) as Promise<any>,
    counts: () => ({ scans, workspaceScans, titles, remoteScans, models }),
    listSignals, modelSignals,
    emit: (name: string, ...args: any[]) => events.get(name)?.(...args),
    advance: async (ms: number) => { t.mock.timers.tick(ms); await setImmediate() },
    enabled: (value: boolean) => { enabled = value; watch() },
    initialized: (value: boolean) => { initialized = value; watch() },
    remoteFailed: (value: boolean) => { remoteFailed = value },
    scope: (value: string[]) => { managed = value; watch() },
    releaseList: () => { listGate = undefined; releaseList?.() },
    releaseModel: () => { modelGate = undefined; releaseModel?.() },
    dispose: () => registry.reconcile([]),
  }
}

test('模块关闭、没有档案、空范围均零自动扫描与模型请求，status 也不唤醒后台', async (t) => {
  for (const options of [{ enabled: false }, { initialized: false }, { managed: [] }]) await t.test(JSON.stringify(options), async (t) => {
    const f = await hostFixture(t, options)
    f.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    f.emit('workspace/changed')
    await f.advance(240_000)
    for (let count = 0; count < 10; count++) assert.equal((await f.call('status')).capturedAt, null)
    assert.deepEqual(f.counts(), { scans: 0, workspaceScans: 0, titles: 0, remoteScans: 0, models: 0 })
  })
})

test('多调用方 debug 和 status 共用已完成快照，显式刷新才重新列出元数据', async (t) => {
  const f = await hostFixture(t, { enabled: false, remote: true })
  const snapshots = await Promise.all(Array.from({ length: 6 }, () => f.call('debug')))
  assert.equal(f.counts().scans, 1); assert.equal(f.counts().remoteScans, 1)
  assert.ok(snapshots.every((value) => value.capturedAt === snapshots[0].capturedAt))
  const before = f.counts()
  for (let count = 0; count < 10; count++) { await f.call('debug'); const status = await f.call('status'); assert.equal(status.workspaces.at(-1).workspaceId, 'remote') }
  assert.deepEqual(f.counts(), before)
  await f.call('debug', { refresh: true })
  assert.equal(f.counts().scans, 2); assert.equal(f.counts().remoteScans, 2)
  assert.equal(f.counts().models, 0)
})

test('模块停用中止自动模型，重新启用恢复待更新版本且不删除档案', async (t) => {
  const f = await hostFixture(t, { holdModel: true })
  await f.advance(5_000)
  assert.equal(f.counts().models, 1)
  f.enabled(false)
  assert.equal(f.modelSignals[0]?.aborted, true)
  f.releaseModel(); await setImmediate()
  const before = f.counts()
  await f.advance(180_000); assert.deepEqual(f.counts(), before)
  assert.equal((await f.call('lifecycle/read')).profile.initialized, true)
  f.enabled(true)
  await f.advance(5_000)
  assert.equal(f.counts().models, 2)
  assert.equal((await f.call('status')).indexState, 'ready')
})

test('清空管理范围中止自动模型并停止扫描，恢复范围继续索引，关闭时仍可手动索引', async (t) => {
  const f = await hostFixture(t, { holdModel: true })
  await f.advance(5_000)
  f.scope([])
  assert.equal(f.modelSignals[0]?.aborted, true)
  f.releaseModel(); await setImmediate()
  const before = f.counts()
  await f.advance(180_000); assert.deepEqual(f.counts(), before)
  f.scope(['w1']); await f.advance(5_000)
  assert.equal(f.counts().models, 2)
  f.enabled(false)
  await f.call('index/rebuild'); await setImmediate()
  assert.equal((await f.call('status')).indexState, 'ready')
})

test('远端失败保留成员但撤销空闲证明，不把失败的空列表显示为索引就绪', async (t) => {
  const f = await hostFixture(t, { enabled: false, remote: true, remoteSession: true })
  const initial = await f.call('debug')
  assert.equal(initial.scopeSessions.find((entry: any) => entry.hostId === 'peer').activity, 'idle')
  f.remoteFailed(true)
  const failed = await f.call('debug', { refresh: true })
  assert.equal(failed.scopeSessions.find((entry: any) => entry.hostId === 'peer').activity, 'unknown')
  assert.equal((await f.call('status')).indexState, 'incomplete')
  await assert.rejects(f.call('chat/start'), /暂不可确认/u)
  f.remoteFailed(false)
  const recovered = await f.call('debug', { refresh: true })
  assert.equal(recovered.scopeSessions.find((entry: any) => entry.hostId === 'peer').activity, 'idle')
})

test('范围切换与销毁的取消到达本地列表，旧范围响应不能发布到快照', async (t) => {
  const f = await hostFixture(t, { holdList: true })
  await f.advance(0)
  assert.equal(f.counts().scans, 1)
  f.scope(['w2'])
  assert.equal(f.listSignals[0]?.aborted, true)
  f.releaseList(); await setImmediate(); await f.advance(5_000)
  const debug = await f.call('debug')
  assert.deepEqual(debug.scopeSessions.map((entry: any) => entry.sessionId), ['s2'])
  await f.dispose()
  assert.equal(f.listSignals.at(-1)?.aborted, true)
  const count = f.counts().scans
  await f.advance(180_000); assert.equal(f.counts().scans, count)
})

test('取消真实传递给远端 Gateway，流式无关事件不重新找成员或失效标题', async (t) => {
  const f = await hostFixture(t, { remote: true, holdList: true })
  await f.advance(0)
  assert.equal(f.counts().remoteScans, 1)
  f.enabled(false)
  assert.ok(f.listSignals.every((signal) => signal.aborted))
  f.releaseList(); await setImmediate()
  await f.call('debug')
  const before = f.counts()
  for (let count = 0; count < 100; count++) {
    f.emit('session/event', { id: 's1' }, { type: 'assistant/live-chunk' })
    f.emit('session/event', { id: 's1' }, { type: 'step/end' })
  }
  await f.call('debug')
  assert.deepEqual(f.counts(), before)
  f.emit('session/title', 's1')
  await f.call('debug', { refresh: true })
  assert.equal(f.counts().titles, before.titles + 1)
})
