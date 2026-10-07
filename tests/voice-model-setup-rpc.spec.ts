import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { registerCodingNsRpc } from '../data/build/dist/host/rpc.js'
import { createGlobalVoiceRpcFeature } from '../data/build/dist/host/features/global-voice-rpc.js'
import { DEFAULT_CODINGNS_SETTINGS, type CodingNsSettings } from '../data/build/dist/shared/contracts/config.js'
import { ASSISTANT_VOICE_MODEL_CATALOG, type AssistantVoiceModelProgress, type AssistantVoiceModelsSnapshot } from '../data/build/dist/shared/voice-models.js'
import type { CodingNsHostServices } from '../data/build/dist/host/features/types.js'
import type { AssistantVoiceModelProbe } from '../data/build/dist/host/features/voice-model-management.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** 所有下载都写入独立临时目录；不读取真实 Host 或 Desktop 的模型配置。 */
async function fixture(t: TestContext, onSave: () => Promise<void> = async () => {}, probeVoiceModel: AssistantVoiceModelProbe = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-setup-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  let settings = DEFAULT_CODINGNS_SETTINGS
  let saves = 0
  const rpc = new CodingNsRpcTable()
  const services = { rpc, settings: {
    get: () => settings,
    update: async (patch: Partial<CodingNsSettings>) => { saves += 1; await onSave(); settings = { ...settings, ...patch } },
  } } as unknown as CodingNsHostServices
  const registry = new FeatureRegistry(services)
  t.after(async () => {
    await registry.reconcile([])
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(directory, { recursive: true, force: true })
  })
  // 此处验证下载进度与 RPC 生命周期，四字节下载夹具不是真实 ONNX 模型。
  registry.register(createGlobalVoiceRpcFeature({ probeVoiceModel }))
  await registry.reconcile(['globalVoiceRpc'])
  const call = async (endpoint: string, payload: unknown = {}) => {
    const target = rpc.resolve(`assistant/${endpoint}`)!
    return target.handler(target.action, payload)
  }
  return { call, settings: () => settings, saves: () => saves }
}

test('初始化期间可查询真实进度，隔离其他请求，禁止重复下载与启动语音', async (t) => {
  const saving = deferred()
  const saveFinished = deferred()
  const f = await fixture(t, async () => { saving.resolve(); await saveFinished.promise })
  const fetched = deferred()
  let firstFile!: ReadableStreamDefaultController<Uint8Array>
  let downloads = 0
  t.mock.method(globalThis, 'fetch', async () => {
    downloads += 1
    if (downloads === 1) {
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { firstFile = controller } }), { headers: { 'content-length': '4' } })
      fetched.resolve()
      return response
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '4' } })
  })
  const modelId = ASSISTANT_VOICE_MODEL_CATALOG[0]!.id
  const request = { modelId, requestId: 'setup-a' }
  assert.equal(await f.call('voice/setup-progress', request), null)
  const setup = f.call('voice/setup', request)
  await fetched.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  const initial = await f.call('voice/setup-progress', request) as AssistantVoiceModelProgress
  assert.equal(initial.phase, 'downloading')
  assert.equal(initial.totalBytes, 4)
  assert.equal(initial.downloadedBytes, 0)
  assert.equal(await f.call('voice/setup-progress', { requestId: 'setup-b' }), null)
  assert.equal(await f.call('voice/setup-progress'), null)
  await assert.rejects(() => f.call('voice/setup', { modelId, requestId: 'setup-b' }), /正在下载或初始化/u)
  await assert.rejects(() => f.call('voice/start', { ownerId: 'other-tab' }), /等待语音模型初始化完成/u)
  firstFile.enqueue(new Uint8Array([1, 2]))
  // 只有落盘后才报告字节数，等待真实文件 I/O 完成而不是猜测完成时机。
  const deadline = Date.now() + 2000
  let halfway = initial
  while (halfway.downloadedBytes !== 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    halfway = await f.call('voice/setup-progress', request) as AssistantVoiceModelProgress
  }
  assert.equal(halfway.downloadedBytes, 2)
  assert.equal(halfway.totalBytes, 4)
  firstFile.enqueue(new Uint8Array([3, 4]))
  firstFile.close()
  await saving.promise
  assert.equal((await f.call('voice/setup-progress', request) as AssistantVoiceModelProgress).phase, 'initializing')
  saveFinished.resolve()
  assert.deepEqual(await setup, { modelId, downloaded: true })
  assert.equal((await f.call('voice/setup-progress', request) as AssistantVoiceModelProgress).phase, 'completed')
  assert.equal(f.settings().assistant.voice.initialized, true)
  assert.equal(f.settings().assistant.voice.modelId, modelId)
  assert.equal(downloads, 4)
  // 老客户端仍能用原载荷初始化，且第二次复用缓存。
  assert.deepEqual(await f.call('voice/setup', { modelId }), { modelId, downloaded: false })
  assert.equal(downloads, 4)
  assert.equal(f.saves(), 2)
})

test('下载失败清除状态且不保存配置，后续请求可以重试', async (t) => {
  const f = await fixture(t)
  let failing = true
  t.mock.method(globalThis, 'fetch', async () => failing ? new Response(null, { status: 503 }) : new Response(new Uint8Array([1, 2, 3])))
  const request = { modelId: ASSISTANT_VOICE_MODEL_CATALOG[0]!.id, requestId: 'failed-setup' }
  await assert.rejects(() => f.call('voice/setup', request), /下载失败（503）/u)
  assert.equal(await f.call('voice/setup-progress', request), null)
  assert.equal(f.saves(), 0)
  assert.equal(f.settings().assistant.voice.initialized, false)
  failing = false
  const retry = { ...request, requestId: 'retry-setup' }
  assert.deepEqual(await f.call('voice/setup', retry), { modelId: request.modelId, downloaded: true })
  assert.equal((await f.call('voice/setup-progress', retry) as AssistantVoiceModelProgress).phase, 'completed')
  assert.equal(await f.call('voice/setup-progress', request), null)
  assert.equal(f.saves(), 1)
})

test('模型切换先验证再保存；失败保留当前模型，单独验证不更改选择', async (t) => {
  let failing = false
  const f = await fixture(t, async () => {}, async () => { if (failing) throw new Error('模型不能加载') })
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])))
  const previousModel = ASSISTANT_VOICE_MODEL_CATALOG[1]!.id
  const nextModel = ASSISTANT_VOICE_MODEL_CATALOG[0]!.id
  await f.call('voice/setup', { modelId: previousModel })
  failing = true
  await assert.rejects(() => f.call('voice/setup', { modelId: nextModel }), /模型不能加载/u)
  assert.equal(f.settings().assistant.voice.modelId, previousModel)
  assert.equal(f.saves(), 1)
  let snapshot = await f.call('voice/models') as AssistantVoiceModelsSnapshot
  assert.equal(snapshot.currentModelId, previousModel)
  assert.equal(snapshot.models[0]?.state, 'downloaded')
  assert.equal(snapshot.models[0]?.validation.state, 'failed')
  assert.equal(snapshot.models[1]?.current, true)
  assert.equal(snapshot.operation, null)
  failing = false
  await f.call('voice/model/verify', { modelId: nextModel })
  snapshot = await f.call('voice/models') as AssistantVoiceModelsSnapshot
  assert.equal(snapshot.models[0]?.validation.state, 'passed')
  assert.equal(snapshot.currentModelId, previousModel)
  assert.equal(f.saves(), 1)
  await f.call('voice/setup', { modelId: nextModel })
  assert.equal(f.settings().assistant.voice.modelId, nextModel)
  assert.equal(f.saves(), 2)
})

test('旧版 HTTP 入口登记进度查询路由，并返回同一份 RPC 状态', async () => {
  const table = new CodingNsRpcTable()
  const progress: AssistantVoiceModelProgress = {
    modelId: 'model-a', phase: 'downloading', fileName: 'encoder.onnx', fileIndex: 1,
    fileCount: 4, downloadedBytes: 2, totalBytes: 4,
  }
  table.register('assistant', (action, payload) => {
    assert.equal(action, 'voice/setup-progress')
    assert.deepEqual(payload, { requestId: 'setup-a' })
    return progress
  })
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let dispose!: () => Promise<void>
  const context = {
    webServer: { register: () => () => {} },
    connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
      routes.set(route.path, route.fetch)
      return () => { routes.delete(route.path) }
    } } },
    effect: (effect: () => () => Promise<void>) => { dispose = effect() },
  } as unknown as Context
  registerCodingNsRpc(context, table)
  try {
    assert.ok(routes.has('/api/codingns/assistant/voice/models'))
    assert.ok(routes.has('/api/codingns/assistant/voice/model/verify'))
    const path = '/api/codingns/assistant/voice/setup-progress'
    const route = routes.get(path)
    assert.ok(route, '旧版 HTTP 精确路由必须包含新增查询端点')
    const response = await route(new Request(`https://voice.test${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 'rpc-a', method: 'assistant/voice/setup-progress', payload: { requestId: 'setup-a' } }),
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'rpc-a', result: { ok: true, value: progress } })
  } finally {
    await dispose()
  }
  assert.equal(routes.size, 0)
})
