import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { QuickAppsLauncher } from '../src/client/quick-apps/launcher.js'
import { QUICK_APPS_RAIL_COLLAPSED_KEY } from '../src/client/quick-apps/rail-preference.js'
import { DshModal } from '../src/dsh-capabilities/client/primitives-adapter.js'
import { QuickAppRegistry } from '../src/host/modules/quick-apps/registry.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import type { QuickApp } from '../src/shared/contracts/quick-apps.js'
import { en } from '../src/client/locales/quickApps.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { QuickAppsClient } from '../src/client/quick-apps/client.js'
import { createQuickAppReorderAnimation } from '../src/client/quick-apps/reorder-animation.js'
import { quickAppFixture, definition } from './quick-apps-fixture.js'

const initial: QuickApp[] = ['a', 'b', 'c'].map((id, order) => ({
  id, title: id.toUpperCase(), hostId: id === 'c' ? 'offline-peer' : 'local', workspaceId: 'missing-workspace',
  entryPath: 'site/index.html', documentRoot: 'site', kind: 'html', spaFallback: true, mounts: [],
  ...(id === 'b' ? { fileAccess: 'workspace' as const } : {}), revision: 1, order,
}))
const request = (apps: readonly QuickApp[]) => apps.map(app => ({ id: app.id, expectedRevision: app.revision }))
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

beforeEach(() => {
  try { globalThis.localStorage?.removeItem(QUICK_APPS_RAIL_COLLAPSED_KEY) } catch { /* isolation only */ }
})

test('reordering is atomic, revision checked and preserves unavailable shortcuts and access policy', async () => {
  let saved = structuredClone(initial)
  let writes = 0
  const storage = { read: () => saved, write: async (apps: readonly QuickApp[]) => { saved = structuredClone([...apps]); writes++ } }
  const registry = new QuickAppRegistry(storage, () => { throw new Error('Ordering must not inspect the workspace') })
  const ordered = await registry.reorder(request([initial[2], initial[0], initial[1]]))
  assert.equal(writes, 1)
  assert.deepEqual(ordered, [initial[2], initial[0], initial[1]].map((app, order) => ({ ...app, order, revision: 2 })))
  const reloaded = CodingNsSettingsSchema(JSON.parse(JSON.stringify({ quickApps: saved })))
  assert.deepEqual(new QuickAppRegistry({ ...storage, read: () => reloaded.quickApps }, () => null).list(), ordered)
  await registry.reorder(request(ordered))
  assert.equal(writes, 1, 'unchanged order must not write settings')
  for (const input of [request(initial), request(ordered.slice(1)), [...request(ordered).slice(1), { id: 'unknown', expectedRevision: 2 }]]) {
    await assert.rejects(registry.reorder(input), { code: 'QUICK_APP_CONFLICT' })
  }
  for (const input of [null, {}, [null], [{ id: 'a', expectedRevision: '2' }], [...request(ordered), request(ordered)[0]]]) {
    await assert.rejects(registry.reorder(input), { code: 'QUICK_APP_ACCESS_DENIED' })
  }
  assert.equal(writes, 1)
  assert.deepEqual(saved, ordered)
  const competing = await Promise.allSettled([
    registry.reorder(request([...ordered].reverse())), registry.reorder(request([ordered[1], ordered[2], ordered[0]])),
  ])
  assert.deepEqual(competing.map(result => result.status), ['fulfilled', 'rejected'])
  assert.equal(writes, 2, 'a stale concurrent reorder cannot partially overwrite the first')
  await registry.dispose()
})

test('reorder RPC requires an authenticated owner and persists through feature restart', async t => {
  let settings = { ...DEFAULT_CODINGNS_SETTINGS, quickApps: structuredClone(initial) }
  let writes = 0
  const rpc = new CodingNsRpcTable()
  const features = new FeatureRegistry({ rpc, resolveManagedWorkspaceRoot: () => null,
    settings: { get: () => settings, update: async patch => { settings = { ...settings, ...patch }; writes++ } } })
  features.register(createQuickAppsFeature()); await features.start('quickApps'); t.after(() => features.disable('quickApps'))
  const invoke = (context: unknown) => rpc.resolve('quickApps/reorder')!.handler('reorder', { apps: request([...initial].reverse()) }, context) as Promise<QuickApp[]>
  await assert.rejects(invoke({}), { code: 'QUICK_APP_PRINCIPAL_UNAVAILABLE' })
  assert.equal(writes, 0)
  const ordered = await invoke({ peer: { id: 'owner' } })
  assert.deepEqual(ordered.map(app => app.id), ['c', 'b', 'a'])
  assert.equal(writes, 1)
  await features.disable('quickApps'); await features.start('quickApps')
  assert.deepEqual(settings.quickApps, ordered)
  await assert.rejects(invoke({ peer: { id: 'owner' } }), { code: 'QUICK_APP_CONFLICT' })
  assert.equal(writes, 1)
})

test('older Hosts persist order through existing upsert without changing access policy', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const trusted = await f.registry.upsert({ ...definition, title: 'Trusted', fileAccess: 'workspace', order: 1 }, 0)
  const last = await f.registry.upsert({ ...definition, title: 'Last', order: 2 }, 0)
  const calls: { endpoint: string; payload: any }[] = []
  const client = new QuickAppsClient({ call: async (_channel, endpoint, payload: any) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'quickApps/reorder') return { ok: false, error: { code: 'CODINGNS_RPC_NOT_FOUND', message: 'Unknown Quick Apps operation.' } }
    assert.equal(endpoint, 'quickApps/upsert')
    assert.equal('availability' in payload.app, false)
    return { ok: true, value: await f.registry.upsert(payload.app, payload.expectedRevision) }
  } })
  const saved = await client.reorder([{ ...last, availability: 'available' } as QuickApp, trusted, f.app], () => true)
  assert.deepEqual(saved, [{ ...last, order: 0, revision: 2 }, trusted, { ...f.app, order: 2, revision: 2 }])
  assert.deepEqual(f.registry.list(), saved)
  assert.deepEqual(calls.map(call => call.endpoint), ['quickApps/reorder', 'quickApps/upsert', 'quickApps/upsert'])
  assert.equal(saved[0]?.fileAccess, undefined)
  assert.equal(saved[1]?.fileAccess, 'workspace')
  assert.equal('fileAccess' in calls[1].payload.app, false, 'reordering a legacy shortcut must not grant workspace access')
})

test('reorder does not fall back after conflicts or permission failures, or continue after cancellation', async () => {
  for (const code of ['QUICK_APP_CONFLICT', 'QUICK_APP_ACCESS_DENIED', 'QUICK_APP_PRINCIPAL_UNAVAILABLE']) {
    const calls: string[] = []
    const client = new QuickAppsClient({ call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: false, error: { code, message: code } } } })
    await assert.rejects(client.reorder([...initial].reverse(), () => true), { code })
    assert.deepEqual(calls, ['quickApps/reorder'])
  }
  let current = true
  const calls: string[] = []
  const client = new QuickAppsClient({ call: async (_channel, endpoint, payload: any) => {
    calls.push(endpoint)
    if (endpoint === 'quickApps/reorder') return { ok: false, error: { code: 'CODINGNS_RPC_NOT_FOUND', message: 'Unknown Quick Apps operation.' } }
    current = false
    return { ok: true, value: { ...payload.app, revision: payload.expectedRevision + 1 } }
  } })
  await client.reorder([...initial].reverse(), () => current)
  assert.deepEqual(calls, ['quickApps/reorder', 'quickApps/upsert'])
})

function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<{ children?: ReactNode }>(node) ? [node, ...Children.toArray(node.props.children).flatMap(elements)] : []
}

async function launcher(wide = true, legacy = false) {
  let saved = structuredClone(initial)
  let fail = false
  let upserts = 0
  let failUpsert = 0
  const calls: { endpoint: string; payload: any }[] = []
  const registry = new QuickAppRegistry({ read: () => saved, write: async apps => { saved = [...apps] } }, () => null)
  const services = {
    locale: { bind: () => (key: keyof typeof en) => en[key] ?? key, subscribe: () => () => {}, getSnapshot: () => ({ revision: 0 }) },
    rpc: { call: async (_channel: string, endpoint: string, payload: any) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'quickApps/list') return { ok: true, value: registry.list().map(app => ({ ...app, availability: 'missing-workspace' })) }
      if (legacy) {
        if (endpoint === 'quickApps/reorder') return { ok: false, error: { code: 'CODINGNS_RPC_NOT_FOUND', message: 'Unknown Quick Apps operation.' } }
        assert.equal(endpoint, 'quickApps/upsert')
        if (++upserts === failUpsert) return { ok: false, error: { code: 'QUICK_APP_CONFLICT', message: 'Changed in another client' } }
        const previous = saved.find(app => app.id === payload.app.id)!
        assert.equal(payload.expectedRevision, previous.revision)
        const app = { ...payload.app, revision: previous.revision + 1 }
        saved = [...saved.filter(item => item.id !== app.id), app]
        return { ok: true, value: app }
      }
      assert.equal(endpoint, 'quickApps/reorder', 'dragging must not launch, edit, remove or grant access')
      if (fail) { fail = false; return { ok: false, error: { message: 'Order could not be saved' } } }
      return { ok: true, value: await registry.reorder(payload.apps) }
    } },
  }
  const renderer = createHookRenderer(QuickAppsLauncher, { services: services as never, wide }, { checkHookOrder: true })
  const read = () => elements(renderer.render())
  const grid = () => read().find(node => node.props.className === 'qa-grid')!
  const tile = (id: string) => elements(read().find(node => node.props['data-quick-app-id'] === id)).find(node => node.props.className === 'qa-tile')!
  const click = (label: string) => read().find(node => node.props['aria-label'] === label)!.props.onClick()
  read(); await flush()
  return { renderer, read, grid, tile, click, calls, order: () => read().filter(node => node.props.className === 'qa-shortcut').map(node => node.props['data-quick-app-id']),
    saved: () => registry.list(), failNext: () => { fail = true }, failAtUpsert: (index: number) => { failUpsert = index } }
}

function pointer(f: Awaited<ReturnType<typeof launcher>>, pointerType = 'mouse') {
  let capture: unknown
  const targets = initial.map((app, index) => ({ dataset: { quickAppId: app.id }, offsetLeft: index * 64, offsetTop: 32, offsetWidth: 60, offsetHeight: 54 }))
  let point = { x: 20, y: 50 }
  const captureMethods = () => ({
    setPointerCapture() { capture = this }, hasPointerCapture() { return capture === this }, releasePointerCapture() { capture = undefined },
  })
  const root = { ...captureMethods(), ownerDocument: {}, querySelectorAll: () => targets,
    scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, right: 240, top: 0, bottom: 300 }) }
  const button = { ...captureMethods() }
  ;(f.grid() as any).ref.current = root
  const event = (currentTarget = root, x = point.x, y = point.y) => ({ pointerId: 1, isPrimary: true, button: 0, pointerType,
    clientX: x, clientY: y, currentTarget, preventDefault() {}, stopPropagation() {} })
  const layout = () => { const order = f.order(); for (const target of targets) target.offsetLeft = order.indexOf(target.dataset.quickAppId) * 64 }
  const aim = (id: string) => {
    layout()
    const target = targets.find(item => item.dataset.quickAppId === id)
    point = { x: target ? target.offsetLeft + 20 : 300, y: 50 }
  }
  return { root, button, event, aim,
    down: (id = 'a') => { aim(id); f.tile(id).props.onPointerDown(event(button as typeof root)) },
    move: (id = 'c') => { aim(id); f.grid().props.onPointerMove(event()) },
    up: () => { layout(); f.grid().props.onPointerUp(event()) },
  }
}

for (const [pointerType, wide] of [['mouse', true], ['touch', true], ['touch', false]] as const) {
  test(`${pointerType} dragging in edit mode previews and persists order (wide=${wide})`, async t => {
    const f = await launcher(wide); t.after(f.renderer.dispose)
    const p = pointer(f, pointerType)
    p.down(); p.move(); p.up()
    assert.deepEqual(f.order(), ['a', 'b', 'c'], 'normal mode cannot drag')
    f.click('Edit shortcuts')
    p.down(); p.move()
    // Capture transfer away from a moving tile must not cancel the gesture.
    f.grid().props.onLostPointerCapture({ ...p.event(), target: p.button })
    assert.deepEqual(f.order(), ['b', 'c', 'a'])
    assert.equal(f.calls.length, 1, 'preview must not save')
    assert.equal(f.tile('a').props['data-dragging'], true)
    p.up()
    let stopped = false
    f.grid().props.onClickCapture({ detail: 1, preventDefault() {}, stopPropagation() { stopped = true } })
    assert.equal(stopped, true, 'a drop must not open the edit form or activate a delete badge')
    await flush()
    assert.deepEqual(f.order(), ['b', 'c', 'a'])
    assert.deepEqual(f.saved().map(app => app.id), ['b', 'c', 'a'])
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls[1].payload.apps, request([initial[1], initial[2], initial[0]]))
    assert.equal(f.read().some(node => node.type === DshModal), false)
    assert.equal(f.tile('c').props['data-unavailable'], true, 'saving order preserves availability')
    f.click('Done')
    assert.deepEqual(f.order(), ['b', 'c', 'a'])
  })
}

test('canceled drags and outside drops preserve order, while taps still open editing', async t => {
  const f = await launcher(); t.after(f.renderer.dispose)
  f.click('Edit shortcuts')
  const p = pointer(f)
  for (const cancel of [
    () => f.grid().props.onPointerCancel(p.event()),
    () => f.grid().props.onLostPointerCapture({ ...p.event(), target: p.root }),
    () => f.grid().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }),
    () => { p.aim('outside'); p.up() },
    () => f.click('Done'),
  ]) {
    p.down(); p.move(); cancel()
    assert.deepEqual(f.order(), ['a', 'b', 'c'])
  }
  f.click('Edit shortcuts')
  p.down()
  f.grid().props.onPointerMove(p.event(p.root, 22, 51))
  p.up()
  let stopped = false
  f.grid().props.onClickCapture({ detail: 1, preventDefault() {}, stopPropagation() { stopped = true } })
  assert.equal(stopped, false)
  f.tile('a').props.onClick()
  assert.ok(f.read().some(node => node.type === 'form'))
  assert.equal(f.calls.length, 1)
})

test('failed reorder restores persisted order and keyboard retries use current revisions', async t => {
  const f = await launcher(); t.after(f.renderer.dispose)
  f.click('Edit shortcuts'); f.failNext()
  const p = pointer(f)
  p.down(); p.move(); p.up(); await flush()
  assert.deepEqual(f.order(), ['a', 'b', 'c'])
  assert.deepEqual(f.saved(), initial)
  assert.equal(f.read().find(node => node.props.role === 'alert')?.props.children, 'Order could not be saved')
  const key = (id: string, name: string, altKey = true) => f.tile(id).props.onKeyDown({ key: name, altKey, preventDefault() {} })
  key('a', 'ArrowLeft'); key('a', 'ArrowRight', false)
  assert.equal(f.calls.length, 3, 'failed saves refresh persisted order; boundaries and unmodified keys must not save')
  key('a', 'ArrowRight'); await flush()
  assert.deepEqual(f.order(), ['b', 'a', 'c'])
  key('a', 'ArrowRight'); await flush()
  assert.deepEqual(f.order(), ['b', 'c', 'a'])
  assert.equal(f.calls[4].payload.apps.find((app: any) => app.id === 'a').expectedRevision, 2)
  f.click('Done'); key('a', 'ArrowLeft')
  assert.equal(f.calls.length, 5)
})

test('partial legacy saves reload the actual order and revisions before another drag', async t => {
  const f = await launcher(true, true); t.after(f.renderer.dispose)
  f.click('Edit shortcuts'); f.failAtUpsert(2)
  const p = pointer(f)
  p.down(); p.move(); p.up(); await flush()
  assert.equal(f.saved().find(app => app.id === 'b')?.revision, 2, 'the first legacy save completed')
  assert.deepEqual(f.order(), f.saved().map(app => app.id))
  assert.ok(f.read().some(node => node.props.role === 'alert'))
  assert.equal(f.calls.at(-1)?.endpoint, 'quickApps/list')
  p.down(); p.move(); p.up(); await flush()
  assert.deepEqual(f.order(), ['b', 'c', 'a'])
  assert.deepEqual(f.saved().map(app => app.id), ['b', 'c', 'a'])
  assert.equal(f.read().some(node => node.props.role === 'alert'), false)
})

test('grid movement animates complete shortcuts, retargets smoothly and respects reduced motion', () => {
  let reducedMotion = false
  const nodes = [0, 64].map(left => {
    const node = { offsetLeft: left, offsetTop: 0, shift: 0, canceled: 0, calls: [] as { frames: Keyframe[]; options: KeyframeAnimationOptions }[],
      getBoundingClientRect() { return { left: this.offsetLeft + this.shift, top: this.offsetTop } },
      animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
        this.calls.push({ frames, options })
        return { finished: new Promise<void>(() => {}), cancel: () => { this.shift = 0; this.canceled++ } }
      },
    }
    return node
  })
  const root = { ownerDocument: { defaultView: { matchMedia: () => ({ matches: reducedMotion }) } }, querySelectorAll: () => nodes } as unknown as HTMLElement
  const animation = createQuickAppReorderAnimation()
  animation.update(root)
  nodes[0].offsetLeft = 64; nodes[1].offsetLeft = 0
  animation.update(root)
  assert.deepEqual(nodes.map(node => node.calls[0].frames), [
    [{ transform: 'translate(-64px, 0px)' }, { transform: 'translate(0, 0)' }],
    [{ transform: 'translate(64px, 0px)' }, { transform: 'translate(0, 0)' }],
  ])
  assert.equal(nodes[0].calls[0].options.duration, 220)
  nodes[0].shift = -32
  nodes[0].offsetLeft = 0; nodes[1].offsetLeft = 64
  animation.update(root)
  assert.equal(nodes[0].calls[1].frames[0].transform, 'translate(32px, 0px)', 'a new move starts from the current visual position')
  reducedMotion = true
  nodes[0].offsetTop = 60
  animation.update(root)
  assert.equal(nodes[0].calls.length, 2, 'reduced motion disables position animation')
  assert.equal(nodes[0].canceled, 2)
  animation.dispose()
})
