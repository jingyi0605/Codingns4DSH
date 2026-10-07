import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantAvatarAdapterRegistry, AssistantAvatarManager, getAssistantAvatarManager, registerAssistantAvatarAdapter } from '../data/build/dist/client/avatar/manager.js'
import { getAssistantAvatarRegistry } from '../data/build/dist/client/avatar/registry.js'
import { AssistantAppearancePanel } from '../data/build/dist/client/avatar/settings-panel.js'
import { assistantAvatarChoices } from '../src/client/avatar/catalog-picker.js'
import { AssistantAvatarSlot } from '../data/build/dist/client/avatar/slot.js'
import { AssistantLive2dController } from '../data/build/dist/client/avatar/live2d.js'
import { assistantAvatarManifest } from '../data/build/dist/shared/assistant-avatar-adapters.js'
import { BUILTIN_ASSISTANT_AVATAR, BUILTIN_ASSISTANT_AVATARS, DEFAULT_ASSISTANT_APPEARANCE, normalizeAssistantAppearance, resolveAssistantAvatarAsset, selectedAssistantAvatar, validateAssistantAppearance, validateAssistantAvatarModel } from '../data/build/dist/shared/assistant-avatar.js'
import { ASSISTANT_AVATAR_PRESETS, LEGACY_ASSISTANT_AVATAR_PRESETS } from '../data/build/dist/shared/assistant-avatar-legacy.js'
import { WHALE_LIVE2D_RESOURCE_PACK } from '../data/build/dist/shared/assistant-avatar-legacy-resources.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'
import { createCodingNsSettingsRpcHandler } from '../data/build/dist/host/rpc.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import type { AssistantAvatarModel } from '../src/shared/assistant-avatar.js'
import type { CodingNsSettings } from '../src/shared/contracts/config.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import type { CodingNsSettingsOperation, CodingNsSettingsStore } from '../src/dsh-capabilities/settings-store.js'

const locale = { bind: () => resolveCodingNsTranslator(), subscribe: () => () => {}, getSnapshot: () => 'zh' }
const image = (id: string): AssistantAvatarModel => ({ id, name: id, renderer: 'image', source: `https://cdn.test/${id}.png`, spriteVersion: 2 })
const manifest = {
  avatarManifestVersion: 1, id: 'whale', name: '大肥鱼', author: '素材作者', license: '仅测试用途',
  asset: { renderer: 'spritesheet', source: './spritesheet.webp', spriteVersion: 2 },
  surfaces: { dialog: { renderer: 'image', source: './full.png', stateSources: { speaking: './talk.png' } } },
}
function store() {
  let value: CodingNsSettings = { ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant,
    managedWorkspaceIds: ['keep-workspace'], appearance: DEFAULT_ASSISTANT_APPEARANCE } }
  let revision = 10
  let writable = true
  let reject = false
  let status: 'ready' | 'loading' = 'ready'
  const listeners = new Set<() => void>()
  const writes: { operations: readonly CodingNsSettingsOperation[]; revision: number | undefined }[] = []
  const settings = {
    getSnapshot: () => ({ value, revision, status, writable }), subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (operations: readonly CodingNsSettingsOperation[], expectedRevision?: number) => {
      assert.equal(expectedRevision, revision)
      if (reject) return false
      writes.push({ operations, revision: expectedRevision })
      assert.deepEqual(operations.map((operation) => operation.path), [['assistant', 'appearance']])
      value = { ...value, assistant: { ...value.assistant, appearance: operations[0]!.value as typeof DEFAULT_ASSISTANT_APPEARANCE } }
      revision++
      for (const listener of listeners) listener()
      return true
    }, set: async () => false, unset: async () => false,
  } satisfies CodingNsSettingsStore<CodingNsSettings>
  return { settings, writes, readonly: () => { writable = false }, loading: () => { status = 'loading' }, reject: (next: boolean) => { reject = next },
    touchVoice: () => { value = { ...value, assistant: { ...value.assistant, voice: { ...value.assistant.voice, modelId: 'changed-voice' } } }; for (const listener of listeners) listener() } }
}

test('原生包的双展示、状态差分、来源和许可经归一化与 Host schema 回读后保留', () => {
  const adapters = new AssistantAvatarAdapterRegistry()
  const model = adapters.parse(manifest, 'https://cdn.test/packs/whale/avatar.json')
  assert.equal(model.source, 'https://cdn.test/packs/whale/spritesheet.webp')
  assert.equal(model.surfaces?.dialog?.stateSources?.speaking, 'https://cdn.test/packs/whale/talk.png')
  assert.equal(model.surfaces?.dialog?.spriteVersion, 2)
  assert.equal(model.package?.license, '仅测试用途')
  const appearance = { ...DEFAULT_ASSISTANT_APPEARANCE, selectedId: model.id, models: [...BUILTIN_ASSISTANT_AVATARS, model] }
  const normalized = normalizeAssistantAppearance(appearance)
  assert.deepEqual(normalized, appearance)
  const settings = CodingNsSettingsSchema({ ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, appearance } })
  assert.deepEqual(normalizeAssistantAppearance(settings.assistant.appearance), appearance)
  validateAssistantAppearance(settings.assistant.appearance)
  const exported = assistantAvatarManifest(model)
  const restored = adapters.parse(exported, 'https://cdn.test/export/avatar.json')
  assert.deepEqual(restored.surfaces, model.surfaces)
  assert.equal(restored.source, model.source)
  assert.equal(restored.package?.author, '素材作者')
})

test('Codex v1/v2 pet.json 自动识别，非法图集版本明确拒绝', () => {
  const registry = new AssistantAvatarAdapterRegistry()
  for (const spriteVersionNumber of [1, 2]) {
    const model = registry.parse({ id: 'whale', displayName: '大肥鱼', spriteVersionNumber, spritesheetPath: 'spritesheet.webp' }, 'https://cdn.test/pet/pet.json')
    assert.equal(model.renderer, 'spritesheet')
    assert.equal(model.spriteVersion, spriteVersionNumber)
    assert.equal(model.source, 'https://cdn.test/pet/spritesheet.webp')
    assert.equal(model.package?.adapterId, 'codex-pet')
  }
  assert.throws(() => registry.parse({ id: 'bad', displayName: '坏模型', spriteVersionNumber: 3, spritesheetPath: 'a.webp' }, 'https://cdn.test/pet.json'), /无效/u)
})

test('DSH Live2D 与 Cubism 2/3 清单复用相同模型契约，模型 ID 稳定', () => {
  const registry = new AssistantAvatarAdapterRegistry()
  const dsh = registry.parse({ petManifestVersion: 2, id: 'ds-whale', displayName: '鲸鱼娘', renderer: 'live2d', license: 'CC BY-NC-SA 4.0', live2d: { model: 'c_0120.model3.json', scale: 0.8, translate: { x: 0.2, y: 0 }, motions: { idle: 'Idle', thinking: 'Idle', failed: 'SprayWater', asking: 'Listen' } } }, 'https://cdn.test/pet/pet.json')
  assert.equal(dsh.source, 'https://cdn.test/pet/c_0120.model3.json')
  assert.equal(dsh.package?.license, 'CC BY-NC-SA 4.0')
  assert.equal(dsh.motionGroups?.error, 'SprayWater')
  assert.equal(dsh.motionGroups?.waiting, 'Listen')
  assert.deepEqual(dsh.live2d, { scale: 0.8, position: [0.2, 0] })
  const cubism = { Version: 3, FileReferences: { Moc: 'model/c.moc3', Textures: ['textures/a.png'] } }
  const first = registry.parse(cubism, 'https://cdn.test/model/c.model3.json')
  assert.equal(first.renderer, 'live2d')
  assert.equal(registry.parse(cubism, 'https://cdn.test/model/c.model3.json').id, first.id)
  assert.equal(registry.parse({ model: 'a.moc', textures: ['a.png'] }, 'https://cdn.test/a.model.json').renderer, 'live2d')
  assert.throws(() => registry.parse({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: [] } }, 'https://cdn.test/a.model3.json'), /不完整/u)
})

test('适配器统一拒绝未知版本、脚本地址、非法状态映射和覆盖内置角色', () => {
  const registry = new AssistantAvatarAdapterRegistry()
  for (const patch of [
    { avatarManifestVersion: 2 }, { id: BUILTIN_ASSISTANT_AVATAR.id },
    { asset: { renderer: 'image', source: 'javascript:alert(1)' } },
    { asset: { renderer: 'image', source: '//evil.test/a.png' } },
    { asset: { renderer: 'image', source: '  //evil.test/a.png' } },
    { asset: { renderer: 'image', source: ' ' } },
    { surfaces: { dialog: { renderer: 'image', source: './a.png', stateSources: { thinking: 'file:///tmp/a.png' } } } },
    { surfaces: { unknown: { renderer: 'image', source: './a.png' } } },
    { asset: { renderer: 'image', source: './a.png', stateSources: { unknown: './b.png' } } },
    { asset: { renderer: 'live2d', source: './a.model3.json', live2d: { scale: 0 } } },
    { asset: { renderer: 'live2d', source: './a.model3.json', live2d: { position: [0, 3] } } },
  ]) assert.throws(() => registry.parse({ ...manifest, ...patch }, 'https://cdn.test/pet.json'))
  assert.throws(() => registry.parse({}, 'https://cdn.test/pet.json'), /识别/u)
  assert.throws(() => registry.parse(manifest, 'https://cdn.test/pet.json', 'missing'), /识别/u)
})

test('Host RPC 拒绝包内非法双展示素材或状态映射，不触发任何持久写入', async () => {
  let writes = 0
  const fixture = store()
  const handler = createCodingNsSettingsRpcHandler({ writable: true,
    describe: () => [{ ns: 'codingns', revision: 10, value: fixture.settings.getSnapshot().value }],
    get: () => fixture.settings.getSnapshot().value,
    mutate: async () => { writes++ },
  })
  for (const patch of [
    { surfaces: { dialog: { renderer: 'image', source: 'file:///tmp/a.png', spriteVersion: 2 } } },
    { renderer: 'live2d', motionGroups: { unknown: 'Idle' } },
    { renderer: 'live2d', live2d: { scale: -1 } },
  ]) {
    const model = { ...image('bad'), ...patch }
    const value = { ...DEFAULT_ASSISTANT_APPEARANCE, selectedId: 'bad', models: [BUILTIN_ASSISTANT_AVATAR, model] }
    await assert.rejects(handler('set', { expectedRevision: 10, ops: [{ op: 'set', path: ['assistant', 'appearance'], value }] }), /无效/u)
  }
  assert.equal(writes, 0)
})

test('注册快照稳定，扩展按 Client 隔离，内置渲染器与扩展共用一个注册表', () => {
  const a = store(); const b = store()
  const servicesA = { settings: a.settings } as unknown as CodingNsClientServices
  const servicesB = { settings: b.settings } as unknown as CodingNsClientServices
  const manager = getAssistantAvatarManager(servicesA)
  const snapshot = manager.adapters.getSnapshot()
  assert.equal(manager.adapters.getSnapshot(), snapshot)
  const adapter = { id: 'my-package', name: '扩展形象包', matches: () => true, parse: () => image('custom') }
  const unregister = registerAssistantAvatarAdapter(servicesA, adapter)
  assert.equal(getAssistantAvatarManager(servicesA), manager)
  assert.equal(manager.adapters.get('my-package'), adapter)
  assert.equal(getAssistantAvatarManager(servicesB).adapters.get('my-package'), undefined)
  assert.throws(() => manager.adapters.register(adapter), /已注册/u)
  assert.throws(() => manager.adapters.register({ ...adapter, id: 'codex-pet' }), /内置/u)
  unregister(); unregister()
  assert.equal(manager.adapters.get('my-package'), undefined)
  const registry = getAssistantAvatarRegistry(servicesA)
  for (const id of ['builtin', 'image', 'spritesheet', 'live2d']) assert.ok(registry.get(id)?.component)
})

test('新增、并发切换和展示设置串行使用最新 revision，不覆盖语音和工作区', async () => {
  const fixture = store()
  const manager = new AssistantAvatarManager(fixture.settings)
  const voice = fixture.settings.getSnapshot().value.assistant.voice
  await manager.add(image('first'))
  await manager.add(image('second'))
  await Promise.all([manager.select('first'), manager.configure({ floatingEnabled: true }), manager.select('second')])
  assert.equal(manager.getSelected().id, 'second')
  assert.equal(manager.getAppearance().floatingEnabled, true)
  assert.deepEqual(fixture.writes.map((write) => write.revision), [10, 11, 12, 13, 14])
  assert.equal(fixture.settings.getSnapshot().value.assistant.voice, voice)
  assert.deepEqual(fixture.settings.getSnapshot().value.assistant.managedWorkspaceIds, ['keep-workspace'])
  const before = fixture.writes.length
  await manager.select('second')
  assert.equal(fixture.writes.length, before)
})

test('管理器快照与列表引用稳定，只通知形象变化，多个订阅者均收到变更', async () => {
  const fixture = store()
  const manager = new AssistantAvatarManager(fixture.settings)
  const snapshot = manager.getSnapshot()
  const list = manager.list()
  assert.equal(manager.getSnapshot(), snapshot)
  assert.equal(manager.list(), list)
  assert.deepEqual(list.slice(0, snapshot.models.length), snapshot.models)
  let a = 0; let b = 0
  const offA = manager.subscribe(() => { a++ })
  const offB = manager.subscribe(() => { b++ })
  fixture.touchVoice()
  assert.equal(manager.getSnapshot(), snapshot)
  assert.equal(manager.list(), list)
  assert.equal(a, 0); assert.equal(b, 0)
  await manager.add(image('new'))
  assert.notEqual(manager.getSnapshot(), snapshot)
  assert.equal(a, 1); assert.equal(b, 1)
  offA(); offB()
  await manager.select(BUILTIN_ASSISTANT_AVATAR.id)
  assert.equal(a, 1); assert.equal(b, 1)
})

test('删除非当前形象不切换，更新保留选择，删除当前形象回落内置且队列可从失败恢复', async () => {
  const fixture = store()
  const manager = new AssistantAvatarManager(fixture.settings)
  await manager.add(image('first')); await manager.add(image('second'))
  await assert.rejects(manager.add(image('second')), /已存在/u)
  await assert.rejects(manager.select('missing'), /清单/u)
  await assert.rejects(manager.remove(BUILTIN_ASSISTANT_AVATAR.id), /内置/u)
  await manager.remove('first')
  assert.equal(manager.getSelected().id, 'second')
  await manager.update({ ...image('second'), name: '更新后的形象' })
  assert.equal(manager.getSelected().name, '更新后的形象')
  await manager.remove('second')
  assert.equal(manager.getSelected().id, BUILTIN_ASSISTANT_AVATAR.id)
  assert.equal(manager.getAppearance().models.length, 2)
})

test('导入根据最终响应目录解析，并加入形象列表；取消、网络或格式失败不写设置', async () => {
  const fixture = store()
  const fetcher = async () => {
    const response = new Response(JSON.stringify(manifest))
    Object.defineProperty(response, 'url', { value: 'https://redirect.test/final/avatar.json' })
    return response
  }
  const manager = new AssistantAvatarManager(fixture.settings, undefined, fetcher)
  const model = await manager.importPackage('https://origin.test/avatar.json')
  assert.equal(model.source, 'https://redirect.test/final/spritesheet.webp')
  assert.equal(manager.getSelected().id, model.id)
  const before = fixture.writes.length
  const bad = new AssistantAvatarManager(fixture.settings, undefined, async () => new Response('{}'))
  await assert.rejects(bad.importPackage('https://origin.test/bad.json'), /识别/u)
  const http = new AssistantAvatarManager(fixture.settings, undefined, async () => new Response('', { status: 404 }))
  await assert.rejects(http.importPackage('https://origin.test/bad.json'), /404/u)
  const controller = new AbortController()
  const cancelled = new AssistantAvatarManager(fixture.settings, undefined, async () => { controller.abort(); return new Response(JSON.stringify(manifest)) })
  await assert.rejects(cancelled.importPackage('https://origin.test/a.json', 'auto', controller.signal), { name: 'AbortError' })
  assert.equal(fixture.writes.length, before)
  assert.equal(manager.getSelected().id, model.id)
})

test('只读、未就绪或保存拒绝时不改变清单，也不提前发起包请求', async () => {
  for (const mode of ['readonly', 'loading'] as const) {
    const fixture = store(); fixture[mode]()
    let requests = 0
    const manager = new AssistantAvatarManager(fixture.settings, undefined, async () => { requests++; return new Response('{}') })
    await assert.rejects(manager.add(image('new')))
    await assert.rejects(manager.importPackage('https://cdn.test/pet.json'))
    assert.equal(requests, 0); assert.equal(fixture.writes.length, 0)
  }
  const fixture = store(); fixture.reject(true)
  const manager = new AssistantAvatarManager(fixture.settings)
  await assert.rejects(manager.add(image('new')), /拒绝/u)
  assert.equal(manager.getAppearance().models.length, 2)
  fixture.reject(false)
  await manager.add(image('new'))
  assert.equal(manager.getSelected().id, 'new')
})

test('同一选择在两个插槽使用包内对应素材和状态差分，切换后展示新形象', async () => {
  const fixture = store()
  const services = { settings: fixture.settings, locale } as unknown as CodingNsClientServices
  const manager = getAssistantAvatarManager(services)
  const model = new AssistantAvatarAdapterRegistry().parse(manifest, 'https://cdn.test/whale/pet.json')
  await manager.add(model)
  const floating = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, model: manager.getSelected(), state: 'speaking', surface: 'floating', size: 144 }))
  const dialog = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, model: manager.getSelected(), state: 'speaking', surface: 'dialog', size: 240 }))
  assert.ok(floating.includes('data-codingns-avatar-renderer="spritesheet"'))
  assert.ok(dialog.includes('src="https://cdn.test/whale/talk.png"'))
  assert.equal(resolveAssistantAvatarAsset(model, 'floating').renderer, 'spritesheet')
  await manager.add(image('next'))
  const next = renderToStaticMarkup(createElement(AssistantAvatarSlot, { services, model: manager.getSelected(), state: 'idle', surface: 'dialog', size: 240 }))
  assert.ok(next.includes('src="https://cdn.test/next.png"'))
})

test('形象管理表单展示包来源和动态适配器，注销导入适配器不删除已有包', async () => {
  const fixture = store()
  const services = { settings: fixture.settings, locale } as unknown as CodingNsClientServices
  const manager = getAssistantAvatarManager(services)
  const dispose = registerAssistantAvatarAdapter(services, { id: 'test-package', name: '测试适配器', matches: () => true, parse: () => image('test') })
  await manager.add(new AssistantAvatarAdapterRegistry().parse(manifest, 'https://cdn.test/avatar.json'))
  const render = () => renderToStaticMarkup(createElement(AssistantAppearancePanel, { services, enabled: true, snapshot: fixture.settings.getSnapshot(), notify: () => {} }))
  const html = render()
  for (const text of ['data-codingns-avatar-list', '安装形象包', 'Codex pet.json', '测试适配器', '素材作者', '仅测试用途', 'https://cdn.test/avatar.json']) assert.ok(html.includes(text), text)
  dispose()
  assert.ok(!render().includes('测试适配器'))
  assert.equal(manager.getSelected().id, 'whale')
})

test('Live2D 使用包内明确动作组，缺失配置组保留待机回落', async () => {
  const played: string[] = []
  let loaded: unknown
  const controller = new AssistantLive2dController({ load: async (options: unknown) => { loaded = options }, getMotions: () => ({ Idle: [], Selfie: [], Hammer: [] }),
    playMotion: (group: string) => played.push(group), resize: () => {}, destroy: () => {} }, { speaking: 'Selfie', error: 'Hammer', thinking: 'Missing' }, { scale: 0.8, position: [0.2, 0] })
  await controller.load('https://cdn.test/c.model3.json')
  controller.setState('speaking'); controller.setState('error'); controller.setState('thinking')
  assert.deepEqual(played, ['Idle', 'Selfie', 'Hammer', 'Idle'])
  assert.deepEqual(loaded, { path: 'https://cdn.test/c.model3.json', scale: 0.8, position: [0.2, 0], volume: 0, logLevel: 'warn' })
})

test('新配置提供男女基础形象，不显示或请求第三方预设', async () => {
  const fixture = store()
  const services = { settings: fixture.settings, locale } as unknown as CodingNsClientServices
  const html = renderToStaticMarkup(createElement(AssistantAppearancePanel, { services, enabled: true, snapshot: fixture.settings.getSnapshot(), notify: () => {} }))
  const choices = assistantAvatarChoices(normalizeAssistantAppearance(fixture.settings.getSnapshot().value.assistant.appearance), [], resolveCodingNsTranslator())
  assert.deepEqual(choices.map((choice) => choice.label), ['鱼妞', '鱼仔'])
  assert.ok(choices.every((choice) => !choice.thirdParty && !choice.catalog))
  assert.ok(html.includes('data-codingns-avatar-list="true"'))
  assert.ok(html.includes('data-codingns-avatar-selected="codingns-default"'))
  assert.ok(!html.includes('data-codingns-avatar-third-party-badge'))
  assert.equal(ASSISTANT_AVATAR_PRESETS.length, 0)
  const manager = new AssistantAvatarManager(fixture.settings)
  await assert.rejects(manager.select(LEGACY_ASSISTANT_AVATAR_PRESETS[0]!.model.id), /清单/u)
  assert.equal(fixture.writes.length, 0)
})

test('已有选中的旧预设保留双展示与元信息，不自动添加其他预设', () => {
  for (const { model } of LEGACY_ASSISTANT_AVATAR_PRESETS) {
    const appearance = normalizeAssistantAppearance({ ...DEFAULT_ASSISTANT_APPEARANCE, selectedId: model.id })
    validateAssistantAppearance(appearance)
    const settings = CodingNsSettingsSchema({ ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, appearance } })
    assert.equal(settings.assistant.appearance.selectedId, model.id)
    assert.equal(selectedAssistantAvatar(appearance), model)
    for (const surface of ['floating', 'dialog'] as const) assert.equal(resolveAssistantAvatarAsset(selectedAssistantAvatar(appearance), surface).source, model.source)
    const fixture = store()
    const services = { ...{ settings: fixture.settings, locale }, settings: { ...fixture.settings,
      getSnapshot: () => ({ ...fixture.settings.getSnapshot(), value: settings }) } } as unknown as CodingNsClientServices
    const manager = getAssistantAvatarManager(services)
    assert.equal(manager.list().length, 3)
    const html = renderToStaticMarkup(createElement(AssistantAppearancePanel, { services, enabled: true, snapshot: services.settings.getSnapshot(), notify: () => {} }))
    assert.ok(html.includes('将此形象安装到本地'))
    assert.ok(html.includes('形象包详情与许可'))
    assert.ok(html.includes('外部依赖'))
    if (model.renderer === 'live2d') assert.ok(html.includes('Live2D 引擎需在 Host 单独安装'))
  }
})

test('已登记的旧 ID 按普通形象管理，不再被源码目录覆盖', async () => {
  const fixture = store()
  const manager = new AssistantAvatarManager(fixture.settings)
  const id = LEGACY_ASSISTANT_AVATAR_PRESETS[0]!.model.id
  const model = { ...image(id), name: '已安装的角色' }
  await manager.add(model)
  assert.deepEqual(manager.getSelected(), model)
  await manager.update({ ...model, name: '新的名称' })
  assert.equal(manager.getSelected().name, '新的名称')
  await manager.remove(id)
  assert.equal(manager.getSelected().id, BUILTIN_ASSISTANT_AVATAR.id)
  assert.equal(manager.list().length, 2)
})

test('清单容量与现有外链角色保持兼容，不再叠加源码第三方目录', async () => {
  const fixture = store()
  const manager = new AssistantAvatarManager(fixture.settings)
  for (let index = 0; index < 19; index++) await manager.add(image('pet-' + index))
  assert.equal(manager.list().length, 21)
  await assert.rejects(manager.add(image('overflow')), /21/u)
  await manager.remove('pet-0')
  await manager.add(image('replacement'))
  assert.equal(manager.list().length, 21)
})

test('男女基础形象可选择并保存，两者都不可更新、伪造或删除', async () => {
  const fixture = store()
  const manager = new AssistantAvatarManager(fixture.settings)
  for (const model of BUILTIN_ASSISTANT_AVATARS) {
    await manager.select(model.id)
    assert.equal(manager.getSelected().id, model.id)
    await assert.rejects(manager.remove(model.id), /内置/u)
    await assert.rejects(manager.update({ ...model, name: '覆盖' }), /内置/u)
    assert.throws(() => validateAssistantAvatarModel({ ...model, renderer: 'image', source: '/arbitrary.png' }), /内置/u)
    const services = { settings: fixture.settings, locale } as unknown as CodingNsClientServices
    const html = renderToStaticMarkup(createElement(AssistantAppearancePanel, { services, enabled: true, snapshot: fixture.settings.getSnapshot(), notify: () => {} }))
    assert.ok(!html.includes('移除此自定义形象'))
  }
})

test('旧预设兼容描述仍可追溯来源，新的适配器与角色无关', () => {
  const adapters = new AssistantAvatarAdapterRegistry()
  const manifests = [
    { id: 'deepseek-whale-v2', displayName: '角色', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 2 },
    { petManifestVersion: 2, id: 'ds-whale-girl', displayName: '角色', renderer: 'live2d',
      live2d: { model: 'c_0120.model3.json', scale: 1, translate: { x: 0, y: 0 }, motions: { idle: 'Idle', waiting: 'Idle', thinking: 'Idle', tool: 'Idle', failed: 'SprayWater' } } },
  ]
  LEGACY_ASSISTANT_AVATAR_PRESETS.forEach(({ model }, index) => {
    const parsed = adapters.parse(manifests[index], model.package!.manifestUrl!)
    if (model.renderer === 'live2d') assert.equal(parsed.source, WHALE_LIVE2D_RESOURCE_PACK.upstreamRoot + WHALE_LIVE2D_RESOURCE_PACK.manifest)
    assert.ok(model.package!.author); assert.ok(model.package!.license)
  })
})
