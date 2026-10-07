import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement, Fragment, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantAvatarCatalog } from '../data/build/dist/host/avatar/catalog.js'
import { AssistantAvatarRemote } from '../data/build/dist/host/avatar/remote.js'
import { AssistantAvatarPackages } from '../data/build/dist/host/avatar/packages.js'
import { createAssistantAvatarRuntimeFeature } from '../data/build/dist/host/features/assistant-avatar-runtime.js'
import { AssistantAvatarManager } from '../data/build/dist/client/avatar/manager.js'
import { AssistantAvatarCatalogPanel, AssistantAvatarCatalogPreview } from '../data/build/dist/client/avatar/catalog-panel.js'
import { AssistantAvatarPicker, AssistantAvatarPickerView, assistantAvatarChoices } from '../data/build/dist/client/avatar/catalog-picker.js'
import { DshMenu } from '../src/dsh-capabilities/client/primitives-adapter.js'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { DEFAULT_ASSISTANT_APPEARANCE, normalizeAssistantAppearance, validateAssistantAppearance } from '../data/build/dist/shared/assistant-avatar.js'
import { ASSISTANT_AVATAR_CONSENT_VERSION, hasAssistantAvatarConsent, assistantAvatarCatalogPreviewUrl } from '../data/build/dist/shared/assistant-avatar-catalog.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import type { CodingNsTranslator } from '../src/client/locale.js'
import * as avatarDictionary from '../data/build/dist/client/locales/assistantAvatar.js'
import type { AssistantAppearanceSettings } from '../src/shared/assistant-avatar.js'
import type { CodingNsSettingsStore, CodingNsSettingsOperation } from '../src/dsh-capabilities/settings-store.js'
import type { CodingNsSettings } from '../src/shared/contracts/config.js'
import type { CodingNsClientServices, CodingNsRpcClient } from '../src/client/features/types.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'

const revision = 'a'.repeat(40)
const source = `https://raw.githubusercontent.com/example/pets/${revision}/idle.png`
const previewUrl = `https://raw.githubusercontent.com/example/pets/${revision}/preview.png`
const manifestUrl = 'https://raw.githubusercontent.com/example/catalog/main/avatar.json'
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
const manifest = { avatarManifestVersion: 1, id: 'catalog-test', name: '测试形象', author: '测试作者', license: '仅测试许可',
  homepage: 'https://github.com/example/pets', asset: { renderer: 'image', source, spriteVersion: 2 } }
const metadata = { catalogVersion: 1, packages: [{ number: 1, id: 'test', revision, name: manifest.name, author: manifest.author,
  repositoryUrl: 'https://github.com/example/pets', description: '测试说明', remarks: '测试备注', format: 'codingns-pack',
  licenseUrl: `https://github.com/example/pets/blob/${revision}/LICENSE`, installManifestUrl: manifestUrl, previewUrl,
  verification: { files: 1, bytes: png.length } }] }
const read = async (path: string) => JSON.stringify(path === 'avatar-packages/catalog.json' ? metadata : manifest)
const dns = async () => [{ address: '93.184.216.34' }]
const previewRequest = (id = 'test', rev = revision) => new Request(`https://codingns.test${assistantAvatarCatalogPreviewUrl({ id, revision: rev })}`)

function settingsFixture() {
  let appearance: AssistantAppearanceSettings = DEFAULT_ASSISTANT_APPEARANCE
  let writable = true, reject = false
  const get = () => ({ ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, appearance } })
  const store: CodingNsSettingsStore<CodingNsSettings> = {
    getSnapshot: () => ({ status: 'ready', writable, revision: 1, value: get() }), subscribe: () => () => {},
    mutate: async (operations: readonly CodingNsSettingsOperation[]) => { if (reject) return false; appearance = operations[0]!.value as AssistantAppearanceSettings; return true },
    set: async () => false, unset: async () => false,
  }
  return { get, store, readonly: () => { writable = false }, reject: () => { reject = true }, consent: () => {
    appearance = { ...appearance, thirdPartyConsent: { version: ASSISTANT_AVATAR_CONSENT_VERSION, acceptedAt: 1 } }
  } }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-avatar-consent-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const downloads: string[] = []
  const remote = new AssistantAvatarRemote(async (url) => { downloads.push(String(url)); return new Response(png) }, dns)
  const catalog = new AssistantAvatarCatalog(read, remote)
  const packages = new AssistantAvatarPackages(join(directory, 'packages'), remote)
  const settings = settingsFixture(), table = new CodingNsRpcTable()
  let handle: (request: Request) => Promise<Response> = async () => new Response(null, { status: 404 })
  const services = { settings: { get: settings.get }, settingsProvider: { get writable() { return settings.store.getSnapshot().writable } }, rpc: table,
    registerAssistantAvatarRuntimeRoute: (handler: typeof handle) => { handle = handler; return () => {} } } as unknown as CodingNsHostServices
  const features = new FeatureRegistry(services)
  features.register(createAssistantAvatarRuntimeFeature({ catalog, packages }))
  await features.reconcile(['assistantAvatarRuntime'])
  t.after(() => features.reconcile([]))
  const calls: string[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload, signal) => {
    calls.push(endpoint)
    const target = table.resolve(endpoint)!
    const action = endpoint.slice('avatar/'.length)
    const value = await target.handler(action, payload, { signal } as never)
    return { ok: true, value }
  } }
  const manager = new AssistantAvatarManager(settings.store, undefined, undefined, undefined, rpc)
  return { settings, packages, catalog, table, downloads, calls, manager, handle: (request: Request) => handle(request) }
}

test('协议记录经归一化和设置 schema 持久保留，旧配置默认未同意，版本变化必须重签', () => {
  const agreed = { ...DEFAULT_ASSISTANT_APPEARANCE, thirdPartyConsent: { version: ASSISTANT_AVATAR_CONSENT_VERSION, acceptedAt: 123 } }
  assert.deepEqual(normalizeAssistantAppearance(agreed).thirdPartyConsent, agreed.thirdPartyConsent)
  const input = { ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, appearance: agreed } }
  assert.deepEqual(CodingNsSettingsSchema(input).assistant.appearance.thirdPartyConsent, agreed.thirdPartyConsent)
  assert.equal(hasAssistantAvatarConsent(DEFAULT_ASSISTANT_APPEARANCE.thirdPartyConsent), false)
  assert.equal(hasAssistantAvatarConsent({ version: 'old', acceptedAt: 1 }), false)
  for (const invalid of [{ version: '', acceptedAt: 1 }, { version: 'test', acceptedAt: NaN }, { version: 'test', acceptedAt: -1 }]) {
    assert.equal(normalizeAssistantAppearance({ ...agreed, thirdPartyConsent: invalid }).thirdPartyConsent, undefined)
    assert.throws(() => validateAssistantAppearance({ ...agreed, thirdPartyConsent: invalid }), /协议/u)
  }
})

test('未同意时 Client 和 Host 均拒绝目录、预览和安装，没有素材网络请求', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(f.manager.list().map((model) => model.name), ['鱼妞', '鱼仔'])
  await assert.rejects(f.manager.getCatalog(), /同意/u)
  await assert.rejects(f.manager.installCatalog('test', revision, true), /同意/u)
  assert.equal(f.calls.length, 0)
  const handler = f.table.resolve('avatar/catalog')!.handler
  await assert.rejects(Promise.resolve().then(() => handler('catalog', {})), /同意/u)
  await assert.rejects(Promise.resolve().then(() => handler('installCatalog', { id: 'test', revision, licenseAccepted: true })), /同意/u)
  assert.equal((await f.handle(previewRequest())).status, 403)
  assert.equal(f.downloads.length, 0); assert.equal((await f.packages.list()).length, 0)
})

test('同意仅加载元数据；选中预览仅下载小图；许可确认后才完整安装并登记启用', async (t) => {
  const f = await fixture(t)
  await f.manager.setThirdPartyEnabled(true)
  assert.equal(hasAssistantAvatarConsent(f.manager.getAppearance().thirdPartyConsent), true)
  const entries = await f.manager.getCatalog()
  assert.equal(entries[0]?.license, '仅测试许可'); assert.equal(f.downloads.length, 0)
  const response = await f.handle(previewRequest())
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png')
  assert.deepEqual(f.downloads, [previewUrl]); assert.equal(f.manager.list().length, 2)
  await f.handle(previewRequest()); assert.equal(f.downloads.length, 1)
  await assert.rejects(f.manager.installCatalog('test', revision, false), /确认/u)
  const handler = f.table.resolve('avatar/installCatalog')!.handler
  await assert.rejects(Promise.resolve().then(() => handler('installCatalog', { id: 'test', revision })), /确认/u)
  await assert.rejects(f.manager.installCatalog('test', 'b'.repeat(40), true), /变更/u)
  assert.deepEqual(f.downloads, [previewUrl])
  await f.manager.installCatalog('test', revision, true)
  assert.deepEqual(f.downloads, [previewUrl, source])
  assert.equal(f.manager.getSelected().id, 'catalog-test'); assert.equal(f.manager.list().length, 3)
  assert.equal(f.manager.getSelected().package?.author, '测试作者')
  await f.manager.setThirdPartyEnabled(false)
  assert.equal(f.manager.getSelected().id, 'catalog-test'); assert.equal((await f.packages.list()).length, 1)
  assert.equal((await f.handle(previewRequest())).status, 403)
  const installed = await f.packages.list()
  assert.equal((await f.handle(new Request(`https://codingns.test${installed[0]!.model.source}`))).status, 200)
})

test('只读可浏览已同意目录和预览，但 Client 与 Host 均禁止下载写盘', async (t) => {
  const f = await fixture(t); f.settings.consent(); f.settings.readonly()
  assert.equal((await f.manager.getCatalog()).length, 1)
  assert.equal((await f.handle(previewRequest())).status, 200)
  await assert.rejects(f.manager.setThirdPartyEnabled(false), /只读/u)
  await assert.rejects(f.manager.installCatalog('test', revision, true), /只读/u)
  const handler = f.table.resolve('avatar/installCatalog')!.handler
  await assert.rejects(Promise.resolve().then(() => handler('installCatalog', { id: 'test', revision, licenseAccepted: true })), /只读/u)
  assert.deepEqual(f.downloads, [previewUrl])
})

test('安装后设置拒绝回收新建素材，当前选择保持两个基础形象', async (t) => {
  const f = await fixture(t); f.settings.consent(); f.settings.reject()
  await assert.rejects(f.manager.installCatalog('test', revision, true), /拒绝/u)
  assert.equal(f.manager.getSelected().id, 'codingns-default')
  assert.equal((await f.packages.list()).length, 0)
})

test('下载完成前关闭列表，迟到安装结果不得登记，且回收未使用的新素材', async (t) => {
  const f = await fixture(t); await f.manager.setThirdPartyEnabled(true)
  let complete!: () => void
  let started!: () => void
  const downloading = new Promise<void>((resolve) => { started = resolve })
  const delayed: CodingNsRpcClient = { call: async (channel, endpoint, payload, signal) => {
    const target = f.table.resolve(endpoint)!
    const value = await target.handler(endpoint.slice(7), payload, { signal } as never)
    if (endpoint === 'avatar/installCatalog') await new Promise<void>((resolve) => { complete = resolve; started() })
    return { ok: true, value }
  } }
  const manager = new AssistantAvatarManager(f.settings.store, undefined, undefined, undefined, delayed)
  const pending = manager.installCatalog('test', revision, true)
  await Promise.race([downloading, pending.then(() => { throw new Error('安装未经过下载等待') })])
  await manager.setThirdPartyEnabled(false); complete()
  await assert.rejects(pending, /关闭/u)
  assert.equal(manager.list().length, 2); assert.equal((await f.packages.list()).length, 0)
})

test('预览白名单拒绝未知版本、任意 URL、脚本或超大图，失败不污染小图缓存', async () => {
  let calls = 0
  const remote = new AssistantAvatarRemote(async () => { calls++; return new Response(calls === 1 ? '<svg/>' : calls === 2 ? new Uint8Array(1024 * 1024 + 1) : png) }, dns)
  const catalog = new AssistantAvatarCatalog(read, remote)
  await assert.rejects(catalog.preview(previewRequest('../secret')), /变更/u)
  await assert.rejects(catalog.preview(previewRequest('test', 'old')), /变更/u)
  assert.equal(calls, 0)
  assert.equal((await catalog.preview(new Request('https://codingns.test/other?url=https://private.test'))).status, 404)
  await assert.rejects(catalog.preview(previewRequest()), /图片/u)
  await assert.rejects(catalog.preview(previewRequest()), /大小/u)
  assert.equal((await catalog.preview(previewRequest())).status, 200)
  await catalog.preview(previewRequest()); assert.equal(calls, 3)
})

test('实际十二条目录由随包元数据恢复，不请求尚未推送的 GitHub 清单', async () => {
  const catalog = new AssistantAvatarCatalog((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
    new AssistantAvatarRemote(async () => { throw new Error('目录读取禁止外网') }, dns))
  const entries = await catalog.list()
  assert.equal(entries.length, 12)
  assert.ok(entries.every((entry) => entry.previewAvailable && entry.license && entry.homepage))
})

test('实际十二条目录与当前形象合并为一个下拉框，第三方标记中英文一致且不登记素材', async () => {
  const catalog = new AssistantAvatarCatalog((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
    new AssistantAvatarRemote(async () => { throw new Error('列表合并禁止下载素材') }, dns))
  const entries = await catalog.list()
  const appearance = normalizeAssistantAppearance(undefined)
  const before = structuredClone(appearance)
  for (const language of ['zh', 'en'] as const) {
    const dictionary: Readonly<Record<string, string>> = avatarDictionary[language]
    const t: CodingNsTranslator = (key, params) => (dictionary[key] ?? key).replace(/\{(\w+)\}/gu,
      (placeholder, name) => params?.[name] === undefined ? placeholder : String(params[name]))
    const choices = assistantAvatarChoices(appearance, entries, t)
    assert.equal(choices.length, 14)
    assert.deepEqual(choices.slice(0, 2).map((choice) => choice.id), ['codingns-default', 'codingns-basic-male'])
    assert.ok(choices.slice(0, 2).every((choice) => !choice.catalog && !choice.thirdParty))
    assert.ok(choices.slice(2).every((choice) => choice.catalog && choice.thirdParty && choice.label === choice.catalog.name))
    const html = renderToStaticMarkup(createElement(AssistantAvatarPicker, {
      choices, value: appearance.selectedId, disabled: false, t, onChoose: () => {},
    }))
    assert.equal((html.match(/aria-haspopup="menu"/gu) ?? []).length, 1)
    assert.ok(!html.includes('data-codingns-avatar-third-party-badge'), '当前内置形象不显示第三方标签')
    const picker = AssistantAvatarPickerView({ choices, value: appearance.selectedId, disabled: false, t, onChoose: () => {}, id: 'avatars', open: true, onOpenChange: () => {} })
    const menu = picker.props.children.find((child: unknown) => isValidElement(child) && child.type === DshMenu)
    // 宿主弹层需要浏览器 document；独立渲染它收到的真实行标签，检查十四项来源标记。
    assert.equal(menu.props.items.length, 14)
    const expanded = renderToStaticMarkup(createElement(Fragment, null, ...menu.props.items.map((item: { label: unknown }) => item.label)))
    assert.equal((expanded.match(/data-codingns-avatar-third-party-badge="true"/gu) ?? []).length, 12)
    assert.ok(expanded.includes(language === 'zh' ? '>第三方</span>' : '>Third-party</span>'))
    assert.ok(html.includes('data-codingns-avatar-list'))
    assert.ok(!html.includes('data-codingns-avatar-catalog-select'))
  }
  assert.deepEqual(appearance, before, '展示合并不能修改持久清单、选择或容量')
})

test('目录形象安装前用于预览，安装后同 ID 去重并直接切换；关闭目录保留已安装选项', async (t) => {
  const f = await fixture(t)
  await f.manager.setThirdPartyEnabled(true)
  const entries = await f.manager.getCatalog()
  const tr = resolveCodingNsTranslator()
  const before = assistantAvatarChoices(f.manager.getAppearance(), entries, tr)
  assert.equal(before.length, 3)
  assert.equal(before.find((choice) => choice.id === 'catalog-test')?.catalog?.id, 'test')
  assert.equal(f.manager.getSelected().id, 'codingns-default')
  assert.equal(f.manager.getAppearance().models.length, 2)
  assert.equal(f.downloads.length, 0)
  await f.manager.installCatalog('test', revision, true)
  const after = assistantAvatarChoices(f.manager.getAppearance(), entries, tr)
  assert.equal(after.length, 3)
  assert.equal(after.filter((choice) => choice.id === 'catalog-test').length, 1)
  const installed = after.find((choice) => choice.id === 'catalog-test')!
  assert.equal(installed.catalog, undefined, '已安装选项必须直接切换，不能再次要求安装')
  assert.equal(installed.label, '测试形象')
  assert.equal(installed.thirdParty, true)
  await f.manager.select('codingns-default')
  await f.manager.select(installed.id)
  assert.equal(f.manager.getSelected().id, installed.id)
  assert.deepEqual(f.downloads, [source], '重复选择已安装形象不能再次下载')
  await f.manager.setThirdPartyEnabled(false)
  const closed = assistantAvatarChoices(f.manager.getAppearance(), [], tr)
  assert.equal(closed.length, 3)
  assert.equal(closed.find((choice) => choice.id === installed.id)?.label, installed.label)
  assert.equal(f.manager.getSelected().id, installed.id)
})

test('统一列表保留旧选中预设和手工形象，不覆盖用户命名或补入未选预设', async () => {
  const tr = resolveCodingNsTranslator()
  const legacy = normalizeAssistantAppearance({ ...DEFAULT_ASSISTANT_APPEARANCE, selectedId: 'codingns-preset-whale-live2d' })
  const choices = assistantAvatarChoices(legacy, [], tr)
  assert.equal(choices.length, 3)
  assert.ok(choices.some((choice) => choice.id === legacy.selectedId && choice.label === '大肥鱼 · Live2D 桌前' && choice.thirdParty))
  const custom = { id: 'catalog-test', name: '用户改过的名字', renderer: 'image', source: '/pet.png', spriteVersion: 2 as const }
  const appearance = { ...DEFAULT_ASSISTANT_APPEARANCE, models: [...DEFAULT_ASSISTANT_APPEARANCE.models, custom] }
  const entry = (await new AssistantAvatarCatalog(read, new AssistantAvatarRemote(async () => { throw new Error('目录读取不下载') }, dns)).list())[0]!
  const registered = assistantAvatarChoices(appearance, [{ ...entry, name: '目录原名' }], tr)
  assert.equal(registered.length, 3)
  assert.equal(registered[2]?.label, '用户改过的名字')
  assert.equal(registered[2]?.thirdParty, true)
  assert.equal(registered[2]?.catalog, undefined)
})

test('预览界面移除手动下载按钮，许可只控制采用，静态渲染不修改实际角色', async (t) => {
  const f = await fixture(t)
  await f.manager.setThirdPartyEnabled(true)
  const entries = await f.manager.getCatalog()
  const locale = { bind: () => resolveCodingNsTranslator(), subscribe: () => () => {}, getSnapshot: () => 'zh' }
  const html = renderToStaticMarkup(createElement(AssistantAvatarCatalogPreview, {
    services: { locale } as unknown as CodingNsClientServices, manager: f.manager, appearance: f.manager.getAppearance(),
    selected: entries[0]!, disabled: false, notify: () => {}, onPending: () => {}, onInstalled: () => {},
  }))
  assert.ok(!html.includes('<select'))
  assert.ok(!html.includes('<img'), '不请求仓库宣传图，组件挂载后自动准备真实模型')
  assert.ok(!html.includes('临时下载并预览'))
  assert.ok(html.includes('codingns-avatar-orbit'))
  assert.ok(!html.includes('正在自动下载并准备所选形象'))
  assert.ok(!html.includes('正在下载形象素材'))
  assert.ok(!html.includes('停止预览并清理素材'))
  assert.ok(!html.includes('<progress'))
  assert.ok(!html.includes('role="progressbar"'))
  assert.ok(html.includes('采用此形象'))
  assert.ok(html.includes('确认应用此形象'))
  assert.ok(html.includes('data-codingns-avatar-temporary-preview'))
  assert.ok(!html.includes('checked=""'))
  assert.ok(html.includes('<button type="button" disabled=""'))
  assert.equal(f.manager.getSelected().id, 'codingns-default')
  assert.equal(f.downloads.length, 0)
})

test('第三方设置默认显示统一当前形象列表与启用复选框，不提前显示协议、目录或预览', () => {
  const settings = settingsFixture()
  const manager = new AssistantAvatarManager(settings.store)
  const locale = { bind: () => resolveCodingNsTranslator(), subscribe: () => () => {}, getSnapshot: () => 'zh' }
  const services = { locale } as unknown as CodingNsClientServices
  const html = renderToStaticMarkup(createElement(AssistantAvatarCatalogPanel, {
    services, manager, appearance: manager.getAppearance(), disabled: false, notify: () => {},
  }))
  assert.ok(!/<p\b/u.test(html), '关闭时只展示当前形象与开关，不展示目录说明区块')
  assert.equal((html.match(/aria-haspopup="menu"/gu) ?? []).length, 1)
  assert.ok(html.includes('当前形象'))
  assert.ok(html.includes('data-codingns-avatar-list'))
  assert.ok(!html.includes('data-codingns-avatar-catalog-select'))
  assert.ok(!html.includes('padding:14px')); assert.ok(!html.includes('border-radius:10px'))
  assert.ok(html.includes('启用第三方形象'))
  assert.ok(html.includes('data-codingns-third-party-enabled'))
  assert.ok(html.includes('role="switch" aria-label="启用第三方形象"'))
  assert.ok(!html.includes('第三方形象使用说明 ·'))
  assert.ok(!html.includes('data-codingns-avatar-consent-dialog'))
  assert.ok(!html.includes('<details'))
  assert.ok(!html.includes('data-codingns-avatar-catalog-browser'))
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('checked=""'))
})
