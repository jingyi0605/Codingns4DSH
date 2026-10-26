import assert from 'node:assert/strict'
import test from 'node:test'
import { getEventListeners } from 'node:events'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { FeatureRegistry } from '../src/features/registry.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { createCodingNsRpcHandler, registerCodingNsRpc } from '../src/host/rpc.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { QuickAppsLauncher } from '../src/client/quick-apps/launcher.js'
import { en } from '../src/client/locales/quickApps.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<{ children?: ReactNode }>(node)
    ? [node, ...Children.toArray(node.props.children).flatMap(elements)] : []
}

test('the first sidebar request waits for delayed Host startup and loads without refresh', async t => {
  const precedingFeature = deferred()
  const rpc = new CodingNsRpcTable()
  const app = { id: 'saved', title: 'Saved shortcut', hostId: 'local', workspaceId: 'workspace',
    entryPath: 'notes.md', documentRoot: '', kind: 'text' as const, spaFallback: false, mounts: [], order: 0, revision: 1 }
  const registry = new FeatureRegistry({
    rpc, resolveManagedWorkspaceRoot: () => null,
    settings: { get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, quickApps: [app] }), update: async () => {} },
  })
  registry.register({
    descriptor: { name: 'preceding', version: '1.0.0', runtime: 'host', dependencies: [], enabledByDefault: true },
    start: () => precedingFeature.promise,
  })
  registry.register(createQuickAppsFeature())
  const featuresReady = registry.reconcile(['preceding', 'quickApps'])
  t.after(async () => { precedingFeature.resolve(); await featuresReady; await registry.reconcile([]) })
  const handler = createCodingNsRpcHandler(rpc, { featuresReady })
  let attempts = 0
  const renderer = createHookRenderer(QuickAppsLauncher, { wide: true, services: {
    locale: { bind: () => (key: keyof typeof en) => en[key] ?? key, subscribe: () => () => {}, getSnapshot: () => ({ revision: 0 }) },
    rpc: { call: async (_channel: string, endpoint: string, payload: unknown) => {
      attempts++
      return handler(endpoint, payload, new AbortController().signal, { id: 'owner' })
    } },
  } as never })
  t.after(renderer.dispose)
  const read = () => elements(renderer.render())
  read()
  await tick()
  assert.equal(rpc.resolve('quickApps/list'), null)
  assert.equal(read().find(node => node.props.className === 'codingns-quick-app-rail')?.props['aria-busy'], true)
  assert.equal(read().some(node => node.props.role === 'alert'), false)
  precedingFeature.resolve()
  await featuresReady
  await tick()
  assert.equal(attempts, 1)
  assert.ok(read().some(node => node.type === 'strong' && node.props.children === app.title))
  assert.equal(read().some(node => node.props.role === 'alert' || node.props['aria-label'] === 'Try again'), false)
})

test('registered RPCs stay available during startup and missing features still return not found', async () => {
  const startup = deferred()
  const table = new CodingNsRpcTable()
  table.register('settings', () => ({ modules: { quickApps: false } }))
  const handler = createCodingNsRpcHandler(table, { featuresReady: startup.promise })
  const controller = new AbortController()
  const settings = await handler('settings/read', {}, controller.signal)
  assert.deepEqual(settings, { ok: true, value: { modules: { quickApps: false } } })
  let settled = false
  const missing = handler('quickApps/list', {}, controller.signal).then(result => { settled = true; return result })
  await tick()
  assert.equal(settled, false)
  startup.resolve()
  const result = await missing
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'CODINGNS_RPC_NOT_FOUND')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('startup waits honor cancellation and never dispatch the cancelled request later', async () => {
  const startup = deferred()
  const table = new CodingNsRpcTable()
  const handler = createCodingNsRpcHandler(table, { featuresReady: startup.promise })
  const controller = new AbortController()
  const pending = handler('quickApps/list', {}, controller.signal)
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'AbortError')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  let calls = 0
  table.register('quickApps', () => { calls++; return [] })
  startup.resolve()
  await tick()
  assert.equal(calls, 0)
  const alreadyCancelled = await handler('missing/list', {}, controller.signal)
  assert.equal(alreadyCancelled.ok, false)
  if (!alreadyCancelled.ok) assert.equal(alreadyCancelled.error.code, 'AbortError')
})

test('legacy Fetch RPC registration shares the Host startup barrier', async t => {
  const startup = deferred()
  const table = new CodingNsRpcTable()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let dispose!: () => Promise<void>
  registerCodingNsRpc({
    effect(factory: () => () => Promise<void>) { dispose = factory() },
    webServer: { register: () => () => {} },
    connection: { admit: () => ({ peer: { id: 'owner', principal: { kind: 'owner' } } }),
      fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
        routes.set(route.path, route.fetch)
        return () => { routes.delete(route.path) }
      } } },
  } as never, table, undefined, startup.promise)
  t.after(() => dispose())
  const pending = routes.get('/api/codingns/quickApps/list')!(new Request('https://fixture.test/api/codingns/quickApps/list', {
    method: 'POST', body: JSON.stringify({ rpcId: 'initial-list', method: 'quickApps/list', payload: {} }),
  }))
  await tick()
  table.register('quickApps', () => ['saved shortcut'])
  startup.resolve()
  const response = await pending
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json() as any).result, { ok: true, value: ['saved shortcut'] })
})
