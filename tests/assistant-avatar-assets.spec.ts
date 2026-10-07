import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantAvatarAssetHandler, prepareAssistantAvatarManifest } from '../data/build/dist/host/features/assistant-avatar-legacy-assets.js'
import { registerAssistantAvatarRoutes } from '../data/build/dist/host/features/assistant-avatar-runtime.js'
import { WHALE_LIVE2D_RESOURCE_PACK as pack } from '../data/build/dist/shared/assistant-avatar-legacy-resources.js'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'

const manifest = {
  Version: 3, Groups: [{ Name: 'EyeBlink', Target: 'Parameter', Ids: ['ParamEyeLOpen'] }], Layout: { CenterX: 0 },
  FileReferences: { Moc: 'model/c_0120.moc3', Textures: ['textures/texture_00.png', 'textures/texture_01.png'],
    Physics: 'model/c_0120.physics3.json', DisplayInfo: 'model/c_0120.cdi3.json',
    Expressions: Array.from({ length: 44 }, (_, index) => ({ Name: `expression-${index}`, File: `expressions/${index}.exp3.json` })),
    Motions: { Idle: [{ File: 'motions/idle.motion3.json' }], SprayWater: [{ File: 'motions/spray-water.motion3.json' }],
      Hammer: [{ File: 'motions/hammer.motion3.json' }], BubbleGum: [{ File: 'motions/bubble-gum.motion3.json' }],
      OpenCase: [{ File: 'motions/open-case.motion3.json' }], Selfie: [{ File: 'motions/selfie.motion3.json' }],
      SelfieQuick: [{ File: 'motions/selfie-quick.motion3.json' }], Ketchup: [{ File: 'motions/ketchup.motion3.json' }] },
  },
}
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${pack.basePath}${path}`, init)
const responseFor = (url: string) => new Response(url.endsWith(pack.manifest) ? JSON.stringify(manifest) : 'test-asset')

test('预设清单从 44 个表情与 8 个动作精简至两个必要动作，布局物理等参数不变', () => {
  const prepared = JSON.parse(prepareAssistantAvatarManifest(manifest, pack))
  assert.deepEqual(prepared.FileReferences.Expressions, [])
  assert.deepEqual(Object.keys(prepared.FileReferences.Motions), ['Idle', 'SprayWater'])
  assert.deepEqual(prepared.Groups, manifest.Groups)
  assert.deepEqual(prepared.Layout, manifest.Layout)
  for (const field of ['Moc', 'Textures', 'Physics', 'DisplayInfo']) assert.deepEqual(prepared.FileReferences[field], manifest.FileReferences[field])
  assert.equal(manifest.FileReferences.Expressions.length, 44)
  assert.equal(Object.keys(manifest.FileReferences.Motions).length, 8)
  assert.throws(() => prepareAssistantAvatarManifest({ ...manifest, Version: 2 }, pack), /无效/u)
  assert.throws(() => prepareAssistantAvatarManifest({ ...manifest, FileReferences: { ...manifest.FileReferences, Moc: 'https://other.test/model.moc3' } }, pack), /未登记/u)
  assert.throws(() => prepareAssistantAvatarManifest({ ...manifest, FileReferences: { ...manifest.FileReferences, Moc: '' } }, pack), /未登记/u)
  assert.throws(() => prepareAssistantAvatarManifest({ ...manifest, FileReferences: { ...manifest.FileReferences, Textures: [''] } }, pack), /未登记/u)
  assert.throws(() => prepareAssistantAvatarManifest({ ...manifest, FileReferences: { ...manifest.FileReferences,
    Motions: { ...manifest.FileReferences.Motions, Idle: [{}] } } }, pack), /动作/u)
  assert.throws(() => prepareAssistantAvatarManifest({ ...manifest, FileReferences: { ...manifest.FileReferences, Motions: { Idle: manifest.FileReferences.Motions.Idle } } }, pack), /不完整/u)
})

test('首次清单立即返回并并发预取六个依赖，引擎分阶段和并发请求命中同一下载', async () => {
  const calls: string[] = []
  const complete = new Map<string, () => void>()
  const handler = createAssistantAvatarAssetHandler(async (input, init) => {
    const url = String(input); calls.push(url)
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal)
    if (!url.endsWith(pack.manifest)) await new Promise<void>((resolve) => { complete.set(url, resolve) })
    return responseFor(url)
  })
  assert.equal(calls.length, 0)
  const first = await handler(request(pack.manifest))
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-codingns-avatar-cache'), 'miss')
  assert.deepEqual((await first.json()).FileReferences.Expressions, [])
  assert.equal(calls.length, 7)
  assert.equal(complete.size, 6)
  assert.ok(!calls.some((url) => /expression|hammer|selfie|\.cdi3/u.test(url)))
  const a = handler(request('model/c_0120.moc3')); const b = handler(request('model/c_0120.moc3'))
  complete.get(pack.upstreamRoot + 'model/c_0120.moc3')!()
  const responses = await Promise.all([a, b])
  assert.ok(responses.every((response) => response.headers.get('x-codingns-avatar-cache') === 'shared'))
  assert.deepEqual(await Promise.all(responses.map((response) => response.text())), ['test-asset', 'test-asset'])
  assert.equal(calls.length, 7)
  for (const finish of complete.values()) finish()
  for (const file of pack.files.filter((file) => file.preload !== false)) assert.equal((await handler(request(file.path))).status, 200)
  assert.equal(calls.length, 7)
  const cached = await handler(request('textures/texture_00.png'))
  assert.equal(cached.headers.get('x-codingns-avatar-cache'), 'hit')
  assert.equal(cached.headers.get('content-type'), 'image/png')
  assert.match(cached.headers.get('cache-control')!, /private.*immutable/u)
  assert.equal(cached.headers.get('x-content-type-options'), 'nosniff')
  // 每次 Response 独立，上一调用读取正文不会耗尽缓存。
  assert.equal(await cached.text(), 'test-asset')
  assert.equal(await (await handler(request('textures/texture_00.png'))).text(), 'test-asset')
  assert.equal(calls.length, 7)
})

test('关闭再打开和多个 Client 的同源读取复用 Host 缓存；query 不能更换下载来源', async () => {
  const calls: string[] = []
  const handler = createAssistantAvatarAssetHandler(async (input) => { const url = String(input); calls.push(url); return responseFor(url) })
  for (let index = 0; index < 3; index++) {
    const response = await handler(request(`${pack.manifest}?url=https://other.test/model.json`, { headers: { Authorization: `Bearer client-${index}` } }))
    assert.equal(response.status, 200)
    assert.ok(!(await response.text()).includes('other.test'))
    for (const file of pack.files.filter((file) => file.preload !== false)) await handler(request(file.path))
  }
  assert.equal(calls.length, 7)
  assert.ok(calls.every((url) => url.startsWith(pack.upstreamRoot)))
})

test('越界路径与非 GET 不触发下载，未使用的显示信息仅在明确请求时读取', async () => {
  const calls: string[] = []
  const handler = createAssistantAvatarAssetHandler(async (input) => { const url = String(input); calls.push(url); return responseFor(url) })
  for (const path of ['expressions/0.exp3.json', 'motions/hammer.motion3.json', '../../secret', 'https://other.test/a', 'missing']) assert.equal((await handler(request(path))).status, 404)
  assert.equal((await handler(request(pack.manifest, { method: 'POST' }))).status, 405)
  assert.equal(calls.length, 0)
  assert.equal((await handler(request('model/c_0120.cdi3.json'))).status, 200)
  assert.deepEqual(calls, [pack.upstreamRoot + 'model/c_0120.cdi3.json'])
})

test('下载或清单失败不永久缓存，失败无浏览器缓存，恢复后能重试', async () => {
  let calls = 0
  const handler = createAssistantAvatarAssetHandler(async (input) => {
    if (String(input).endsWith(pack.manifest) && ++calls === 1) return new Response('unavailable', { status: 503 })
    return responseFor(String(input))
  })
  const failed = await handler(request(pack.manifest))
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('cache-control'), 'no-store')
  assert.equal((await handler(request(pack.manifest))).status, 200)
  assert.equal(calls, 2)
  let bad = true
  const invalid = createAssistantAvatarAssetHandler(async (input) => String(input).endsWith(pack.manifest) && bad ? new Response('{}') : responseFor(String(input)))
  assert.equal((await invalid(request(pack.manifest))).status, 503)
  bad = false
  assert.equal((await invalid(request(pack.manifest))).status, 200)
})

test('声明体积、流式实际体积与空响应均有界，拒绝的请求可以重试', async () => {
  for (const mode of ['header', 'stream', 'empty'] as const) {
    let bad = true
    const handler = createAssistantAvatarAssetHandler(async () => {
      if (!bad) return new Response('recovered')
      if (mode === 'header') return new Response('oversized', { headers: { 'Content-Length': '99999999' } })
      if (mode === 'empty') return new Response('')
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1048577)); controller.close() } }))
    })
    assert.equal((await handler(request('model/c_0120.physics3.json'))).status, 503)
    bad = false
    assert.equal(await (await handler(request('model/c_0120.physics3.json'))).text(), 'recovered')
  }
})

test('全部固定路由按原生 buffered GET 注册，重复释放和注册失败不会残留', async () => {
  const active = new Set<string>()
  const methods: unknown[] = []
  let failAt: number | undefined
  let count = 0
  const registry = { register: (route: { path: string; methods: readonly string[]; requestBody: string }) => {
    if (++count === failAt) throw new Error('registration failed')
    assert.equal(route.requestBody, 'buffered'); methods.push(route.methods)
    active.add(route.path)
    return async () => { active.delete(route.path) }
  } } as unknown as HostConnectionFetch
  const release = registerAssistantAvatarRoutes(registry, async () => new Response('test'), true)
  assert.equal(active.size, 16)
  assert.ok(methods.every((value) => JSON.stringify(value) === '["GET"]'))
  await release(); await release()
  assert.equal(active.size, 0)
  count = 0; failAt = 4
  assert.throws(() => registerAssistantAvatarRoutes(registry, async () => new Response('test'), true), /registration/u)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(active.size, 0)
})

test('缓存状态读取不下载素材，准确区分成功缓存、进行中与重试下载次数', async () => {
  let calls = 0
  let complete!: () => void
  const handler = createAssistantAvatarAssetHandler(async () => {
    calls++
    await new Promise<void>((resolve) => { complete = resolve })
    return new Response('asset')
  })
  const read = async () => {
    const response = await handler(request('cache-status.json'))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return response.json()
  }
  const initial = await read()
  const generation = initial.generation
  assert.match(generation, /^[0-9a-f-]{36}$/u)
  assert.deepEqual(initial, { version: 1, generation, pack: pack.basePath, total: 7, cached: 0, pending: 0, downloads: 0 })
  assert.equal(calls, 0)
  const asset = handler(request('model/c_0120.moc3'))
  assert.deepEqual(await read(), { version: 1, generation, pack: pack.basePath, total: 7, cached: 0, pending: 1, downloads: 1 })
  complete(); await asset
  assert.deepEqual(await read(), { version: 1, generation, pack: pack.basePath, total: 7, cached: 1, pending: 0, downloads: 1 })
  await handler(request('model/c_0120.moc3'))
  assert.equal(calls, 1)
  assert.equal((await handler(request('cache-status.json', { method: 'POST' }))).status, 405)
  let fail = true
  const retry = createAssistantAvatarAssetHandler(async () => fail ? new Response('failed', { status: 503 }) : new Response('ok'))
  await retry(request('model/c_0120.moc3'))
  const failed = await (await retry(request('cache-status.json'))).json()
  assert.notEqual(failed.generation, generation)
  assert.deepEqual(failed, { version: 1, generation: failed.generation, pack: pack.basePath, total: 7, cached: 0, pending: 0, downloads: 1 })
  fail = false
  await retry(request('model/c_0120.moc3'))
  assert.equal((await (await retry(request('cache-status.json'))).json()).downloads, 2)
})

test('生产入口重建 Handler 仍共享完成缓存，不重新发起外网获取', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('shared-production-asset') }
  try {
    const first = createAssistantAvatarAssetHandler()
    const second = createAssistantAvatarAssetHandler()
    assert.equal((await first(request('model/c_0120.moc3'))).headers.get('x-codingns-avatar-cache'), 'miss')
    const cached = await second(request('model/c_0120.moc3'))
    assert.equal(cached.headers.get('x-codingns-avatar-cache'), 'hit')
    assert.equal(await cached.text(), 'shared-production-asset')
    assert.equal(calls, 1)
    assert.equal((await (await second(request('cache-status.json'))).json()).cached, 1)
  } finally { globalThis.fetch = original }
})
