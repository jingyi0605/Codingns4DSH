import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  fetchSidebarSessionBundle,
  injectSidebarSessionCompat,
  installSidebarSessionCompat,
  patchSidebarSessionBundle,
} from '../src/dsh-capabilities/host/sidebar-session-compat.ts'

const require = createRequire(import.meta.url)
// 使用仓库锁定的上游实际实现回放生命周期，防止测试只证明补丁字符串存在。
const nativeBundle = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/client'), 'utf8')
const moduleId = '@deepseek-ai/dsh-client-ui-sidebar-right'
const bundleUrl = `plugins/??${moduleId}/client.js&rev=native-rev`
const compatUrl = `__codingns/sidebar-session-v1/${bundleUrl}`

function createView(source: string) {
  const start = source.indexOf('var SidebarSessionView = class {')
  const end = source.indexOf('//#endregion', start)
  assert.ok(start >= 0 && end > start, '锁定的原生 SidebarSessionView 必须存在')
  const errors: unknown[][] = []
  const View = runInNewContext(`${source.slice(start, end)}; SidebarSessionView`, {
    console: { error: (...args: unknown[]) => errors.push(args) },
  })
  const opening = Promise.withResolvers<object>()
  let releases = 0
  const reference = {
    ready: opening.promise,
    release() {
      releases += 1
      opening.reject(new Error('Session reference "test-session" is released'))
    },
  }
  const view = new View('test-session', {
    retain(sessionId: string, options: { source: string }) {
      assert.equal(sessionId, 'test-session')
      assert.equal(options.source, 'sidebarView')
      return reference
    },
  }, () => undefined, () => undefined)
  return { view, opening, reference, errors, releases: () => releases }
}

test('上游原生代码可复现：打开未完成时卸载侧栏会误报 released', async () => {
  const state = createView(nativeBundle)
  const unmount = state.view.mount()
  state.view.retire()
  assert.equal(state.releases(), 0)
  unmount()
  await Promise.resolve()
  assert.equal(state.releases(), 1)
  assert.equal(state.errors.length, 1)
  assert.equal(state.errors[0]?.[0], 'Sidebar Session opening failed:')
  assert.match(String(state.errors[0]?.[1]), /is released/u)
})

test('修复后退休视图等最后一次卸载才释放，取消不误报且 ready 保持拒绝', async () => {
  const state = createView(patchSidebarSessionBundle(nativeBundle))
  const unmountFirst = state.view.mount()
  const unmountLast = state.view.mount()
  state.view.retire()
  unmountFirst()
  assert.equal(state.releases(), 0)
  unmountLast()
  state.view.dispose()
  await assert.rejects(state.reference.ready, /is released/u)
  assert.equal(state.releases(), 1)
  assert.deepEqual(state.errors, [])
})

test('未挂载视图撤销及插件直接销毁都只释放一次且不误报', async () => {
  for (const action of ['retire', 'dispose']) {
    const state = createView(patchSidebarSessionBundle(nativeBundle))
    state.view[action]()
    state.view.dispose()
    await Promise.resolve()
    assert.equal(state.releases(), 1)
    assert.deepEqual(state.errors, [])
  }
})

test('活跃视图真实打开失败仍完整报告原始错误', async () => {
  const state = createView(patchSidebarSessionBundle(nativeBundle))
  const error = new Error('Session opening failed: transport disconnected')
  state.opening.reject(error)
  await Promise.resolve()
  assert.equal(state.errors.length, 1)
  assert.equal(state.errors[0]?.[1], error)
  assert.equal(state.releases(), 0)
  state.view.dispose()
})

test('成功打开仍返回原绑定，不改变后续释放', async () => {
  const state = createView(patchSidebarSessionBundle(nativeBundle))
  const binding = { sessionId: 'test-session' }
  state.opening.resolve(binding)
  assert.equal(await state.reference.ready, binding)
  state.view.dispose()
  assert.equal(state.releases(), 1)
  assert.deepEqual(state.errors, [])
})

test('补丁幂等、保持行数、未知格式原样返回', () => {
  const patched = patchSidebarSessionBundle(nativeBundle)
  assert.notEqual(patched, nativeBundle)
  assert.equal(patchSidebarSessionBundle(patched), patched)
  assert.equal(patched.split('\n').length, nativeBundle.split('\n').length)
  const other = 'console.error("Sidebar Session opening failed:", error);'
  assert.equal(patchSidebarSessionBundle(other), other)
  assert.equal(patchSidebarSessionBundle('var SidebarSessionView = class {}'), 'var SidebarSessionView = class {}')
})

function createInjections() {
  const otherUrl = 'plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=bootstrap-rev'
  const graph = {
    rev: 'graph-rev',
    entries: [{ id: moduleId, url: bundleUrl, rev: 'native-rev' }, { id: 'other', url: otherUrl, rev: 'bootstrap-rev' }],
    batches: [
      { phase: 'application', url: bundleUrl, rev: 'native-rev', entries: [moduleId] },
      { phase: 'bootstrap', url: otherUrl, rev: 'bootstrap-rev', entries: ['other'] },
    ],
  }
  const table = [
    { kind: 'script-preload', src: bundleUrl },
    { kind: 'script-src', src: otherUrl },
    { kind: 'global', name: '__DSH_BOOT__', value: graph },
  ]
  return { table, graph, otherUrl }
}

test('预加载、批次、单模块回退一致使用新 URL，不修改原生共享图', () => {
  const { table, graph, otherUrl } = createInjections()
  injectSidebarSessionCompat(table)
  const updated = table[2]!.value!
  assert.equal(table[0]!.src, compatUrl)
  assert.equal(table[1]!.src, otherUrl)
  assert.equal(updated.entries[0]!.url, compatUrl)
  assert.equal(updated.batches[0]!.url, compatUrl)
  assert.equal(updated.entries[1]!.url, otherUrl)
  assert.equal(graph.entries[0]!.url, bundleUrl)
  assert.equal(graph.batches[0]!.url, bundleUrl)
  const snapshot = JSON.stringify(table)
  injectSidebarSessionCompat(table)
  assert.equal(JSON.stringify(table), snapshot)
  assert.equal(new URL(compatUrl, 'https://example.test/stage0/').pathname, '/stage0/__codingns/sidebar-session-v1/plugins/')
})

test('组合批次保留其他模块、绝对 URL 语义和未知注入行', () => {
  const combined = `/plugins/??other/client.js,${moduleId}/client.js&rev=batch-rev`
  const table = [null, { kind: 'script-preload', src: combined }, { kind: 'global', name: 'OTHER', value: combined }]
  injectSidebarSessionCompat(table)
  assert.equal(table[1]!.src, `/__codingns/sidebar-session-v1${combined}`)
  assert.equal(table[2]!.value, combined)
  assert.equal(table[0], null)
})

test('注入到资源响应的完整链路实际执行已修复的原生视图', async () => {
  const { table } = createInjections()
  injectSidebarSessionCompat(table)
  const requested: Request[] = []
  const response = await fetchSidebarSessionBundle({
    async fetchBundle(request) {
      requested.push(request)
      return new Response(nativeBundle, { headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': String(Buffer.byteLength(nativeBundle)),
        etag: 'original',
      } })
    },
  }, { method: 'GET', url: `/${table[0]!.src}` })
  assert.equal(requested[0]!.url, `http://dsh.invalid/${bundleUrl}`)
  assert.equal(response.headers.get('content-length'), null)
  assert.equal(response.headers.get('etag'), null)
  assert.match(response.headers.get('cache-control')!, /immutable/u)
  const state = createView(await response.text())
  state.view.dispose()
  await Promise.resolve()
  assert.deepEqual(state.errors, [])
  assert.equal(state.releases(), 1)
})

test('HEAD、source map 和未知修订的 404 原样透传，非法方法不调用原生服务', async () => {
  for (const [method, source, status, contentType] of [
    ['HEAD', null, 200, 'text/javascript'],
    ['GET', '{"version":3}', 200, 'application/json'],
    ['GET', null, 404, 'text/plain'],
  ] as const) {
    const original = new Response(source, { status, headers: { 'content-type': contentType } })
    const url = contentType === 'application/json' ? compatUrl.replace('client.js&', 'client.js.map&') : compatUrl
    const result = await fetchSidebarSessionBundle({ fetchBundle: async (request) => {
      assert.equal(request.url, `http://dsh.invalid/${url.replace('__codingns/sidebar-session-v1/', '')}`)
      assert.equal(request.method, method)
      return original
    } }, { method, url: `/${url}` })
    assert.equal(result, original)
  }
  const modules = { fetchBundle: async () => { throw new Error('不应调用原生服务') } }
  assert.equal((await fetchSidebarSessionBundle(modules, { method: 'POST', url: `/${compatUrl}` })).status, 405)
  assert.equal((await fetchSidebarSessionBundle(modules, { url: '/not-a-plugin' })).status, 404)
})

test('兼容层只为已核对版本注册 Web 资源路由和页面注入，路由随 effect 注销', () => {
  const routes: Array<{ path: string }> = []
  const listeners: Array<(table: unknown[]) => void> = []
  const disposers: Array<() => void> = []
  const ctx = {
    clientModules: { fetchBundle: async () => new Response() },
    webServer: { register(route: { path: string }) { routes.push(route); return () => { routes.pop() } } },
    effect(setup: () => () => void) { disposers.push(setup()) },
    on(name: string, listener: (table: unknown[]) => void) { assert.equal(name, 'webserver/index-inject'); listeners.push(listener) },
  }
  installSidebarSessionCompat(ctx as never, '0.2.0-rc.2')
  assert.equal(routes.length, 0)
  installSidebarSessionCompat(ctx as never, '0.2.1-alpha.1')
  assert.equal(routes[0]!.path, '/__codingns/sidebar-session-v1')
  const { table } = createInjections()
  listeners[0]!(table)
  assert.equal(table[0]!.src, compatUrl)
  disposers[0]!()
  assert.equal(routes.length, 0)
})
