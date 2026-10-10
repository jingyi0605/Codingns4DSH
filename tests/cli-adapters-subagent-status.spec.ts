import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

test('外部子 Agent 状态投影覆盖原生事件并保留 DSH 原生会话隔离', async () => {
  const table = new CodingNsRpcTable()
  const sessionStore = new CodingNsCliSessionStore()
  sessionStore.upsert('external-child', { adapterId: 'fake', status: 'idle' })
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } as const },
  }], {}, { sessionStore })

  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const dshContext = {
    get() { return undefined },
    on(name: string, listener: (...args: unknown[]) => unknown) {
      const current = handlers.get(name) ?? []
      current.push(listener)
      handlers.set(name, current)
      return () => {
        const next = handlers.get(name)?.filter(item => item !== listener) ?? []
        handlers.set(name, next)
      }
    },
  }
  const emitted: Array<readonly [string, ...unknown[]]> = []
  const events = {
    on() { return () => {} },
    emit(name: string, ...args: unknown[]) { emitted.push([name, ...args]) },
  }
  let nativeSubscription: { onEvent?: (session: unknown, event: unknown) => void } | undefined
  const nativeSessions = {
    available: true,
    supportsEvents: true,
    store: undefined,
    controller: undefined,
    get(id: string) { return id === 'external-child' ? { id } : undefined },
    list() { return [] },
    async listRemote() { return [] },
    async ensure() { return null },
    async flush() {},
    subscribe(subscription: { onEvent?: (session: unknown, event: unknown) => void }) {
      nativeSubscription = subscription
      return () => { nativeSubscription = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    dshContext: dshContext as never,
    events,
    nativeSessions,
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')

  nativeSubscription?.onEvent?.({ id: 'external-child' }, { type: 'turn/start' })
  nativeSubscription?.onEvent?.({ id: 'external-child' }, { type: 'turn/start' })
  handlers.get('agent/status')?.[0]?.({ agent: { id: 'external-child' }, status: 'running' })
  nativeSubscription?.onEvent?.({ id: 'external-child' }, { type: 'turn/end' })
  handlers.get('agent/status')?.[0]?.({ agent: { id: 'external-child' }, status: 'idle' })
  handlers.get('agent/disposed')?.[0]?.({ agent: { id: 'external-child' } })
  nativeSubscription?.onEvent?.({ id: 'native-dsh' }, { type: 'turn/start' })

  assert.deepEqual(emitted.filter(([name]) => name === 'api-session/status'), [
    ['api-session/status', 'external-child', true],
    ['api-session/status', 'external-child', false],
  ])
  await features.disable('cliAdapters')
})
