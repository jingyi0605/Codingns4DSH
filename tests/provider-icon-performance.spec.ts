import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { createProviderIconHandler, registerProviderIconRoutes } from '../src/host/provider-icon-assets.js'
import { PROVIDER_ICON_FILES, PROVIDER_ICON_PATH } from '../src/shared/provider-icon-resources.js'
import { installProviderIconImageBridge } from '../src/client/provider-icon-bridge.js'
import { RemoteDshWebContext } from '../src/client/remote-web-context.js'
import { registerCodingNsRpc } from '../src/host/rpc.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const request = (filename: string, method = 'GET') => new Request(`https://host.test${PROVIDER_ICON_PATH}${filename}?v=1`, { method })

test('图标注册零读取、固定白名单、并发合并和失败重试', async () => {
  let reads = 0
  let fail = true
  const handler = createProviderIconHandler(async () => {
    reads++
    if (fail) throw new Error('短暂读取失败')
    return new Uint8Array([1, 2, 3])
  })
  assert.equal(reads, 0)
  assert.equal((await handler(request('unknown.svg'))).status, 404)
  assert.equal((await handler(request('codex.png', 'POST'))).status, 405)
  assert.equal(reads, 0)
  const failed = await Promise.all([handler(request('codex.png')), handler(request('codex.png'))])
  assert.deepEqual(failed.map((response) => response.status), [503, 503])
  assert.equal(reads, 1)
  fail = false
  const [first, second] = await Promise.all([handler(request('codex.png')), handler(request('codex.png', 'HEAD'))])
  assert.equal(reads, 2)
  assert.equal(first.headers.get('content-type'), 'image/png')
  assert.equal(second.headers.get('content-length'), '3')
  assert.equal((await second.arrayBuffer()).byteLength, 0)
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [1, 2, 3])
  await handler(request('codex.png'))
  assert.equal(reads, 2)
  assert.equal((await handler(request('pi.svg'))).headers.get('content-type'), 'image/svg+xml')
})

test('资源清单均存在于 npm 随包目录，路由完整注册并释放', async () => {
  const paths: string[] = []
  const released: string[] = []
  const dispose = registerProviderIconRoutes({ register(route: any) {
    paths.push(route.path)
    assert.deepEqual(route.methods, ['GET', 'HEAD'])
    return async () => { released.push(route.path) }
  } } as never)
  assert.deepEqual(paths, Object.values(PROVIDER_ICON_FILES).map((filename) => PROVIDER_ICON_PATH + filename))
  for (const filename of Object.values(PROVIDER_ICON_FILES)) assert.ok((await readFile(new URL(`../assets/provider-icons/${filename}`, import.meta.url))).length > 0)
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(packageJson.files.includes('assets/provider-icons/**'))
  await dispose()
  await dispose()
  assert.deepEqual(released, paths.toReversed())
  assert.ok(paths.every((path) => path.startsWith('/api/')), '不能落入 Desktop 专属的 /assets 应用静态目录')
})

function imageRealm() {
  class Element extends EventTarget {
    tagName = 'IMG'
    attrs = new Map<string, string>()
    setAttribute(name: string, value: string) { this.attrs.set(name, value) }
    removeAttribute(name: string) { this.attrs.delete(name) }
    getAttribute(name: string) { return this.attrs.get(name) ?? null }
  }
  class HTMLImageElement extends Element {
    get src() { return this.getAttribute('src') ?? '' }
    set src(value: string) { this.attrs.set('src', value) }
  }
  return { Element, HTMLImageElement, Event, document: { baseURI: 'https://dsh.remote.invalid/' }, location: { origin: 'https://outer.test' } }
}

test('H5 图片桥自包含：并发合并，普通图片透传，换图和清空后丢弃迟到结果', async () => {
  const realm = imageRealm()
  const waiting = new Map<string, (value: string) => void>()
  let calls = 0
  // 用函数源码在全新上下文执行，确保 srcdoc 没有隐式依赖父页面模块变量。
  const install = vm.runInNewContext(`(${installProviderIconImageBridge.toString()})`, { URL })
  install(realm, PROVIDER_ICON_PATH, (path: string) => {
    calls++
    return new Promise<string>((resolve) => waiting.set(path, resolve))
  })
  const first = new realm.HTMLImageElement()
  const second = new realm.HTMLImageElement()
  first.src = `${PROVIDER_ICON_PATH}codex.png?v=1`
  second.setAttribute('src', `${PROVIDER_ICON_PATH}codex.png?v=1`)
  await tick()
  assert.equal(calls, 1)
  first.src = 'https://external.test/image.png'
  waiting.get(`${PROVIDER_ICON_PATH}codex.png?v=1`)!('blob:codex')
  await tick()
  assert.equal(first.src, 'https://external.test/image.png')
  assert.equal(second.src, 'blob:codex')
  second.src = `${PROVIDER_ICON_PATH}pi.svg`
  await tick()
  second.removeAttribute('src')
  waiting.get(`${PROVIDER_ICON_PATH}pi.svg`)!('blob:pi')
  await tick()
  assert.equal(second.src, '')
})

test('H5 图片失败触发 error，下一次赋值可以重试', async () => {
  const realm = imageRealm()
  let calls = 0
  installProviderIconImageBridge(realm as never, PROVIDER_ICON_PATH, async () => {
    if (++calls === 1) throw new Error('连接中断')
    return 'blob:recovered'
  })
  const image = new realm.HTMLImageElement()
  let errors = 0
  image.addEventListener('error', () => errors++)
  image.src = `${PROVIDER_ICON_PATH}codex.png`
  await tick()
  assert.equal(errors, 1)
  image.src = `${PROVIDER_ICON_PATH}codex.png`
  await tick()
  assert.equal(image.src, 'blob:recovered')
  assert.equal(calls, 2)
})

test('H5 父桥合并图片请求，关闭后不创建迟到 Blob，原生异步分块不预加载', async (t) => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {} })
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete (globalThis as any).document })
  const calls: string[] = []
  let release!: (body: Uint8Array) => void
  const transport = { webRequest: async (_method: string, input: { path: string }) => {
    calls.push(input.path)
    if (input.path.includes('codex.png')) return new Promise<Uint8Array>((resolve) => { release = resolve })
    return new TextEncoder().encode('require.async("./client.editor.js")')
  } }
  const context = new RemoteDshWebContext({ transport, container: {} } as never) as any
  let created = 0
  t.mock.method(URL, 'createObjectURL', () => { created++; return `blob:test-${created}` })
  const first = context.loadImage(PROVIDER_ICON_PATH + 'codex.png')
  const second = context.loadImage(PROVIDER_ICON_PATH + 'codex.png')
  assert.equal(calls.length, 1)
  context.disposed = true
  release(new Uint8Array([1]))
  const settled = await Promise.allSettled([first, second])
  assert.ok(settled.every((result) => result.status === 'rejected'))
  assert.equal(created, 0)
  context.disposed = false
  await context.loadScript('/plugins/test/client.workbench.js')
  assert.deepEqual(calls, [PROVIDER_ICON_PATH + 'codex.png', '/plugins/test/client.workbench.js'])
})

test('H5 脚本断线后清除失败的在途缓存，下一次操作重新请求', async (t) => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {} })
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete (globalThis as any).document })
  let calls = 0
  const context = new RemoteDshWebContext({ transport: { webRequest: async () => {
    if (++calls === 1) throw new Error('连接中断')
    return new TextEncoder().encode('exports.value = 1')
  } }, container: {} } as never) as any
  t.mock.method(URL, 'createObjectURL', () => 'blob:recovered')
  await assert.rejects(context.loadScript('/plugins/test/client.editor.js'), /连接中断/u)
  assert.equal(await context.loadScript('/plugins/test/client.editor.js'), 'blob:recovered')
  assert.equal(calls, 2)
})

test('助理轻量状态贯通旧 HTTP 精确路由，与逻辑通道共用同一分发器', async () => {
  const table = new CodingNsRpcTable()
  const routes = new Map<string, any>()
  let dispose!: () => Promise<void>
  const value = { revision: 1, capturedAt: null, indexState: 'missing', indexedAt: null, workspaces: [] }
  table.register('assistant', async (action) => { assert.equal(action, 'status'); return value })
  registerCodingNsRpc({
    effect(callback: () => () => Promise<void>) { dispose = callback() },
    webServer: { register() { return () => {} } },
    connection: { fetch: { register(route: any) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } },
  } as never, table)
  try {
    const route = routes.get('/api/codingns/assistant/status')
    assert.ok(route)
    const response = await route.fetch(new Request('https://host.test/api/codingns/assistant/status', {
      method: 'POST', body: JSON.stringify({ rpcId: 'test-status', method: 'codingns/assistant/status', payload: {} }),
    }))
    assert.deepEqual((await response.json()).result, { ok: true, value })
  } finally { await dispose() }
})
