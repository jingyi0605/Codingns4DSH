import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PWA_ASSET_PREFIX,
  PWA_BACKGROUND_COLOR,
  PWA_MANIFEST_MARKER,
  PWA_MANIFEST_PATH,
  PWA_SERVICE_WORKER_PATH,
  PWA_THEME_COLOR,
  applyViewportFitTap,
  createLanAccessDshPwaBundle,
  createLanAccessDshPwaProvider,
  createPwaClientScript,
  createPwaIconPng,
  createPwaManifest,
  createPwaServiceWorkerScript,
  hasViewportFit,
} from '../data/build/dist/host/modules/pwa/index.js'
import { resolveLanAccessDshPwaResponse, synthLanResponse } from '../data/build/dist/host/lan-access-dsh.js'
import { DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS } from '../data/build/dist/shared/contracts/config.js'

interface DecodedResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

function decodeResponse(bytes: Uint8Array): DecodedResponse {
  const text = new TextDecoder().decode(bytes)
  const [head, body = ''] = text.split('\r\n\r\n')
  const lines = (head ?? '').split('\r\n')
  const status = Number(lines[0]?.split(' ')[1] ?? 0)
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':')
    if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim()
  }
  return { status, headers, body }
}

test('PWA manifest 覆盖为独立窗口并补齐 PNG 图标', () => {
  const manifest = createPwaManifest() as {
    name: string
    short_name: string
    start_url: string
    scope: string
    display: string
    theme_color: string
    background_color: string
    icons: readonly { src: string; sizes: string; type: string; purpose?: string }[]
    codingns4dsh: { pwa: number; marker: string }
  }
  assert.equal(manifest.start_url, './')
  assert.equal(manifest.scope, './')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.theme_color, PWA_THEME_COLOR)
  assert.equal(manifest.background_color, PWA_BACKGROUND_COLOR)
  // 标记字段是浏览器侧判断“这份 manifest 来自插件”的唯一依据。
  assert.equal(manifest.codingns4dsh.pwa, 1)
  assert.equal(manifest.codingns4dsh.marker, PWA_MANIFEST_MARKER)
  const sizes = manifest.icons.map((icon) => `${icon.src}|${icon.sizes}|${icon.purpose ?? 'any'}`)
  assert.ok(sizes.includes(`${PWA_ASSET_PREFIX}icon-192.png|192x192|any`))
  assert.ok(sizes.includes(`${PWA_ASSET_PREFIX}icon-512.png|512x512|any`))
  assert.ok(sizes.includes(`${PWA_ASSET_PREFIX}icon-maskable-512.png|512x512|maskable`))
  assert.ok(manifest.icons.every((icon) => icon.type === 'image/png' || icon.type === 'image/svg+xml'))
})

test('Service Worker 不做请求缓存，只处理推送、点击与注销', () => {
  const script = createPwaServiceWorkerScript()
  assert.match(script, /skipWaiting/u)
  assert.match(script, /showNotification/u)
  assert.match(script, /notificationclick/u)
  assert.match(script, /client\.navigate\(target\)/u)
  assert.match(script, /codingns-sw-unregister/u)
  // 空 fetch 监听只为满足安装判定；一旦出现 respondWith/cache.addAll 就说明开始缓存请求了。
  assert.doesNotMatch(script, /respondWith/u)
  assert.doesNotMatch(script, /caches\.open/u)
  assert.doesNotMatch(script, /addAll/u)
  assert.doesNotMatch(script, /<\/script/iu)
})

test('注入脚本：回环短路、manifest 标记探测、注销入口与可选能力', () => {
  const full = createPwaClientScript({ serviceWorker: true, installPrompt: true })
  assert.match(full, /__CODINGNS_PWA__/u)
  assert.match(full, /127\.0\.0\.1/u)
  assert.match(full, /isSecureContext/u)
  assert.match(full, /codingns4dsh/u)
  assert.match(full, /__CODINGNS_PWA_UNREGISTER__/u)
  assert.match(full, /beforeinstallprompt/u)
  assert.doesNotMatch(full, /<\/script/iu)
  assert.ok(full.length < 4096, `脚本长度应保持精简，实际 ${full.length}`)

  const minimal = createPwaClientScript({ serviceWorker: false, installPrompt: false })
  assert.doesNotMatch(minimal, /serviceWorker\.register/u)
  assert.doesNotMatch(minimal, /beforeinstallprompt/u)
  assert.match(minimal, /__CODINGNS_PWA_UNREGISTER__/u)
})

test('图标是合法 PNG，按尺寸缓存，maskable 与普通版本不同', () => {
  const icon = createPwaIconPng({ size: 192 })
  assert.deepEqual([...icon.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(icon.buffer, icon.byteOffset, icon.byteLength)
  assert.equal(view.getUint32(16), 192)
  assert.equal(view.getUint32(20), 192)
  assert.equal(icon, createPwaIconPng({ size: 192 }))
  const maskable = createPwaIconPng({ size: 512, maskable: true })
  const plain = createPwaIconPng({ size: 512 })
  assert.notEqual(maskable.length, 0)
  assert.notDeepEqual([...maskable], [...plain])
})

test('viewport 改写追加 viewport-fit=cover，且幂等、不新增 meta', () => {
  const html = '<head><meta name="viewport" content="width=device-width, initial-scale=1" /><meta charset="utf-8" /></head>'
  const once = applyViewportFitTap(html)
  assert.match(once, /content="width=device-width, initial-scale=1, viewport-fit=cover"/u)
  assert.equal((once.match(/name="viewport"/gu) ?? []).length, 1)
  assert.equal(applyViewportFitTap(once), once)
  assert.equal(hasViewportFit(once), true)

  const withoutViewport = '<head><meta charset="utf-8" /></head>'
  assert.equal(applyViewportFitTap(withoutViewport), withoutViewport)
  assert.equal(hasViewportFit(withoutViewport), false)

  const singleQuoted = "<meta name='viewport' content='width=device-width'>"
  assert.match(applyViewportFitTap(singleQuoted), /viewport-fit=cover/u)
})

test('PWA 白名单合成响应：manifest、SW 与图标都带正确头部', () => {
  const bundle = createLanAccessDshPwaBundle({ serviceWorker: true })
  const manifest = resolveLanAccessDshPwaResponse({ method: 'GET', path: PWA_MANIFEST_PATH }, bundle)
  assert.ok(manifest !== undefined)
  const decodedManifest = decodeResponse(manifest)
  assert.equal(decodedManifest.status, 200)
  assert.match(decodedManifest.headers['content-type'] ?? '', /application\/manifest\+json/u)
  assert.equal(decodedManifest.headers['cache-control'], 'public, max-age=300')
  assert.equal(decodedManifest.headers['x-content-type-options'], 'nosniff')
  assert.equal(Number(decodedManifest.headers['content-length']), new TextEncoder().encode(decodedManifest.body).length)

  const serviceWorker = resolveLanAccessDshPwaResponse({ method: 'GET', path: PWA_SERVICE_WORKER_PATH }, bundle)
  assert.ok(serviceWorker !== undefined)
  const decodedSw = decodeResponse(serviceWorker)
  assert.equal(decodedSw.headers['cache-control'], 'no-cache')
  assert.match(decodedSw.headers['content-type'] ?? '', /text\/javascript/u)
  assert.match(decodedSw.body, /showNotification/u)

  const icon = resolveLanAccessDshPwaResponse({ method: 'GET', path: `${PWA_ASSET_PREFIX}icon-192.png` }, bundle)
  assert.ok(icon !== undefined)
  const decodedIcon = decodeResponse(icon)
  assert.equal(decodedIcon.headers['content-type'], 'image/png')
  assert.match(decodedIcon.headers['cache-control'] ?? '', /max-age=\d+/u)
})

test('PWA 白名单的边界：非白名单透传、方法限制、未启用回退、缺失资产 404', () => {
  const bundle = createLanAccessDshPwaBundle({ serviceWorker: false })
  // 非白名单路径必须回到原有登录/转发语义。
  assert.equal(resolveLanAccessDshPwaResponse({ method: 'GET', path: '/index.html' }, bundle), undefined)
  // 关闭 SW 时 /sw.js 交回原有语义（上游 404 或登录页），而不是合成 200。
  assert.equal(resolveLanAccessDshPwaResponse({ method: 'GET', path: PWA_SERVICE_WORKER_PATH }, bundle), undefined)
  // 未启用时 manifest 交回上游，图标路径直接 404。
  assert.equal(resolveLanAccessDshPwaResponse({ method: 'GET', path: PWA_MANIFEST_PATH }, null), undefined)
  const missingIcon = resolveLanAccessDshPwaResponse({ method: 'GET', path: `${PWA_ASSET_PREFIX}icon-999.png` }, null)
  assert.equal(decodeResponse(missingIcon!).status, 404)

  const notAllowed = resolveLanAccessDshPwaResponse({ method: 'POST', path: PWA_MANIFEST_PATH }, bundle)
  const decoded = decodeResponse(notAllowed!)
  assert.equal(decoded.status, 405)
  assert.equal(decoded.headers.allow, 'GET, HEAD')

  const head = resolveLanAccessDshPwaResponse({ method: 'HEAD', path: PWA_MANIFEST_PATH }, bundle)
  const decodedHead = decodeResponse(head!)
  assert.equal(decodedHead.status, 200)
  assert.equal(decodedHead.body, '')
  assert.ok(Number(decodedHead.headers['content-length']) > 0)
})

test('合成响应助手按字节计算 Content-Length，并保留自定义头', () => {
  const bytes = synthLanResponse({
    status: 200,
    contentType: 'application/octet-stream',
    body: new Uint8Array([1, 2, 3, 4]),
    headers: { 'X-Test': 'yes' },
  })
  const decoded = decodeResponse(bytes)
  assert.equal(decoded.status, 200)
  assert.equal(decoded.headers['content-length'], '4')
  assert.equal(decoded.headers['x-test'], 'yes')
  assert.equal(decoded.headers.connection, 'close')
})

test('PWA provider 跟随设置开关，并只缓存同一份配置的结果', () => {
  let settings = { ...DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS, enabled: false }
  const provider = createLanAccessDshPwaProvider({ readSettings: () => settings })
  assert.equal(provider.snapshot(), null)

  settings = { ...settings, enabled: true }
  const first = provider.snapshot()
  assert.notEqual(first, null)
  assert.equal(first?.serviceWorker, null)
  assert.equal(provider.snapshot(), first)

  settings = { ...settings, serviceWorker: true }
  const second = provider.snapshot()
  assert.notEqual(second?.serviceWorker, null)
  assert.notEqual(second, first)

  settings = { ...settings, enabled: false }
  assert.equal(provider.snapshot(), null)
})
