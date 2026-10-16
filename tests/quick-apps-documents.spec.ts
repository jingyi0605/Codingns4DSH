import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Children, isValidElement, type ReactNode, type ReactElement } from 'react'
import { definition, quickAppFixture } from './quick-apps-fixture.js'
import { serializeWorkspaceMutation } from '../src/host/workspace-file-mutations.js'
import { QuickAppRemoteOwner, QuickAppRemoteController } from '../src/host/modules/quick-apps/remote.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { QuickAppsClient } from '../src/client/quick-apps/client.js'
import { documentPath, QuickAppEditor, QuickAppMarkdown } from '../src/client/quick-apps/document.js'
import { QuickAppViewer } from '../src/client/quick-apps/viewer.js'
import { DshModal, DshMenu, hasNativeMarkdown } from '../src/dsh-capabilities/client/primitives-adapter.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { en } from '../src/client/locales/quickApps.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { registerCodingNsRpc } from '../src/host/rpc.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'

async function documentFixture() {
  const f = await quickAppFixture()
  const app = await f.registry.upsert({ ...definition, kind: 'text', entryPath: 'site/空 格.txt' }, 0)
  const launch = await f.service.launch(app.id, 'owner') as any
  const call = (operation: string, extra: Record<string, unknown> = {}, principal = 'owner') => f.service.documents.handle(launch.launchId, principal, { operation, ...extra }) as Promise<any>
  return { ...f, app, launch, call }
}

test('registered native Fetch routes launch, authorize, save and close sessionless documents', async t => {
  const f = await documentFixture(); t.after(f.dispose)
  const rpc = new CodingNsRpcTable()
  const modules = new FeatureRegistry({ rpc, resolveManagedWorkspaceRoot: f.registry.workspaceRoot,
    settings: { get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, quickApps: [f.app] }), update: async () => {} } })
  modules.register(createQuickAppsFeature()); await modules.start('quickApps'); t.after(() => modules.disable('quickApps'))
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let dispose!: () => Promise<void>
  let principal = 'owner'
  registerCodingNsRpc({ effect(factory: () => () => Promise<void>) { dispose = factory() },
    webServer: { register: () => () => {} },
    connection: { browserPeer: { id: principal }, admit: () => ({ peer: { id: principal, principal: { kind: 'owner' } } }),
      fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
        routes.set(route.path, route.fetch); return () => { routes.delete(route.path) }
      } } },
  } as never, rpc)
  t.after(() => dispose())
  const call = async (action: string, payload: unknown) => {
    const method = `quickApps/${action}`
    const path = `/api/codingns/${method}`
    const route = routes.get(path); assert.ok(route, `${path} must be registered`)
    const response = await route(new Request(`https://fixture.test${path}`, { method: 'POST', body: JSON.stringify({ rpcId: 'document-test', method, payload }) }))
    assert.equal(response.status, 200)
    return (await response.json() as any).result
  }
  const opened = await call('launch', { id: f.app.id })
  assert.equal(opened.ok, true); assert.equal(opened.value.canWrite, false)
  const id = opened.value.launchId
  principal = 'another-owner'
  assert.equal((await call('document', { id, operation: 'read' })).error.code, 'QUICK_APP_ACCESS_DENIED')
  principal = 'owner'
  assert.equal((await call('document', { id, operation: 'allow-edit' })).ok, true)
  assert.equal((await call('document', { id, operation: 'save', version: opened.value.version, content: '# Native route' })).ok, true)
  assert.equal(await readFile(join(f.root, f.app.entryPath), 'utf8'), '# Native route')
  assert.equal((await call('close', { id })).ok, true)
  assert.equal((await call('document', { id, operation: 'read' })).error.code, 'QUICK_APP_ACCESS_DENIED')
})

test('sessionless document edits require explicit exact-file approval and a current version', async t => {
  const f = await documentFixture(); t.after(f.dispose)
  assert.equal(f.launch.canWrite, false)
  await assert.rejects(f.call('save', { content: 'no grant', version: f.launch.version }), { code: 'QUICK_APP_ACCESS_DENIED' })
  await assert.rejects(f.call('allow-edit', {}, 'another-owner'), { code: 'QUICK_APP_ACCESS_DENIED' })
  await f.call('allow-edit')
  assert.equal((await f.call('read')).canWrite, true)
  await assert.rejects(f.call('save', { content: 'no version' }), { code: 'QUICK_APP_PRECONDITION_REQUIRED' })
  await assert.rejects(f.call('save', { content: '\ud800', version: f.launch.version }), { code: 'QUICK_APP_ACCESS_DENIED' })
  const saved = await f.call('save', { content: '# Saved\n', version: f.launch.version, hostId: 'elsewhere', workspaceId: 'unmanaged' })
  assert.equal(await readFile(join(f.root, f.app.entryPath), 'utf8'), '# Saved\n')
  await assert.rejects(f.call('save', { content: 'stale', version: f.launch.version }), { code: 'QUICK_APP_CONFLICT' })
  await assert.rejects(f.call('save', { path: 'site/data.json', content: 'other', version: saved.version }), { code: 'QUICK_APP_ACCESS_DENIED' })
  await assert.rejects(f.call('save', { path: 'site/new.txt', content: 'create', version: saved.version }), { code: 'QUICK_APP_ACCESS_DENIED' })
  await assert.rejects(f.call('delete'), { code: 'CODINGNS_RPC_NOT_FOUND' })
  const second = await f.service.launch(f.app.id, 'owner') as any
  assert.equal(second.canWrite, false, 'write approval belongs only to the current viewer')
  await f.service.invalidate(f.app.id)
  await assert.rejects(f.call('read'), { code: 'QUICK_APP_ACCESS_DENIED' })
})

test('document reads/images reject traversal, secrets, symlinks, other roots and HTML launch identities', async t => {
  const f = await documentFixture(); t.after(f.dispose)
  for (const path of ['../data/member.json', 'site/../data/member.json', 'site/%2e%2e/x', 'data/member.json', 'site/.env']) {
    await assert.rejects(f.call('read', { path }), { code: 'QUICK_APP_ACCESS_DENIED' }, path)
  }
  await symlink(join(f.root, 'data/member.json'), join(f.root, 'site/link.txt'))
  await assert.rejects(f.call('read', { path: 'site/link.txt' }), { code: 'QUICK_APP_ACCESS_DENIED' })
  const image = await f.call('image', { path: 'site/assets/pixel.png' })
  assert.equal(image.url, `data:image/png;base64,${(await readFile(join(f.root, 'site/assets/pixel.png'))).toString('base64')}`)
  await assert.rejects(f.call('image', { path: 'site/index.html' }), { code: 'QUICK_APP_ACCESS_DENIED' })
  await writeFile(join(f.root, 'site/large.png'), Buffer.alloc(2 * 1024 * 1024 + 1))
  await assert.rejects(f.call('image', { path: 'site/large.png' }), { code: 'QUICK_APP_TOO_LARGE' })
  const html = await f.service.launch(f.registry.list().find(app => app.kind === 'html')!.id, 'browser-owner') as any
  await assert.rejects(f.service.documents.handle(html.launchId, 'browser-owner', { operation: 'allow-edit', path: 'site/index.html' }), { code: 'QUICK_APP_ACCESS_DENIED' })
})

test('queued document saves recheck revocation and replaced ancestors before changing bytes', async t => {
  for (const replace of [false, true]) {
    const f = await documentFixture(); t.after(f.dispose)
    await f.call('allow-edit')
    let release!: () => void
    const held = serializeWorkspaceMutation(join(f.root, f.app.entryPath), () => new Promise<void>(resolve => { release = resolve }))
    await new Promise(resolve => setImmediate(resolve))
    const saving = f.call('save', { content: 'queued', version: f.launch.version })
    const rejected = assert.rejects(saving)
    for (let attempt = 0; attempt < 100 && !f.service.files.pending; attempt++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(f.service.files.pending, 1)
    if (replace) { await rename(join(f.root, 'site'), join(f.root, 'original')); await symlink(join(f.root, 'original'), join(f.root, 'site')) }
    else await f.service.invalidate(f.app.id)
    release(); await held; await rejected
    assert.equal(await readFile(join(f.root, f.app.entryPath), 'utf8'), 'unicode\n')
  }
})

test('remote document operations use the owning Host launch and close invalidates editing', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const owner = new QuickAppRemoteOwner(f.registry.workspaceRoot); t.after(() => owner.dispose())
  const routes: string[] = []
  const controller = new QuickAppRemoteController(() => ({ call: async (host, workspace, action, payload) => {
    routes.push(`${host}/${workspace}/${action}`)
    return owner.handle(action, payload, 'peer-principal')
  } })); t.after(() => controller.dispose())
  const app = { ...f.app, kind: 'text' as const, entryPath: 'site/空 格.txt', hostId: 'peer-target', workspaceId: createVirtualWorkspaceId('peer-target', 'workspace-a') }
  const launch = await controller.launch(app, 'browser', undefined) as any
  const call = (operation: string, extra = {}) => controller.document(launch.launchId, 'browser', { operation, ...extra }, () => app)
  await call('allow-edit')
  await call('save', { version: launch.version, content: 'remote document', hostId: 'wrong-host' })
  assert.equal(await readFile(join(f.root, 'site/空 格.txt'), 'utf8'), 'remote document')
  assert.ok(routes.every(route => route.startsWith('peer-target/workspace-a/')))
  await controller.close(launch.launchId, 'browser')
  await assert.rejects(call('read'), { code: 'QUICK_APP_ACCESS_DENIED' })
})

test('client cleans up superseded document launches and rejects document path escapes', async () => {
  const calls: any[] = []; let finish!: (value: unknown) => void
  const client = new QuickAppsClient({ call: async (_channel, method, payload) => {
    calls.push({ method, payload })
    return method.endsWith('/launch') ? { ok: true, value: await new Promise(resolve => { finish = resolve }) } : { ok: true, value: {} }
  } } as never)
  const opening = client.open('doc'); await new Promise(resolve => setImmediate(resolve)); await client.close()
  finish({ kind: 'text', content: 'late', title: 'Doc', launchId: 'late-document' }); await opening
  assert.deepEqual(calls.at(-1), { method: 'quickApps/close', payload: { id: 'late-document' } })
  assert.equal(documentPath('site', 'site/notes.md', './next.md'), 'site/next.md')
  assert.equal(documentPath('site', 'site/sub/notes.md', '/next.md'), 'site/next.md')
  assert.equal(documentPath('site', 'site/notes.md', '%E7%A9%BA%20%E6%A0%BC.txt'), 'site/空 格.txt')
  for (const path of ['../secret', '//wrong/file', 'file:///etc/passwd', '%2e%2e/file', '%252e%252e/file', 'a%2fb', 'a%5cb', 'a\\b', '%invalid']) assert.equal(documentPath('site', 'site/a.md', path), undefined)
  assert.equal(hasNativeMarkdown({}), false)
  assert.equal(hasNativeMarkdown({ MarkdownText: () => null }), false)
  assert.equal(hasNativeMarkdown(), true)
})

function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<any>(node) ? [node, ...Children.toArray(node.props.children).flatMap(elements), ...Children.toArray(node.props.footer).flatMap(elements)] : []
}

test('native document modes retain drafts on conflicts and guard modal dismissal', async t => {
  let closed = 0
  const view = { kind: 'text', title: 'Notes', content: '# Original', path: 'site/notes.md', version: 'v1', canWrite: true, launchId: 'doc' }
  const renderer = createHookRenderer(QuickAppViewer, { app: { ...definition, id: 'a', revision: 1, entryPath: view.path }, view, busy: false,
    t: (key: keyof typeof en) => en[key], onClose: () => closed++, onReload() {}, client: { call: async () => { throw Object.assign(new Error('Conflict'), { code: 'QUICK_APP_CONFLICT' }) } } } as never)
  t.after(renderer.dispose)
  const read = () => elements(renderer.render())
  const click = (label: string) => read().find(node => node.props['aria-label'] === label)!.props.onClick()
  assert.ok(read().some(node => node.type === QuickAppMarkdown))
  click('Edit'); read().find(node => node.type === QuickAppEditor)!.props.onChange('# Draft')
  click('Save'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(read().find(node => node.type === QuickAppEditor)!.props.content, '# Draft')
  assert.equal(read().find(node => node.props.role === 'alert')!.props.children, en['quickApps.documentConflict'])
  read().find(node => node.type === DshMenu)!.props.onSelect('markdown')
  assert.equal(read().find(node => node.type === QuickAppMarkdown)!.props.content, '# Draft')
  read().find(node => node.type === DshModal)!.props.onClose()
  assert.equal(closed, 0); assert.equal(read().filter(node => node.type === DshModal).length, 2)
})
