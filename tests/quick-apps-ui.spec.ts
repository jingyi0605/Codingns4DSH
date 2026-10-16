import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { QuickAppsLauncher } from '../src/client/quick-apps/launcher.js'
import { DshInput, DshModal } from '../src/dsh-capabilities/client/primitives-adapter.js'
import { en, zh } from '../src/client/locales/quickApps.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { quickAppFixture, definition } from './quick-apps-fixture.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { QuickAppField } from '../src/client/quick-apps/ui.js'
import { shortcutIcon, entryTitle } from '../src/client/quick-apps/presentation.js'
import { QuickAppWorkspacePicker } from '../src/client/quick-apps/workspace-picker.js'
import { QuickAppViewer } from '../src/client/quick-apps/viewer.js'

function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<{ children?: ReactNode; footer?: ReactNode }>(node) ? [node, ...Children.toArray(node.props.children).flatMap(elements), ...Children.toArray(node.props.footer).flatMap(elements)] : []
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('native HTML viewer uses the Host sandbox without exposing the launch address', t => {
  const app = { ...definition, id: 'app', revision: 1 }
  const renderer = createHookRenderer(QuickAppViewer, { app, view: { kind: 'html', url: 'http://dsh.test/__codingns/quick-apps/secret/index.html', origin: 'http://dsh.test', launchId: 'launch', expiresAt: Date.now() + 1000, isolation: 'sandbox-proxy' }, busy: false,
    t: (key: keyof typeof en) => en[key], onClose() {}, onReload() {} } as never)
  t.after(renderer.dispose)
  const tree = elements(renderer.render())
  assert.equal(tree.find(item => item.type === 'iframe')?.props.sandbox, 'allow-scripts allow-forms allow-downloads')
  assert.equal(tree.find(item => item.props.className === 'qa-view-address')?.props.value, app.entryPath)
  assert.ok(tree.some(item => item.props.children === en['quickApps.sandboxPreview']))
})

test('shortcut icons and inferred names follow the parent launcher', () => {
  assert.equal(shortcutIcon({ title: '会员管理', entryPath: 'site/index.html', kind: 'html' }).text, '会员')
  assert.equal(shortcutIcon({ title: 'Project Notes', entryPath: 'notes.md', kind: 'text' }).text, 'PN')
  assert.equal(entryTitle('apps/calendar/index.html'), 'calendar')
  assert.equal(entryTitle('notes/readme.md'), 'readme')
})

test('inline launcher ignores a previous connection list response after its client changes', async t => {
  const pending: ((value: unknown) => void)[] = []
  const services = {
    locale: { bind: () => (key: keyof typeof en) => en[key] ?? key, subscribe: () => () => {}, getSnapshot: () => ({ revision: 0 }) },
    rpc: { call: async () => new Promise(resolve => pending.push(resolve)) },
  }
  const renderer = createHookRenderer(QuickAppsLauncher, { services: services as never, wide: true }); t.after(renderer.dispose)
  const read = () => elements(renderer.render())
  read(); await flush()
  renderer.render({ services: { ...services, rpc: { ...services.rpc } } as never, wide: true }); await flush()
  pending[1]({ ok: true, value: [{ ...definition, id: 'new', title: 'Current shortcut', revision: 1, availability: 'available' }] })
  await flush()
  pending[0]({ ok: true, value: [{ ...definition, id: 'old', title: 'Old shortcut', revision: 1, availability: 'available' }] })
  await flush()
  assert.deepEqual(read().filter(element => element.type === 'strong').map(element => element.props.children), ['Current shortcut'])
  assert.equal(read().some(element => element.type === DshModal), false)
})

test('inline launcher exposes an initial load error and retry without opening a dialog', async t => {
  let attempts = 0
  const services = {
    locale: { bind: () => (key: keyof typeof en) => en[key] ?? key, subscribe: () => () => {}, getSnapshot: () => ({ revision: 0 }) },
    rpc: { call: async () => ++attempts === 1 ? { ok: false, error: { message: 'Offline' } } : { ok: true, value: [] } },
  }
  const renderer = createHookRenderer(QuickAppsLauncher, { services: services as never, wide: true }); t.after(renderer.dispose)
  const read = () => elements(renderer.render())
  read(); await flush()
  assert.equal(read().find(element => element.props.role === 'alert')?.props.children, 'Offline')
  read().find(element => element.props['aria-label'] === 'Try again')!.props.onClick(); await flush()
  assert.equal(attempts, 2)
  assert.equal(read().some(element => element.props.role === 'alert' || element.type === DshModal), false)
  assert.ok(read().some(element => element.props.children === en['quickApps.empty']))
})

test('editing keeps launch separate and changing workspace resets paths without losing Host identity', async t => {
  const calls: { endpoint: string; payload: any }[] = []
  const app = { ...definition, id: 'app', revision: 4, availability: 'available' }
  const services = {
    locale: { bind: () => (key: keyof typeof en) => en[key] ?? key, subscribe: () => () => {}, getSnapshot: () => ({ revision: 0 }) },
    uiContext: { get: () => ({ list: { getSnapshot: () => ({ items: [
      { workspaceId: 'workspace-a', title: 'Local' }, { workspaceId: 'workspace-a', hostId: 'peer-a', title: 'Remote' },
    ] }), subscribe: () => () => {} } }) },
    rpc: { call: async (_channel: string, endpoint: string, payload: any) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: endpoint.endsWith('/list') ? [app] : { ...payload.app, revision: 5 } }
    } },
  }
  const renderer = createHookRenderer(QuickAppsLauncher, { services: services as never, wide: true }); t.after(renderer.dispose)
  const read = () => elements(renderer.render())
  const click = (label: string) => read().find(element => element.props['aria-label'] === label)!.props.onClick()
  const input = (label: string) => elements(read().find(element => element.type === QuickAppField && element.props.label === label)!.props.children).find(element => element.type === DshInput)!
  read(); await flush()
  click('Edit shortcuts')
  read().find(element => element.props.className === 'qa-tile')!.props.onClick()
  assert.ok(read().some(element => element.type === 'form'))
  assert.deepEqual(calls.map(call => call.endpoint), ['quickApps/list'])
  const picker = read().find(element => element.type === QuickAppWorkspacePicker)!
  picker.props.onSelect(picker.props.workspaces[1])
  assert.equal(input('Entry file').props.value, '')
  assert.equal(input('Application folder').props.value, '')
  read().find(element => element.type === 'form')!.props.onSubmit({ preventDefault() {} }); await flush()
  assert.equal(calls.length, 1, 'empty paths must not be submitted')
  input('Entry file').props.onChange({ target: { value: 'index.html' } })
  read().find(element => element.type === 'form')!.props.onSubmit({ preventDefault() {} }); await flush()
  const saved = calls.find(call => call.endpoint.endsWith('/upsert'))!.payload
  assert.equal(saved.app.hostId, 'peer-a')
  assert.equal(saved.app.workspaceId, 'workspace-a')
  assert.equal(saved.app.fileAccess, 'workspace')
  assert.equal(saved.expectedRevision, 4)
})

test('launcher opens sessionless text and explains unavailable HTML on click', async t => {
  const calls: { endpoint: string; payload: any }[] = []
  const text = { ...definition, id: 'text', kind: 'text', revision: 1, availability: 'available' }
  const services = {
    locale: { bind: () => (key: keyof typeof en) => en[key] ?? key, subscribe: () => () => undefined, getSnapshot: () => ({ revision: 0 }) },
    rpc: { call: async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: endpoint === 'quickApps/list' ? [text, { ...definition, id: 'html', revision: 1, availability: 'unsupported-runtime', runtimeReason: 'not-configured' }]
        : { kind: 'text', title: 'Document', content: '<script>must remain text</script>' } }
    } },
  }
  const renderer = createHookRenderer(QuickAppsLauncher, { services: services as never, wide: false }); t.after(renderer.dispose)
  const read = () => elements(renderer.render())
  read(); await flush()
  assert.deepEqual(calls.map(call => call.endpoint), ['quickApps/list'])
  assert.equal(read().some(element => element.type === DshModal), false)
  const open = read().filter(element => element.props.className === 'qa-tile')
  assert.equal(open.length, 2); assert.equal(open[1].props.disabled, false)
  open[1].props.onClick()
  assert.equal(read().find(element => element.props.role === 'alert')!.props.title, en['quickApps.runtime.not-configured'])
  assert.equal(calls.length, 1, 'unavailable tiles explain their status without attempting a launch')
  open[0].props.onClick(); await flush()
  const viewer = read().find(element => element.type === QuickAppViewer)!
  const document = createHookRenderer(QuickAppViewer, viewer.props); t.after(document.dispose)
  assert.equal(elements(document.render()).find(element => element.type === 'pre')?.props.children, '<script>must remain text</script>')
  assert.equal(read().some(element => element.type === 'iframe' || element.type === 'script'), false)
  assert.deepEqual(calls.at(-1)?.payload, { id: 'text' })
  viewer.props.onReload(); await flush()
  assert.deepEqual(calls.map(call => call.endpoint), ['quickApps/list', 'quickApps/launch', 'quickApps/launch'])
  viewer.props.onClose()
  assert.equal(read().some(element => element.type === DshModal), false)
  assert.equal(read().filter(element => element.props.className === 'qa-tile').length, 2)
})

test('native-style viewer controls keep text literal and HTML launch credentials out of the address field', t => {
  let reloaded = 0; let closed = 0
  const common = { app: { ...definition, id: 'app', revision: 1 }, busy: false, t: (key: keyof typeof en) => en[key],
    onClose: () => { closed++ }, onReload: () => { reloaded++ } }
  const text = createHookRenderer(QuickAppViewer, { ...common, view: { kind: 'text', title: 'Notes', content: '<script>literal</script>' } } as never)
  t.after(text.dispose)
  const readText = () => elements(text.render())
  assert.equal(readText().find(node => node.props.className === 'qa-view-text-body')!.props['data-wrap'], true)
  readText().find(node => node.props['aria-label'] === 'Wrap text')!.props.onClick()
  assert.equal(readText().find(node => node.props.className === 'qa-view-text-body')!.props['data-wrap'], false)
  assert.equal(readText().find(node => node.type === 'pre')!.props.children, '<script>literal</script>')
  readText().find(node => node.props['aria-label'] === 'Reload')!.props.onClick()
  const html = createHookRenderer(QuickAppViewer, { ...common, view: { kind: 'html', launchId: 'launch-a', expiresAt: 1, origin: 'https://app.test', url: 'https://app.test/__quickapp/start#secret' } } as never)
  t.after(html.dispose)
  const nodes = elements(html.render())
  const address = nodes.find(node => node.type === 'input')!
  assert.equal(address.props.readOnly, true)
  assert.equal(address.props.value, 'https://app.test/index.html')
  assert.equal(address.props.title.includes('secret'), false)
  const frame = nodes.find(node => node.type === 'iframe')!
  assert.equal(frame.props.src, 'https://app.test/__quickapp/start#secret')
  assert.equal(frame.props.referrerPolicy, 'no-referrer')
  assert.equal(frame.props.sandbox, 'allow-scripts allow-same-origin allow-forms allow-downloads')
  nodes.find(node => node.props['aria-label'] === 'Back to shortcuts')!.props.onClick()
  assert.equal(reloaded, 1); assert.equal(closed, 1)
})

test('shortcut form preserves Host/workspace identity and leaves failed edits available for retry', async t => {
  const calls: any[] = []
  const services = {
    locale: { bind: () => (key: keyof typeof en) => en[key] ?? key, subscribe: () => () => undefined, getSnapshot: () => ({ revision: 0 }) },
    uiContext: { get: () => ({ list: { getSnapshot: () => ({ items: [{ workspaceId: 'peer:workspace', hostId: 'owning-peer', title: 'Remote project' }] }), subscribe: () => () => undefined } }) },
    rpc: { call: async (_channel: string, endpoint: string, payload: any) => {
      calls.push({ endpoint, payload })
      return endpoint === 'quickApps/list' ? { ok: true, value: [] } : { ok: false, error: { code: 'QUICK_APP_HOST_UNAVAILABLE', message: 'Host unavailable' } }
    } },
  }
  const renderer = createHookRenderer(QuickAppsLauncher, { services: services as never, wide: true }); t.after(renderer.dispose)
  const read = () => elements(renderer.render())
  read(); await flush()
  read().find(element => element.props['aria-label'] === 'Add shortcut')!.props.onClick()
  const input = (label: string) => elements(read().find(element => element.type === QuickAppField && element.props.label === label)!.props.children).find(element => element.type === DshInput)!
  input('Title').props.onChange({ target: { value: 'My app' } })
  input('Entry file').props.onChange({ target: { value: 'site/index.html' } })
  read().find(element => element.type === 'form')!.props.onSubmit({ preventDefault() {} }); await flush()
  assert.equal(calls.at(-1).payload.app.hostId, 'owning-peer')
  assert.equal(calls.at(-1).payload.app.workspaceId, 'peer:workspace')
  assert.equal(input('Title').props.value, 'My app')
  assert.ok(read().some(element => element.props.role === 'alert'))
})

test('shortcut settings survive schema serialization without launch secrets and dictionaries match', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const settings = CodingNsSettingsSchema({ quickApps: [f.app] } as never)
  const reloaded = CodingNsSettingsSchema(JSON.parse(JSON.stringify(settings)))
  assert.deepEqual(reloaded.quickApps, [f.app])
  assert.equal(JSON.stringify(reloaded.quickApps).includes('credential'), false)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})
