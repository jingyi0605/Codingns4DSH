import assert from 'node:assert/strict'
import test from 'node:test'
import { createScopedNativeIdResolver } from '../data/build/dist/host/features/peer-host.js'
import {
  DSH_NATIVE_REMOTE_METHODS,
  decodeNativeResponseBytes,
  encodeNativeResponseBytes,
  isDshNativeRemoteMethod,
  rewriteNativeRequestIds,
  rewriteNativeResponseIds,
} from '../data/build/dist/host/modules/peer-host/peer-host-native-protocol.js'
import { VirtualWorkspaceRegistry } from '../data/build/dist/host/modules/peer-host/peer-host-virtual-registry.js'
import { createVirtualSessionId } from '../data/build/dist/shared/index.js'

const resolver = {
  resolveWorkspace: (id: string) => id === 'codingns:peer-host:v1:workspace:peer-a:remote-ws'
    ? { workspaceId: 'remote-ws', targetHostId: 'peer-a' }
    : null,
  resolveSession: (id: string) => id === 'codingns:peer-host:v1:session:peer-a:remote-session'
    ? { sessionId: 'remote-session', targetHostId: 'peer-a' }
    : null,
}

test('新建会话尚未进入聚合 Registry 时，按作用域改写临时虚拟会话 ID', () => {
  const registry = new VirtualWorkspaceRegistry()
  const scope = {
    hostId: 'host-local',
    targetHostId: 'peer-a',
    workspaceId: 'remote-ws',
    sessionId: 'new-session',
    scopeGeneration: 0,
  }
  const scopedResolver = createScopedNativeIdResolver(registry, scope)
  const request = rewriteNativeRequestIds('session/follow', {
    args: { request: { address: { kind: 'session', sessionId: createVirtualSessionId('peer-a', 'new-session') } } },
  }, scopedResolver)
  assert.deepEqual(request, { args: { request: { address: { kind: 'session', sessionId: 'new-session' } } } })

  const unrelated = rewriteNativeRequestIds('session/follow', {
    sessionId: createVirtualSessionId('peer-a', 'other-session'),
  }, scopedResolver)
  assert.equal((unrelated as { sessionId: string }).sessionId, createVirtualSessionId('peer-a', 'other-session'))
})

test('DSH 原生 Workspace/Session Remote 方法使用正式命名空间', () => {
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('workspace/follow'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('workspace/insertBefore'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('session/control'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('session/follow'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('session/page'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('session/prompt'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('officeToPdf/generation'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('officeToPdf/render'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('workspaceFiles/changes'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('terminal/environment'))
  assert.ok(DSH_NATIVE_REMOTE_METHODS.includes('terminal/follow'))
  assert.equal(isDshNativeRemoteMethod('workspace/list'), false)
  assert.equal(isDshNativeRemoteMethod('session/send'), false)
})

test('原生请求只改写 Workspace/Session 资源 ID，不污染 requestId 和正文', () => {
  const value = rewriteNativeRequestIds('workspace/insertBefore', {
    workspaceId: 'codingns:peer-host:v1:workspace:peer-a:remote-ws',
    beforeWorkspaceId: 'codingns:peer-host:v1:workspace:peer-a:other',
    sessionId: 'codingns:peer-host:v1:session:peer-a:remote-session',
    requestId: 'codingns:peer-host:v1:session:peer-a:remote-session',
    content: [{ text: 'workspaceId=sessionId 不应解析' }],
  }, resolver)
  assert.deepEqual(value, {
    workspaceId: 'remote-ws',
    beforeWorkspaceId: 'codingns:peer-host:v1:workspace:peer-a:other',
    sessionId: 'remote-session',
    requestId: 'codingns:peer-host:v1:session:peer-a:remote-session',
    content: [{ text: 'workspaceId=sessionId 不应解析' }],
  })
})

test('session/follow 流沿用同一套请求与帧 ID 改写', () => {
  const request = rewriteNativeRequestIds('session/follow', {
    args: { request: { address: { kind: 'session', sessionId: 'codingns:peer-host:v1:session:peer-a:remote-session' }, assistantStream: true } },
  }, resolver)
  assert.deepEqual(request, {
    args: { request: { address: { kind: 'session', sessionId: 'remote-session' }, assistantStream: true } },
  })
  const frame = rewriteNativeResponseIds(
    { type: 'snapshot', cursor: 1, records: [], header: { id: 'remote-session', cwd: '/repo' } },
    (id) => `codingns:peer-host:v1:workspace:peer-a:${id}`,
    (id) => `codingns:peer-host:v1:session:peer-a:${id}`,
  )
  assert.deepEqual(frame, {
    type: 'snapshot',
    cursor: 1,
    records: [],
    header: { id: 'codingns:peer-host:v1:session:peer-a:remote-session', cwd: '/repo' },
  })
})

test('codingnsTerminal 的 agentId 承载会话身份并双向改写', () => {
  const request = rewriteNativeRequestIds('codingnsTerminal/environment', {
    args: { agentId: 'codingns:peer-host:v1:session:peer-a:remote-session' },
  }, resolver)
  assert.deepEqual(request, { args: { agentId: 'remote-session' } })
  const frame = rewriteNativeResponseIds(
    { agentId: 'remote-session', workspaceId: 'remote-ws' },
    (id) => `codingns:peer-host:v1:workspace:peer-a:${id}`,
    (id) => `codingns:peer-host:v1:session:peer-a:${id}`,
  )
  assert.deepEqual(frame, {
    agentId: 'codingns:peer-host:v1:session:peer-a:remote-session',
    workspaceId: 'codingns:peer-host:v1:workspace:peer-a:remote-ws',
  })
})

test('原生响应中的列表、header 和 projection key 可重新编码为虚拟 ID', () => {
  const value = rewriteNativeResponseIds({
    workspaceIds: ['remote-ws'],
    items: [{ workspaceId: 'remote-ws', sessionIds: ['remote-session'] }],
    header: { id: 'remote-session', parentSession: 'remote-parent' },
    projections: { 'remote-session': { sessionId: 'remote-session' } },
  }, (id) => `codingns:peer-host:v1:workspace:peer-a:${id}`,
  (id) => `codingns:peer-host:v1:session:peer-a:${id}`)
  assert.deepEqual(value, {
    workspaceIds: ['codingns:peer-host:v1:workspace:peer-a:remote-ws'],
    items: [{ workspaceId: 'codingns:peer-host:v1:workspace:peer-a:remote-ws', sessionIds: ['codingns:peer-host:v1:session:peer-a:remote-session'] }],
    header: { id: 'codingns:peer-host:v1:session:peer-a:remote-session', parentSession: 'codingns:peer-host:v1:session:peer-a:remote-parent' },
    projections: { 'remote-session': { sessionId: 'codingns:peer-host:v1:session:peer-a:remote-session' } },
  })
})

test('原生响应改写不会展开 Uint8Array，并可安全穿过 PeerHost JSON 边界', () => {
  const bytes = new Uint8Array([0, 45, 60, 255])
  const rewritten = rewriteNativeResponseIds(
    { offset: 0, data: bytes, absolutePath: '/repo/index.html' },
    (id) => `codingns:peer-host:v1:workspace:peer-a:${id}`,
    (id) => `codingns:peer-host:v1:session:peer-a:${id}`,
  ) as { data: Uint8Array }
  assert.equal(rewritten.data, bytes)

  const wire = JSON.parse(JSON.stringify(encodeNativeResponseBytes(rewritten)))
  const decoded = decodeNativeResponseBytes(wire) as { data: Uint8Array }
  assert.ok(decoded.data instanceof Uint8Array)
  assert.deepEqual([...decoded.data], [...bytes])
})
