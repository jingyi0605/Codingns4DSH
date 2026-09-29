import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { CODINGNS_PWA_METADATA_MARKUP, injectDshWebPwaMetadata, injectDshWebTransportOwnership } from '../data/build/dist/host/index-injection.js'

/** 启动页在文档里执行脚本行；这里用 vm 复现页面侧的赋值结果。 */
function runScripts(table: readonly unknown[], sandbox: Record<string, unknown>): void {
  for (const entry of table) {
    if (typeof entry !== 'object' || entry === null) continue
    if ((entry as { kind?: unknown }).kind !== 'script') continue
    runInNewContext(String((entry as { text?: unknown }).text), sandbox)
  }
}

function transportRows(table: readonly unknown[]): unknown[] {
  return table.filter((entry) => typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === '__DSH_TRANSPORT__')
}

test('没有既有 Transport 时用脚本行声明 Host 所有权，不追加同名全局', () => {
  const table: unknown[] = []

  injectDshWebTransportOwnership(table)

  assert.deepEqual(transportRows(table), [], '不得追加 __DSH_TRANSPORT__ 全局行')
  const sandbox: Record<string, unknown> = {}
  runScripts(table, sandbox)
  assert.equal((sandbox.__DSH_TRANSPORT__ as { ownsHost?: unknown } | undefined)?.ownsHost, true)
  assert.deepEqual(Object.keys(sandbox.__DSH_TRANSPORT__ as object), ['ownsHost', 'rpc', 'fetch', 'reconnect', 'close', 'openStream', 'loadBundle'])
  assert.equal(typeof (sandbox.__CODINGNS4DSH_PREBOOT_SHIM__ as { getState: () => string }).getState, 'function')
})

test('Desktop Transport 保留 streamBaseUrl 并补充 Host 所有权', () => {
  const desktopTransport = {
    fetch: () => Promise.resolve(new Response()),
    streamBaseUrl: 'dsh-app://app',
  }
  const table: unknown[] = [{ kind: 'global', name: '__DSH_TRANSPORT__', value: desktopTransport }]

  injectDshWebTransportOwnership(table)

  assert.equal((table[0] as { value: { streamBaseUrl?: unknown; ownsHost?: unknown } }).value.streamBaseUrl, 'dsh-app://app')
  assert.equal((table[0] as { value: { ownsHost?: unknown } }).value.ownsHost, true)

  const sandbox: Record<string, unknown> = { __DSH_TRANSPORT__: { fetch: desktopTransport.fetch, streamBaseUrl: 'dsh-app://app' } }
  runScripts(table, sandbox)
  const merged = sandbox.__DSH_TRANSPORT__ as { fetch?: unknown; streamBaseUrl?: unknown; ownsHost?: unknown }
  assert.equal(merged.fetch, desktopTransport.fetch)
  assert.equal(merged.streamBaseUrl, 'dsh-app://app')
  assert.equal(merged.ownsHost, true)
})

test('Desktop 壳存在且尚未登记 Transport 时不由插件创建', () => {
  const table: unknown[] = []

  injectDshWebTransportOwnership(table)

  const sandbox: Record<string, unknown> = { dshDesktopBoot: {} }
  runScripts(table, sandbox)
  assert.equal(sandbox.__DSH_TRANSPORT__, undefined)
})

test('未知 Transport 形状不被覆盖', () => {
  const table: unknown[] = [{ name: '__DSH_TRANSPORT__', value: 'desktop-managed' }]

  injectDshWebTransportOwnership(table)

  assert.deepEqual(table[0], { name: '__DSH_TRANSPORT__', value: 'desktop-managed' })

  const sandbox: Record<string, unknown> = { __DSH_TRANSPORT__: 'desktop-managed' }
  runScripts(table, sandbox)
  assert.equal(sandbox.__DSH_TRANSPORT__, 'desktop-managed')
})

test('PWA 元数据与注册脚本只按开关追加，关闭时零副作用', () => {
  const disabled: unknown[] = []
  assert.equal(injectDshWebPwaMetadata(disabled, { enabled: false, serviceWorker: true, installPrompt: true, notifications: 'off' }), false)
  assert.deepEqual(disabled, [])

  const table: unknown[] = []
  injectDshWebTransportOwnership(table)
  assert.equal(injectDshWebPwaMetadata(table, { enabled: true, serviceWorker: false, installPrompt: true, notifications: 'local' }), true)

  const htmlRows = table.filter((entry) => (entry as { kind?: unknown }).kind === 'html')
  const scriptRows = table.filter((entry) => (entry as { kind?: unknown }).kind === 'script')
  assert.equal(htmlRows.length, 1)
  const markup = String((htmlRows[0] as { html?: unknown }).html)
  assert.equal(markup, CODINGNS_PWA_METADATA_MARKUP)
  assert.match(markup, /apple-mobile-web-app-capable/u)
  assert.match(markup, /apple-touch-icon/u)
  assert.match(markup, /theme-color/u)
  // 元数据行必须排在脚本行之前，脚本行排在最后，避免迟到覆盖其它注入。
  assert.equal(table.indexOf(htmlRows[0]!), table.length - 2)
  assert.equal(table.indexOf(scriptRows[scriptRows.length - 1]!), table.length - 1)
  const text = scriptRows.map((entry) => String((entry as { text?: unknown }).text)).join('')
  assert.doesNotMatch(text, /serviceWorker\.register/u)
  assert.match(text, /beforeinstallprompt/u)
})

test('注入脚本在页面侧按入口与安全上下文裁剪行为', () => {
  const table: unknown[] = []
  injectDshWebPwaMetadata(table, { enabled: true, serviceWorker: true, installPrompt: true, notifications: 'push' })

  const loopback: Record<string, unknown> = { location: { hostname: '127.0.0.1' } }
  runScripts(table, loopback)
  assert.equal((loopback.__CODINGNS_PWA__ as { loopback: boolean; sw: string }).loopback, true)
  assert.equal((loopback.__CODINGNS_PWA__ as { sw: string }).sw, 'loopback')

  const insecure: Record<string, unknown> = {
    location: { hostname: '192.168.1.10' },
    isSecureContext: false,
    // 浏览器提供的最小事件接口；脚本在非安全上下文里也只用到这些。
    addEventListener: () => undefined,
    dispatchEvent: () => true,
    CustomEvent: class {},
    matchMedia: () => ({ matches: false }),
  }
  runScripts(table, insecure)
  const state = insecure.__CODINGNS_PWA__ as { loopback: boolean; sw: string }
  assert.equal(state.loopback, false)
  // 非安全上下文只暴露注销入口，不注册 Service Worker。
  assert.equal(state.sw, 'unsupported')
  assert.equal(typeof insecure.__CODINGNS_PWA_UNREGISTER__, 'function')
})
