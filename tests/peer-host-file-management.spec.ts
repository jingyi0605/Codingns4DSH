import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPeerHostPageTransport, installPeerHostConnectionRouting } from '../src/client/features/peer-host.js'
import { registerSessionChangedFilesView, selectSessionChangedFiles } from '../src/client/session-changed-files-view.js'
import { resolveGitWorkspaceId } from '../src/client/git-management.js'
import { subscribeNativeSessionWorkspace } from '../src/client/native-workspace-store.js'
import { createFileManagementFeature } from '../src/host/features/file-management.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { isPeerHostHttpRoute } from '../src/shared/peer-host-http-routes.js'

const sessionId = (host: string) => createVirtualSessionId(host, 'session-1')
const workspaceId = (host: string) => createVirtualWorkspaceId(host, 'workspace-1')

test('会话归属晚到自动刷新，标题和其它会话变化不额外查询 Git，卸载后释放订阅', () => {
  let items: Array<{ workspaceId: string; sessionIds: string[]; title?: string }> = []
  const listeners = new Set<() => void>()
  const uiContext = { get: () => ({ list: {
    getSnapshot: () => ({ items }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } }) } as never
  let refreshed = 0
  const dispose = subscribeNativeSessionWorkspace(uiContext, sessionId('peer-a'), () => { refreshed++ })
  const emit = () => { for (const listener of listeners) listener() }
  items = [{ workspaceId: workspaceId('peer-a'), sessionIds: [sessionId('peer-a')] }]
  emit()
  assert.equal(refreshed, 1)
  items = [{ ...items[0]!, title: '新标题', sessionIds: [sessionId('peer-a'), 'other'] }]
  emit()
  assert.equal(refreshed, 1)
  items = []
  emit()
  assert.equal(refreshed, 2)
  dispose()
  assert.equal(listeners.size, 0)
})

test('修改文件视图和后台计数器都使用含远端会话的工作区 Store', async () => {
  const registrations: any[] = []
  const ctx = {
    get: (name: string) => name === 'workspaces' ? { list: { getSnapshot: () => ({ items: [
      { workspaceId: workspaceId('peer-a'), sessionIds: [sessionId('peer-a')] },
    ] }), subscribe: () => () => undefined } } : undefined,
    slots: {
      inject: (_key: string, callback: () => () => void) => callback(),
      register: (options: unknown) => { registrations.push(options); return () => undefined },
    },
  }
  const remote = { workspace: { follow: async function* () { yield { value: { items: [] } } } } }
  const dispose = registerSessionChangedFilesView(ctx, { call: async () => ({ ok: true, value: {} }) }, remote)
  try {
    assert.equal(registrations.length, 2)
    for (const registration of registrations) {
      const props = registration.inject()
      assert.equal(await resolveGitWorkspaceId(props.remote, sessionId('peer-a'), props.uiContext), workspaceId('peer-a'))
    }
  } finally { dispose?.() }
})

for (const connection of ['web', 'native'] as const) {
  test(`文件管理 ${connection} 连接在远端读取会话变更和文件，写入保持 Host 隔离`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'peer-files-'))
    const previousFetch = globalThis.fetch
    const resources: Array<() => void> = []
    const calls: Array<{ host: string; method: string; payload: any }> = []
    const tables = new Map<string, CodingNsRpcTable>()
    const roots = new Map<string, string>()
    const response = (value: unknown) => Response.json({ result: { ok: true, value } })
    let restore: (() => void) | undefined
    try {
      for (const host of ['peer-a', 'peer-b']) {
        const directory = await mkdtemp(join(root, `${host}-`))
        roots.set(host, directory)
        await writeFile(join(directory, 'test.ts'), host)
        const table = new CodingNsRpcTable()
        tables.set(host, table)
        createFileManagementFeature().start({ services: {
          rpc: table, resolveWorkspaceRoot: (id: string) => id === 'workspace-1' ? directory : null,
          listWorkspaceRoots: () => [directory],
          nativeSessions: { get: (id: string) => id === 'session-1' ? { cwd: directory, snapshotEvents: () => [
            { type: 'tool/call', data: { arguments: { path: 'test.ts' } } },
          ] } : undefined },
        }, resources: { add: (dispose: () => void) => resources.push(dispose) } } as never)
      }
      globalThis.fetch = (async (_url, init) => {
        const envelope = JSON.parse(String(init?.body))
        if (envelope.method !== 'peerHost/request') return response({ local: true })
        const proxy = envelope.payload
        assert.equal(isPeerHostHttpRoute(proxy.method, proxy.path), true)
        const request = JSON.parse(proxy.body)
        calls.push({ host: proxy.peerHostId, ...request })
        const route = tables.get(proxy.peerHostId)!.resolve(request.method)!
        try {
          return response({ status: 200, body: JSON.stringify({ result: { ok: true, value: await route.handler(route.action, request.payload) } }) })
        } catch (error) {
          return response({ status: 200, body: JSON.stringify({ result: { ok: false, error: { code: 'REMOTE_FILE_ERROR', message: (error as Error).message } } }) })
        }
      }) as typeof fetch
      const transport = createPeerHostPageTransport()
      transport.setAggregate([...roots].map(([host, path]) => ({
        hostId: 'local', targetHostId: host, hostLabel: host, availability: 'ready', errorCode: null,
        workspaces: [{ workspaceId: 'workspace-1', path, sessions: [{
          scope: { hostId: 'local', targetHostId: host, workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
          title: host, status: 'idle', updatedAt: 1,
        }] }],
      })) as never)
      const rpc = { call: async (_channel: string, _method: string, _payload: unknown): Promise<any> => ({ ok: true, value: { local: true } }) }
      restore = connection === 'native' ? installPeerHostConnectionRouting({
        uiContext: { get: (name) => name === 'connection' ? { rpc } : undefined },
        remote: { openRemoteStream: () => (async function* () {})() }, hooks: transport.hooks, matchesScope: transport.matchesScope,
      }) : undefined
      const call = (endpoint: string, payload: unknown, channel = '/codingns'): Promise<any> => connection === 'native'
        ? rpc.call(channel, endpoint, payload)
        : transport.hooks.rpc!({ method: endpoint, payload: { channel, payload } })
      for (const host of roots.keys()) {
        const scope = { sessionId: sessionId(host), workspaceId: workspaceId(host) }
        const files = await call('fileManagement/session-changes', scope)
        assert.deepEqual(files, { ok: true, value: { paths: ['test.ts'] } })
        assert.deepEqual(calls.at(-1)?.payload, { sessionId: 'session-1', workspaceId: 'workspace-1' })
        assert.equal(selectSessionChangedFiles(files.value, { changes: [{ path: 'test.ts', oldPath: null }, { path: 'other.ts', oldPath: null }] } as never).length, 1)
        const content = await call('codingns/fileManagement/read', { sessionId: scope.sessionId, path: 'test.ts' }, '/api')
        assert.equal(content.value.content, host)
        // 文件正文中即使包含其他 Host 的虚拟 ID，也必须原样保存。
        assert.equal((await call('fileManagement/write', { sessionId: scope.sessionId, path: 'test.ts', content: sessionId('peer-b') })).ok, true)
        assert.equal(await readFile(join(roots.get(host)!, 'test.ts'), 'utf8'), sessionId('peer-b'))
        assert.equal((await call('fileManagement/download', { ...scope, path: 'test.ts' })).value.contentBase64, Buffer.from(sessionId('peer-b')).toString('base64'))
      }
      const count = calls.length
      for (const scope of [
        { sessionId: sessionId('missing') },
        { sessionId: sessionId('peer-a'), workspaceId: workspaceId('peer-b') },
        { sessionId: sessionId('peer-a'), workspaceId: 'local-workspace' },
      ]) {
        const rejected = await call('fileManagement/write', { ...scope, path: 'test.ts', content: '不应写入' })
        assert.equal(rejected.error.code, 'PEER_HOST_SCOPE_MISMATCH')
      }
      assert.equal(calls.length, count)
      assert.equal((await call('fileManagement/write', { sessionId: 'local-session', path: 'test.ts', content: sessionId('peer-b') })).value.local, true)
      transport.setAggregate([])
      assert.equal((await call('fileManagement/read', { sessionId: sessionId('peer-a'), path: 'test.ts' })).error.code, 'PEER_HOST_SCOPE_MISMATCH')
    } finally {
      restore?.()
      globalThis.fetch = previousFetch
      for (const dispose of resources.reverse()) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
