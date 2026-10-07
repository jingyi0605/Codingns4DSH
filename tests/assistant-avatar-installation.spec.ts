import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AssistantAvatarPackages } from '../data/build/dist/host/avatar/packages.js'
import { AssistantAvatarRemote } from '../data/build/dist/host/avatar/remote.js'
import { discoverAssistantAvatarSource } from '../data/build/dist/host/avatar/sources.js'
import { AssistantAvatarManager } from '../data/build/dist/client/avatar/manager.js'
import { readAssistantAvatarCacheStatus } from '../data/build/dist/client/avatar/cache-status.js'
import { ASSISTANT_AVATAR_ASSET_PATH, ASSISTANT_AVATAR_STATUS_PATH } from '../data/build/dist/shared/assistant-avatar-installation.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { DEFAULT_ASSISTANT_APPEARANCE } from '../data/build/dist/shared/assistant-avatar.js'
import { CODINGNS_RPC_CHANNEL } from '../data/build/dist/shared/contracts/transport.js'
import { registerAssistantAvatarRoutes, createAssistantAvatarRuntimeFeature } from '../data/build/dist/host/features/assistant-avatar-runtime.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import type { CodingNsSettings } from '../src/shared/contracts/config.js'
import type { CodingNsSettingsOperation, CodingNsSettingsStore } from '../src/dsh-capabilities/settings-store.js'
import type { CodingNsRpcClient } from '../src/client/features/types.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'

const root = 'https://assets.example.test/pet/'
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
const publicDns = async () => [{ address: '93.184.216.34' }]
const native = { avatarManifestVersion: 1, id: 'my-pet', name: '我的形象', author: '素材作者', license: '仅测试',
  asset: { renderer: 'image', source: 'idle.png', spriteVersion: 2, stateSources: { speaking: 'talk.png' } },
  surfaces: { floating: { renderer: 'spritesheet', source: 'idle.png', spriteVersion: 2 } } }
const model3 = { Version: 3, Groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['EyeOpen'] }], Layout: { CenterX: 0 },
  FileReferences: { Moc: 'model.moc3', Textures: ['idle.png'], Physics: 'physics.json', Pose: 'pose.json', UserData: 'user.json', DisplayInfo: 'display.json',
    Expressions: [{ Name: 'happy', File: 'happy.exp3.json' }], Motions: { Idle: [{ File: 'idle.motion3.json', FadeInTime: 0.5, Sound: 'idle.wav' }], Error: [{ File: 'error.motion3.json' }] } } }
function downloader(values: Record<string, unknown>, calls: string[] = []): AssistantAvatarRemote {
  return new AssistantAvatarRemote(async (input) => {
    const url = String(input); calls.push(url)
    const value = values[url]
    if (value === undefined) return new Response('missing', { status: 404 })
    return value instanceof Uint8Array ? new Response(value) : typeof value === 'string' ? new Response(value) : Response.json(value)
  }, publicDns)
}
async function temporary(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'codingns-avatar-install-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return join(path, 'packages')
}
const request = (source: string, init?: RequestInit) => new Request(new URL(source, 'https://codingns.test').href, init)

test('GitHub 仓库与子目录发现固定到提交，宠物清单优先且不执行插件入口', async () => {
  const api = 'https://api.github.com/repos/example/pets'
  const sha = 'a'.repeat(40)
  const calls: string[] = []
  const remote = downloader({ [api]: { default_branch: 'main' }, [`${api}/commits/main`]: { sha },
    [`${api}/git/trees/${sha}?recursive=1`]: { tree: [
      { type: 'blob', path: 'pets/one/pet.json' }, { type: 'blob', path: 'pets/one/one.model3.json' },
      { type: 'blob', path: 'pets/two/two.model3.json' }, { type: 'blob', path: 'src/index.ts' }, { type: 'blob', path: 'package.json' },
    ] } }, calls)
  const all = await discoverAssistantAvatarSource('https://github.com/example/pets.git', remote)
  assert.equal(all.length, 2)
  assert.ok(all.every((candidate) => candidate.url.includes(`/pets/${sha}/`)))
  const sub = await discoverAssistantAvatarSource('https://github.com/example/pets/tree/main/pets/one', remote)
  assert.deepEqual(sub.map((candidate) => candidate.name), ['pets/one/pet.json'])
  assert.ok(!calls.some((url) => /index\.ts|package\.json/u.test(url)))
  const file = await discoverAssistantAvatarSource('https://github.com/example/pets/blob/main/pets/one/pet.json', remote)
  assert.equal(file[0]?.url, `https://raw.githubusercontent.com/example/pets/${sha}/pets/one/pet.json`)
})

test('仓库分支包含斜杠可解析，超大或没有候选的仓库提供明确错误', async () => {
  const api = 'https://api.github.com/repos/example/pets'
  const sha = 'b'.repeat(40)
  const remote = downloader({ [api]: { default_branch: 'main' }, [`${api}/commits/feature%2Fpet`]: { sha },
    [`${api}/git/trees/${sha}?recursive=1`]: { tree: [{ type: 'blob', path: 'one/avatar.json' }] } })
  assert.equal((await discoverAssistantAvatarSource('https://github.com/example/pets/tree/feature/pet/one', remote))[0]?.name, 'one/avatar.json')
  const truncated = downloader({ [api]: { default_branch: 'main' }, [`${api}/commits/main`]: { sha }, [`${api}/git/trees/${sha}?recursive=1`]: { truncated: true, tree: [] } })
  await assert.rejects(discoverAssistantAvatarSource('https://github.com/example/pets', truncated), /仓库过大/u)
})

test('来源、格式和素材适配器运行期注册可注销，注销不会影响已安装形象', async (t) => {
  const source = `${root}custom.json`
  const packages = new AssistantAvatarPackages(await temporary(t), downloader({ [source]: { customAvatar: true }, [`${root}idle.png`]: png }))
  const releaseSource = packages.sources.register({ id: 'example-repository', matches: (url) => url.hostname === 'example.org',
    async discover() { return [{ url: source, name: '扩展来源' }] } })
  assert.equal((await packages.discover('https://example.org/my-repo'))[0]?.url, source)
  const releaseFormat = packages.formats.register({ id: 'custom-format', matches: (value: any) => value.customAvatar === true,
    parse: () => ({ id: 'custom-pet', name: '扩展素材', renderer: 'custom-renderer', source: `${root}idle.png`, spriteVersion: 2 }) })
  const releaseMaterial = packages.materials.register({ id: 'custom-material', supports: (renderer) => renderer === 'custom-renderer',
    async install(asset, context) { return { ...asset, source: await context.file(asset.source, 'image') } } })
  const installed = await packages.install(source)
  assert.equal(installed.model.renderer, 'custom-renderer')
  releaseSource(); releaseSource(); releaseFormat(); releaseMaterial()
  assert.equal((await packages.list()).length, 1)
  assert.equal((await packages.handle(request(installed.model.source))).status, 200)
  await assert.rejects(packages.install(source), /识别/u)
})

test('Fake-IP 代理保留域名请求，直接 IP 和重定向到真实私网仍拒绝', async () => {
  let calls = 0
  const fake = new AssistantAvatarRemote(async () => { calls++; return Response.json({ ok: true }) }, async () => [{ address: '198.18.0.18' }])
  assert.deepEqual((await fake.json(`${root}avatar.json`)).value, { ok: true })
  await assert.rejects(fake.json('http://198.18.0.18/avatar.json'), /公开/u)
  assert.equal(calls, 1)
  const redirect = new AssistantAvatarRemote(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.json' } }), publicDns)
  await assert.rejects(redirect.json(`${root}avatar.json`), /公开/u)
})

test('双展示与图片差分完整下载、重复来源去重，Host 重建后离线读取且不请求外网', async (t) => {
  const directory = await temporary(t)
  const calls: string[] = []
  const packages = new AssistantAvatarPackages(directory, downloader({ [`${root}avatar.json`]: native, [`${root}idle.png`]: png, [`${root}talk.png`]: png }, calls))
  const installed = await packages.install(`${root}avatar.json`)
  assert.equal(installed.created, true); assert.equal(installed.files, 2)
  assert.equal(calls.filter((url) => url.endsWith('idle.png')).length, 1)
  assert.equal(installed.model.package?.installationId, installed.id)
  assert.ok(installed.model.source.startsWith(ASSISTANT_AVATAR_ASSET_PATH))
  assert.ok(installed.model.surfaces?.floating.source.startsWith(ASSISTANT_AVATAR_ASSET_PATH))
  assert.ok(installed.model.stateSources?.speaking?.includes(installed.id))
  const offline = new AssistantAvatarPackages(directory, new AssistantAvatarRemote(async () => { throw new Error('禁止外网') }, publicDns))
  assert.equal((await offline.list())[0]?.id, installed.id)
  const response = await offline.handle(request(installed.model.source))
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-codingns-avatar-cache'), 'disk')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png)
  const status = await offline.handle(request(`${ASSISTANT_AVATAR_STATUS_PATH}?pack=${installed.id}`))
  assert.equal((await status.json()).cached, 2)
  assert.equal((await packages.install(`${root}avatar.json`)).created, false)
  await offline.remove(installed.id)
  assert.equal((await offline.handle(request(installed.model.source))).status, 404)
  assert.equal((await offline.list()).length, 0)
})

test('Cubism 3 全部核心、表情、动作和音频引用本地化，布局与参数保留', async (t) => {
  const values: Record<string, unknown> = { [`${root}pet.json`]: { petManifestVersion: 2, id: 'live-pet', displayName: '动态形象', renderer: 'live2d',
    live2d: { model: 'pet.model3.json', motions: { idle: 'Idle', failed: 'Error' } } }, [`${root}pet.model3.json`]: model3,
    [`${root}model.moc3`]: 'model-data', [`${root}idle.png`]: png, [`${root}idle.wav`]: 'audio-data' }
  for (const file of ['physics.json', 'pose.json', 'user.json', 'display.json', 'happy.exp3.json', 'idle.motion3.json', 'error.motion3.json']) values[root + file] = { Version: 3 }
  const packages = new AssistantAvatarPackages(await temporary(t), downloader(values))
  const installed = await packages.install(`${root}pet.json`)
  assert.equal(installed.files, 11)
  assert.deepEqual(installed.model.motionGroups, { idle: 'Idle', error: 'Error' })
  const response = await packages.handle(request(installed.model.source))
  const local = await response.json()
  assert.deepEqual(local.Groups, model3.Groups); assert.deepEqual(local.Layout, model3.Layout)
  assert.equal(local.FileReferences.Expressions[0].Name, 'happy')
  assert.deepEqual(Object.keys(local.FileReferences.Motions), ['Idle', 'Error'])
  assert.equal(local.FileReferences.Motions.Idle[0].FadeInTime, 0.5)
  const refs = [local.FileReferences.Moc, ...local.FileReferences.Textures, local.FileReferences.Physics,
    local.FileReferences.Pose, local.FileReferences.UserData, local.FileReferences.DisplayInfo,
    local.FileReferences.Expressions[0].File, ...Object.values(local.FileReferences.Motions).flatMap((entries: any) => entries.map((entry: any) => entry.File)), local.FileReferences.Motions.Idle[0].Sound]
  for (const ref of refs) {
    assert.ok(ref.startsWith('assistant-avatar-assets?pack='))
    const resolved = new URL(ref, new URL(installed.model.source, 'https://codingns.test'))
    assert.equal((await packages.handle(new Request(resolved))).status, 200)
  }
})

test('Cubism 2 的 mtn 动作与 Codex v1/v2 图集通过同一安装仓库管理', async (t) => {
  const values = { [`${root}pet.model.json`]: { model: 'pet.moc', textures: ['idle.png'], expressions: [{ name: 'happy', file: 'happy.json' }], motions: { idle: [{ file: 'idle.mtn' }] } },
    [`${root}pet.moc`]: 'model-data', [`${root}idle.png`]: png, [`${root}happy.json`]: {}, [`${root}idle.mtn`]: '#Live2D motion',
    [`${root}codex.json`]: { id: 'sprite-pet', name: '图集', spritesheetPath: 'idle.png', spriteVersionNumber: 1 } }
  const packages = new AssistantAvatarPackages(await temporary(t), downloader(values))
  const model = await packages.install(`${root}pet.model.json`)
  assert.equal(model.files, 5)
  const sprite = await packages.install(`${root}codex.json`)
  assert.equal(sprite.model.spriteVersion, 1); assert.equal(sprite.model.renderer, 'spritesheet')
})

test('非法资源、私有网络、超大响应和取消不会登记半包或保留临时目录', async (t) => {
  const directory = await temporary(t)
  for (const source of ['https://localhost/avatar.json', 'http://127.0.0.1/a.json', 'http://[::1]/a.json', 'file:///a.json', 'https://user:pass@a.test/a.json']) {
    const remote = new AssistantAvatarRemote(async () => { throw new Error('不得发起请求') }, publicDns)
    await assert.rejects(remote.json(source), /公开|无效/u)
  }
  const privateDns = new AssistantAvatarRemote(async () => { throw new Error('不得发起请求') }, async () => [{ address: '10.0.0.1' }])
  await assert.rejects(privateDns.json(`${root}avatar.json`), /公开/u)
  const bad = new AssistantAvatarPackages(directory, downloader({ [`${root}avatar.json`]: { ...native, asset: { renderer: 'image', source: 'code.js', spriteVersion: 2 } } }))
  await assert.rejects(bad.install(`${root}avatar.json`), /类型/u)
  assert.equal((await bad.list()).length, 0)
  const huge = new AssistantAvatarRemote(async () => new Response('oversized', { headers: { 'Content-Length': '9999999' } }), publicDns)
  await assert.rejects(huge.json(`${root}avatar.json`), /大小/u)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(bad.install(`${root}avatar.json`, 'auto', controller.signal))
  await assert.rejects(readdir(directory), { code: 'ENOENT' })
})

test('实际流式体积有界，下载途中取消终止在途请求且不写磁盘', async (t) => {
  let cancelled = false
  const streamed = new AssistantAvatarRemote(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)) }, cancel() { cancelled = true },
  })), publicDns)
  await assert.rejects(streamed.read(`${root}idle.png`, 4), /大小/u)
  assert.equal(cancelled, true)
  let started!: () => void
  const downloading = new Promise<void>((resolve) => { started = resolve })
  let aborted = false
  const remote = new AssistantAvatarRemote(async (input, init) => {
    if (String(input).endsWith('avatar.json')) return Response.json(native)
    started()
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason) }, { once: true })
    })
  }, publicDns)
  const directory = await temporary(t)
  const packages = new AssistantAvatarPackages(directory, remote)
  const controller = new AbortController()
  const operation = packages.install(`${root}avatar.json`, 'auto', controller.signal)
  await downloading
  controller.abort()
  await assert.rejects(operation)
  assert.equal(aborted, true)
  assert.equal((await packages.list()).length, 0)
  await assert.rejects(readdir(directory), { code: 'ENOENT' })
})

test('固定素材入口只读已完成记录的文件键，拒绝任意路径、远程代理和未知版本', async (t) => {
  const packages = new AssistantAvatarPackages(await temporary(t), downloader({ [`${root}idle.png`]: png }))
  const installed = await packages.install(`${root}idle.png`)
  assert.equal((await packages.handle(request(installed.model.source, { method: 'POST' }))).status, 405)
  for (const url of [`${ASSISTANT_AVATAR_ASSET_PATH}?pack=../../etc&file=passwd`, `${ASSISTANT_AVATAR_ASSET_PATH}?pack=${installed.id}&file=../record.json`,
    `${ASSISTANT_AVATAR_ASSET_PATH}?url=https://assets.test/a.png`, '/api/codingns/assistant-avatar-assets/unregistered.png']) assert.equal((await packages.handle(request(url))).status, 404)
})

test('本地版本诊断仅读取实时状态，普通外链不触发素材或缓存请求', async () => {
  const id = 'f'.repeat(64)
  let calls = 0
  const snapshot = { version: 1, generation: 'test-host', pack: id, cached: 11, pending: 0, total: 11, downloads: 0 }
  const fetchStatus: typeof fetch = async (source) => { calls++; assert.equal(String(source), `https://codingns.test${ASSISTANT_AVATAR_STATUS_PATH}?pack=${id}`); return Response.json(snapshot) }
  assert.deepEqual(await readAssistantAvatarCacheStatus(`${ASSISTANT_AVATAR_ASSET_PATH}?pack=${id}&file=model.json`, 'https://codingns.test', fetchStatus), snapshot)
  assert.equal(await readAssistantAvatarCacheStatus('https://assets.test/model.json', 'https://codingns.test', fetchStatus), undefined)
  assert.equal(calls, 1)
})

function settingsFixture() {
  let appearance = DEFAULT_ASSISTANT_APPEARANCE
  let rejected = false
  let writable = true
  const settings = { getSnapshot: () => ({ status: 'ready' as const, writable, revision: 1,
    value: { ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, appearance } } }),
    subscribe: () => () => {}, mutate: async (operations: readonly CodingNsSettingsOperation[]) => {
      if (rejected) return false
      appearance = operations[0]!.value as typeof appearance; return true
    }, set: async () => false, unset: async () => false } satisfies CodingNsSettingsStore<CodingNsSettings>
  return { settings, reject: () => { rejected = true }, readonly: () => { writable = false } }
}

test('安装完成后登记并选择，重复安装不增加角色，设置拒绝回滚新建素材', async (t) => {
  const packages = new AssistantAvatarPackages(await temporary(t), downloader({ [`${root}avatar.json`]: native, [`${root}idle.png`]: png, [`${root}talk.png`]: png }))
  const rpc: CodingNsRpcClient = { call: async (channel, endpoint, payload, signal) => {
    assert.equal(channel, CODINGNS_RPC_CHANNEL)
    const input = payload as { source: string; id: string; adapterId: string }
    if (endpoint === 'avatar/install') return { ok: true, value: await packages.install(input.source, input.adapterId, signal) }
    if (endpoint === 'avatar/discover') return { ok: true, value: await packages.discover(input.source, signal) }
    if (endpoint === 'avatar/remove') return { ok: true, value: await packages.remove(input.id) }
    throw new Error(endpoint)
  } }
  const fixture = settingsFixture()
  const manager = new AssistantAvatarManager(fixture.settings, undefined, undefined, undefined, rpc)
  assert.equal((await manager.discover(`${root}avatar.json`)).length, 1)
  await manager.installPackage(`${root}avatar.json`)
  assert.equal(manager.getSelected().id, 'my-pet'); assert.equal(manager.list().length, 3)
  await manager.installPackage(`${root}avatar.json`)
  assert.equal(manager.list().length, 3)
  await manager.remove('my-pet')
  assert.equal((await packages.list()).length, 0)
  // 已有外链清单可以原地升级为本地素材，不要求先删除角色。
  await manager.add({ id: 'my-pet', name: '原外链', renderer: 'image', source: `${root}idle.png`, spriteVersion: 2,
    package: { adapterId: 'codingns-pack', manifestUrl: `${root}avatar.json` } })
  await manager.installPackage(`${root}avatar.json`)
  assert.ok(manager.getSelected().package?.installationId)
  assert.equal(manager.list().length, 3)
  await manager.remove('my-pet')
  fixture.reject()
  await assert.rejects(manager.installPackage(`${root}avatar.json`), /拒绝/u)
  assert.equal(manager.list().length, 2); assert.equal((await packages.list()).length, 0)
  fixture.readonly()
  await assert.rejects(manager.installPackage(`${root}avatar.json`), /只读/u)
})

test('新配置登记通用路由和两张基础图片，模块停用释放 RPC，Host 只读拒绝磁盘安装', async (t) => {
  const active = new Set<string>()
  const routes = { register: (route: { path: string }) => { active.add(route.path); return async () => { active.delete(route.path) } } } as unknown as HostConnectionFetch
  const release = registerAssistantAvatarRoutes(routes, async () => new Response('test'))
  assert.equal(active.size, 7); assert.ok(active.has(ASSISTANT_AVATAR_ASSET_PATH)); await release(); assert.equal(active.size, 0)
  const rpc = new CodingNsRpcTable()
  const registry = new FeatureRegistry({ rpc, settingsProvider: { writable: false } } as unknown as CodingNsHostServices)
  const packages = new AssistantAvatarPackages(await temporary(t), downloader({}))
  registry.register(createAssistantAvatarRuntimeFeature({ packages }))
  await registry.reconcile(['assistantAvatarRuntime'])
  const target = rpc.resolve('avatar/install')!
  await assert.rejects(Promise.resolve(target.handler('install', { source: `${root}avatar.json` })), /只读/u)
  await registry.reconcile([])
  assert.equal(rpc.resolve('avatar/install'), null)
})
