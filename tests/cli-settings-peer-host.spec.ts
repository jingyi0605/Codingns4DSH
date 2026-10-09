import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { isValidElement } from 'react'
import type { ReactElement } from 'react'
import { callCliRpc } from '../src/client/cli-catalog.js'
import { createCliSettingsRpc } from '../src/client/cli-settings-rpc.js'
import { CliAdaptersPanel } from '../src/client/features/cli-adapters.js'
import type { CodingNsRpcClient, CodingNsRpcResult, FeaturePanelProps } from '../src/client/features/types.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../src/shared/contracts/transport.js'
import type { PeerHostClientRecord } from '../src/shared/contracts/peer-host.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { registerCodingNsRpc } from '../src/host/rpc.js'
import { PeerHostHttpProxyService } from '../src/host/modules/peer-host/host-api-proxy-service.js'
import { InMemoryPeerHostCredentialStore, InMemoryPeerHostRecordStore, PeerHostStore } from '../src/host/modules/peer-host/peer-host-store.js'

const t = resolveCodingNsTranslator()
const adapter = (name: string, version = '1') => ({ id: 'codex', name, installed: true, enabled: true, version, command: `/tools/${name}` })
const hosts = ['peer-a', 'peer-b'].map(id => ({ id, displayName: id, status: 'ready', route: { kind: 'lan' }, visibleWorkspaceIds: [] })) as unknown as PeerHostClientRecord[]
const success = (value: unknown): CodingNsRpcResult => ({ ok: true, value })
const proxyResponse = (value: unknown) => success({ status: 200, headers: [], body: JSON.stringify({ result: success(value) }) })
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}
const find = (node: unknown, label: string) => elements(node).find(element => element.props['aria-label'] === label)!
const texts = (node: unknown): string => Array.isArray(node) ? node.map(texts).join(' ') : isValidElement(node) ? texts((node.props as any).children) : typeof node === 'string' ? node : ''
function panel(rpc: CodingNsRpcClient) {
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  value.modules.peerHost = true
  const snapshot = { value, status: 'ready', writable: true }
  const notices: unknown[] = []
  const mutations: unknown[] = []
  const props = { enabled: true, snapshot, notify: (notice: unknown) => notices.push(notice), services: { rpc,
    locale: { bind: () => t, getSnapshot: () => ({ revision: 1 }), subscribe: () => () => {} },
    settings: { mutate: async (patch: unknown) => { mutations.push(patch); return true } },
  } } as unknown as FeaturePanelProps
  const renderer = createHookRenderer(CliAdaptersPanel, props)
  return { ...renderer, notices, mutations, props,
    async flush() { await setImmediate(); renderer.render(); await setImmediate(); return renderer.render() },
    switchHost(host: string) { find(renderer.render(), t('cli.agentHost')).props.onChange({ currentTarget: { value: host } }); return renderer.render() },
  }
}

test('PeerHost 设置目录通过真实 HTTP 白名单与目标 RPC 刷新注册表，无工作区也可查询', async context => {
  let detections = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: '远端 Codex' },
    async detect() { return { installed: true, version: String(++detections), command: '/remote/codex' } },
    async listModels() { return { groups: [{ id: 'remote', name: '远端模型', models: [{ id: 'remote-model', name: '远端模型', efforts: [] }] }], currentModel: null, currentEffort: null } },
    async *executeTurn() { assert.fail('设置查询不能执行任务') },
  }])
  const table = new CodingNsRpcTable()
  const features = new FeatureRegistry({ rpc: table })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  context.after(() => features.disable('cliAdapters'))
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const disposers: (() => void)[] = []
  registerCodingNsRpc({
    effect(callback: () => () => void) { disposers.push(callback()) },
    webServer: { register() { return () => {} } },
    connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) { routes.set(route.path, route.fetch); return () => {} } } },
  } as never, table)
  context.after(() => disposers.forEach(dispose => dispose()))
  const store = new PeerHostStore('user', new InMemoryPeerHostRecordStore(), new InMemoryPeerHostCredentialStore(), () => 100, () => 'peer-a')
  await store.create({ displayName: '远端', route: { kind: 'lan', baseUrl: 'http://target.test', normalizedOrigin: '' } })
  await store.updateStatus('peer-a', 'ready', null)
  const paths: string[] = []
  const proxy = new PeerHostHttpProxyService(store, { getAccessToken: async () => 'target-token' } as never, {
    fetchImpl: async (input, init) => {
      const request = new Request(String(input), init)
      assert.equal(request.headers.get('authorization'), 'Bearer target-token')
      const path = new URL(request.url).pathname
      paths.push(path)
      return routes.get(path)!(request)
    },
  })
  for (const fallback of [false, true]) {
    const rpc: CodingNsRpcClient = { call: async (channel, endpoint, payload) => {
      if (fallback && channel === CODINGNS_RPC_CHANNEL) throw new Error('HTTP 405')
      assert.equal(endpoint, fallback ? 'codingns/peerHost/request' : 'peerHost/request')
      const input = payload as Parameters<typeof proxy.request>[1] & { peerHostId: string }
      assert.equal(input.scope.workspaceId, '__aggregate__')
      assert.equal(input.scope.sessionId, null)
      return success(await proxy.request(input.peerHostId, input))
    } }
    const remote = createCliSettingsRpc(rpc, 'peer-a')
    const before = detections
    await callCliRpc(remote, 'catalog', {})
    assert.equal(detections, before, '查看目录不能触发检测')
    const single = await callCliRpc<ReturnType<typeof adapter>[]>(remote, 'catalog/refresh', { adapterId: 'codex' })
    assert.equal(single[0]?.version, String(before + 1))
    assert.equal(single[0]?.command, '/remote/codex')
    await callCliRpc(remote, 'catalog/refresh', {})
    assert.equal(detections, before + 2)
    const models = await callCliRpc<{ groups: { id: string }[] }>(remote, 'models', { adapterId: 'codex' })
    assert.equal(models.groups[0]?.id, 'remote')
    const count = paths.length
    await assert.rejects(callCliRpc(remote, 'adapter/set', { adapterId: 'codex', enabled: false }), /只支持查看和刷新/u)
    assert.equal(paths.length, count, '远端启用修改不发送请求')
  }
})

test('远端错误、旧版不支持与非法响应保留真实原因，不回落本机目录', async () => {
  for (const response of [
    { status: 401, body: JSON.stringify({ error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '目标 Host 需要登录' } }), expected: /目标 Host 需要登录/u },
    { status: 200, body: JSON.stringify({ result: { ok: false, error: { code: 'Error', message: '未知 CLI RPC: cli/catalog/refresh' } } }), expected: /未知 CLI RPC/u },
    { status: 200, body: 'invalid', expected: /响应格式无效/u },
    { status: 200, body: JSON.stringify({ result: { ok: true } }), expected: /响应格式无效/u },
    { status: 404, body: 'not found', expected: /HTTP 404/u },
  ]) {
    const calls: string[] = []
    const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => { calls.push(endpoint); return success({ ...response, headers: [] }) } }
    await assert.rejects(callCliRpc(createCliSettingsRpc(rpc, 'peer-a'), 'catalog/refresh', {}), response.expected)
    assert.deepEqual(calls, ['peerHost/request'])
  }
})

test('PeerHost 目录查询的取消信号贯穿代理和旧通道回退，已取消请求不再发送', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, _payload, signal) => {
    calls.push(endpoint)
    assert.equal(signal, controller.signal)
    if (endpoint === 'peerHost/request') throw new Error('HTTP 405')
    return proxyResponse([adapter('peer-a')])
  } }
  const remote = createCliSettingsRpc(rpc, 'peer-a')
  await callCliRpc(remote, 'catalog', {}, controller.signal)
  assert.deepEqual(calls, ['peerHost/request', 'codingns/peerHost/request'])
  controller.abort(new Error('查询已取消'))
  await assert.rejects(callCliRpc(remote, 'catalog', {}, controller.signal), /查询已取消/u)
  assert.equal(calls.length, 2)
})

test('设置页切换本机与多个 PeerHost，单个及全部刷新、详情均绑定所选 Host', async context => {
  const calls: { host: string | null; method: string; payload: any }[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload) => {
    if (endpoint === 'peerHost/list') return success(hosts)
    const input = payload as any
    const remote = endpoint === 'peerHost/request'
    const envelope = remote ? JSON.parse(input.body) : { method: endpoint, payload: input }
    const host = remote ? input.peerHostId : null
    calls.push({ host, ...envelope })
    const value = envelope.method === 'cli/models' ? { groups: [], currentModel: host, currentEffort: null } : [adapter(host ?? '本机')]
    return remote ? proxyResponse(value) : success(value)
  } }
  const view = panel(rpc); context.after(() => view.dispose())
  view.render(); let output = await view.flush()
  assert.match(texts(output), /本机/u)
  assert.ok(calls.some(call => call.host === null && call.payload.catalogHostId === 'local'))
  for (const host of ['peer-a', 'peer-b']) {
    view.switchHost(host); output = await view.flush()
    assert.ok(texts(output).includes(host))
    assert.equal(find(output, t('cli.adapterToggle', { name: host })).props.disabled, true)
    assert.equal(find(output, t('cli.subagentBridgeToggle')), undefined, '远端不展示本机托管设置')
    find(output, t('cli.adapterToggle', { name: host })).props.onChange({ currentTarget: { checked: false } })
    assert.equal(calls.some(call => call.method === 'cli/adapter/set'), false)
    for (const label of [`${host} · ${t('cli.redetect')}`, t('cli.redetectAll')]) {
      const button = elements(view.render()).find(element => element.props.label === label)!
      button.props.onClick(); await view.flush()
      assert.ok(calls.some(call => call.host === host && call.method === 'cli/catalog/refresh'
        && (label === t('cli.redetectAll') ? !call.payload.adapterId : call.payload.adapterId === 'codex')))
    }
    find(view.render(), t('cli.viewDetails', { name: host })).props.onClick(); output = await view.flush()
    const dialog = elements(output).find(element => typeof element.type === 'function' && element.props.hostLabel === host && element.props.adapter)!
    assert.equal(dialog.props.adapter.command, `/tools/${host}`)
    assert.equal(dialog.props.models.currentModel, host)
    assert.equal(calls.at(-1)?.host, host)
  }
  view.switchHost(''); output = await view.flush()
  assert.ok(find(output, t('cli.subagentBridgeToggle')))
  assert.equal(find(output, t('cli.adapterToggle', { name: '本机' })).props.disabled, false)
  find(output, t('cli.adapterToggle', { name: '本机' })).props.onChange({ currentTarget: { checked: false } })
  await view.flush()
  assert.ok(calls.some(call => call.host === null && call.method === 'cli/adapter/set'))
  assert.deepEqual(view.mutations, [], '切换、查看和刷新不能写插件设置')
})

test('切换后迟到的远端列表、刷新与模型结果不能覆盖当前 Host，往返同一 Host 也隔离', async context => {
  const pending: { host: string; method: string; resolve: (value: CodingNsRpcResult) => void }[] = []
  let defer = false
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload) => {
    if (endpoint === 'peerHost/list') return success(hosts)
    if (endpoint !== 'peerHost/request') return success([adapter('本机')])
    const input = payload as any
    const { method } = JSON.parse(input.body)
    if (defer) return new Promise(resolve => pending.push({ host: input.peerHostId, method, resolve }))
    return proxyResponse(method === 'cli/models' ? { groups: [], currentModel: input.peerHostId } : [adapter(input.peerHostId)])
  } }
  const view = panel(rpc); context.after(() => view.dispose())
  view.render(); await view.flush()
  defer = true
  view.switchHost('peer-a'); await view.flush()
  view.switchHost('peer-b'); await view.flush()
  pending.find(item => item.host === 'peer-b')!.resolve(proxyResponse([adapter('peer-b')]))
  await view.flush()
  pending.find(item => item.host === 'peer-a')!.resolve(proxyResponse([adapter('迟到的 A')]))
  assert.ok(!texts(await view.flush()).includes('迟到的 A'))
  defer = false
  view.switchHost('peer-a'); await view.flush()
  defer = true
  find(view.render(), t('cli.viewDetails', { name: 'peer-a' })).props.onClick(); await view.flush()
  elements(view.render()).find(element => element.props.label === t('cli.redetectAll'))!.props.onClick(); await view.flush()
  const oldRefresh = pending.find(item => item.method === 'cli/catalog/refresh')!
  const oldModels = pending.find(item => item.method === 'cli/models')!
  defer = false
  view.switchHost('peer-b'); await view.flush()
  view.switchHost('peer-a'); await view.flush()
  oldRefresh.resolve(proxyResponse([adapter('过时刷新')]))
  oldModels.resolve(proxyResponse({ groups: [], currentModel: '过时模型' }))
  const output = await view.flush()
  assert.ok(!texts(output).includes('过时刷新'))
  assert.equal(elements(output).some(element => element.props.models?.currentModel === '过时模型'), false)
  assert.deepEqual(view.notices, [])
})

test('远端连接不可用和查询失败显示原因；禁用模块不查询，失败不伪装为空目录', async context => {
  const calls: string[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'peerHost/list') return success([...hosts, { ...hosts[0], id: 'offline', displayName: '离线主机', status: 'disabled' }])
    if (endpoint === 'peerHost/request') return success({ status: 401, body: JSON.stringify({ error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '目标 Host 需要登录' } }) })
    return success([adapter('本机')])
  } }
  const view = panel(rpc); context.after(() => view.dispose())
  view.render(); await view.flush()
  const before = calls.length
  view.switchHost('offline'); let output = await view.flush()
  assert.equal(calls.length, before)
  assert.ok(texts(output).includes('暂不可用'))
  assert.equal(elements(output).find(element => element.props.label === t('cli.redetectAll'))!.props.disabled, true)
  view.switchHost('peer-a'); output = await view.flush()
  assert.ok(elements(output).some(element => element.props.role === 'alert' && texts(element).includes('目标 Host 需要登录')))
  assert.ok(!texts(output).includes(t('cli.noAgents')))
  const count = calls.length
  view.render({ ...view.props, enabled: false }); await view.flush()
  assert.equal(calls.length, count)
})

test('Host 选择器重新获取焦点时更新登记列表，移除所选 Host 后恢复本机', async context => {
  let registered = hosts
  let fail = false
  let lists = 0
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, _payload, signal) => {
    if (endpoint === 'peerHost/list') {
      lists++
      assert.ok(signal instanceof AbortSignal)
      if (fail) throw new Error('主机列表读取失败')
      return success(registered)
    }
    if (endpoint === 'peerHost/request') return proxyResponse([adapter('远端')])
    return success([adapter('本机')])
  } }
  const view = panel(rpc); context.after(() => view.dispose())
  view.render(); await view.flush()
  view.switchHost('peer-a'); await view.flush()
  registered = [hosts[1]!]
  find(view.render(), t('cli.agentHost')).props.onFocus()
  let output = await view.flush()
  assert.equal(lists, 2)
  assert.equal(find(output, t('cli.agentHost')).props.value, '')
  assert.ok(texts(output).includes('本机'))
  fail = true
  find(output, t('cli.agentHost')).props.onFocus(); output = await view.flush()
  assert.ok(elements(output).some(element => element.props.role === 'alert' && texts(element).includes('主机列表读取失败')))
  assert.ok(find(output, t('cli.adapterToggle', { name: '本机' })), '读取远端主机列表失败不能影响本机 Agent')
  view.render({ ...view.props, snapshot: { ...view.props.snapshot, value: { ...view.props.snapshot.value!, modules: { peerHost: false } } } })
  output = await view.flush()
  const before = lists
  find(output, t('cli.agentHost')).props.onFocus(); await view.flush()
  assert.equal(lists, before, '停用 PeerHost 模块后不再读取主机列表')
  assert.equal(elements(output).filter(element => element.type === 'option').length, 1)
})
