import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostManagementApi } from '../data/build/dist/client/peer-host-management-api.js'
import { startPeerHostManagementPanel } from '../data/build/dist/client/peer-host-management-panel.js'
import { createPeerHostScopedClient, createPeerHostWebSocketFactory } from '../data/build/dist/client/peer-host-scoped-client.js'
import type { PeerHostProxyResponse } from '../data/build/dist/client/peer-host-scoped-client.js'
import { toPeerHostClientRecord } from '../data/build/dist/host/features/peer-host.js'
import { HostRouter } from '../data/build/dist/client/host-router.js'
import { PeerHostSessionController } from '../data/build/dist/client/peer-host-session-controller.js'
import { CODINGNS_RPC_CHANNEL } from '../data/build/dist/shared/contracts/transport.js'

test('PeerHost 管理 API 只向 Host RPC 发送目标 ID 和一次性登录参数', async () => {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  const rpc = {
    async call(channel: string, endpoint: string, payload: unknown) {
      calls.push({ channel, endpoint, payload })
      if (endpoint === 'peerHost/list') return { ok: true as const, value: [] }
      if (endpoint === 'peerHost/login') return { ok: true as const, value: { peerHostId: 'peer-1', status: 'logged_in', expiresAt: 123 } }
      if (endpoint === 'peerHost/remove') return { ok: true as const, value: null }
      if (endpoint === 'peerHost/status') return { ok: true as const, value: { cpuPercent: 12, memoryPercent: 34, memoryUsedBytes: 1, memoryTotalBytes: 2, sampledAt: 3 } }
      return { ok: true as const, value: { id: 'peer-1' } }
    },
  }
  const api = createPeerHostManagementApi(rpc)
  await api.list()
  await api.login({ peerHostId: 'peer-1', username: 'alice', password: 'password-secret' })
  await api.remove('peer-1')
  await api.enable('peer-1')
  await api.disable('peer-1')
  await api.status('peer-1')

  assert.deepEqual(calls.map((call) => call.endpoint), ['peerHost/list', 'peerHost/login', 'peerHost/remove', 'peerHost/enable', 'peerHost/disable', 'peerHost/status'])
  assert.deepEqual(calls.map((call) => call.channel), ['/codingns', '/codingns', '/codingns', '/codingns', '/codingns', '/codingns'])
  assert.deepEqual(calls[1]?.payload, { peerHostId: 'peer-1', username: 'alice', password: 'password-secret' })
  assert.equal(JSON.stringify(calls[0]?.payload).includes('token'), false)
  assert.equal(JSON.stringify(calls[2]?.payload), JSON.stringify({ peerHostId: 'peer-1' }))
})

test('PeerHost 管理 API 将 Host 错误转换为可读异常', async () => {
  const api = createPeerHostManagementApi({
    async call() {
      return { ok: false as const, error: { code: 'PEER_HOST_NOT_READY', message: 'PeerHost 尚未准备好' } }
    },
  })
  await assert.rejects(api.check('peer-1'), /PeerHost 尚未准备好/u)
})

test('PeerHost 管理 API 通过固定 RPC 获取聚合摘要，不接收目标地址', async () => {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const api = createPeerHostManagementApi({
    async call(_channel, endpoint, payload) {
      calls.push({ endpoint, payload })
      return { ok: true as const, value: [{ hostId: 'host', targetHostId: null, hostLabel: '当前 Host', availability: 'ready', errorCode: null, workspaces: [] }] }
    },
  })
  const result = await api.aggregate()
  assert.equal(result[0]?.hostId, 'host')
  assert.deepEqual(calls, [{ endpoint: 'peerHost/aggregate', payload: {} }])
  assert.equal(JSON.stringify(calls).includes('baseUrl'), false)
})

test('PeerHost 管理面板关闭后可重新打开，dispose 会移除事件监听和 DOM', async () => {
  const dom = new FakeDocument()
  const api = { list: async () => [] }
  const controller = startPeerHostManagementPanel({ document: dom as never, rpc: {} as never, api: api as never })
  dom.defaultView.dispatchEvent(new Event('codingns4dsh:peer-host-open'))
  await Promise.resolve()
  assert.equal(dom.body.children.length, 1)
  const first = dom.body.children[0]!
  const close = first.find((node) => node.tagName === 'BUTTON' && node.attributes.get('aria-label') === '关闭 PeerHost 管理')
  assert.ok(close)
  close.dispatchEvent(new Event('click'))
  assert.equal(dom.body.children.length, 0)
  dom.defaultView.dispatchEvent(new Event('codingns4dsh:peer-host-open'))
  await Promise.resolve()
  assert.equal(dom.body.children.length, 1)
  controller.dispose()
  assert.equal(dom.body.children.length, 0)
  dom.defaultView.dispatchEvent(new Event('codingns4dsh:peer-host-open'))
  assert.equal(dom.body.children.length, 0)
})

test('PeerHost 管理面板居中显示列表，并隐藏中转实现字段', async () => {
  const dom = new FakeDocument()
  const controller = startPeerHostManagementPanel({ document: dom as never, rpc: {} as never, api: { list: async () => [] } as never })
  dom.defaultView.dispatchEvent(new Event('codingns4dsh:peer-host-open'))
  await Promise.resolve()
  const panel = dom.body.children[0]!
  assert.equal(panel.style.position, 'fixed')
  assert.equal(panel.style.alignItems, 'center')
  assert.equal(panel.style.justifyContent, 'center')
  assert.ok(panel.querySelector('[data-codingns-peer-host-list]'))
  assert.equal(panel.querySelector('[data-codingns-peer-host-device-id]'), null)
  assert.equal(panel.querySelector('[data-codingns-peer-host-relay-entry-id]'), null)
  assert.equal(panel.querySelector('[data-codingns-peer-host-transport-version]'), null)
  const addButton = panel.find((node) => node.tagName === 'BUTTON' && node.attributes.get('aria-label') === '添加 Host')
  assert.ok(addButton)
  addButton.dispatchEvent(new Event('click'))
  const addForm = panel.querySelector('[data-codingns-peer-host-add-form]')
  assert.ok(addForm)
  const formDialog = panel.querySelector('[data-codingns-peer-host-form-dialog]')
  assert.equal(formDialog?.attributes.get('role'), 'dialog')
  controller.dispose()
})

test('PeerHost 作用域客户端为会话请求绑定完整 HostScope，不接受目标 URL', async () => {
  const calls: unknown[] = []
  const client = createPeerHostScopedClient({
    async call(_channel: string, endpoint: string, payload: unknown) {
      calls.push({ endpoint, payload })
      return { ok: true as const, value: { status: 200, headers: [], body: '{}' } }
    },
  })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 7 }
  await client.sendMessage(scope, '{"text":"hello"}')
  assert.deepEqual(calls, [{
    endpoint: 'peerHost/request',
    payload: {
      peerHostId: 'peer-1',
      scope,
      path: '/api/sessions/session-1/messages',
      method: 'POST',
      body: '{"text":"hello"}',
    },
  }])
  assert.throws(() => client.sendMessage({ ...scope, targetHostId: null }, '{}'), /必须包含 targetHostId/u)
  await assert.rejects(client.request(scope, 'https://target.example/api/sessions'), /固定 API 路径/u)
})

test('PeerHost 作用域请求使用统一 RPC 通道并兼容 HTTP 回退', async () => {
  const calls: Array<[string, string]> = []
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 1 }
  const client = createPeerHostScopedClient({
    async call(channel: string, endpoint: string) {
      calls.push([channel, endpoint])
      if (channel === CODINGNS_RPC_CHANNEL) throw new Error('HTTP 404')
      return { ok: true as const, value: { status: 200, headers: [], body: '{}' } }
    },
  })

  const response = await client.loadSessionHistory(scope)
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [
    [CODINGNS_RPC_CHANNEL, 'peerHost/request'],
    ['/api', 'codingns/peerHost/request'],
  ])
})

test('Host 返回的 PeerHost DTO 不包含完整路由地址或 fingerprint', () => {
  const value = toPeerHostClientRecord({
    id: 'peer-1', ownerUserId: 'user-1', displayName: '开发机',
    route: { kind: 'lan', baseUrl: 'http://192.168.1.20:13080', normalizedOrigin: 'http://192.168.1.20:13080' },
    status: 'ready', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:full-fingerprint-secret', lastCheckedAt: 1, lastErrorCode: null, createdAt: 1, updatedAt: 1,
  })
  assert.deepEqual(value.route, { kind: 'lan' })
  assert.equal(value.fingerprint, 'sha256:f...cret')
  assert.equal(JSON.stringify(value).includes('192.168.1.20'), false)
  assert.equal(JSON.stringify(value).includes('full-fingerprint-secret'), false)
})

test('PeerHost 事件流只接收同一 HostScope 的白名单事件，并可在关闭时清理', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  let closed = false
  const socket = {
    readyState: 1,
    send() {},
    close() { closed = true },
    on(event: string, listener: (...args: any[]) => void) { listeners.set(event, listener) },
  }
  const received: Record<string, unknown>[] = []
  const client = createPeerHostScopedClient({ async call() { return { ok: true as const, value: { status: 200, headers: [], body: '{}' } } } })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 7 }
  const subscription = await client.openEventStream(scope, async () => socket, (event) => received.push(event))
  listeners.get('message')?.(JSON.stringify({ type: 'session.delta', hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 7, body: 'ok' }))
  listeners.get('message')?.(JSON.stringify({ type: 'session.delta', hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 6, body: 'stale' }))
  listeners.get('message')?.(JSON.stringify({ type: 'unregistered', hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 7 }))
  assert.equal(received.length, 1)
  assert.equal(received[0]?.body, 'ok')
  subscription.close()
  assert.equal(closed, true)
})

test('PeerHost WebSocket 工具消息自动绑定 HostScope，并拒绝覆盖作用域', async () => {
  const sent: string[] = []
  const socket = {
    readyState: 1,
    send(value: string) { sent.push(value) },
    close() {},
    on() {},
  }
  const client = createPeerHostScopedClient({ async call() { return { ok: true as const, value: { status: 200, headers: [], body: '{}' } } } })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 8 }
  const subscription = await client.openEventStream(scope, async () => socket, () => undefined)
  subscription.terminalInput({ terminalId: 'terminal-1', data: 'ls\n' })
  subscription.terminalResize({ terminalId: 'terminal-1', cols: 120, rows: 32 })
  subscription.rightToolSubscribe({ toolId: 'debug' })
  subscription.rightToolRefresh({ toolId: 'debug' })
  subscription.rightToolClose({ toolId: 'debug' })
  assert.deepEqual(sent.map((value) => JSON.parse(value)), [
    { type: 'terminal.input', ...scope, terminalId: 'terminal-1', data: 'ls\n' },
    { type: 'terminal.resize', ...scope, terminalId: 'terminal-1', cols: 120, rows: 32 },
    { type: 'rightTool.subscribe', ...scope, toolId: 'debug' },
    { type: 'rightTool.refresh', ...scope, toolId: 'debug' },
    { type: 'rightTool.close', ...scope, toolId: 'debug' },
  ])
  assert.throws(() => subscription.send('terminal.input', { hostId: 'attacker' }), /不得覆盖作用域字段/u)
  assert.throws(() => subscription.send('admin.secret' as never), /未加入白名单/u)
  subscription.close()
})

test('PeerHost 浏览器 WebSocket 工厂适配标准 addEventListener 事件', async () => {
  const runtime = globalThis as typeof globalThis & { WebSocket?: unknown }
  const previous = runtime.WebSocket
  class BrowserSocket {
    static latest: BrowserSocket | undefined
    readyState = 0
    readonly sent: string[] = []
    readonly listeners = new Map<string, Array<(event: unknown) => void>>()
    readonly url: string
    constructor(url: string) { this.url = url; BrowserSocket.latest = this }
    addEventListener(event: string, listener: (value: unknown) => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    }
    send(value: string): void { this.sent.push(value) }
    close(): void { this.readyState = 3; this.emit('close', {}) }
    emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value) }
  }
  Object.defineProperty(runtime, 'WebSocket', { configurable: true, value: BrowserSocket })
  try {
    const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 13 }
    const factory = createPeerHostWebSocketFactory({ host: '127.0.0.1', port: 13080, path: '/api/codingns/peer-host/ws' }, { protocol: 'ws' })
    const socket = await factory(scope)
    const browserSocket = BrowserSocket.latest!
    assert.match(String(browserSocket.url), /targetHostId=peer-1/u)
    let opened = false
    let message = ''
    socket.on('open', () => { opened = true })
    socket.on('message', (value) => { message = String(value) })
    browserSocket.readyState = 1
    browserSocket.emit('open', {})
    browserSocket.emit('message', { data: 'event-body' })
    assert.equal(opened, true)
    assert.equal(message, 'event-body')
    socket.close()
    assert.equal(browserSocket.readyState, 3)
  } finally {
    if (previous === undefined) delete runtime.WebSocket
    else Object.defineProperty(runtime, 'WebSocket', { configurable: true, value: previous })
  }
})

test('PeerHost 事件流在无 sessionId 作用域下丢弃带会话的旧事件', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const socket = {
    readyState: 1,
    send() {},
    close() {},
    on(event: string, listener: (...args: any[]) => void) { listeners.set(event, listener) },
  }
  const received: Record<string, unknown>[] = []
  const client = createPeerHostScopedClient({ async call() { return { ok: true as const, value: { status: 200, headers: [], body: '{}' } } } })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: null, scopeGeneration: 9 }
  const subscription = await client.openEventStream(scope, async () => socket, (event) => received.push(event))
  listeners.get('message')?.(JSON.stringify({ type: 'workbench.snapshot', ...scope, body: 'ok' }))
  listeners.get('message')?.(JSON.stringify({ type: 'workbench.snapshot', ...scope, sessionId: 'stale-session', body: 'stale' }))
  assert.equal(received.length, 1)
  assert.equal(received[0]?.body, 'ok')
  subscription.close()
})

test('PeerHost 事件流断线后只按有限次数重连，关闭作用域会取消重连', async () => {
  const sockets: Array<{ readyState: number; close: () => void; on: (event: string, listener: (...args: any[]) => void) => void }> = []
  const listeners: Array<Map<string, (...args: any[]) => void>> = []
  let calls = 0
  const factory = async () => {
    const eventListeners = new Map<string, (...args: any[]) => void>()
    const socket = {
      readyState: 1,
      close() { socket.readyState = 3; eventListeners.get('close')?.() },
      on(event: string, listener: (...args: any[]) => void) { eventListeners.set(event, listener) },
    }
    sockets.push(socket)
    listeners.push(eventListeners)
    calls += 1
    return socket
  }
  const client = createPeerHostScopedClient({ async call() { return { ok: true as const, value: { status: 200, headers: [], body: '{}' } } } })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 10 }
  const subscription = await client.openEventStream(scope, factory, () => undefined, { maxReconnectAttempts: 1, reconnectDelaysMs: [0] })
  sockets[0]!.readyState = 3
  listeners[0]!.get('close')?.()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls, 2)
  subscription.close()
  sockets[1]!.readyState = 3
  listeners[1]!.get('close')?.()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls, 2)
})

test('PeerHost 事件流等待 CONNECTING socket 打开，并在重连后重放幂等订阅', async () => {
  type TestSocket = { readyState: number; sent: string[]; close: () => void; on: (event: string, listener: (...args: any[]) => void) => void; emit: (event: string, ...args: any[]) => void }
  const makeSocket = (initialState: number): TestSocket => {
    const listeners = new Map<string, Array<(...args: any[]) => void>>()
    const socket: TestSocket = {
      readyState: initialState,
      sent: [],
      send(value) { socket.sent.push(value) },
      close() { socket.readyState = 3; socket.emit('close') },
      on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
      emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args) },
    }
    return socket
  }
  const sockets: TestSocket[] = []
  const factory = async () => {
    const socket = makeSocket(0)
    sockets.push(socket)
    return socket
  }
  const client = createPeerHostScopedClient({ async call() { return { ok: true as const, value: { status: 200, headers: [], body: '{}' } } } })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 11 }
  const pending = client.openEventStream(scope, factory, () => undefined, { maxReconnectAttempts: 1, reconnectDelaysMs: [0] })
  sockets[0]!.readyState = 1
  sockets[0]!.emit('open')
  const subscription = await pending
  subscription.send('session.subscribe')
  sockets[0]!.readyState = 3
  sockets[0]!.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(sockets.length, 2)
  sockets[1]!.readyState = 1
  sockets[1]!.emit('open')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!), { type: 'session.subscribe', ...scope })
  subscription.close()
})

test('PeerHost 事件流关闭时会清理尚未打开的重连 socket', async () => {
  type TestSocket = { readyState: number; closeCount: number; close: () => void; on: (event: string, listener: (...args: any[]) => void) => void; emit: (event: string, ...args: any[]) => void }
  const makeSocket = (initialState: number): TestSocket => {
    const listeners = new Map<string, Array<(...args: any[]) => void>>()
    const socket: TestSocket = {
      readyState: initialState,
      closeCount: 0,
      close() { socket.closeCount += 1; socket.readyState = 3; socket.emit('close') },
      on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
      emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args) },
    }
    return socket
  }
  const first = makeSocket(1)
  const second = makeSocket(0)
  let calls = 0
  const client = createPeerHostScopedClient({ async call() { return { ok: true as const, value: { status: 200, headers: [], body: '{}' } } } })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 12 }
  const subscription = await client.openEventStream(scope, async () => { calls += 1; return calls === 1 ? first : second }, () => undefined, { maxReconnectAttempts: 1, reconnectDelaysMs: [0] })
  first.readyState = 3
  first.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 5))
  subscription.close()
  assert.equal(second.closeCount, 1)
})

test('PeerHost 会话控制器切换作用域后拒绝旧历史结果并清理旧订阅', async () => {
  let resolveHistory: ((value: unknown) => void) | undefined
  let closeCount = 0
  const client = {
    async loadSessionHistory() { return await new Promise((resolve) => { resolveHistory = resolve }) as never },
    async sendMessage() { return { status: 200, headers: [], body: '{}' } },
    async stopSession() { return { status: 200, headers: [], body: '{}' } },
    async replyPermission() { return { status: 200, headers: [], body: '{}' } },
    async answerQuestion() { return { status: 200, headers: [], body: '{}' } },
    async openEventStream() { return { close: () => { closeCount += 1 } } },
  }
  const router = new HostRouter()
  const controller = new PeerHostSessionController(router, client as never)
  const first = await controller.select({ hostId: 'host', targetHostId: 'peer-1', workspaceId: 'w', sessionId: 's-1' })
  const pending = controller.loadHistory(first)
  const second = await controller.select({ hostId: 'host', targetHostId: 'peer-1', workspaceId: 'w', sessionId: 's-2' })
  resolveHistory?.({ status: 200, headers: [], body: '{}' })
  await assert.rejects(pending, /HostScope 已失效/u)
  await controller.subscribe(second, async () => ({ readyState: 1, send() {}, close() { closeCount += 1 }, on() {} }), () => undefined)
  await router.clear()
  assert.equal(closeCount, 1)
})

test('PeerHost 会话控制器重连后强制递增 generation、清理旧订阅并刷新摘要', async () => {
  let closeCount = 0
  const client = {
    async loadSessionHistory() { return { status: 200, headers: [], body: '{}' } },
    async sendMessage() { return { status: 200, headers: [], body: '{}' } },
    async stopSession() { return { status: 200, headers: [], body: '{}' } },
    async replyPermission() { return { status: 200, headers: [], body: '{}' } },
    async answerQuestion() { return { status: 200, headers: [], body: '{}' } },
    async openEventStream() {
      return {
        close: () => { closeCount += 1 },
        send() {}, terminalInput() {}, terminalResize() {}, terminalClose() {},
        rightToolSubscribe() {}, rightToolRefresh() {}, rightToolClose() {},
      }
    },
  }
  const router = new HostRouter()
  const controller = new PeerHostSessionController(router, client as never)
  const first = await controller.select({ hostId: 'host', targetHostId: 'peer-1', workspaceId: 'w', sessionId: 's-1' })
  await controller.subscribe(first, async () => ({ readyState: 1, send() {}, close() {}, on() {} }), () => undefined)
  let refreshed: typeof first | undefined
  const next = await controller.rebuildAfterReconnect(first, (scope) => { refreshed = scope })
  assert.equal(next.scopeGeneration, first.scopeGeneration + 1)
  assert.deepEqual(refreshed, next)
  assert.equal(closeCount, 1)
  assert.equal(controller.current()?.scopeGeneration, next.scopeGeneration)
})

test('PeerHost 会话控制器的发送、停止、权限和问题回答在切换后全部丢弃旧结果', async () => {
  let resolvePending: ((value: PeerHostProxyResponse) => void) | undefined
  const pending = (): Promise<PeerHostProxyResponse> => new Promise((resolve) => { resolvePending = resolve })
  const client = {
    async loadSessionHistory() { return { status: 200, headers: [], body: '{}' } },
    sendMessage: pending,
    stopSession: pending,
    replyPermission: pending,
    answerQuestion: pending,
    async openEventStream() {
      return {
        close() {}, send() {}, terminalInput() {}, terminalResize() {}, terminalClose() {},
        rightToolSubscribe() {}, rightToolRefresh() {}, rightToolClose() {},
      }
    },
  }
  const controller = new PeerHostSessionController(new HostRouter(), client as never)
  const operations: Array<(scope: Parameters<PeerHostSessionController['sendMessage']>[0]) => Promise<PeerHostProxyResponse>> = []
  // 通过控制器公开方法逐一验证，不能绕过当前作用域检查。
  operations.push((scope) => controller.sendMessage(scope, '{}'))
  operations.push((scope) => controller.stop(scope))
  operations.push((scope) => controller.replyPermission(scope, '{}'))
  operations.push((scope) => controller.answerQuestion(scope, '{}'))
  for (const [index, operation] of operations.entries()) {
    const scope = await controller.select({ hostId: 'host', targetHostId: 'peer-1', workspaceId: 'w', sessionId: `s-${index}` })
    const result = operation(scope)
    await controller.select({ hostId: 'host', targetHostId: 'peer-1', workspaceId: 'w', sessionId: `next-${index}` })
    resolvePending?.({ status: 200, headers: [], body: '{}' })
    await assert.rejects(result, /HostScope 已失效/u)
  }
})

class FakeElement {
  readonly children: FakeElement[] = []
  readonly style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  parentElement: FakeElement | null = null
  ownerDocument!: FakeDocument
  tagName: string
  textContent = ''
  value = ''
  type = ''
  required = false
  hidden = false

  constructor(tagName: string) { this.tagName = tagName.toUpperCase() }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) { node.parentElement = this; node.ownerDocument = this.ownerDocument; this.children.push(node) }
  }

  remove(): void {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }

  addEventListener(name: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(name) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  removeEventListener(name: string, listener: (event: Event) => void): void { this.listeners.get(name)?.delete(listener) }

  dispatchEvent(event: Event): void { for (const listener of this.listeners.get(event.type) ?? []) listener(event) }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    for (const child of this.children) {
      if (matches(child, selector)) return child as T
      const nested = child.querySelector<T>(selector)
      if (nested !== null) return nested
    }
    return null
  }

  find(predicate: (node: FakeElement) => boolean): FakeElement | null {
    for (const child of this.children) { if (predicate(child)) return child; const nested = child.find(predicate); if (nested !== null) return nested }
    return null
  }
}

class FakeDocument {
  readonly body = new FakeElement('body')
  readonly defaultView = new FakeElement('window')

  constructor() {
    this.body.ownerDocument = this
    this.defaultView.ownerDocument = this
    this.defaultView.prompt = () => null
    this.defaultView.confirm = () => false
  }

  createElement(tagName: string): FakeElement { const element = new FakeElement(tagName); element.ownerDocument = this; return element }
}

function matches(element: FakeElement, selector: string): boolean {
  const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector)
  if (attribute === null) return false
  return element.attributes.has(attribute[1]!) && (attribute[2] === undefined || element.attributes.get(attribute[1]!) === attribute[2])
}
