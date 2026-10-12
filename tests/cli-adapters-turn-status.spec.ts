import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

/**
 * 分步驱动的会话状态回归。
 *
 * OpenCode 等适配器声明 `supportsToolStepSplitting` 后，工具完成只结束一个
 * DSH step；Agent Loop 注入 next-step 会继续留在同一个 turn 里。如果每段
 * llm/stream 返回都播报 idle，会话状态就会随每个工具调用在「已完成 / 进行中」
 * 之间反复闪烁。这里锁定一个 turn 只播报一次 running 和一次 idle。
 */
test('分步外部 Agent 的工具边界不播报已完成，回合真正收尾才回到 idle', async () => {
  const table = new CodingNsRpcTable()
  const sessionStore = new CodingNsCliSessionStore()
  const listenerRef: { current?: (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown> } = {}
  const sessionStatuses: Array<readonly [string, boolean]> = []
  const injections: string[] = []

  const driver = {
    descriptor: { id: 'fake', name: 'Fake' },
    supportsToolStepSplitting: true,
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    /** 一个 Provider 回合：正文 → 工具完成 → 正文 → finish。 */
    async *executeTurn() {
      yield { type: 'text-delta', text: '先说明' } as const
      yield {
        type: 'tool-event', toolName: 'bash', callId: 'call_1', status: 'completed',
        input: '{"command":"pwd"}', output: '/workspace', outputMode: 'snapshot',
      } as const
      yield { type: 'text-delta', text: '工具结果已确认' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }
  const registry = new CodingNsCliAdapterRegistry([driver as never], {}, { sessionStore })
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listenerRef.current = next
      return () => { listenerRef.current = undefined }
    },
    emit(name: string, ...args: unknown[]) {
      if (name === 'api-session/status' && typeof args[0] === 'string' && typeof args[1] === 'boolean') {
        sessionStatuses.push([args[0], args[1]])
      }
    },
  }
  const nativeSessions = {
    available: true,
    supportsEvents: true,
    store: undefined,
    controller: undefined,
    get(id: string) { return id === 's1' ? { id } : undefined },
    list() { return [] },
    async listRemote() { return [] },
    async ensure() { return null },
    async flush() {},
    canInjectNextStep() { return true },
    injectNextStep(id: string) { injections.push(id); return true },
    subscribe() { return () => {} },
  }
  const features = new FeatureRegistry({ rpc: table, events, nativeSessions })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 's1', adapterId: 'fake' })
  const listener = listenerRef.current
  assert.notEqual(listener, undefined)

  // 同一个 turn 的第一个 step：在工具完成处挂起，等 Agent Loop 注入 next-step。
  const firstStep: unknown[] = []
  for await (const chunk of listener!({
    sessionId: 's1',
    messages: [{ role: 'user', source: { kind: 'user' }, content: '检查工作目录' }],
  }, async function* () { yield { type: 'text-delta', text: '默认 DSH' } })) firstStep.push(chunk)
  assert.deepEqual(injections, ['s1'])
  assert.deepEqual(firstStep.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.deepEqual(sessionStatuses, [['s1', true]])

  // 同一个 turn 的第二个 step：续读挂起的 Provider 流并真正结束回合。
  const secondStep: unknown[] = []
  for await (const chunk of listener!({
    sessionId: 's1',
    messages: [{ role: 'user', source: { kind: 'plugin', plugin: 'codingns4dsh', form: 'notice' }, content: '外部工具已完成，继续处理当前任务。' }],
  }, async function* () { yield { type: 'text-delta', text: '默认 DSH' } })) secondStep.push(chunk)
  assert.deepEqual(secondStep.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.deepEqual(sessionStatuses, [['s1', true], ['s1', false]])

  await features.disable('cliAdapters')
})

/**
 * 注入失败时挂起会被丢弃，回合随即结束；此时必须补播 idle，
 * 否则会话会一直停留在「进行中」。
 */
test('next-step 注入失败时外部 Agent 立即回到 idle', async () => {
  const table = new CodingNsRpcTable()
  const sessionStore = new CodingNsCliSessionStore()
  const listenerRef: { current?: (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown> } = {}
  const sessionStatuses: Array<readonly [string, boolean]> = []
  const driver = {
    descriptor: { id: 'fake', name: 'Fake' },
    supportsToolStepSplitting: true,
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'tool-event', toolName: 'bash', callId: 'call_1', status: 'completed', output: '/workspace', outputMode: 'snapshot' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }
  const registry = new CodingNsCliAdapterRegistry([driver as never], {}, { sessionStore })
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listenerRef.current = next
      return () => { listenerRef.current = undefined }
    },
    emit(name: string, ...args: unknown[]) {
      if (name === 'api-session/status' && typeof args[0] === 'string' && typeof args[1] === 'boolean') {
        sessionStatuses.push([args[0], args[1]])
      }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      supportsEvents: true,
      store: undefined,
      controller: undefined,
      get(id: string) { return id === 's1' ? { id } : undefined },
      list() { return [] },
      async listRemote() { return [] },
      async ensure() { return null },
      async flush() {},
      canInjectNextStep() { return true },
      injectNextStep() { return false },
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 's1', adapterId: 'fake' })

  const chunks: unknown[] = []
  for await (const chunk of listenerRef.current!({
    sessionId: 's1',
    messages: [{ role: 'user', source: { kind: 'user' }, content: '检查工作目录' }],
  }, async function* () { yield { type: 'text-delta', text: '默认 DSH' } })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.deepEqual(sessionStatuses, [['s1', true], ['s1', false]])

  await features.disable('cliAdapters')
})
