import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantAvatarLoading, assistantAvatarLoadPercent } from '../data/build/dist/client/avatar/loading.js'
import { readAssistantAvatarCacheStatus } from '../data/build/dist/client/avatar/cache-status.js'
import { AssistantLive2dController } from '../data/build/dist/client/avatar/live2d.js'
import { AssistantAvatarSlot } from '../data/build/dist/client/avatar/slot.js'
import { registerAssistantAvatarRenderer } from '../data/build/dist/client/avatar/registry.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import { BUILTIN_ASSISTANT_AVATAR } from '../data/build/dist/shared/assistant-avatar.js'
import { WHALE_LIVE2D_RESOURCE_PACK as pack } from '../data/build/dist/shared/assistant-avatar-legacy-resources.js'
import type { AssistantAvatarLoadProgress } from '../src/client/avatar/loading.js'
import type { AssistantLive2dEventMap, AssistantLive2dRuntime } from '../src/client/avatar/live2d.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'

const source = pack.basePath + pack.manifest
const t = resolveCodingNsTranslator()
const snapshot = { version: 1 as const, generation: 'test-generation', pack: pack.basePath, cached: 7, pending: 0, total: 7, downloads: 7 }
const services = { locale: { bind: () => t, subscribe: () => () => undefined, getSnapshot: () => 'zh' } } as unknown as CodingNsClientServices

function eventRuntime(load: () => Promise<void>) {
  const listeners = new Map<keyof AssistantLive2dEventMap, (...args: any[]) => void>()
  let destroyed = 0
  let played = 0
  const runtime: AssistantLive2dRuntime = { load, getMotions: () => ({ Idle: [] }), playMotion: () => { played++ }, resize: () => {},
    destroy: () => { destroyed++ }, on: (event, listener) => { listeners.set(event, listener) } }
  return { runtime, emit: <K extends keyof AssistantLive2dEventMap>(event: K, ...args: Parameters<AssistantLive2dEventMap[K]>) => listeners.get(event)?.(...args),
    destroyed: () => destroyed, played: () => played }
}

test('未知进度不伪造百分比，真实文件计数有界且支持减少动态效果', () => {
  assert.equal(assistantAvatarLoadPercent({ phase: 'engine' }), undefined)
  assert.equal(assistantAvatarLoadPercent({ phase: 'resources', loaded: 0, total: 0 }), undefined)
  assert.equal(assistantAvatarLoadPercent({ phase: 'resources', loaded: NaN, total: 7 }), undefined)
  assert.equal(assistantAvatarLoadPercent({ phase: 'resources', loaded: 3, total: 7 }), 43)
  assert.equal(assistantAvatarLoadPercent({ phase: 'resources', loaded: 9, total: 7 }), 100)
  const loading = renderToStaticMarkup(createElement(AssistantAvatarLoading, { size: 144, t, showCache: true, diagnostics: true, progress: { phase: 'engine' } }))
  assert.ok(loading.includes('codingns-avatar-orbit'))
  assert.ok(loading.includes('prefers-reduced-motion: reduce'))
  assert.ok(loading.includes('role="progressbar"'))
  assert.ok(!loading.includes('aria-valuenow'))
  assert.ok(loading.includes(t('avatar.cacheUnknown')))
})

test('Stage0 就绪摘要用加载前快照与下载差值表达证据，不将事后缓存冒充本次命中', () => {
  const ready = renderToStaticMarkup(createElement(AssistantAvatarLoading, { size: 144, t, showCache: true, diagnostics: true,
    progress: { phase: 'ready', elapsedMs: 1500, resourcesMs: 1200, cacheBefore: snapshot, cacheAfter: snapshot } }))
  assert.ok(ready.includes(t('avatar.cacheBefore', { cached: 7, total: 7 })))
  assert.ok(ready.includes(t('avatar.cacheDownloads', { count: 0 })))
  assert.ok(ready.includes(t('avatar.cacheDownloadsCompact', { count: 0 })))
  assert.ok(ready.includes(t('avatar.loadElapsed', { seconds: '1.50' })))
  assert.ok(ready.includes(t('avatar.loadResourcesElapsed', { seconds: '1.20' })))
  assert.ok(!ready.includes('data-codingns-avatar-loading'))
  const cold = renderToStaticMarkup(createElement(AssistantAvatarLoading, { size: 240, t, showCache: true, diagnostics: true,
    progress: { phase: 'ready', cacheBefore: { ...snapshot, cached: 0, downloads: 0 }, cacheAfter: snapshot } }))
  assert.ok(cold.includes(t('avatar.cacheShort', { cached: 0, total: 7 })))
  assert.ok(cold.includes(t('avatar.cacheDownloads', { count: 7 })))
  const restarted = renderToStaticMarkup(createElement(AssistantAvatarLoading, { size: 144, t, showCache: true, diagnostics: true,
    progress: { phase: 'ready', cacheBefore: snapshot, cacheAfter: { ...snapshot, generation: 'new-host' } } }))
  // Host 重启后计数恰好相同也不能伪造「新增下载 0」。
  assert.ok(!restarted.includes(t('avatar.cacheDownloadsCompact', { count: 0 })))
  assert.ok(!restarted.includes(t('avatar.cacheDownloads', { count: 0 })))
})

test('正式环境只显示动画和真实进度，兼容字段不能泄漏调试文字或 tooltip', () => {
  const details = { loaded: 3, total: 7, elapsedMs: 2490, resourcesMs: 1200, cacheBefore: snapshot, cacheAfter: snapshot }
  const html = renderToStaticMarkup(createElement(AssistantAvatarLoading, { size: 144, t, showCache: true,
    progress: { ...details, phase: 'resources' } }))
  assert.ok(html.includes('codingns-avatar-orbit'))
  assert.ok(html.includes('role="progressbar"'))
  assert.ok(html.includes('aria-valuenow="43"'))
  assert.ok(html.includes('3/7 · 43%'))
  assert.ok(!html.includes('title='))
  for (const value of ['Host', '缓存', '下载', '2.49', '1.20', 'data-codingns-avatar-load-summary']) assert.ok(!html.includes(value), value)
  assert.equal(renderToStaticMarkup(createElement(AssistantAvatarLoading, { size: 144, t, showCache: true,
    progress: { ...details, phase: 'ready' } })), '')
})

test('两个容器的基础图片和 Live2D 使用统一载入占位，旧扩展无需加载回调', () => {
  for (const surface of ['floating', 'dialog'] as const) {
    const loading = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, surface, size: 144, state: 'idle',
      model: { ...BUILTIN_ASSISTANT_AVATAR, renderer: 'live2d', source } }))
    assert.ok(loading.includes('data-codingns-avatar-loading="engine"'))
    assert.ok(loading.includes('aria-busy="true"'))
    const builtin = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, surface, size: 144, state: 'idle', model: BUILTIN_ASSISTANT_AVATAR }))
    assert.ok(builtin.includes('data-codingns-avatar-loading="resources"'))
  }
  const dispose = registerAssistantAvatarRenderer(services, { id: 'legacy', component: () => createElement('span', null, 'legacy') })
  try {
    const old = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, surface: 'dialog', size: 144, state: 'idle', model: { ...BUILTIN_ASSISTANT_AVATAR, renderer: 'legacy' } }))
    assert.ok(old.includes('legacy'))
    assert.ok(!old.includes('data-codingns-avatar-loading'))
  } finally { dispose() }
  const custom = registerAssistantAvatarRenderer(services, { id: 'another-engine', reportsLoading: true, initialLoadPhase: 'engine', reportsCache: true,
    component: ({ diagnostics }) => createElement('canvas', { 'data-diagnostics': diagnostics }) })
  const debugServices = { ...services, stage0: true }
  const debugCustom = registerAssistantAvatarRenderer(debugServices, { id: 'another-engine', reportsLoading: true, initialLoadPhase: 'engine', reportsCache: true,
    component: ({ diagnostics }) => createElement('canvas', { 'data-diagnostics': diagnostics }) })
  try {
    const html = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, surface: 'dialog', size: 144, state: 'idle', model: { ...BUILTIN_ASSISTANT_AVATAR, renderer: 'another-engine' } }))
    assert.ok(html.includes('data-codingns-avatar-loading="engine"'))
    assert.ok(!html.includes(t('avatar.cacheUnknown')))
    assert.ok(html.includes('data-diagnostics="false"'))
    const debug = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services: debugServices, surface: 'dialog', size: 144, state: 'idle', model: { ...BUILTIN_ASSISTANT_AVATAR, renderer: 'another-engine' } }))
    assert.ok(debug.includes(t('avatar.cacheUnknown')))
    assert.ok(debug.includes('data-diagnostics="true"'))
    const preview = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services: debugServices, showDiagnostics: false, surface: 'dialog', size: 144, state: 'idle', model: { ...BUILTIN_ASSISTANT_AVATAR, renderer: 'another-engine' } }))
    assert.ok(preview.includes('data-codingns-avatar-loading="engine"'), '创建预览仍显示真实加载状态')
    assert.ok(!preview.includes(t('avatar.cacheUnknown')), '创建预览隐藏缓存诊断')
    assert.ok(preview.includes('data-diagnostics="false"'))
  } finally { custom(); debugCustom() }
})

test('固定同源预设只读实时状态，外部或自定义模型不触发诊断请求', async () => {
  let calls = 0
  const fetchStatus: typeof fetch = async (url, init) => {
    calls++
    assert.equal(String(url), `https://codingns.test${pack.basePath}cache-status.json`)
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.credentials, 'same-origin'); assert.ok(init?.signal)
    return Response.json(snapshot)
  }
  assert.deepEqual(await readAssistantAvatarCacheStatus(source, 'https://codingns.test/app', fetchStatus), snapshot)
  for (const url of ['https://other.test' + source, '/pets/custom.model3.json', '/unknown.json']) {
    assert.equal(await readAssistantAvatarCacheStatus(url, 'https://codingns.test/app', fetchStatus), undefined)
  }
  assert.equal(calls, 1)
})

test('缓存诊断失败和非法快照返回未知，不误报命中或阻断加载', async () => {
  const fixtures = [{ ...snapshot, cached: 8 }, { ...snapshot, total: 56 }, { ...snapshot, pending: 1 },
    { ...snapshot, downloads: -1 }, { ...snapshot, pack: '/other/' }, { ...snapshot, generation: '' }, { ...snapshot, generation: undefined },
    { ...snapshot, version: 2 }, {}, null]
  for (const value of fixtures) assert.equal(await readAssistantAvatarCacheStatus(source, 'https://codingns.test/', async () => Response.json(value)), undefined)
  assert.equal(await readAssistantAvatarCacheStatus(source, 'https://codingns.test/', async () => new Response(null, { status: 404 })), undefined)
  assert.equal(await readAssistantAvatarCacheStatus(source, 'https://codingns.test/', async () => { throw new Error('timeout') }), undefined)
})

test('Live2D 真实事件推进进度，持续加载不误超时，等待 loaded 确认才播放', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let complete!: () => void
  const events = eventRuntime(() => new Promise<void>((resolve) => { complete = resolve }))
  const progress: AssistantAvatarLoadProgress[] = []
  const controller = new AssistantLive2dController(events.runtime, undefined, undefined, (next) => progress.push(next), 50)
  const loading = controller.load(source)
  events.emit('loadstart', 7)
  context.mock.timers.tick(40)
  events.emit('loadprogress', 3, 7, 'physics.json')
  context.mock.timers.tick(40)
  events.emit('loadprogress', 7, 7, 'texture.png')
  context.mock.timers.tick(40)
  assert.equal(events.played(), 0)
  assert.deepEqual(progress, [{ phase: 'resources', loaded: 0, total: 7 }, { phase: 'resources', loaded: 3, total: 7 }, { phase: 'rendering', loaded: 7, total: 7 }])
  events.emit('loaded'); complete()
  assert.equal(await loading, true)
  assert.equal(events.played(), 1)
  controller.dispose()
  events.emit('loadprogress', 1, 99, 'late')
  assert.equal(progress.length, 3)
})

test('引擎静默返回也报告失败，不谎报完成；永久等待有超时并销毁', async () => {
  const silent = eventRuntime(async () => {})
  await assert.rejects(new AssistantLive2dController(silent.runtime).load(source), /avatar_model_not_loaded/u)
  assert.equal(silent.destroyed(), 1)
  let complete!: () => void
  const pending = eventRuntime(() => new Promise<void>((resolve) => { complete = resolve }))
  const progress: AssistantAvatarLoadProgress[] = []
  const controller = new AssistantLive2dController(pending.runtime, undefined, undefined, (next) => progress.push(next), 5)
  await assert.rejects(controller.load(source), /avatar_load_timeout/u)
  assert.equal(pending.destroyed(), 1)
  pending.emit('loadprogress', 1, 7, 'late'); pending.emit('loaded'); complete()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(progress.length, 0)
  assert.equal(pending.played(), 0)
  assert.equal(pending.destroyed(), 2)
})

test('隐藏或卸载立即取消等待，迟到事件不能更新旧插槽', async () => {
  let complete!: () => void
  const events = eventRuntime(() => new Promise<void>((resolve) => { complete = resolve }))
  let reports = 0
  const controller = new AssistantLive2dController(events.runtime, undefined, undefined, () => { reports++ })
  const loading = controller.load(source)
  controller.dispose()
  assert.equal(await loading, false)
  events.emit('loadstart', 7); events.emit('loadprogress', 7, 7, 'late'); events.emit('loaded'); complete()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(reports, 0)
  assert.equal(events.played(), 0)
  assert.equal(events.destroyed(), 2)
})
