import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createWorkspaceDirectoryBrowser } from '../src/dsh-capabilities/host/workspace-directory-adapter.js'
import { browseQuickAppDirectory } from '../src/host/modules/quick-apps/browse.js'
import { QuickAppWorkspacePicker, workspaceChoiceId } from '../src/client/quick-apps/workspace-picker.js'
import { QuickAppFilePicker } from '../src/client/quick-apps/file-picker.js'
import { QuickAppButton } from '../src/client/quick-apps/ui.js'
import { DshMenu } from '../src/dsh-capabilities/client/primitives-adapter.js'
import { QuickAppsClient } from '../src/client/quick-apps/client.js'
import { en } from '../src/client/locales/quickApps.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { quickAppFixture } from './quick-apps-fixture.js'
import { fixtureWorkspaceDirectoryBrowser } from './fixtures/quick-app-directory.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { Context } from '@deepseek-ai/cordis'
import { createCodingNsRpcHandler, registerCodingNsRpc } from '../src/host/rpc.js'

const translate = (key: string) => en[key as keyof typeof en] ?? key
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<any>(node) ? [node, ...Children.toArray(node.props.children).flatMap(elements), ...Children.toArray(node.props.footer).flatMap(elements)] : []
}

test('native directory capability is explicit across required versions and preserves service binding without a session', async () => {
  const calls: unknown[][] = []
  const context = { workspaceFiles: { list(...args: unknown[]) { assert.equal(this, context.workspaceFiles); calls.push(args); return Promise.resolve({ entries: [], truncated: false }) } } }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.1-alpha.3']) {
    const profile = createDshCapabilityRegistry(version, 'host', context).getProfile(context)
    const capability = profile.capabilities.get('workspace.directory-list')!
    assert.equal(capability.status, version === '0.2.1-alpha.3' ? 'ready' : 'unavailable')
    if (capability.status !== 'ready') assert.ok(profile.diagnostics.some(item => item.capability === 'workspace.directory-list'))
  }
  assert.equal(createDshCapabilityRegistry('0.2.1-alpha.3', 'host', {}).getProfile({}).capabilities.get('workspace.directory-list')?.status, 'unavailable')
  await createWorkspaceDirectoryBrowser(context).list('/verified/root', '', new AbortController().signal)
  assert.deepEqual(calls[0]?.slice(0, 2), [{ workspaceRoot: '/verified/root' }, '.'])
})

test('directory capability reads a real Cordis service outside its injection chain and stops using disposed services', async t => {
  const app = new Context()
  const calls: unknown[][] = []
  const native = { list(...args: unknown[]) { calls.push(args); return Promise.resolve({ entries: [], truncated: false }) } }
  const provider = await app.plugin(ctx => { ctx.provide('workspaceFiles', native) })
  t.after(() => provider.dispose())
  let probe!: Context
  const consumer = await app.plugin(ctx => { probe = ctx })
  t.after(() => consumer.dispose())
  assert.throws(() => Reflect.get(probe, 'workspaceFiles'), /without inject/u)
  const capability = createDshCapabilityRegistry('0.2.1-alpha.3', 'host', probe).getProfile(probe).capabilities.get('workspace.directory-list')!
  assert.equal(capability.status, 'ready')
  const browser = capability.value as ReturnType<typeof createWorkspaceDirectoryBrowser>
  const signal = new AbortController().signal
  await browser.list('/verified/root', '', signal)
  assert.deepEqual(calls[0]?.slice(0, 2), [{ workspaceRoot: '/verified/root' }, '.'])
  await provider.dispose()
  await assert.rejects(browser.list('/verified/root', '', signal), { code: 'QUICK_APP_BROWSE_UNAVAILABLE' })
  assert.equal(calls.length, 1)
})

test('registered browse RPC lists a workspace before any shortcut exists and rejects unknown operations before lookup', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const rpc = new CodingNsRpcTable()
  const modules = new FeatureRegistry({ rpc, resolveManagedWorkspaceRoot: f.registry.workspaceRoot,
    settings: { get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, quickApps: [] }), update: async () => { assert.fail('browsing must not save a shortcut') } },
    workspaceDirectoryBrowser: fixtureWorkspaceDirectoryBrowser() })
  modules.register(createQuickAppsFeature()); await modules.start('quickApps'); t.after(() => modules.disable('quickApps'))
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let dispose!: () => Promise<void>
  registerCodingNsRpc({
    effect(factory: () => () => Promise<void>) { dispose = factory() },
    webServer: { register: () => () => {} },
    connection: { browserPeer: { id: 'browser-owner' }, admit: () => ({ peer: { id: 'browser-owner', principal: { kind: 'owner' } } }),
      fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
        routes.set(route.path, route.fetch); return () => { routes.delete(route.path) }
      } } },
  } as never, rpc)
  t.after(() => dispose())
  const payload = { hostId: 'local', workspaceId: 'workspace-a', path: 'site' }
  const handler = createCodingNsRpcHandler(rpc)
  const channelClient = new QuickAppsClient({ call: async (_channel: string, endpoint: string, input: unknown) => handler(endpoint, input, new AbortController().signal, { id: 'browser-owner' }) } as never)
  const expected = await channelClient.call('browse', payload)
  for (const [endpoint, input] of [['quickApps/browse', payload], ['quickApps/remote', { action: 'browse', workspaceId: 'workspace-a', path: 'site' }]] as const) {
    const route = routes.get(`/api/codingns/${endpoint}`)
    assert.ok(route, 'the exact browser and PeerHost routes must be registered')
    const response = await route(new Request(`https://fixture.test/api/codingns/${endpoint}`, { method: 'POST',
      body: JSON.stringify({ rpcId: 'browse-test', method: endpoint, payload: input }) }))
    assert.equal(response.status, 200)
    const envelope = await response.json() as any
    assert.equal(envelope.result.ok, true)
    assert.deepEqual(envelope.result.value, expected)
    assert.ok(envelope.result.value.entries.some((entry: any) => entry.name === '空 格.txt'))
  }
  await assert.rejects(channelClient.call('unknown-operation'), { code: 'CODINGNS_RPC_NOT_FOUND' })
  await assert.rejects(channelClient.call('launch', { id: 'missing' }), { code: 'QUICK_APP_UNAVAILABLE' })
})

test('directory browsing uses the exact managed root and rejects escapes and private entries', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  await writeFile(join(f.root, 'site/.secret'), 'private')
  await symlink(join(f.root, 'data'), join(f.root, 'site/link'))
  const signal = new AbortController().signal
  const browser = fixtureWorkspaceDirectoryBrowser()
  const list = (workspace: string, path: string) => browseQuickAppDirectory(f.registry.workspaceRoot, browser, workspace, path, signal)
  const result = await list('workspace-a', 'site')
  assert.ok(result.entries.some(entry => entry.path === 'site/空 格.txt'))
  assert.ok(result.entries.some(entry => entry.kind === 'directory'))
  assert.equal(result.entries.some(entry => entry.name === '.secret' || entry.name === 'link'), false)
  await assert.rejects(list('unknown', ''), { code: 'QUICK_APP_WORKSPACE_UNAVAILABLE' })
  for (const path of ['../data', '/etc', 'site/%2e%2e', 'site/.secret', 'site/link', 'site\\folder']) await assert.rejects(list('workspace-a', path), { code: 'QUICK_APP_ACCESS_DENIED' })
  await assert.rejects(browseQuickAppDirectory(f.registry.workspaceRoot, undefined, 'workspace-a', '', signal), { code: 'QUICK_APP_BROWSE_UNAVAILABLE' })
})

test('browsing bounds entries and refuses a removed workspace or an aborted request before returning', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  let root: string | null = f.root
  const workspaceRoot = () => root
  const entries = Array.from({ length: 1001 }, (_, i) => ({ name: `file-${i}.txt`, type: 'file' }))
  const browser = { list: async () => ({ entries, truncated: false }) }
  const signal = new AbortController().signal
  const result = await browseQuickAppDirectory(workspaceRoot, browser, 'workspace-a', '', signal)
  assert.equal(result.entries.length, 1000); assert.equal(result.truncated, true)
  await assert.rejects(browseQuickAppDirectory(workspaceRoot, { list: async () => { root = null; return { entries: [], truncated: false } } }, 'workspace-a', '', signal), { code: 'QUICK_APP_ACCESS_DENIED' })
  root = f.root
  const abort = new AbortController(); abort.abort()
  await assert.rejects(browseQuickAppDirectory(workspaceRoot, browser, 'workspace-a', '', abort.signal), { name: 'AbortError' })
})

test('browsing requires authenticated management and module disposal aborts its pending native listing', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const rpc = new CodingNsRpcTable()
  let started!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  const modules = new FeatureRegistry({ rpc, resolveManagedWorkspaceRoot: f.registry.workspaceRoot,
    settings: { get: () => DEFAULT_CODINGNS_SETTINGS, update: async () => {} },
    workspaceDirectoryBrowser: { list: async (_root: string, _path: string, signal: AbortSignal) => {
      started()
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } } })
  modules.register(createQuickAppsFeature()); await modules.start('quickApps'); t.after(() => modules.disable('quickApps'))
  const route = rpc.resolve('quickApps/browse')!
  const input = { hostId: 'local', workspaceId: 'workspace-a', path: '', workspaceRoot: '/ignored' }
  await assert.rejects(route.handler('browse', input, {}), { code: 'QUICK_APP_PRINCIPAL_UNAVAILABLE' })
  const listing = route.handler('browse', input, { peer: { id: 'owner' } })
  const rejected = assert.rejects(listing, { name: 'AbortError' })
  await pending; await modules.disable('quickApps'); await rejected
  assert.equal(rpc.resolve('quickApps/browse'), null)
})

test('native workspace menu keeps Host identity when items reorder or share a workspace id', () => {
  const local = { workspaceId: 'same', title: 'Local', sessionIds: [] }
  const remote = { workspaceId: 'same', title: 'Remote', hostId: 'peer', sessionIds: [] }
  let selected: unknown
  const props = { workspaces: [local, remote], hostId: 'local', workspaceId: 'same', disabled: false, t: translate as never, onSelect: (value: unknown) => { selected = value } }
  const renderer = createHookRenderer(QuickAppWorkspacePicker, props)
  try {
    const initial = elements(renderer.render()).find(element => element.type === DshMenu)!
    assert.notEqual(initial.props.items[0].id, initial.props.items[1].id)
    const menu = elements(renderer.render({ ...props, workspaces: [remote, local] })).find(element => element.type === DshMenu)!
    menu.props.onSelect(workspaceChoiceId(remote)); assert.deepEqual(selected, remote)
  } finally { renderer.dispose() }
})

test('file picker ignores stale Host responses and confirms only a listed file', async t => {
  const pending: { payload: any; resolve(value: unknown): void }[] = []
  const client = new QuickAppsClient({ call: async (_channel: string, _endpoint: string, payload: unknown) => new Promise(resolve => pending.push({ payload, resolve })) } as never)
  let selected = ''
  const props = { client, workspace: { workspaceId: 'same', hostId: 'old', title: 'Workspace', sessionIds: [] }, value: '', t: translate as never, onClose() {}, onSelect(path: string) { selected = path } }
  const renderer = createHookRenderer(QuickAppFilePicker, props); t.after(renderer.dispose)
  renderer.render(); await flush()
  renderer.render({ ...props, workspace: { ...props.workspace, hostId: 'new' } }); await flush()
  assert.equal(pending[1].payload.hostId, 'new')
  pending[1].resolve({ ok: true, value: { path: '', entries: [{ name: 'current.txt', path: 'current.txt', kind: 'file' }], truncated: false } }); await flush()
  pending[0].resolve({ ok: true, value: { path: '', entries: [{ name: 'old.txt', path: 'old.txt', kind: 'file' }], truncated: false } }); await flush()
  const read = () => elements(renderer.render())
  assert.equal(read().filter(element => element.props.className === 'qa-file-row').length, 1)
  read().find(element => element.props.className === 'qa-file-row')!.props.onClick()
  read().find(element => element.type === QuickAppButton && element.props.children === 'Use this file')!.props.onClick()
  assert.equal(selected, 'current.txt')
})

test('file picker reports unavailable browsing, retries explicitly and leaves cancellation to the owner', async t => {
  let attempts = 0; let closed = false; let selected = false
  const client = new QuickAppsClient({ call: async () => ++attempts === 1
    ? { ok: false, error: { code: 'QUICK_APP_BROWSE_UNAVAILABLE', message: 'Unavailable' } }
    : { ok: true, value: { path: '', entries: [], truncated: false } } } as never)
  const renderer = createHookRenderer(QuickAppFilePicker, { client, workspace: { workspaceId: 'workspace-a', title: 'Workspace', sessionIds: [] }, value: '', t: translate as never,
    onClose() { closed = true }, onSelect() { selected = true } }); t.after(renderer.dispose)
  const read = () => elements(renderer.render())
  read(); await flush()
  assert.equal(read().find(element => element.props.role === 'alert')?.props.children, en['quickApps.browseUnavailable'])
  read().find(element => element.type === 'button' && element.props['aria-label'] === 'Refresh')!.props.onClick(); read(); await flush()
  assert.equal(attempts, 2)
  assert.equal(read().some(element => element.props.role === 'alert'), false)
  assert.equal(read().find(element => element.type === QuickAppButton && element.props.children === 'Use this file')!.props.disabled, true)
  read().find(element => element.type === QuickAppButton && element.props.children === 'Cancel')!.props.onClick()
  assert.equal(closed, true); assert.equal(selected, false)
})

test('file picker distinguishes an older Host handler from a missing workspace', async t => {
  for (const [code, message, expected] of [
    ['QUICK_APP_UNAVAILABLE', 'The shortcut no longer exists.', en['quickApps.browseHostUpdateRequired']],
    ['CODINGNS_RPC_NOT_FOUND', 'Unknown Quick Apps operation.', en['quickApps.browseHostUpdateRequired']],
    ['QUICK_APP_WORKSPACE_UNAVAILABLE', 'The exact workspace is unavailable.', 'The exact workspace is unavailable.'],
  ]) {
    const client = new QuickAppsClient({ call: async () => ({ ok: false, error: { code, message } }) } as never)
    const renderer = createHookRenderer(QuickAppFilePicker, { client, workspace: { workspaceId: 'workspace-a', title: 'Workspace', sessionIds: [] }, value: '', t: translate as never,
      onClose() {}, onSelect() { assert.fail('a failed listing must not select a file') } }); t.after(renderer.dispose)
    renderer.render(); await flush()
    const nodes = elements(renderer.render())
    assert.equal(nodes.find(element => element.props.role === 'alert')?.props.children, expected)
    assert.equal(nodes.find(element => element.type === QuickAppButton && element.props.children === 'Use this file')!.props.disabled, true)
    assert.equal(nodes.some(element => element.props.className === 'qa-file-row'), false)
  }
})
