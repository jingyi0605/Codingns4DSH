import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantAvatarPreviewStore, assistantAvatarPreviewKey, validAssistantAvatarPreview } from '../data/build/dist/client/avatar/preview-store.js'
import { captureAssistantAvatarPreview } from '../data/build/dist/client/avatar/preview-capture.js'
import { BUILTIN_ASSISTANT_AVATAR } from '../data/build/dist/shared/assistant-avatar.js'
import type { AssistantAvatarModel } from '../src/shared/assistant-avatar.js'

const model: AssistantAvatarModel = { ...BUILTIN_ASSISTANT_AVATAR, id: 'test', renderer: 'live2d', source: '/a/v1/model.json' }

test('预览键区分双展示、形象、资源版本和构图，等值复制和名称变化不失效', () => {
  const key = assistantAvatarPreviewKey(model, 'dialog', '1', 'https://avatar.test/app')
  assert.equal(key, assistantAvatarPreviewKey({ ...model, name: '新名字', live2d: { scale: 1, position: [0, 0] } }, 'dialog', '1', 'https://avatar.test/other'))
  for (const [next, surface, version] of [
    [{ ...model, id: 'other' }, 'dialog', '1'], [{ ...model, source: '/a/v2/model.json' }, 'dialog', '1'],
    [{ ...model, live2d: { scale: .8 } }, 'dialog', '1'], [{ ...model, live2d: { position: [1, 0] } }, 'dialog', '1'],
    [model, 'floating', '1'], [model, 'dialog', '2'],
  ] as const) assert.notEqual(assistantAvatarPreviewKey(next, surface, version, 'https://avatar.test/app'), key)
  const a = { ...model, motionGroups: { idle: 'Idle', error: 'Error' } }
  const b = { ...model, motionGroups: { error: 'Error', idle: 'Idle' } }
  assert.equal(assistantAvatarPreviewKey(a, 'dialog', '1'), assistantAvatarPreviewKey(b, 'dialog', '1'))
  const surfaces = { ...model, surfaces: { dialog: { renderer: 'live2d', source: '/desk/model.json', spriteVersion: 2 as const } } }
  assert.notEqual(assistantAvatarPreviewKey(surfaces, 'dialog', '1'), assistantAvatarPreviewKey(model, 'dialog', '1'))
  assert.notEqual(assistantAvatarPreviewKey({ ...model, source: 'model.json' }, 'dialog', '1', 'https://avatar.test/one/'),
    assistantAvatarPreviewKey({ ...model, source: 'model.json' }, 'dialog', '1', 'https://avatar.test/two/'))
})

test('预览拒绝非 PNG、空文件和超限数据；存储被禁用或已取消均无副作用', async () => {
  const valid = { blob: new Blob(['png'], { type: 'image/png' }), width: 144, height: 156 }
  assert.equal(validAssistantAvatarPreview(valid), true)
  for (const invalid of [null, {}, { ...valid, width: 0 }, { ...valid, height: 513 }, { ...valid, width: Infinity },
    { ...valid, blob: new Blob([], { type: 'image/png' }) }, { ...valid, blob: new Blob(['svg'], { type: 'image/svg+xml' }) },
    { ...valid, blob: new Blob([new Uint8Array(512 * 1024 + 1)], { type: 'image/png' }) }]) assert.equal(validAssistantAvatarPreview(invalid), false)
  for (const factory of [() => undefined, () => { throw new Error('storage denied') }]) {
    const store = new AssistantAvatarPreviewStore(factory)
    assert.equal(await store.read('key'), undefined)
    assert.equal(await store.write('key', 'test', 'dialog', valid), false)
    await store.remove('key'); await store.removeModel('test')
  }
  const cancelled = new AbortController(); cancelled.abort()
  const store = new AssistantAvatarPreviewStore(() => { throw new Error('不应开启数据库') })
  assert.equal(await store.read('key', cancelled.signal), undefined)
  assert.equal(await store.write('key', 'test', 'dialog', valid, cancelled.signal), false)
})

test('数据库开库阻塞和超时不挂住加载，迟到成功立即关闭连接', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const blocked of [true, false]) {
    let closed = 0
    const request = { result: { close: () => { closed++ } }, onsuccess: undefined, onblocked: undefined } as unknown as IDBOpenDBRequest
    const store = new AssistantAvatarPreviewStore(() => ({ open: () => request }) as unknown as IDBFactory)
    const task = store.read('key')
    if (blocked) request.onblocked?.call(request, new Event('blocked'))
    else context.mock.timers.tick(1000)
    assert.equal(await task, undefined)
    request.onsuccess?.call(request, new Event('success'))
    assert.equal(closed, 1)
  }
})

test('头像百分比裁剪位置兼容旧预览，拒绝空值、非数字和越界坐标', () => {
  const preview = { blob: new Blob(['png'], { type: 'image/png' }), width: 128, height: 128 }
  const area = { x: 20, y: 10, width: 50, height: 30 }
  assert.equal(validAssistantAvatarPreview(preview), true)
  assert.equal(validAssistantAvatarPreview({ ...preview, cropAreaPercentages: area }), true)
  for (const invalid of [null, {}, { ...area, x: -1 }, { ...area, y: NaN }, { ...area, width: 0 },
    { ...area, height: Infinity }, { ...area, x: 51 }, { ...area, height: 91 }, { ...area, width: '50' }]) {
    assert.equal(validAssistantAvatarPreview({ ...preview, cropAreaPercentages: invalid }), false)
  }
})

/** 只模拟 GPU 和 PNG 编码边界，真实 IndexedDB 与绘制缓冲另由隔离浏览器验证。 */
function canvasFixture() {
  let alpha = 0
  let copies = 0
  let drawCalls = 0
  const drawElements = () => { drawCalls++ }
  const drawArrays = () => { drawCalls++ }
  const gl = { drawElements, drawArrays }
  const source = { width: 1024, height: 2048, getContext: () => gl } as unknown as HTMLCanvasElement
  const copied = { width: 0, height: 0, getContext: () => ({ drawImage: () => { copies++ }, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, alpha]) }) }),
    toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })) }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => copied } })
  return { source, gl, copied, original: { drawElements, drawArrays }, alpha: (next: number) => { alpha = next }, copies: () => copies, draws: () => drawCalls,
    restore: () => { if (previous === undefined) delete (globalThis as { document?: unknown }).document; else Object.defineProperty(globalThis, 'document', previous) } }
}

test('完整绘制后的微任务捕获有效透明 PNG，多个 draw 合并且还原原方法', async () => {
  const fixture = canvasFixture()
  try {
    const task = captureAssistantAvatarPreview(fixture.source)
    assert.notEqual(fixture.gl.drawElements, fixture.original.drawElements)
    fixture.gl.drawElements(); fixture.gl.drawArrays()
    fixture.alpha(128)
    const preview = await task
    assert.ok(preview)
    assert.equal(preview.width, 256); assert.equal(preview.height, 512)
    assert.equal(preview.blob.type, 'image/png')
    assert.equal(fixture.draws(), 2)
    assert.equal(fixture.copies(), 2) // 初次空帧一次、该帧多个绘制合并捕获一次。
    assert.equal(fixture.gl.drawElements, fixture.original.drawElements)
    assert.equal(fixture.gl.drawArrays, fixture.original.drawArrays)
  } finally { fixture.restore() }
})

test('空帧不保存，取消与超时均还原绘制方法，迟到绘制不再捕获', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = canvasFixture()
  try {
    const controller = new AbortController()
    const cancelled = captureAssistantAvatarPreview(fixture.source, controller.signal)
    controller.abort()
    assert.equal(await cancelled, undefined)
    assert.equal(fixture.gl.drawElements, fixture.original.drawElements)
    fixture.alpha(255); fixture.gl.drawElements()
    assert.equal(fixture.copies(), 1)
    fixture.alpha(0)
    const expired = captureAssistantAvatarPreview(fixture.source)
    context.mock.timers.tick(1000)
    assert.equal(await expired, undefined)
    assert.equal(fixture.gl.drawArrays, fixture.original.drawArrays)
  } finally { fixture.restore() }
})

test('跨域像素读取失败不影响原绘制，不保存失败预览', async () => {
  const fixture = canvasFixture()
  try {
    fixture.copied.getContext = () => ({ drawImage: () => { throw new Error('SecurityError') }, getImageData: () => ({ data: new Uint8ClampedArray() }) })
    assert.equal(await captureAssistantAvatarPreview(fixture.source), undefined)
    assert.equal(fixture.gl.drawElements, fixture.original.drawElements)
    fixture.gl.drawElements()
    assert.equal(fixture.draws(), 1)
  } finally { fixture.restore() }
})

test('PNG 编码期间取消，迟到编码结果不能提交预览', async () => {
  const fixture = canvasFixture()
  try {
    let encode!: BlobCallback
    fixture.alpha(255)
    fixture.copied.toBlob = callback => { encode = callback }
    const controller = new AbortController()
    const task = captureAssistantAvatarPreview(fixture.source, controller.signal)
    assert.equal(fixture.gl.drawElements, fixture.original.drawElements)
    controller.abort()
    assert.equal(await task, undefined)
    encode(new Blob(['png'], { type: 'image/png' }))
    assert.equal(fixture.gl.drawArrays, fixture.original.drawArrays)
  } finally { fixture.restore() }
})
