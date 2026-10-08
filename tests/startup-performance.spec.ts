import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsSettingsSection } from '../src/client/settings-section.js'
import { peerHostFeature } from '../src/client/features/peer-host.js'
import { createPeerHostManagementApi } from '../src/client/peer-host-management-api.js'
import { requestPeerHostAggregateRefresh } from '../src/client/peer-host-aggregate-refresh.js'
import { startSerialPolling } from '../src/client/serial-polling.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** 只遍历 React 元素树，不执行未挂载的业务组件。 */
function findElement(tree: any, predicate: (element: any) => boolean): any {
  if (Array.isArray(tree)) return tree.map((child) => findElement(child, predicate)).find(Boolean)
  if (!tree || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  return findElement(tree.props?.children, predicate)
}

for (const defaultOpen of [false, true]) {
  test(`设置面板按首次展开挂载并在收起后保留实例，默认展开=${defaultOpen}`, () => {
    const panel = () => null
    const module = {
      descriptor: { name: 'peerHost', runtime: 'client', enabledByDefault: false, ui: { label: '测试面板', description: '', defaultOpen } },
      settingsPanel: panel,
    }
    const settings = {
      subscribe: () => () => undefined,
      getSnapshot: () => ({ status: 'ready', value: DEFAULT_CODINGNS_SETTINGS, writable: true }),
    }
    const locale = { subscribe: () => () => undefined, getSnapshot: () => ({ revision: 0 }), bind: () => (key: string) => key }
    const section = createHookRenderer(CodingNsSettingsSection, {
      settings, registry: { modules: () => [module] }, services: { dshVersion: '0.2.1-alpha.1', settings, locale },
    } as never)
    const card = findElement(section.render(), (element) => element.props?.entry?.module === module)
    assert.ok(card)
    const renderer = createHookRenderer(card.type, card.props)
    try {
      let output = renderer.render() as any
      assert.equal(Boolean(findElement(output, (element) => element.type === panel)), defaultOpen)
      output.props.onToggle({ currentTarget: { open: true } })
      output = renderer.render()
      const opened = findElement(output, (element) => element.type === panel)
      assert.ok(opened)
      output.props.onToggle({ currentTarget: { open: false } })
      output = renderer.render()
      const folded = findElement(output, (element) => element.type === panel)
      assert.ok(folded, '收起不能卸载草稿组件')
      assert.equal(folded.type, opened.type)
      assert.equal(folded.key, opened.key)
      assert.equal(output.props.open, false)
    } finally { renderer.dispose(); section.dispose() }
  })
}

test('写入完成后的刷新合并为一次后续读取，慢请求始终串行', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  let backend = 0
  const snapshots: number[] = []
  const polling = startSerialPolling(async () => {
    calls++
    const snapshot = backend
    if (calls === 1) await blocked
    snapshots.push(snapshot)
  }, 30_000)
  try {
    await tick()
    backend = 1
    const first = polling.refresh({ afterPending: true })
    assert.equal(polling.refresh({ afterPending: true }), first)
    assert.equal(calls, 1)
    release()
    await first
    assert.deepEqual(snapshots, [0, 1])
  } finally { release(); polling.dispose() }
})

test('PeerHost 启动不等待远端，停用取消请求且迟到响应不再读取工作区顺序', async () => {
  const disposers: Array<() => void> = []
  let release!: (value: unknown) => void
  const blocked = new Promise((resolve) => { release = resolve })
  const calls: string[] = []
  let signal: AbortSignal | undefined
  const start = peerHostFeature.start({
    resources: { add: (dispose: () => void) => disposers.push(dispose) },
    services: { rpc: { async call(_channel: string, endpoint: string, _payload: unknown, nextSignal?: AbortSignal) {
      calls.push(endpoint)
      signal = nextSignal
      return blocked
    } } },
  } as never)
  try {
    assert.equal(start, undefined, '慢远端不能阻塞 FeatureRegistry 后续模块')
    await tick()
    assert.deepEqual(calls, ['peerHost/aggregate'])
    const refresh = requestPeerHostAggregateRefresh()
    for (const dispose of disposers.reverse()) dispose()
    assert.equal(signal?.aborted, true)
    release({ ok: true, value: [] })
    await refresh
    assert.deepEqual(calls, ['peerHost/aggregate'])
    assert.equal(requestPeerHostAggregateRefresh(), undefined)
  } finally {
    release({ ok: true, value: [] })
    for (const dispose of disposers) dispose()
  }
})

test('PeerHost 旧 HTTP 路由回退透传取消信号，取消后不再重试', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  const api = createPeerHostManagementApi({ async call(channel, _endpoint, _payload, signal) {
    assert.equal(signal, controller.signal)
    calls.push(channel)
    if (channel !== '/api') throw new Error('HTTP 405')
    return { ok: true, value: [] }
  } })
  assert.deepEqual(await api.aggregate(controller.signal), [])
  assert.deepEqual(calls, ['/codingns', '/api'])
  controller.abort()
  await assert.rejects(api.aggregate(controller.signal), { name: 'AbortError' })
  assert.equal(calls.length, 2)
})

test('同一回合即停用的轮询不发出任何请求', async () => {
  let calls = 0
  const polling = startSerialPolling(async () => { calls++ }, 10)
  polling.dispose()
  await tick()
  assert.equal(calls, 0)
})
