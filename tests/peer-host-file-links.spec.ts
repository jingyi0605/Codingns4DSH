import assert from 'node:assert/strict'
import test from 'node:test'
import { win32 } from 'node:path'
import { fileAddressFor, parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { installPeerHostFileLinkRouting } from '../src/client/peer-host-file-links.js'
import { createPeerHostPageTransport, installPeerHostConnectionRouting } from '../src/client/features/peer-host.js'
import { createPeerHostNativeProjection } from '../src/client/peer-host-native-projection.js'
import { normalizePeerHostFileLocation } from '../src/shared/peer-host-file-location.js'
import { createVirtualSessionId } from '../src/shared/contracts/peer-host.js'
import { createScopedNativeIdResolver } from '../src/host/features/peer-host.js'
import { VirtualWorkspaceRegistry } from '../src/host/modules/peer-host/peer-host-virtual-registry.js'
import { encodeNativeResponseBytes, rewriteNativeRequestIds } from '../src/host/modules/peer-host/peer-host-native-protocol.js'
import { resolveDshNativeDispatch } from '../src/host/modules/peer-host/peer-host-native-dispatch.js'

const root = 'C:/Code/zhiweijz'
const filePath = `${root}/docs/20261009-后端全面审查与重构清理清单.md`
const linkPath = `/${filePath}:170`
const sessionId = (host: string) => createVirtualSessionId(host, 'session-1')
const aggregate = ['peer-a', 'peer-b'].map((host) => ({
  hostId: 'local', targetHostId: host, hostLabel: host, availability: 'ready', errorCode: null,
  workspaces: [{ workspaceId: 'workspace-1', path: root, displayName: host, sessions: [{
    scope: { hostId: 'local', targetHostId: host, workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
    title: host, status: 'idle', updatedAt: 1,
  }] }],
}))

test('截图路径在 Windows 下确实解析成错误文件，规范后与文件树路径一致', () => {
  assert.notEqual(win32.resolve(root, linkPath), win32.resolve(root, filePath))
  assert.deepEqual(normalizePeerHostFileLocation(linkPath, root), { path: filePath, line: 170 })
  assert.equal(win32.resolve(root, normalizePeerHostFileLocation(linkPath, root).path), win32.resolve(root, filePath))
  assert.deepEqual(normalizePeerHostFileLocation('docs/说明.md:170:8', root), { path: 'docs/说明.md', line: 170 })
  assert.deepEqual(normalizePeerHostFileLocation('C:\\项目\\说明.md:170', 'C:\\项目'), { path: 'C:\\项目\\说明.md', line: 170 })
  assert.deepEqual(normalizePeerHostFileLocation('docs/说明.md:9', '\\\\server\\share'), { path: 'docs/说明.md', line: 9 })
})

test('POSIX 与未知平台保留冒号文件名，Windows 普通路径及非法位置不被截断', () => {
  for (const path of [linkPath, '/repo/report:170', 'report.md:8', 'C:/repo/file.md']) {
    for (const workspace of ['/repo', undefined]) assert.deepEqual(normalizePeerHostFileLocation(path, workspace), { path })
  }
  for (const path of ['C:/repo/file.md', 'docs/file:0', 'docs/file:0:8', 'docs/file:2:0', 'docs/file:9007199254740992', 'docs/file:2:9007199254740992']) {
    assert.deepEqual(normalizePeerHostFileLocation(path, root), { path })
  }
})

test('原生资源入口保留虚拟会话、行号、放置参数与查询片段，并在卸载后还原', () => {
  const calls: Array<{ address: string; options?: any; owner?: string }> = []
  const sidebar = {
    openResource(address: string, options?: any) { assert.equal(this, sidebar); calls.push({ address, options }) },
    openResourceIn(owner: string, address: string, options?: any) { assert.equal(this, sidebar); calls.push({ owner, address, options }) },
  }
  const originalOpen = sidebar.openResource
  const originalOpenIn = sidebar.openResourceIn
  const restore = installPeerHostFileLinkRouting({ get: () => sidebar }, (id) => id === sessionId('peer-a') ? root : undefined)!
  try {
    const address = fileAddressFor(sessionId('peer-a') as never, root, linkPath)
    assert.equal(parseFileAddress(address)?.path, linkPath, '原生地址构造未拆出路径行号')
    sidebar.openResource(`${address}?mode=text#section`, { preferNewPane: true, params: { language: 'markdown' } })
    assert.equal(calls[0]?.address, `${sessionFileAddress(sessionId('peer-a') as never, filePath)}?mode=text#section`)
    assert.deepEqual(calls[0]?.options, { preferNewPane: true, params: { line: 170, language: 'markdown' } })
    sidebar.openResourceIn('other-owner', address, { kind: 'file', params: { line: 12 } })
    assert.equal(calls[1]?.owner, 'other-owner')
    assert.deepEqual(calls[1]?.options, { kind: 'file', params: { line: 12 } })
    for (const untouched of [
      sessionFileAddress('local-session' as never, linkPath),
      sessionFileAddress(sessionId('peer-b') as never, linkPath),
      sessionFileAddress(sessionId('peer-a') as never, 'docs/normal.md'),
      'dsh-resource://file/absolute/C:/file.md:170',
      'dsh-resource://file/session/%invalid/file.md',
      'https://example.test/file.md:170',
    ]) {
      sidebar.openResource(untouched)
      assert.equal(calls.at(-1)?.address, untouched)
      assert.equal(calls.at(-1)?.options, undefined)
    }
  } finally { restore() }
  assert.equal(sidebar.openResource, originalOpen)
  assert.equal(sidebar.openResourceIn, originalOpenIn)
})

for (const connection of ['web', 'native'] as const) {
  test(`${connection} 回放消息链接、文件树和旧标签的 stat/read/readBytes/changes，两个同路径 Host 保持隔离`, async () => {
    const previousFetch = globalThis.fetch
    const projection = createPeerHostNativeProjection()
    const registry = new VirtualWorkspaceRegistry()
    registry.replace(aggregate as never)
    const calls: Array<{ host: string; method: string; args: any }> = []
    const streams = new Map<string, AsyncIterator<unknown>>()
    const response = (value: unknown) => Response.json({ result: { ok: true, value } })
    let resourceAddress = ''
    let resourceOptions: any
    const sidebar = { openResource(address: string, options?: any) { resourceAddress = address; resourceOptions = options } }
    const rpc = { call: async (_channel: string, _method: string, _payload: unknown): Promise<any> => ({ ok: true, value: 'local' }) }
    const remote = { openRemoteStream: (_method: string, _payload: unknown): AsyncIterable<unknown> => (async function* () {})() }
    const context = { get: (name: string) => name === 'connection' ? { rpc } : name === 'sidebarRight' ? sidebar : undefined }
    globalThis.fetch = (async (_input, init) => {
      const envelope = JSON.parse(String(init?.body))
      const input = envelope.payload
      if (envelope.method === 'peerHost/nativeStreamNext') return response(await streams.get(input.streamId)!.next())
      if (envelope.method === 'peerHost/nativeStreamClose') { streams.delete(input.streamId); return response({ closed: true }) }
      assert.ok(['peerHost/native', 'peerHost/nativeStream'].includes(envelope.method))
      const payload = rewriteNativeRequestIds(input.method, input.payload, createScopedNativeIdResolver(registry, input.scope))
      // 回放正式 Gateway 的名字参数解码，再用 win32 路径解析模拟目标文件定位。
      const invoke = async (request: { method: string; args: any }) => {
        const { args } = request
        assert.equal(args.workspaceFileScopeId, 'session-1')
        assert.equal(win32.resolve(root, args.path), win32.resolve(root, filePath))
        calls.push({ host: input.scope.targetHostId, method: request.method, args })
        if (request.method === 'read') return { content: input.scope.targetHostId, absolutePath: filePath }
        if (request.method === 'readBytes') return { data: new TextEncoder().encode(input.scope.targetHostId), absolutePath: filePath }
        return { absolutePath: filePath, version: 'v1', bytes: 6 }
      }
      const dispatch = resolveDshNativeDispatch({ get: () => ({ invoke, stream: async (request: any) => {
        await invoke(request)
        return (async function* () { yield { kind: 'ready' } })()
      } }) } as never)!
      if (envelope.method === 'peerHost/nativeStream') {
        const streamId = `stream-${streams.size}`
        streams.set(streamId, (await dispatch.stream(input.method, payload))[Symbol.asyncIterator]())
        return response({ streamId })
      }
      return response(encodeNativeResponseBytes(await dispatch.rpc(input.method, payload)))
    }) as typeof fetch
    const transport = createPeerHostPageTransport(projection, context)
    transport.setAggregate(aggregate as never)
    const restoreLinks = installPeerHostFileLinkRouting(context, (id) => projection.sessions().find((session) => session.sessionId === id)?.cwd)!
    const restoreConnection = connection === 'native' ? installPeerHostConnectionRouting({ uiContext: context, remote, hooks: transport.hooks, matchesScope: transport.matchesScope }) : undefined
    const call = (method: string, args: unknown) => connection === 'native' ? rpc.call('/api', method, { args })
      : transport.hooks.rpc!({ method, payload: { channel: '/api', payload: { args } } })
    try {
      for (const host of ['peer-a', 'peer-b']) {
        const id = sessionId(host)
        for (const path of [linkPath, filePath]) {
          sidebar.openResource(fileAddressFor(id as never, root, path))
          const parsed = parseFileAddress(resourceAddress)!
          assert.equal(win32.resolve(root, parsed.path), win32.resolve(root, filePath))
          assert.equal(resourceOptions?.params?.line, path === linkPath ? 170 : undefined)
          assert.equal((await call('workspaceFiles/stat', { workspaceFileScopeId: id, path: parsed.path })).ok, true)
          assert.equal((await call('workspaceFiles/read', { workspaceFileScopeId: id, path: parsed.path, range: { offset: 0 } })).value.content, host)
          const bytes = (await call('workspaceFiles/readBytes', { workspaceFileScopeId: id, path: parsed.path, options: { baseFile: linkPath } })).value.data
          assert.ok(bytes instanceof Uint8Array)
          assert.equal(new TextDecoder().decode(bytes), host)
          assert.equal(calls.at(-1)?.args.options.baseFile, filePath)
        }
        // 已持久化的坏地址不会再次经过打开入口，转发边界必须也能读到正确文件。
        assert.equal((await call('workspaceFiles/read', { workspaceFileScopeId: id, path: linkPath })).value.content, host)
        const payload = { args: { workspaceFileScopeId: id, path: linkPath } }
        const stream = connection === 'native' ? remote.openRemoteStream('workspaceFiles/changes', payload)
          : transport.hooks.openStream!({ method: 'workspaceFiles/changes', payload: { channel: '/api', payload } })
        assert.deepEqual(await Array.fromAsync(stream), [{ kind: 'ready' }])
        assert.equal(calls.at(-1)?.host, host)
      }
      assert.equal(calls.length, 16)
      assert.deepEqual(calls.map((call) => call.host), [...Array(8).fill('peer-a'), ...Array(8).fill('peer-b')])
    } finally {
      restoreConnection?.()
      restoreLinks()
      transport.dispose()
      globalThis.fetch = previousFetch
    }
  })
}

test('非文件 Remote 与 POSIX 工作区的正文、位置路径及调用载荷保持原样', () => {
  const registry = new VirtualWorkspaceRegistry()
  registry.replace(aggregate as never)
  const scope = aggregate[0]!.workspaces[0]!.sessions[0]!.scope
  const resolver = createScopedNativeIdResolver(registry, scope)
  const input = { args: { path: linkPath, text: linkPath, requestId: sessionId('peer-b') } }
  assert.deepEqual(rewriteNativeRequestIds('session/prompt', input, resolver), input)
  assert.deepEqual(rewriteNativeRequestIds('workspaceFiles/read', input, { ...resolver, workspacePath: '/repo' }), input)
  const normalized = rewriteNativeRequestIds('workspaceFiles/read', input, resolver) as any
  assert.equal(normalized.args.path, filePath)
  assert.equal(normalized.args.text, linkPath)
  assert.equal(normalized.args.requestId, sessionId('peer-b'))
  assert.equal(input.args.path, linkPath, '规范不能修改调用方的原对象')
})
