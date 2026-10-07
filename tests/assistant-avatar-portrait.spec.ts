import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantAvatarPortraitService, assistantAvatarPortraitKey } from '../src/client/avatar/portrait-service.js'
import { assistantAvatarPortraitCrop } from '../src/client/avatar/portrait-capture.js'
import { assistantAvatarPreviewKey } from '../src/client/avatar/preview-store.js'
import { AssistantConversationView } from '../src/client/features/assistant-workbench.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { BUILTIN_ASSISTANT_AVATAR, BUILTIN_ASSISTANT_AVATARS } from '../src/shared/assistant-avatar.js'
import type { AssistantAvatarModel } from '../src/shared/assistant-avatar.js'
import type { AssistantAvatarPreview } from '../src/client/avatar/preview-store.js'
import type { AssistantAvatarRenderer } from '../src/client/avatar/registry.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'

const model: AssistantAvatarModel = { ...BUILTIN_ASSISTANT_AVATAR, id: 'portrait-test', renderer: 'image', source: '/avatars/a.png' }
const png = (text = 'png'): AssistantAvatarPreview => ({ blob: new Blob([text], { type: 'image/png' }), width: 128, height: 128 })
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function fixture(create: NonNullable<AssistantAvatarRenderer['createPortrait']> = async () => png()) {
  const cached = new Map<string, AssistantAvatarPreview>(), frames = new Map<string, AssistantAvatarPreview>()
  const manual = new Map<string, AssistantAvatarPreview>()
  const revoked: string[] = [], writes: string[] = [], removed: string[] = []
  let generated = 0, reads = 0, urls = 0
  const renderer: AssistantAvatarRenderer = { id: 'image', component: () => null, portraitVersion: '1', createPortrait: (asset, signal) => { generated++; return create(asset, signal) } }
  const store = { async read(key: string) { reads++; return cached.get(key) }, async write(key: string, _id: string, _surface: string, preview: AssistantAvatarPreview) { cached.set(key, preview); writes.push(key); return true }, async removeModel(id: string) { removed.push(id); cached.clear() } }
  const previews = { async read(key: string) { return frames.get(key) } }
  let crops = 0
  const crop = async (frame: AssistantAvatarPreview) => { crops++; return png(await frame.blob.text()) }
  const overrides = { async read(key: string) { return manual.get(key) }, async write(key: string, _id: string, _surface: string, preview: AssistantAvatarPreview) { manual.set(key, preview); return true }, async removeModel() { manual.clear() } }
  const service = new AssistantAvatarPortraitService(store, previews, crop, () => `blob:portrait-${++urls}`, (url) => revoked.push(url), overrides)
  return { service, renderer, cached, frames, manual, overrides, writes, revoked, removed, store, previews, crop, crops: () => crops, reads: () => reads, generated: () => generated }
}

test('头像键按对话资源和适配器版本失效，改名与等值配置不重复生成', () => {
  const f = fixture(), key = assistantAvatarPortraitKey(model, f.renderer)
  assert.equal(key, assistantAvatarPortraitKey({ ...model, name: '改名', live2d: { scale: 1, position: [0, 0] } }, f.renderer))
  for (const next of [{ ...model, id: 'other' }, { ...model, source: '/avatars/b.png' },
    { ...model, surfaces: { dialog: { renderer: 'image', source: '/dialog.png' } } }, { ...model, stateSources: { idle: '/idle.png' } }]) {
    assert.notEqual(key, assistantAvatarPortraitKey(next, f.renderer))
  }
  assert.notEqual(key, assistantAvatarPortraitKey(model, { ...f.renderer, portraitVersion: '2' }))
  assert.notEqual(key, assistantAvatarPortraitKey(model, { ...f.renderer, previewVersion: '2' }))
  assert.notEqual(assistantAvatarPortraitKey(BUILTIN_ASSISTANT_AVATARS[0]!, f.renderer), assistantAvatarPortraitKey(BUILTIN_ASSISTANT_AVATARS[1]!, f.renderer))
})

test('透明边距不参与裁剪，上部轮廓形成方形且空帧不生成头像', () => {
  const width = 100, height = 140, pixels = new Uint8ClampedArray(width * height * 4)
  const fill = (left: number, top: number, right: number, bottom: number) => {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) pixels[(y * width + x) * 4 + 3] = 255
  }
  fill(25, 20, 75, 75); fill(35, 75, 65, 120)
  const crop = assistantAvatarPortraitCrop(pixels, width, height)!
  assert.ok(crop); assert.ok(crop.size >= 55 && crop.size <= 65)
  assert.equal(crop.x + crop.size / 2, 50)
  assert.ok(crop.y < 20); assert.ok(crop.y + crop.size < 120, '排除下半身，保留头部与透明边缘')
  assert.equal(assistantAvatarPortraitCrop(new Uint8ClampedArray(width * height * 4), width, height), undefined)
  assert.equal(assistantAvatarPortraitCrop(pixels, 513, height), undefined)
  assert.equal(assistantAvatarPortraitCrop(pixels, width, height - 1), undefined)
})

test('消息与按钮共用一次生成、一个 URL 和一份持久化记录，渲染读快照不启动任务', async () => {
  const f = fixture(), first = f.service.getSnapshot(model, f.renderer)
  assert.equal(f.service.getSnapshot({ ...model }, f.renderer), first)
  assert.equal(f.reads(), 0); assert.equal(f.generated(), 0)
  let notices = 0
  const unsubscribe = f.service.subscribe(model, f.renderer, () => { notices++ })
  const releaseA = f.service.retain(model, f.renderer), releaseB = f.service.retain({ ...model }, f.renderer)
  await drain()
  assert.equal(f.generated(), 1); assert.equal(f.reads(), 1); assert.equal(f.writes.length, 1); assert.equal(notices, 1)
  const url = f.service.getSnapshot(model, f.renderer).url
  assert.equal(url, 'blob:portrait-1')
  releaseA(); releaseB(); unsubscribe()
  const releaseC = f.service.retain(model, f.renderer)
  await drain()
  assert.equal(f.generated(), 1); assert.equal(f.service.getSnapshot(model, f.renderer).url, url)
  releaseC()
})

test('页面刷新读持久化头像，不读取全身预览或调用渲染器', async () => {
  const f = fixture()
  f.cached.set(assistantAvatarPortraitKey(model, f.renderer), png('saved'))
  const release = f.service.retain(model, f.renderer)
  await drain()
  assert.equal(f.generated(), 0); assert.equal(f.crops(), 0)
  assert.equal(f.service.getSnapshot(model, f.renderer).url, 'blob:portrait-1')
  release()
})

test('Live2D 优先裁剪已有透明全身预览，兼容只有 preview 接口的旧扩展', async () => {
  const f = fixture(), renderer = { ...f.renderer, previewVersion: '1' }
  const { createPortrait: _unused, ...legacy } = renderer
  f.frames.set(assistantAvatarPreviewKey(model, 'floating', '1'), png('floating-frame'))
  const release = f.service.retain(model, legacy)
  await drain()
  assert.equal(f.generated(), 0); assert.equal(f.crops(), 1)
  assert.equal(await f.cached.get(assistantAvatarPortraitKey(model, legacy))!.blob.text(), 'floating-frame')
  release()
})

test('双展示资源不同不能混用，头像生成使用对话素材', async () => {
  let source = ''
  const f = fixture(async (asset) => { source = asset.source; return png('dialog') })
  const dual = { ...model, surfaces: { dialog: { renderer: 'image', source: '/dialog.png' }, floating: { renderer: 'image', source: '/floating.png' } } }
  const renderer = { ...f.renderer, previewVersion: '1' }
  f.frames.set(assistantAvatarPreviewKey(dual, 'floating', '1'), png('wrong'))
  const release = f.service.retain(dual, renderer)
  await drain()
  assert.equal(source, '/dialog.png'); assert.equal(f.crops(), 0)
  release()
})

test('插槽现成帧取消临时生成，旧任务迟到不能覆盖头像', async () => {
  const job = deferred<AssistantAvatarPreview>(), signals: AbortSignal[] = []
  const f = fixture(async (_model, signal) => { signals.push(signal); return job.promise })
  const release = f.service.retain(model, f.renderer)
  await drain()
  f.service.offerPreview(model, 'dialog', f.renderer, png('actual-frame'))
  await drain()
  assert.equal(signals[0]!.aborted, true)
  const url = f.service.getSnapshot(model, f.renderer).url
  job.resolve(png('late')); await drain()
  assert.equal(f.service.getSnapshot(model, f.renderer).url, url)
  assert.equal(f.writes.length, 1)
  assert.equal(await f.cached.get(assistantAvatarPortraitKey(model, f.renderer))!.blob.text(), 'actual-frame')
  release()
})

test('快速切换取消旧头像，取消后迟到结果既不发布也不落盘', async () => {
  const job = deferred<AssistantAvatarPreview>(), signals: AbortSignal[] = []
  const f = fixture(async (asset, signal) => { if (asset.id === model.id) { signals.push(signal); return job.promise }; return png('new') })
  const releaseA = f.service.retain(model, f.renderer)
  await drain(); releaseA()
  const other = { ...model, id: 'new-model', source: '/new.png' }
  const releaseB = f.service.retain(other, f.renderer)
  await drain(); job.resolve(png('old')); await drain()
  assert.equal(signals[0]!.aborted, true)
  assert.equal(f.service.getSnapshot(model, f.renderer).url, undefined)
  assert.equal(f.service.getSnapshot(other, f.renderer).url, 'blob:portrait-1')
  assert.deepEqual(f.writes, [assistantAvatarPortraitKey(other, f.renderer)])
  releaseB()
})

test('存储和生成失败不阻断助理，非法全身图不能作为方形头像保存', async () => {
  for (const create of [async () => { throw new Error('CORS') }, async () => ({ ...png(), height: 256 }), async () => undefined]) {
    const f = fixture(create), release = f.service.retain(model, f.renderer)
    await drain()
    assert.equal(f.service.getSnapshot(model, f.renderer).url, undefined); assert.equal(f.writes.length, 0)
    release()
  }
  const f = fixture()
  f.store.read = async () => { throw new Error('IndexedDB disabled') }
  const release = f.service.retain(model, f.renderer)
  await drain(); assert.equal(f.generated(), 1); assert.ok(f.service.getSnapshot(model, f.renderer).url)
  release()
})

test('移除形象回收头像缓存和 URL，内存只保留八个无订阅头像', async () => {
  const f = fixture()
  const release = f.service.retain(model, f.renderer)
  await drain(); release(); f.service.removeModel(model.id)
  assert.deepEqual(f.removed, [model.id]); assert.deepEqual(f.revoked, ['blob:portrait-1'])
  assert.equal(f.service.getSnapshot(model, f.renderer).url, undefined)
  for (let i = 0; i < 10; i++) {
    const release = f.service.retain({ ...model, id: `model-${i}` }, f.renderer)
    await drain(); release()
  }
  assert.ok(f.revoked.length >= 3)
})

test('正式与流式助理消息显示当前头像，用户消息不添加助理头像，旧调用兼容', () => {
  const conversation = { revision: 1, summary: '', messages: [
    { id: 'user', role: 'user' as const, text: '问题', createdAt: 1 }, { id: 'assistant', role: 'assistant' as const, text: '回答', createdAt: 2 },
  ], pendingMessage: null, active: { requestId: 'stream', provider: 'test', model: 'test', generation: 1, state: 'running' as const,
    text: '继续回答', error: null, startedAt: 1, finishedAt: null }, compressing: false, error: null }
  const services = { locale: { bind: () => resolveCodingNsTranslator(), subscribe: () => () => {}, getSnapshot: () => ({ revision: 1 }) } } as unknown as CodingNsClientServices
  const props = { conversation, name: '助理', t: resolveCodingNsTranslator() }
  const markup = renderToStaticMarkup(createElement(AssistantConversationView, { ...props, services, model }))
  assert.equal((markup.match(/data-codingns-avatar-portrait="portrait-test"/g) ?? []).length, 2)
  assert.ok(markup.includes('问题')); assert.ok(markup.includes('继续回答'))
  const old = renderToStaticMarkup(createElement(AssistantConversationView, props))
  assert.ok(!old.includes('data-codingns-avatar-portrait'))
})

test('保存微调头像先持久化再同步发布，后续自动帧和生成结果不覆盖用户头像', async () => {
  const f = fixture(), key = assistantAvatarPortraitKey(model, f.renderer)
  const release = f.service.retain(model, f.renderer)
  await drain()
  const first = f.service.getSnapshot(model, f.renderer).url
  await f.service.setPortrait(model, f.renderer, png('manual'), new AbortController().signal)
  assert.notEqual(f.service.getSnapshot(model, f.renderer).url, first)
  assert.equal(await f.manual.get(key)!.blob.text(), 'manual')
  assert.deepEqual(f.revoked, [first])
  f.service.offerPreview(model, 'dialog', f.renderer, png('animation'))
  await drain()
  assert.equal(await f.manual.get(key)!.blob.text(), 'manual'); assert.equal(f.crops(), 0)
  release()
})

test('手动头像优先于自动缓存，读取手动设置期间现成动画帧不能抢占', async () => {
  const f = fixture(), key = assistantAvatarPortraitKey(model, f.renderer), job = deferred<AssistantAvatarPreview>()
  f.cached.set(key, png('auto')); f.overrides.read = async () => job.promise
  const release = f.service.retain(model, f.renderer)
  f.service.offerPreview(model, 'dialog', f.renderer, png('early-frame'))
  job.resolve(png('manual')); await drain()
  assert.equal(f.generated(), 0); assert.equal(f.crops(), 0); assert.ok(f.service.getSnapshot(model, f.renderer).url)
  release()
})

test('持久化失败、保存取消和非法裁剪结果保留当前头像，不伪报成功', async () => {
  const f = fixture(), release = f.service.retain(model, f.renderer)
  await drain()
  const previous = f.service.getSnapshot(model, f.renderer)
  f.overrides.write = async () => false
  await assert.rejects(f.service.setPortrait(model, f.renderer, png('manual'), new AbortController().signal), /write_failed/)
  assert.equal(f.service.getSnapshot(model, f.renderer), previous)
  const pending = deferred<boolean>(); f.overrides.write = async () => pending.promise
  const controller = new AbortController(), task = f.service.setPortrait(model, f.renderer, png('manual'), controller.signal)
  controller.abort(); pending.resolve(true)
  await assert.rejects(task, { name: 'AbortError' }); assert.equal(f.service.getSnapshot(model, f.renderer), previous)
  await assert.rejects(f.service.setPortrait(model, f.renderer, { ...png(), height: 100 }, new AbortController().signal), /invalid/)
  release()
})

test('编辑来源按需加载完整帧，旧扩展回退现有头像，角色资源不同不读取其他形象', async () => {
  const f = fixture(), signal = new AbortController().signal
  let sources = 0
  const renderer = { ...f.renderer, createPortraitSource: async () => { sources++; return { ...png('source'), width: 200, height: 300 } } }
  const release = f.service.retain(model, renderer)
  await drain(); assert.equal(sources, 0)
  assert.equal((await f.service.getSource(model, renderer, signal))!.height, 300); assert.equal(sources, 1)
  assert.equal((await f.service.getSource(model, f.renderer, signal))!.width, 128)
  f.service.removeModel(model.id)
  assert.equal(f.manual.size, 0)
  release()
})

test('微调位置随手动头像持久化，完整来源恢复百分比，旧缩略图不重复应用原图坐标', async () => {
  const f = fixture(), signal = new AbortController().signal
  const percentages = { x: 20, y: 10, width: 50, height: 30 }
  const renderer = { ...f.renderer, previewVersion: '1', createPortraitSource: async () => ({ ...png('full-source'), width: 200, height: 300 }) }
  await f.service.setPortrait(model, renderer, { ...png('manual'), cropAreaPercentages: percentages }, signal)
  assert.deepEqual(f.manual.get(assistantAvatarPortraitKey(model, renderer))?.cropAreaPercentages, percentages)
  const source = await f.service.getSource(model, renderer, signal)
  assert.equal(await source!.blob.text(), 'full-source')
  assert.deepEqual(source!.cropAreaPercentages, percentages)
  f.frames.set(assistantAvatarPreviewKey(model, 'dialog', '1'), { ...png('cached-frame'), width: 256, height: 384 })
  const cachedSource = await f.service.getSource(model, renderer, signal)
  assert.equal(await cachedSource!.blob.text(), 'cached-frame')
  assert.deepEqual(cachedSource!.cropAreaPercentages, percentages)
  f.frames.clear()
  const fallback = await f.service.getSource(model, { ...renderer, createPortraitSource: undefined }, signal)
  assert.equal(fallback!.width, 128)
  assert.equal(fallback!.cropAreaPercentages, undefined)
})
