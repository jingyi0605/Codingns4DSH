import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runHtmlWorkspaceFileOperation } from '../src/host/html-workspace-files.js'
import { startHtmlWorkspaceFiles } from '../src/client/html-workspace-files.js'
import { createFileManagementFeature } from '../src/host/features/file-management.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), 'data', 'html-files-test-'))
  await mkdir(join(root, 'Tools'))
  await mkdir(join(root, 'members'))
  await writeFile(join(root, 'Tools', 'app.html'), '<!doctype html><title>Test</title>')
  await writeFile(join(root, 'members', 'one.md'), '# Original')
  const base = { documentPath: 'Tools/app.html', scopes: ['../members'] }
  return {
    root,
    call: (operation: string, extra: Record<string, unknown> = {}) => runHtmlWorkspaceFileOperation(root, { ...base, operation, ...extra }) as Promise<any>,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

test('HTML files read, save, create, list, and delete inside the approved scope', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await f.call('connect'), { scopes: ['members'] })
    const original = await f.call('read', { path: '../members/one.md' })
    assert.equal(original.content, '# Original')
    await f.call('write', { path: '../members/one.md', content: '# Saved', ifMtime: original.mtime })
    assert.equal(await readFile(join(f.root, 'members/one.md'), 'utf8'), '# Saved')
    await f.call('write', { path: '../members/new.md', content: '# New', createOnly: true })
    await assert.rejects(f.call('write', { path: '../members/new.md', content: 'Overwrite', createOnly: true }), /already exists/u)
    const list = await f.call('list', { path: '../members' })
    assert.deepEqual(list.items.map((item: any) => item.name).sort(), ['new.md', 'one.md'])
    await assert.rejects(f.call('delete', { path: '../members' }), /regular files/u)
    await f.call('delete', { path: '../members/new.md' })
    await assert.rejects(stat(join(f.root, 'members/new.md')), { code: 'ENOENT' })
  } finally { await f.dispose() }
})

test('HTML files reject traversal, other scopes, absolute paths, and symlink escapes', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'private.md'), 'Not granted')
    for (const path of ['../private.md', '../../outside.md', join(f.root, 'private.md'), 'https://elsewhere.test/file']) {
      await assert.rejects(f.call('read', { path }), /scope|relative/u)
    }
    await assert.rejects(f.call('connect', { scopes: ['../../'] }), /outside this session/u)
    await symlink(join(f.root, 'private.md'), join(f.root, 'members/link.md'))
    await assert.rejects(f.call('read', { path: '../members/link.md' }), /Symlink/u)
    await assert.rejects(f.call('write', { path: '../members/link.md', content: 'Unsafe' }), /Symlink/u)
    await mkdir(join(f.root, 'private'))
    await symlink(join(f.root, 'private'), join(f.root, 'members/linked'))
    await assert.rejects(f.call('write', { path: '../members/linked/new.md', content: 'Unsafe' }), /Symlink/u)
    assert.equal(await readFile(join(f.root, 'private.md'), 'utf8'), 'Not granted')
  } finally { await f.dispose() }
})

test('HTML file writes reject stale versions and serialize simultaneous saves', async () => {
  const f = await fixture()
  try {
    const original = await f.call('read', { path: '../members/one.md' })
    await writeFile(join(f.root, 'members/one.md'), '# External change')
    await assert.rejects(f.call('write', { path: '../members/one.md', content: 'Stale', ifMtime: original.mtime }), /changed/u)
    const fresh = await f.call('read', { path: '../members/one.md' })
    const results = await Promise.allSettled(['A', 'B'].map(content => f.call('write', { path: '../members/one.md', content, ifMtime: fresh.mtime })))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  } finally { await f.dispose() }
})

test('HTML RPC uses the supplied session workspace, not another known workspace', async () => {
  const f = await fixture()
  const table = new CodingNsRpcTable()
  const feature = createFileManagementFeature()
  const disposers: (() => unknown)[] = []
  feature.start({ services: {
    rpc: table, listWorkspaceRoots: () => [f.root],
    nativeSessions: { get: (id: string) => id === 'owner' ? { header: { cwd: f.root } } : undefined },
  }, resources: { add: (dispose: () => unknown) => disposers.push(dispose) } } as never)
  try {
    const route = table.resolve('fileManagement/html-files')!
    const input = { operation: 'read', documentPath: 'Tools/app.html', scopes: ['../members'], path: '../members/one.md' }
    assert.equal((await route.handler(route.action, { ...input, sessionId: 'owner' }) as any).content, '# Original')
    await assert.rejects(Promise.resolve().then(() => route.handler(route.action, { ...input, sessionId: 'unknown' })), /no available workspace/u)
  } finally { for (const dispose of disposers) dispose(); await f.dispose() }
})

function clientFixture() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const responses: any[] = [], calls: any[] = []
  let approved = true, confirmations = 0, address = 'dsh-resource://file/session/owner/Tools/app.html'
  const source = { postMessage: (value: unknown) => responses.push(value) }
  const frame = Object.assign(new EventTarget(), {
    isConnected: true, contentWindow: source, src: 'blob:preview-one',
    closest: () => ({ getAttribute: () => address }),
  })
  const host = Object.assign(new EventTarget(), { confirm: () => { confirmations++; return approved } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [frame] } })
  const dispose = startHtmlWorkspaceFiles({ async call(channel, endpoint, payload) {
    calls.push({ channel, endpoint, payload })
    return { ok: true, value: (payload as any).operation === 'connect' ? { scopes: ['members'] } : { content: '# Result' } }
  } })
  async function send(operation: string, extra = {}, sender: unknown = source) {
    const event = new Event('message')
    Object.assign(event, { source: sender, data: { type: 'codingns.html-files.request.v1', id: String(responses.length), operation, ...extra } })
    host.dispatchEvent(event)
    await new Promise(resolve => setImmediate(resolve))
    return responses.at(-1)
  }
  return {
    frame, responses, calls, send, setApproved: (value: boolean) => { approved = value }, confirmations: () => confirmations,
    setAddress: (value: string) => { address = value }, stop: dispose,
    dispose() {
      dispose()
      for (const [key, value] of [['window', previousWindow], ['document', previousDocument]] as const) {
        if (value) Object.defineProperty(globalThis, key, value)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('HTML bridge checks source, grants, trusted session identity, and disposal', async () => {
  const f = clientFixture()
  try {
    await f.send('probe', {}, {})
    assert.equal(f.responses.length, 0)
    assert.equal((await f.send('probe')).value.available, true)
    assert.equal((await f.send('read', { path: '../members/one.md' })).ok, false)
    assert.equal(f.calls.length, 0)
    f.setApproved(false)
    assert.equal((await f.send('connect', { scopes: ['../members'] })).error.code, 'HTML_FILES_CANCELLED')
    f.setApproved(true)
    assert.equal((await f.send('connect', { scopes: ['../members'] })).ok, true)
    assert.equal((await f.send('read', { path: '../members/one.md', sessionId: 'attacker', scopes: ['../../'] })).ok, true)
    assert.equal(f.calls.at(-1).payload.sessionId, 'owner')
    assert.deepEqual(f.calls.at(-1).payload.scopes, ['../members'])
    f.frame.dispatchEvent(new Event('load'))
    assert.equal((await f.send('read', { path: '../members/one.md' })).ok, false)
    await f.send('connect', { scopes: ['../members'] })
    f.setAddress('dsh-resource://file/session/other/Tools/app.html')
    assert.equal((await f.send('read', { path: '../members/one.md' })).ok, false)
    f.stop()
    const count = f.responses.length
    await f.send('probe')
    assert.equal(f.responses.length, count)
  } finally { f.dispose() }
})
