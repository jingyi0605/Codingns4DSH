import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AssistantAvatarCatalog } from '../src/host/avatar/catalog.js'
import { AssistantAvatarPackages } from '../src/host/avatar/packages.js'
import { AssistantAvatarTemporaryPreviews } from '../src/host/avatar/temporary-previews.js'
import { AssistantAvatarRemote } from '../src/host/avatar/remote.js'
import { createAssistantAvatarRuntimeFeature } from '../src/host/features/assistant-avatar-runtime.js'
import { AssistantAvatarManager } from '../src/client/avatar/manager.js'
import { AssistantAvatarTemporaryPreviewSession, startAssistantAvatarTemporaryPreview } from '../src/client/avatar/temporary-preview.js'
import { AssistantConfigurationPage, readAssistantDraft } from '../src/client/features/assistant-workbench.js'
import { AssistantAppearanceEditor } from '../src/client/avatar/settings-panel.js'
import { AssistantAvatarCatalogPreviewRegion } from '../src/client/avatar/catalog-panel.js'
import { AssistantAvatarSlot } from '../src/client/avatar/slot.js'
import { registerAssistantAvatarRenderer } from '../src/client/avatar/registry.js'
import { FeatureRegistry } from '../src/features/index.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { registerCodingNsRpc } from '../src/host/rpc.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { ASSISTANT_AVATAR_CONSENT_VERSION, ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH } from '../src/shared/assistant-avatar-catalog.js'
import { ASSISTANT_AVATAR_ASSET_PATH } from '../src/shared/assistant-avatar-installation.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CodingNsClientServices, CodingNsRpcClient } from '../src/client/features/types.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import type { CodingNsSettingsStore } from '../src/dsh-capabilities/settings-store.js'
import type { CodingNsSettings } from '../src/shared/contracts/config.js'

const revision = 'a'.repeat(40)
const root = `https://raw.githubusercontent.com/example/pets/${revision}/`
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: { after(fn: () => Promise<void>): void }, live2d = false, gate?: ReturnType<typeof deferred<void>>, http = false) {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-temporary-preview-test-'))
  const downloads: string[] = []; const started = deferred<void>()
  let downloadSignal: AbortSignal | undefined
  const resources: Record<string, Uint8Array | string> = {
    [`${root}idle.png`]: png, [`${root}texture.png`]: png, [`${root}model.moc3`]: new Uint8Array([1, 2, 3]),
    [`${root}model.model3.json`]: JSON.stringify({ Version: 3, FileReferences: { Moc: 'model.moc3', Textures: ['texture.png'] } }),
  }
  const remote = new AssistantAvatarRemote(async (url, options) => {
    downloadSignal = options?.signal ?? undefined
    downloads.push(String(url)); started.resolve()
    if (gate !== undefined) await gate.promise
    const resource = resources[String(url)]
    if (resource === undefined) throw new Error(`非素材请求：${url}`)
    return new Response(resource)
  }, async () => [{ address: '93.184.216.34' }])
  const manifest = { avatarManifestVersion: 1, id: 'catalog-test', name: '测试形象', author: '作者', license: '测试许可', homepage: 'https://github.com/example/pets',
    asset: { renderer: live2d ? 'live2d' : 'image', source: `${root}${live2d ? 'model.model3.json' : 'idle.png'}`, spriteVersion: 2 } }
  const metadata = { catalogVersion: 1, packages: [{ number: 1, id: 'test', revision, name: '测试形象', author: '作者', repositoryUrl: 'https://github.com/example/pets',
    description: '测试说明', remarks: '测试备注', format: live2d ? 'cubism3' : 'codingns-pack', licenseUrl: `${root}LICENSE`,
    installManifestUrl: 'https://raw.githubusercontent.com/example/catalog/main/avatar.json', previewUrl: `${root}宣传图.png`, verification: { files: live2d ? 3 : 1, bytes: 200 } }] }
  const catalog = new AssistantAvatarCatalog(async (path) => JSON.stringify(path.endsWith('catalog.json') ? metadata : manifest), remote)
  let now = 1000
  const temporary = new AssistantAvatarTemporaryPreviews(catalog, (path) => new AssistantAvatarPackages(path, remote), directory, () => now, 180_000)
  const packages = new AssistantAvatarPackages(join(directory, 'permanent'), remote)
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  value.assistant.appearance = normalizeAssistantAppearance({ thirdPartyConsent: { version: ASSISTANT_AVATAR_CONSENT_VERSION, acceptedAt: 1 } })
  let writable = true; let reject = false; let writes = 0
  const settings = { getSnapshot: () => ({ value, writable, status: 'ready', revision: 1 }), subscribe: () => () => {},
    mutate: async (ops) => { if (reject) return false; writes++; value.assistant.appearance = ops[0]!.value; return true },
  } as CodingNsSettingsStore<CodingNsSettings>
  const table = new CodingNsRpcTable()
  let handle = async (_request: Request) => new Response(null, { status: 404 })
  const services = { settings: { get: () => value }, settingsProvider: { get writable() { return writable } }, rpc: table,
    registerAssistantAvatarRuntimeRoute: (handler: typeof handle) => { handle = handler; return () => {} },
  } as unknown as CodingNsHostServices
  const features = new FeatureRegistry(services)
  features.register(createAssistantAvatarRuntimeFeature({ catalog, packages, temporary }))
  await features.reconcile(['assistantAvatarRuntime'])
  t.after(async () => { gate?.resolve(); await features.reconcile([]); await rm(directory, { recursive: true, force: true }) })
  let rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload, signal) => ({ ok: true,
    value: await table.resolve(endpoint)!.handler(endpoint.slice('avatar/'.length), payload, { signal } as never),
  }) }
  if (http) {
    // 真实 Node HTTP 生命周期；隔离测试端口，不依赖或操作任何运行中的 Host。
    let channel!: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    let dispose!: () => Promise<void>
    registerCodingNsRpc({
      webServer: { register: (route) => { channel = route.handler; return () => {} } },
      connection: { requestRejection: () => undefined, fetch: { register: () => () => {} } },
      effect: (effect) => { dispose = effect() },
    } as unknown as Parameters<typeof registerCodingNsRpc>[0], table)
    const server = createServer((request, response) => { void channel(request, response) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await dispose() })
    rpc = { call: async (_channel, endpoint, payload, signal) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/codingns/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload }),
      })
      return (await response.json()).result
    } }
  }
  const manager = new AssistantAvatarManager(settings, undefined, undefined, undefined, rpc)
  const request = (source: string) => handle(new Request(new URL(source, 'https://codingns.test')))
  const folders = async () => (await readdir(directory)).filter((name) => name.startsWith('codingns-avatar-preview-'))
  return { value, manager, temporary, packages, table, downloads, directory, request, folders, features, started,
    downloadSignal: () => downloadSignal,
    readonly: () => { writable = false }, reject: () => { reject = true }, writes: () => writes,
    advance: (ms: number) => { now += ms },
  }
}

test('完整 HTTP 请求体结束不能取消仍在下载的临时预览，响应完成后租约仍可用', async (t) => {
  const f = await fixture(t, false, undefined, true)
  const preview = await f.manager.previewCatalog('test', revision, randomUUID())
  assert.equal(f.downloads.length, 1)
  assert.equal(f.downloadSignal()!.aborted, false, '正常响应结束不能取消仍有效的预览租约')
  assert.equal((await f.request(preview.model.source)).status, 200)
  await f.manager.keepPreview(preview.lease)
  assert.equal(f.writes(), 0)
  await f.manager.releasePreview(preview.lease)
  assert.deepEqual(await f.folders(), [])
})

test('HTTP 请求体读完后用户断开响应，仍取消素材下载并清理临时目录', { timeout: 5000 }, async (t) => {
  const gate = deferred<void>(); const f = await fixture(t, false, gate, true)
  const controller = new AbortController(); const lease = randomUUID()
  const loading = f.manager.previewCatalog('test', revision, lease, controller.signal)
  await f.started.promise
  const signal = f.downloadSignal()!
  assert.equal(signal.aborted, false)
  const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  controller.abort()
  await assert.rejects(loading, { name: 'AbortError' })
  await aborted
  gate.resolve(); await f.temporary.release(lease)
  assert.deepEqual(await f.folders(), []); assert.equal(f.writes(), 0)
})

test('Live2D 清单与全部依赖走独立租约，释放后磁盘和入口清理，设置不变', async (t) => {
  const f = await fixture(t, true)
  const before = structuredClone(f.value)
  const lease = randomUUID()
  const preview = await f.manager.previewCatalog('test', revision, lease)
  await assert.rejects(f.manager.installCatalog('test', 'b'.repeat(40), true, undefined, lease), /一致/u)
  assert.equal(preview.model.renderer, 'live2d')
  assert.ok(preview.model.source.startsWith(ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH))
  assert.equal((await f.packages.list()).length, 0)
  assert.equal((await f.folders()).length, 1)
  const response = await f.request(preview.model.source)
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  const model = await response.json()
  const dependencies = [model.FileReferences.Moc, ...model.FileReferences.Textures]
  for (const source of dependencies) {
    const url = new URL(source, new URL(preview.model.source, 'https://codingns.test'))
    assert.equal(url.pathname, ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH)
    assert.equal(url.searchParams.get('lease'), lease)
    assert.equal((await f.request(url.href)).status, 200)
  }
  assert.equal(f.downloads.length, 3); assert.equal(f.writes(), 0); assert.deepEqual(f.value, before)
  f.readonly(); delete f.value.assistant.appearance!.thirdPartyConsent
  await f.manager.releasePreview(lease)
  assert.deepEqual(await f.folders(), [], '只读或撤销协议后也能清理')
})

test('采用临时预览复用已下载素材，清理临时目录不删除正式安装和当前角色', async (t) => {
  const f = await fixture(t, true)
  const lease = randomUUID()
  const preview = await f.manager.previewCatalog('test', revision, lease)
  const model = await f.manager.installCatalog('test', revision, true, undefined, lease)
  assert.equal(model.id, 'catalog-test'); assert.ok(model.source.startsWith(ASSISTANT_AVATAR_ASSET_PATH))
  assert.equal(f.downloads.length, 3, '正式采用不能重复下载')
  await f.manager.releasePreview(lease)
  assert.deepEqual(await f.folders(), [])
  assert.equal((await f.request(preview.model.source)).status, 404)
  const response = await f.request(model.source)
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.ok(!text.includes('temporary')); assert.ok(!text.includes('lease='))
  assert.equal(f.manager.getSelected().id, model.id)
  assert.equal((await f.packages.list()).length, 1)
  assert.equal(f.writes(), 1)
})

test('预览无需形象许可，正式采用仍由 Client 和 Host 校验许可，拒绝时不登记或重复下载', async (t) => {
  const f = await fixture(t)
  const session = new AssistantAvatarTemporaryPreviewSession(f.manager)
  const preview = await session.load({ id: 'test', revision })
  assert.equal(f.downloads.length, 1)
  assert.equal((await f.folders()).length, 1)
  assert.equal((await f.request(preview.model.source)).status, 200)
  assert.equal(f.writes(), 0); assert.equal(f.manager.getSelected().id, 'codingns-default')
  await assert.rejects(f.manager.installCatalog('test', revision, false, undefined, preview.lease), /许可及应用/u)
  const handler = f.table.resolve('avatar/installCatalog')!.handler
  for (const licenseAccepted of [undefined, false]) {
    await assert.rejects(Promise.resolve().then(() => handler('installCatalog', { id: 'test', revision, lease: preview.lease, licenseAccepted })), /许可及应用/u)
  }
  assert.equal(f.downloads.length, 1); assert.equal(f.writes(), 0)
  assert.equal((await f.packages.list()).length, 0)
  assert.equal((await f.request(preview.model.source)).status, 200, '许可未同意不停止临时预览')
  await f.manager.installCatalog('test', revision, true, undefined, preview.lease)
  assert.equal(f.downloads.length, 1); assert.equal(f.writes(), 1)
  await session.dispose(); assert.deepEqual(await f.folders(), [])
})

test('错误版本及只读不下载；采用预览拒绝写设置后回收正式副本', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.manager.previewCatalog('test', 'b'.repeat(40), randomUUID()), /变更/u)
  assert.equal(f.downloads.length, 0); assert.deepEqual(await f.folders(), [])
  const lease = randomUUID()
  await f.manager.previewCatalog('test', revision, lease)
  f.reject()
  await assert.rejects(f.manager.installCatalog('test', revision, true, undefined, lease), /拒绝/u)
  assert.equal((await f.packages.list()).length, 0)
  assert.equal(f.manager.getSelected().id, 'codingns-default')
  await f.manager.releasePreview(lease)
  f.readonly()
  await assert.rejects(f.manager.previewCatalog('test', revision, randomUUID()), /只读/u)
  const handler = f.table.resolve('avatar/previewCatalog')!.handler
  await assert.rejects(Promise.resolve().then(() => handler('previewCatalog', { id: 'test', revision, lease: randomUUID() })), /只读/u)
  assert.equal(f.downloads.length, 1)
})

test('预览心跳延续生命周期，失联超时及模块停用清理所有临时目录', async (t) => {
  const f = await fixture(t)
  const first = await f.manager.previewCatalog('test', revision, randomUUID())
  f.advance(120_000); await f.manager.keepPreview(first.lease)
  f.advance(120_000); await f.temporary.reap()
  assert.equal((await f.request(first.model.source)).status, 200)
  f.advance(180_001); await f.temporary.reap()
  assert.equal((await f.request(first.model.source)).status, 404); assert.deepEqual(await f.folders(), [])
  await f.manager.previewCatalog('test', revision, randomUUID())
  await f.features.reconcile([])
  assert.deepEqual(await f.folders(), [])
  assert.equal((await f.packages.list()).length, 0)
})

test('下载中取消和先取消后迟到创建不会残留素材或复活预览', async (t) => {
  const gate = deferred<void>(); const f = await fixture(t, false, gate)
  const session = new AssistantAvatarTemporaryPreviewSession(f.manager)
  const loading = session.load({ id: 'test', revision })
  await f.started.promise
  const clearing = session.dispose()
  gate.resolve()
  await assert.rejects(loading)
  await clearing
  assert.deepEqual(await f.folders(), []); assert.equal(f.writes(), 0)
  const cancelled = randomUUID()
  await f.manager.releasePreview(cancelled)
  await assert.rejects(f.manager.previewCatalog('test', revision, cancelled), /取消/u)
  assert.deepEqual(await f.folders(), [])
})

test('客户端遇到忽略取消的迟到答复再次释放租约，不持有计时器或采用模型', async () => {
  const lease = randomUUID(); const result = deferred<any>(); let released = 0
  const manager = { previewCatalog: () => result.promise, keepPreview: async () => {}, releasePreview: async () => { released++ } }
  const session = new AssistantAvatarTemporaryPreviewSession(manager, undefined, lease)
  const loading = session.load({ id: 'test', revision })
  await session.dispose()
  result.resolve({ lease, model: { id: `preview-${lease}`, source: '/temporary' } })
  await assert.rejects(loading)
  assert.equal(released, 2)
})

test('自动预览挂载即下载，不需要许可参数，退出时隔离迟到结果和状态回调', async () => {
  const replies = [deferred<any>(), deferred<any>()]
  const requests: { id: string; lease: string; signal?: AbortSignal }[] = []
  const released: string[] = []; const visible: string[] = []; const settled = deferred<void>()
  const manager = {
    previewCatalog: (id: string, _revision: string, lease: string, signal?: AbortSignal) => {
      requests.push({ id, lease, signal }); return replies[requests.length - 1]!.promise
    },
    keepPreview: async () => {}, releasePreview: async (lease: string) => { released.push(lease) },
  }
  const first = startAssistantAvatarTemporaryPreview(manager, { id: 'first', revision }, {
    onLoaded: () => visible.push('旧形象'), onError: () => visible.push('旧错误'), onSettled: () => visible.push('旧状态'),
  })
  assert.equal(requests.length, 1, '无需点击下载按钮就发起请求')
  await first.dispose(); assert.equal(requests[0]!.signal!.aborted, true)
  const second = startAssistantAvatarTemporaryPreview(manager, { id: 'second', revision }, {
    onLoaded: () => visible.push('新形象'), onError: () => visible.push('新错误'), onSettled: () => settled.resolve(),
  })
  assert.equal(requests.length, 2)
  replies[0]!.resolve({ lease: requests[0]!.lease, model: { id: 'first' } })
  replies[1]!.resolve({ lease: requests[1]!.lease, model: { id: 'second' } })
  await settled.promise
  await second.dispose()
  // 迟到答复会再次释放旧租约，但不再向已退出的观察者提交结果或状态。
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(visible, ['新形象'])
  assert.equal(released.filter((lease) => lease === requests[0]!.lease).length, 2)
  assert.equal(released.filter((lease) => lease === requests[1]!.lease).length, 1)
})

test('自动预览下载失败会释放租约并结束加载，不提交形象', async () => {
  const failure = new Error('上游素材不可用')
  const settled = deferred<void>(); const errors: unknown[] = []; const released: string[] = []
  let loaded = false
  const preview = startAssistantAvatarTemporaryPreview({
    previewCatalog: async () => { throw failure }, keepPreview: async () => {},
    releasePreview: async (lease: string) => { released.push(lease) },
  }, { id: 'test', revision }, {
    onLoaded: () => { loaded = true }, onError: (error) => errors.push(error), onSettled: () => settled.resolve(),
  })
  await settled.promise
  assert.equal(loaded, false); assert.deepEqual(errors, [failure]); assert.equal(released.length, 1)
  await preview.dispose(); assert.equal(released.length, 1)
})

function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}
test('形象管理页把右侧目标及活动状态传给共享编辑器，切换页面能结束临时预览', () => {
  const target = { nodeType: 1 } as unknown as Element
  const onPreviewChange = () => {}
  const value = DEFAULT_CODINGNS_SETTINGS.assistant
  const page = AssistantConfigurationPage({ tab: 'appearance', active: false, services: {} as CodingNsClientServices, value,
    draft: readAssistantDraft(value), catalog: undefined, appearance: normalizeAssistantAppearance(value.appearance), tts: undefined,
    workspaces: [], t: resolveCodingNsTranslator(), disabled: false, onChange: () => {}, onModels: () => {}, onDebug: () => {}, onError: () => {},
    previewTarget: target, onPreviewChange,
  })
  const editor = elements(page).find((node) => node.type === AssistantAppearanceEditor)!
  assert.equal(editor.props.previewTarget, target)
  assert.equal(editor.props.onPreviewChange, onPreviewChange)
  assert.equal(editor.props.active, false)
  const child = createElement('div', { 'data-preview': true })
  const portal = AssistantAvatarCatalogPreviewRegion({ target, children: child }) as any
  assert.equal(portal.containerInfo, target, '预览节点挂载到右侧，不能仍留在列表下方')
  const standalone = renderToStaticMarkup(AssistantAvatarCatalogPreviewRegion({ target: undefined, children: child }))
  assert.ok(standalone.startsWith('<aside'))
})

test('临时插槽不提交持久预览，失败时不显示错误的内置形象', () => {
  const tr = resolveCodingNsTranslator()
  const services = { locale: { bind: () => tr, subscribe: () => () => {}, getSnapshot: () => 'zh' } } as unknown as CodingNsClientServices
  let captures = false
  const dispose = registerAssistantAvatarRenderer(services, { id: 'test-renderer', previewVersion: '1', component: (props) => {
    captures = props.onPreview !== undefined
    return createElement('span', null, props.model.name)
  } })
  try {
    const props = { services, model: { id: 'preview-test', name: '测试角色', renderer: 'test-renderer', source: '/temporary', spriteVersion: 2 as const }, state: 'idle' as const, surface: 'dialog' as const, size: 168 }
    renderToStaticMarkup(createElement(AssistantAvatarSlot, props)); assert.equal(captures, true)
    renderToStaticMarkup(createElement(AssistantAvatarSlot, { ...props, transient: true })); assert.equal(captures, false)
    const failed = renderToStaticMarkup(createElement(AssistantAvatarSlot, { ...props, transient: true, model: { ...props.model, renderer: 'missing-renderer' } }))
    assert.ok(failed.includes('data-codingns-avatar-preview-failed'))
    assert.ok(!failed.includes('Live2D'), '图片或图集预览失败不能归因于 Live2D 引擎')
    assert.ok(!failed.includes('female-v1.png')); assert.ok(!failed.includes('data-codingns-builtin-avatar'))
  } finally { dispose() }
})
