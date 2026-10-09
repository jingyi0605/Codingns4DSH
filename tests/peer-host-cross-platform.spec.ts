import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'
import { createPeerHostRemoteSummarySource } from '../src/host/modules/peer-host/peer-host-remote-summary-source.js'
import { createAggregateHostSource, PeerHostAggregateService } from '../src/host/modules/peer-host/peer-host-aggregate-service.js'
import { VirtualWorkspaceRegistry } from '../src/host/modules/peer-host/peer-host-virtual-registry.js'
import { createScopedNativeIdResolver } from '../src/host/features/peer-host.js'
import { rewriteNativeRequestIds, rewriteNativeResponseIds } from '../src/host/modules/peer-host/peer-host-native-protocol.js'
import { createPeerHostNativeProjection } from '../src/client/peer-host-native-projection.js'
import { createPeerHostPageTransport, installPeerHostConnectionRouting } from '../src/client/features/peer-host.js'
import { sessionAdapterId } from '../src/client/session-adapter-cache.js'
import { normalizePeerHostFileLocation } from '../src/shared/peer-host-file-location.js'
import { createVirtualSessionId, createVirtualWorkspaceId, parseVirtualSessionId } from '../src/shared/contracts/peer-host.js'

const cases = [
  { name: 'macOS 访问 Windows 盘符目录', localPath: '/Users/mac/Code/本机项目', remotePath: 'C:\\Code\\远端项目 Space', path: win32,
    file: 'C:/Code/远端项目 Space/docs/说明.md', link: '/C:/Code/远端项目 Space/docs/说明.md:23:7', line: 23 },
  { name: 'macOS 访问 Windows 正斜杠目录', localPath: '/Users/mac/Code/本机项目', remotePath: 'D:/Code/远端项目 Space', path: win32,
    file: 'D:/Code/远端项目 Space/docs/说明.md', link: '/D:/Code/远端项目 Space/docs/说明.md:23', line: 23 },
  { name: 'macOS 访问 Windows UNC 共享目录', localPath: '/Users/mac/Code/本机项目', remotePath: '\\\\Windows-Host\\共享\\远端项目 Space', path: win32,
    file: '\\\\Windows-Host\\共享\\远端项目 Space\\docs\\说明.md', link: '\\\\Windows-Host\\共享\\远端项目 Space\\docs\\说明.md:23', line: 23 },
  // POSIX（类 Unix 路径）中的冒号可以是文件名，不能套用 Windows 的行号拆分。
  { name: 'Windows 访问 macOS 目录与冒号文件名', localPath: 'C:\\Code\\本机项目', remotePath: '/Users/mac/Code/远端项目 Space', path: posix,
    file: '/Users/mac/Code/远端项目 Space/docs/说明:23', link: '/Users/mac/Code/远端项目 Space/docs/说明:23', line: undefined },
] as const

/** 方向由本机/目标的不同路径语义定义；显式使用 win32/posix 校验，不冒充 Windows 内核实测。 */
async function fixture(localPath: string, remotePath: string) {
  const hostId = '本机:Host%'
  const targetHostId = '远端:Host%'
  const workspaceId = '工作区:项目 Space%'
  const parentId = 'parent:同名%'
  const childId = 'child:同名%'
  const source = createPeerHostRemoteSummarySource({
    scope: { hostId, targetHostId, workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 },
    visibleWorkspaceIds: [workspaceId],
    transport: {
      async rpc() { return JSON.parse(JSON.stringify({ items: [
        { sessionId: parentId, cwd: remotePath, running: true, blank: false },
        { sessionId: childId, cwd: remotePath, parentSessionId: parentId, origin: 'subagent', running: true, blank: false },
      ] })) },
      async cli() { return [{ sessionId: childId, adapterId: 'codex' }] },
      async *stream() { yield { type: 'baseline', value: { items: [{ workspaceId, path: remotePath, sessionIds: [parentId] }] } } },
    },
  })
  const results = await new PeerHostAggregateService(1000).load([
    { hostId, targetHostId: null, hostLabel: '本机', load: async () => [{ workspaceId, path: localPath, displayName: '本机项目', sessions: [
      { sessionId: childId, title: '本机同名会话', adapterId: 'dsh', running: false, status: 'idle', updatedAt: 1, blank: false },
    ] }] },
    createAggregateHostSource({ hostId, targetHostId, hostLabel: '远端', source }),
  ])
  const registry = new VirtualWorkspaceRegistry()
  registry.replace(results)
  return { results, registry, hostId, targetHostId, workspaceId, parentId, childId,
    virtualChild: createVirtualSessionId(targetHostId, childId),
    virtualParent: createVirtualSessionId(targetHostId, parentId),
    virtualWorkspace: createVirtualWorkspaceId(targetHostId, workspaceId),
  }
}

for (const sample of cases) for (const connection of ['web', 'native'] as const) {
  test(`${sample.name}：${connection} 入口的子会话状态、Codex 配置、父子路由和文件访问`, async () => {
    const f = await fixture(sample.localPath, sample.remotePath)
    const projection = createPeerHostNativeProjection()
    projection.setAggregate(f.results)
    const child = projection.sessions().find(row => row.sessionId === f.virtualChild)!
    assert.equal(child.cwd, sample.remotePath, '目标路径必须原样保留，不能由本机路径库重写')
    assert.equal(child.parentSessionId, f.virtualParent)
    assert.equal(child.running, true)
    assert.equal(child.projections.values.title, sample.path.basename(sample.remotePath), '标题回退按目标路径分隔符取目录名')
    assert.equal(sessionAdapterId(f.virtualChild), 'codex')
    assert.equal(projection.sessions().some(row => row.sessionId === f.childId), false, '本机同名会话不能覆盖远端')
    assert.deepEqual(parseVirtualSessionId(f.virtualChild), { hostId: f.targetHostId, sessionId: f.childId })
    const location = normalizePeerHostFileLocation(sample.link, child.cwd)
    assert.deepEqual(location, { path: sample.file, ...(sample.line === undefined ? {} : { line: sample.line }) })

    const previousFetch = globalThis.fetch
    const calls: Array<{ method: string; scope: any; payload: any }> = []
    globalThis.fetch = (async (_url, init) => {
      const envelope = JSON.parse(String(init?.body))
      const input = envelope.payload
      assert.equal(input.scope.targetHostId, f.targetHostId)
      assert.equal(input.scope.workspaceId, f.workspaceId)
      // 子会话输入通过父会话地址派发；CLI 和文件请求直接以子会话为作用域。
      assert.equal(input.scope.sessionId, input.method === 'subagents/prompt' ? f.parentId : f.childId)
      if (envelope.method === 'peerHost/request') {
        const cli = JSON.parse(input.body)
        calls.push({ method: cli.method, scope: input.scope, payload: cli.payload })
        assert.equal(cli.payload.sessionId, f.childId)
        return response({ status: 200, body: JSON.stringify({ result: { ok: true, value: { adapterId: 'codex', modelId: 'gpt-model', effortId: 'high' } } }) })
      }
      assert.equal(envelope.method, 'peerHost/native')
      const resolver = createScopedNativeIdResolver(f.registry, input.scope)
      assert.equal(resolver.workspacePath, sample.remotePath)
      const payload = rewriteNativeRequestIds(input.method, input.payload, resolver) as any
      calls.push({ method: input.method, scope: input.scope, payload })
      if (input.method === 'workspaceFiles/stat') {
        assert.equal(payload.args.workspaceFileScopeId, f.childId)
        assert.equal(sample.path.resolve(sample.remotePath, payload.args.path), sample.path.resolve(sample.remotePath, sample.file))
        return response({ absolutePath: sample.file })
      }
      assert.equal(input.method, 'subagents/prompt')
      assert.equal(payload.args.request.parentSessionId, f.parentId)
      assert.equal(payload.args.request.childSessionId, f.childId)
      assert.equal(payload.args.request.content[0].text, sample.link, '正文中的路径和行号必须保留')
      return response({ messageId: 'remote-message' })
    }) as typeof fetch
    const localCalls: string[] = []
    const rpc = { call: async (_channel: string, endpoint: string, _payload: unknown): Promise<any> => {
      localCalls.push(endpoint)
      return { ok: true, value: { adapterId: 'dsh' } }
    } }
    const remote = { openRemoteStream: (): AsyncIterable<unknown> => (async function* () {})() }
    const context = { get: (name: string) => name === 'connection' ? { rpc } : undefined }
    const transport = createPeerHostPageTransport(projection, context)
    transport.setAggregate(f.results)
    const restore = connection === 'native' ? installPeerHostConnectionRouting({ uiContext: context, remote, hooks: transport.hooks, matchesScope: transport.matchesScope }) : undefined
    const call = (channel: string, method: string, payload: unknown) => connection === 'native' ? rpc.call(channel, method, payload)
      : transport.hooks.rpc!<any>({ method, payload: { channel, payload } })
    try {
      const config = await call('/codingns', 'cli/session/get', { sessionId: f.virtualChild })
      assert.deepEqual(config.value, { adapterId: 'codex', modelId: 'gpt-model', effortId: 'high' })
      const selection = { sessionId: f.virtualChild, adapterId: 'codex', modelId: 'gpt-model', effortId: 'xhigh', serviceTierId: 'priority' }
      await call('/codingns', 'cli/session/set', selection)
      assert.deepEqual(calls.at(-1)?.payload, { ...selection, sessionId: f.childId })
      const prompted = await call('/api', 'subagents/prompt', { args: { request: {
        requestId: '跨平台-request', parentSessionId: f.virtualParent, childSessionId: f.virtualChild,
        mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: sample.link }],
      } } })
      assert.equal(prompted.ok, true, JSON.stringify(prompted.error))
      assert.equal(prompted.value.messageId, 'remote-message')
      assert.equal((await call('/api', 'workspaceFiles/stat', { args: { workspaceFileScopeId: f.virtualChild, path: sample.link } })).value.absolutePath, sample.file)

      // 侧栏的虚拟根目录在 Host 边界还原，再使用目标平台的路径规则定位文件。
      const resolver = createScopedNativeIdResolver(f.registry, f.registry.resolveSession(f.virtualChild)!)
      const virtualRoot = projection.workspaces()[0]!.path
      const path = resolver.resolveWorkspacePath!(`${virtualRoot}/docs/文件 Space.md`)!
      assert.equal(sample.path.resolve(path), sample.path.resolve(sample.remotePath, 'docs/文件 Space.md'))
      for (const running of [true, false]) {
        const frame = rewriteNativeResponseIds(JSON.parse(JSON.stringify({ type: 'emit', event: 'api-session/status', args: [f.childId, running] })), id => id, id => createVirtualSessionId(f.targetHostId, id))
        assert.deepEqual(frame, { type: 'emit', event: 'api-session/status', args: [f.virtualChild, running] })
      }
      assert.equal(localCalls.length, 0, '所有远端操作都不能落到本机同名会话')
      if (connection === 'native') {
        assert.equal((await call('/codingns', 'cli/session/get', { sessionId: f.childId })).value.adapterId, 'dsh')
        assert.deepEqual(localCalls, ['cli/session/get'], '本机请求仍走本机连接')
      }
    } finally { restore?.(); transport.dispose(); globalThis.fetch = previousFetch }
  })
}

function response(value: unknown) { return Response.json({ result: { ok: true, value } }) }
