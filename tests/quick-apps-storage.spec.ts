import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuickAppBrowserStore, attachQuickAppStorageBroker } from '../src/client/quick-apps/browser-storage.js'
import { QUICK_APP_STORAGE_LIMITS, QUICK_APP_STORAGE_PROTOCOL, quickAppStorageKey } from '../src/shared/quick-app-browser-storage.js'
import { definition } from './quick-apps-fixture.js'
import { quickAppProxyFixture } from './quick-apps-proxy-fixture.js'
import { QuickAppsClient } from '../src/client/quick-apps/client.js'
import { request } from 'node:http'

const app = { ...definition, id: 'app-a', revision: 1 }
function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return { get length() { return entries.size }, key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value) }, removeItem: key => { entries.delete(key) }, clear: () => entries.clear() }
}

test('browser namespaces isolate apps, Hosts, workspaces and source reassignments; metadata preserves values', () => {
  const native = { local: memoryStorage(), session: memoryStorage() }
  native.local.setItem('dsh-private', 'untouched')
  const store = createQuickAppBrowserStore(quickAppStorageKey(app), area => native[area])
  store.execute({ id: 1, area: 'local', operation: 'setItem', key: '__proto__', value: 'safe' })
  store.execute({ id: 2, area: 'session', operation: 'setItem', key: 'draft', value: 'session only' })
  assert.deepEqual(store.read('local'), [['__proto__', 'safe']])
  assert.deepEqual(store.read('session'), [['draft', 'session only']])
  for (const patch of [{ id: 'app-b' }, { hostId: 'peer-a' }, { workspaceId: 'workspace-b' }, { documentRoot: 'other' }, { entryPath: 'site/other.html' }]) {
    assert.deepEqual(createQuickAppBrowserStore(quickAppStorageKey({ ...app, ...patch }), area => native[area]).read('local'), [])
  }
  assert.equal(quickAppStorageKey({ ...app, title: 'Renamed', order: 99, revision: 17 } as typeof app), quickAppStorageKey(app))
  store.execute({ id: 3, area: 'local', operation: 'clear' })
  assert.equal(native.local.getItem('dsh-private'), 'untouched')
  assert.deepEqual(store.read('session'), [['draft', 'session only']])
})

test('storage rejects forged identities, malformed operations, excessive data and browser failures without overwriting values', () => {
  const native = memoryStorage()
  const store = createQuickAppBrowserStore(quickAppStorageKey(app), () => native)
  const request = { id: 1, area: 'local', operation: 'setItem', key: 'value', value: 'before' }
  store.execute(request)
  for (const input of [{ ...request, namespace: 'dsh-private' }, { ...request, appId: 'app-b' }, { ...request, operation: 'eval' }, { ...request, area: ['local'] }, { ...request, key: 7 }, { ...request, id: -1 }]) {
    assert.throws(() => store.execute(input), { name: 'SecurityError' })
  }
  assert.throws(() => store.execute({ ...request, value: 'x'.repeat(QUICK_APP_STORAGE_LIMITS.bytes) }), { name: 'SecurityError' })
  const original = native.setItem
  native.setItem = () => { throw new DOMException('Browser quota fixture', 'QuotaExceededError') }
  assert.throws(() => store.execute({ ...request, value: 'after' }), { name: 'QuotaExceededError' })
  assert.deepEqual(store.read('local'), [['value', 'before']])
  native.setItem = original
  native.setItem(quickAppStorageKey(app), 'damaged')
  assert.throws(() => store.read('local'), { name: 'DataError' })
  store.execute({ id: 2, area: 'local', operation: 'clear' })
  assert.deepEqual(store.read('local'), [])
  native.setItem(quickAppStorageKey(app), JSON.stringify(Array.from({ length: QUICK_APP_STORAGE_LIMITS.keys }, (_, index) => [String(index), 'value'])))
  assert.throws(() => store.execute({ ...request, key: 'one-more' }), { name: 'QuotaExceededError' })
  assert.equal(store.read('local').length, QUICK_APP_STORAGE_LIMITS.keys)
  assert.throws(() => createQuickAppBrowserStore(quickAppStorageKey(app), () => { throw new DOMException('Browser denied storage', 'SecurityError') }).read('local'), { name: 'SecurityError' })
})

test('broker expiry closes the active port and rejects later initialization', { timeout: 3000 }, async t => {
  const owner = new EventTarget() as EventTarget & { localStorage: Storage; sessionStorage: Storage }
  owner.localStorage = memoryStorage(); owner.sessionStorage = memoryStorage()
  let port: MessagePort | undefined
  const frameWindow = { postMessage: (_data: unknown, _origin: string, ports: MessagePort[]) => { port = ports[0] } }
  const token = '11111111-1111-4111-8111-111111111111'
  const dispose = attachQuickAppStorageBroker({ owner: owner as unknown as Window, frame: () => ({ contentWindow: frameWindow }) as unknown as HTMLIFrameElement,
    scope: quickAppStorageKey(app), token, expiresAt: Date.now() + 75, onError: () => assert.fail('Unexpected storage error') })
  t.after(dispose)
  const event = new Event('message')
  Object.defineProperties(event, { source: { value: frameWindow }, origin: { value: 'null' }, data: { value: { type: QUICK_APP_STORAGE_PROTOCOL, token, documentId: 'a'.repeat(32) } } })
  owner.dispatchEvent(event)
  assert.ok(port)
  const activePort = port; t.after(() => activePort.close())
  const closed = await new Promise<any>(resolve => { activePort.onmessage = message => resolve(message.data) })
  assert.equal(closed.type, 'closed')
  port = undefined; owner.dispatchEvent(event); assert.equal(port, undefined)
})

test('broker requires the exact iframe, opaque origin and token; navigation replacement and disposal close old channels', { timeout: 10_000 }, async t => {
  const owner = new EventTarget() as EventTarget & { localStorage: Storage; sessionStorage: Storage }
  owner.localStorage = memoryStorage(); owner.sessionStorage = memoryStorage()
  const connections: { value: any; port: MessagePort }[] = []
  const frameWindow = { postMessage: (value: any, _origin: string, ports: MessagePort[]) => connections.push({ value, port: ports[0]! }) }
  const frame = { contentWindow: frameWindow }
  const token = '11111111-1111-4111-8111-111111111111'
  const errors: Error[] = []
  const dispose = attachQuickAppStorageBroker({ owner: owner as unknown as Window, frame: () => frame as unknown as HTMLIFrameElement,
    scope: quickAppStorageKey(app), token, expiresAt: Date.now() + 60_000, onError: error => errors.push(error) })
  t.after(dispose)
  const ready = { type: QUICK_APP_STORAGE_PROTOCOL, token, documentId: 'a'.repeat(32) }
  const send = (data = ready, source: unknown = frameWindow, origin = 'null') => {
    const event = new Event('message')
    Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: origin } })
    owner.dispatchEvent(event)
  }
  send(ready, {}); send({ ...ready, token: 'wrong' }); send(ready, frameWindow, 'https://foreign.test')
  assert.equal(connections.length, 0)
  send(); send()
  assert.equal(connections.length, 1)
  const first = connections[0]!.port
  t.after(() => first.close())
  const receive = (port: MessagePort) => new Promise<any>(resolve => port.addEventListener('message', event => resolve(event.data), { once: true }))
  first.start()
  let response = receive(first)
  first.postMessage({ id: 1, area: 'local', operation: 'setItem', key: 'saved', value: 'yes' })
  assert.equal((await response).error, undefined)
  response = receive(first)
  send({ ...ready, documentId: 'b'.repeat(32) })
  assert.equal((await response).type, 'closed')
  assert.deepEqual(connections[1]!.value.snapshot.local, [['saved', 'yes']])
  const second = connections[1]!.port; second.start(); t.after(() => second.close())
  response = receive(second)
  second.postMessage({ id: 2, area: 'local', operation: 'clear', namespace: 'foreign' })
  assert.equal((await response).error.name, 'SecurityError')
  assert.equal(errors.length, 1)
  dispose(); send({ ...ready, documentId: 'c'.repeat(32) }); assert.equal(connections.length, 2)
})

test('new clients request browser storage; old launches/raw resources remain unchanged and navigation stays sandboxed', async t => {
  const f = await quickAppProxyFixture(); t.after(f.dispose)
  const legacy = await f.launch()
  assert.equal(legacy.storageToken, undefined)
  let payload: any
  const client = new QuickAppsClient({ call: async (_channel, _endpoint, input) => { payload = input; return { ok: true, value: legacy } } })
  await client.open(f.app.id)
  assert.equal(payload.browserStorage, true)
  const launch = await f.launch(f.origin, true)
  assert.match(launch.storageToken, /^[a-f0-9-]{36}$/u)
  const raw = await fetch(launch.url)
  assert.match(await raw.text(), /Ordinary static app/u)
  const page = await new Promise<{ body: string; csp: string }>((resolve, reject) => {
    const req = request(launch.url, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } }, response => {
      let body = ''; response.on('data', bytes => { body += String(bytes) })
      response.on('end', () => resolve({ body, csp: String(response.headers['content-security-policy']) }))
      response.on('error', reject)
    }); req.on('error', reject); req.end()
  })
  assert.ok(page.body.includes(launch.storageToken)); assert.ok(page.body.includes('document.write(html)'))
  assert.match(page.csp, /sandbox allow-scripts/u); assert.equal(page.csp.includes('allow-same-origin'), false)
  const native = memoryStorage()
  createQuickAppBrowserStore(launch.storageScope, () => native).execute({ id: 1, area: 'local', operation: 'setItem', key: 'old-source', value: 'private' })
  const current = f.registry.get(f.app.id)
  const updated = await f.registry.upsert({ ...current, entryPath: 'site/proxy.html' }, current.revision)
  const reassigned = await f.launch(f.origin, true)
  assert.equal(reassigned.storageScope, quickAppStorageKey(updated))
  assert.notEqual(reassigned.storageScope, launch.storageScope, 'The Host launch snapshot selects storage even if sidebar metadata is stale')
  assert.deepEqual(createQuickAppBrowserStore(reassigned.storageScope, () => native).read('local'), [])
})
