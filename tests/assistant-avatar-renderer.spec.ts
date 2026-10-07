import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantAvatarRegistry } from '../data/build/dist/client/avatar/registry.js'
import { AssistantSpriteClock } from '../data/build/dist/client/avatar/spritesheet.js'
import { AssistantAvatarSlot } from '../data/build/dist/client/avatar/slot.js'
import { BuiltinAssistantAvatar } from '../data/build/dist/client/avatar/builtin.js'
import { AssistantLive2dController, AssistantLive2dModuleLoader } from '../data/build/dist/client/avatar/live2d.js'
import { BUILTIN_ASSISTANT_AVATAR, BUILTIN_ASSISTANT_AVATARS, BUILTIN_ASSISTANT_AVATAR_SOURCES } from '../data/build/dist/shared/assistant-avatar.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'

const services = { locale: { bind: () => resolveCodingNsTranslator(), subscribe: () => () => undefined, getSnapshot: () => 'zh' } } as unknown as CodingNsClientServices

test('Live2D 引擎并发加载共享模块，成功后不重复导入或探测状态', async () => {
  let imports = 0, probes = 0
  const module = { init: () => null }
  let complete!: (value: typeof module) => void
  const loader = new AssistantLive2dModuleLoader(() => {
    imports++
    return new Promise((resolve) => { complete = resolve })
  }, async () => { probes++; return new Response(null) })
  const first = loader.load('https://preview.test/settings')
  const second = loader.load('https://preview.test/settings')
  assert.equal(first, second)
  complete(module)
  assert.equal(await first, module)
  assert.equal(loader.load('https://preview.test/settings'), first)
  assert.equal(imports, 1)
  assert.equal(probes, 0)
})

test('Live2D 缺少引擎报告真实原因，恢复时更换失败模块 URL 并共享成功结果', async () => {
  const urls: string[] = []
  let probes = 0
  const module = { init: () => null }
  const loader = new AssistantLive2dModuleLoader(async (url) => {
    urls.push(url)
    if (urls.length === 1) throw new TypeError('Failed to fetch dynamically imported module')
    return module
  }, async () => { probes++; return new Response(null, { status: 503 }) })
  await assert.rejects(loader.load('https://preview.test/settings'), /avatar_runtime_unavailable/u)
  const recovered = loader.load('https://preview.test/settings')
  assert.equal(await recovered, module)
  assert.equal(loader.load('https://preview.test/settings'), recovered)
  assert.equal(new URL(urls[0]!).searchParams.get('retry'), null)
  assert.equal(new URL(urls[1]!).searchParams.get('retry'), '1')
  assert.equal(new URL(urls[1]!).searchParams.get('v'), '2.1.1')
  assert.equal(probes, 1)
})

test('Live2D 模块接口无效、HTTP 拒绝和探测失败均保留可诊断原因', async () => {
  const invalid = new AssistantLive2dModuleLoader(async () => ({}) as never, async () => new Response(null))
  await assert.rejects(invalid.load('https://preview.test/'), /avatar_runtime_invalid/u)
  const unauthorized = new AssistantLive2dModuleLoader(async () => { throw new Error('import failed') }, async () => new Response(null, { status: 401 }))
  await assert.rejects(unauthorized.load('https://preview.test/'), /avatar_runtime_http_401/u)
  const original = new Error('original import failure')
  const offline = new AssistantLive2dModuleLoader(async () => { throw original }, async () => { throw new Error('probe failed') })
  await assert.rejects(offline.load('https://preview.test/'), (error) => error === original)
})

test('渲染器注销幂等、重复注册拒绝，注销不会移除后续新注册', () => {
  const registry = new AssistantAvatarRegistry()
  let notifications = 0
  const unsubscribe = registry.subscribe(() => { notifications += 1 })
  const renderer = { id: 'custom-robot', component: () => null }
  const dispose = registry.register(renderer)
  assert.equal(registry.get(renderer.id), renderer)
  assert.throws(() => registry.register(renderer), /已注册/u)
  assert.throws(() => registry.register({ ...renderer, id: 'live2d' }), /内置/u)
  dispose(); dispose()
  const next = { ...renderer }
  registry.register(next)
  dispose()
  assert.equal(registry.get(renderer.id), next)
  assert.equal(notifications, 3)
  unsubscribe()
})

test('精灵图时钟处理零时刻、长时间间隔、状态切换和暂停恢复', () => {
  const clock = new AssistantSpriteClock('idle')
  assert.deepEqual(clock.tick(0), { row: 0, frame: 0 })
  assert.deepEqual(clock.tick(160), { row: 0, frame: 1 })
  assert.deepEqual(clock.tick(160 * 1001), { row: 0, frame: 5 })
  clock.setState('error')
  assert.deepEqual(clock.tick(200000), { row: 5, frame: 0 })
  assert.deepEqual(clock.tick(200140), { row: 5, frame: 1 })
  clock.reset()
  assert.deepEqual(clock.tick(900000), { row: 5, frame: 1 })
})

test('两个展示位置共享同一角色接口，未知扩展退回可用内置形象', () => {
  for (const surface of ['floating', 'dialog'] as const) {
    for (const model of BUILTIN_ASSISTANT_AVATARS) {
      const html = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, model, state: 'speaking', size: 144, surface }))
      assert.ok(html.includes(`data-codingns-avatar-slot="${surface}"`))
      assert.ok(html.includes('data-codingns-avatar-state="speaking"'))
      assert.ok(html.includes(`<img src="${BUILTIN_ASSISTANT_AVATAR_SOURCES[model.id]}"`))
      assert.ok(!html.includes('<canvas'))
      const character = renderToStaticMarkup(createElement(BuiltinAssistantAvatar, { model, state: 'idle', size: 144, surface, onError: () => {} }))
      assert.ok(!character.includes('<svg'))
    }
  }
  const fallback = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, model: { ...BUILTIN_ASSISTANT_AVATAR, renderer: 'missing' }, state: 'idle', size: 144, surface: 'dialog' }))
  assert.ok(fallback.includes('data-codingns-avatar-fallback'))
  assert.ok(fallback.includes(BUILTIN_ASSISTANT_AVATAR_SOURCES[BUILTIN_ASSISTANT_AVATAR.id]!))
})

test('Live2D 加载中销毁后，迟到完成不会再播放动作', async () => {
  let complete: (() => void) | undefined
  let destroyed = 0
  const motions: string[] = []
  const runtime = { load: () => new Promise<void>((resolve) => { complete = resolve }), getMotions: () => ({ Idle: ['idle'], Talk: ['talk'] }),
    playMotion: (group: string) => motions.push(group), resize: () => undefined, destroy: () => { destroyed += 1 } }
  const controller = new AssistantLive2dController(runtime)
  const loading = controller.load('/pets/a.model3.json')
  controller.setState('speaking')
  controller.dispose(); controller.dispose()
  complete?.()
  assert.equal(await loading, false)
  assert.deepEqual(motions, [])
  assert.equal(destroyed, 2)
})

test('Live2D 等待加载完成后使用最新状态，缺少动作组回到待机', async () => {
  const motions: string[] = []
  const controller = new AssistantLive2dController({ load: async () => undefined, getMotions: () => ({ Idle: [], Talk: [] }),
    playMotion: (group: string) => motions.push(group), resize: () => undefined, destroy: () => undefined })
  controller.setState('speaking')
  assert.equal(await controller.load('/pets/a.model3.json'), true)
  controller.setState('error')
  assert.deepEqual(motions, ['Talk', 'Idle'])
})

test('Live2D 已销毁后的迟到失败也会清理加载期间创建的资源', async () => {
  let reject!: (error: Error) => void
  let destroyed = 0
  const controller = new AssistantLive2dController({ load: () => new Promise((_resolve, fail) => { reject = fail }),
    getMotions: () => ({}), playMotion: () => {}, resize: () => {}, destroy: () => { destroyed++ } })
  const loading = controller.load('/pets/b.model3.json')
  controller.dispose()
  reject(new Error('迟到加载失败'))
  assert.equal(await loading, false)
  assert.equal(destroyed, 2)
})
