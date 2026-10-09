import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'
import { PeerHostWsProxyService } from '../data/build/dist/host/modules/peer-host/host-ws-proxy-service.js'

class FakeSocket {
  readyState = 1
  readonly sent: string[] = []
  readonly closed: Array<{ code?: number; reason?: string }> = []
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()
  send(data: string): void { this.sent.push(data) }
  close(code?: number, reason?: string): void { this.readyState = 3; this.closed.push({ code, reason }) }
  on(event: string, listener: (...args: any[]) => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]) }
  emit(event: string, ...args: any[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
}

const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 3 } as const

async function setup() {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await store.updateHandshake('peer-1', { status: 'ready', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:first', lastCheckedAt: 100, lastErrorCode: null })
  const sessions = { getAccessToken: async () => 'access-secret' }
  let remote: FakeSocket
  const service = new PeerHostWsProxyService(store, sessions as never, async (_record, token) => { assert.equal(token, 'access-secret'); remote = new FakeSocket(); return remote as never })
  const client = new FakeSocket()
  await service.open('peer-1', client as never, scope)
  return { service, client, remote: remote!, store }
}

test('WebSocket 只转发完整作用域的双端白名单消息，并向当前连接报告未知远端消息', async () => {
  const { client, remote } = await setup()
  client.emit('message', JSON.stringify({ type: 'session.send', ...scope, text: 'hello' }), false)
  assert.equal(remote.sent.length, 1)
  remote.emit('message', JSON.stringify({ type: 'session.delta', ...scope, message: 'reply' }), false)
  assert.equal(client.sent.length, 1)
  remote.emit('message', JSON.stringify({ type: 'admin.secret', ...scope }), false)
  assert.equal(client.sent.length, 2)
  assert.equal(JSON.parse(client.sent[1]!).error_code, 'PEER_HOST_TOOL_UNSUPPORTED')
})

test('WebSocket 拒绝未知类型、二进制和错误作用域，并绑定双端关闭', async () => {
  const { client, remote } = await setup()
  client.emit('message', JSON.stringify({ type: 'admin.secret', ...scope }), false)
  assert.equal(JSON.parse(client.sent[0]!).error_code, 'PEER_HOST_TOOL_UNSUPPORTED')
  client.emit('message', new Uint8Array([1, 2]), true)
  assert.equal(JSON.parse(client.sent[1]!).error_code, 'PEER_HOST_PROXY_PATH_NOT_ALLOWED')
  client.emit('message', JSON.stringify({ type: 'session.send', ...scope, scopeGeneration: 2 }), false)
  assert.equal(JSON.parse(client.sent[2]!).error_code, 'PEER_HOST_SCOPE_MISMATCH')
  client.emit('close')
  assert.equal(remote.closed.length, 1)
})

test('PeerHost 不可用时不会建立目标 WebSocket', async () => {
  const { store } = await setup()
  await store.updateStatus('peer-1', 'version_mismatch', 'PEER_HOST_VERSION_MISMATCH')
  const service = new PeerHostWsProxyService(store, { getAccessToken: async () => 'secret' } as never, async () => { throw new Error('should not connect') })
  await assert.rejects(service.open('peer-1', new FakeSocket() as never, scope), /尚未准备好/u)
})

test('临时断线状态下仍允许重新建立实时数据面连接', async () => {
  const { store, service } = await setup()
  await store.updateStatus('peer-1', 'unreachable', 'PEER_HOST_UNREACHABLE')
  const client = new FakeSocket()
  await service.open('peer-1', client as never, scope)
  assert.equal(client.closed.length, 0)
})

test('session 消息缺少 sessionId 时拒绝，即使 workspace 作用域字段匹配', async () => {
  const { client, remote } = await setup()
  const workspaceScope = { ...scope, sessionId: null }
  client.emit('message', JSON.stringify({ type: 'session.send', ...workspaceScope, text: 'hello' }), false)
  assert.equal(remote.sent.length, 0)
  assert.equal(JSON.parse(client.sent[0]!).error_code, 'PEER_HOST_SCOPE_MISMATCH')
})
