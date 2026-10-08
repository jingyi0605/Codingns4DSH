import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { isValidElement, type ReactElement } from 'react'
import { AssistantAvatarCatalogPanel, AssistantAvatarCatalogPreview } from '../src/client/avatar/catalog-panel.js'
import { AssistantAvatarPicker } from '../src/client/avatar/catalog-picker.js'
import { AssistantAvatarEngineDialog, AssistantAvatarEngineProgress, useAssistantAvatarEngine } from '../src/client/avatar/engine.js'
import { AssistantAvatarSlot } from '../src/client/avatar/slot.js'
import { getAssistantAvatarManager, type AssistantAvatarManager } from '../src/client/avatar/manager.js'
import { AssistantConfigurationSession } from '../src/client/features/assistant-configuration-session.js'
import type { CodingNsClientServices, CodingNsRpcResult } from '../src/client/features/types.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { ASSISTANT_AVATAR_CONSENT_VERSION } from '../src/shared/assistant-avatar-catalog.js'
import type { AssistantAvatarCatalogEntry } from '../src/shared/assistant-avatar-catalog.js'
import { ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION, ASSISTANT_AVATAR_ENGINE_VERSION, hasAssistantAvatarEngineConsent, invalidateAssistantAvatarRuntime, type AssistantAvatarEngineStatus } from '../src/shared/assistant-avatar-engine.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}

/** 真实草稿、管理器与组件流程；只替换 RPC，不下载素材或操作任何 Host Profile。 */
function fixture(format = 'cubism-model', installed = false) {
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  value.assistant.appearance = { ...normalizeAssistantAppearance(),
    thirdPartyConsent: { version: ASSISTANT_AVATAR_CONSENT_VERSION, acceptedAt: 1 } }
  const entry: AssistantAvatarCatalogEntry = { id: 'test', number: 1, name: '测试形象', format,
    author: 'test', description: '', remarks: '', repositoryUrl: '', licenseUrl: '', license: '', homepage: '',
    revision: 'a'.repeat(40), bytes: 100, files: 1, previewAvailable: true }
  const calls: { endpoint: string; payload: any; signal?: AbortSignal }[] = []
  let writes = 0
  let finish!: (result: CodingNsRpcResult) => void
  const services = {
    settings: { getSnapshot: () => ({ value, revision: 1, writable: true, status: 'ready' as const }),
      subscribe: () => () => {}, mutate: async () => { writes++; return true } },
    locale: { bind: () => (key: string) => key, getSnapshot: () => 'zh', subscribe: () => () => {} },
    rpc: { call: async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<CodingNsRpcResult> => {
      calls.push({ endpoint, payload, ...(signal === undefined ? {} : { signal }) })
      if (endpoint === 'avatar/catalog') return { ok: true, value: [entry] }
      if (endpoint === 'avatar/engineStatus') return { ok: true, value: { installed, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: installed ? 'managed' : 'missing' } }
      if (endpoint === 'avatar/installEngine') return new Promise((resolve) => { finish = resolve })
      throw new Error(`意外请求：${endpoint}`)
    } },
  } as unknown as CodingNsClientServices
  const session = new AssistantConfigurationSession(services)
  const manager = getAssistantAvatarManager(session.services)
  const props = { services: session.services, manager, appearance: manager.getAppearance(), disabled: false, notify: () => {} }
  const renderer = createHookRenderer(AssistantAvatarCatalogPanel, props)
  const render = () => renderer.render({ ...props, appearance: manager.getAppearance() })
  const find = (type: unknown) => elements(render()).find((element) => element.type === type)
  return { services, session, manager, value, entry, calls, render, find, writes: () => writes,
    choose: () => find(AssistantAvatarPicker)!.props.onChoose({ id: 'catalog-test', label: entry.name, thirdParty: true, catalog: entry }),
    controller: () => find(AssistantAvatarEngineDialog)!.props.controller,
    finish: (ready = true) => { installed = ready; finish({ ok: true, value: { installed, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: installed ? 'managed' : 'missing' } }) },
    fail: () => finish({ ok: false, error: { code: 'TEST_DOWNLOAD_FAILED', message: '下载失败' } }),
    dispose: () => { renderer.dispose(); session.dispose() },
  }
}

for (const format of ['cubism-model', 'dsh-live2d-pet']) {
  test(`${format} 首次预览先确认引擎许可，草稿安装就绪后才挂载预览`, async (t) => {
    const f = fixture(format); t.after(f.dispose)
    f.render(); await setImmediate(); f.choose(); await setImmediate()
    assert.equal(f.controller().consentOpen, true)
    assert.equal(f.find(AssistantAvatarCatalogPreview), undefined)
    assert.equal(f.calls.some((call) => call.endpoint === 'avatar/installEngine'), false)
    f.controller().setAgreed(true)
    const accepted = f.controller().acceptConsent()
    await setImmediate()
    const request = f.calls.find((call) => call.endpoint === 'avatar/installEngine')!
    assert.ok(request)
    assert.ok(hasAssistantAvatarEngineConsent(request.payload.engineConsent))
    assert.equal(f.session.getSnapshot().preparing, true)
    assert.equal(f.find(AssistantAvatarEngineProgress)!.props.controller.installing, true)
    assert.equal(f.find(AssistantAvatarCatalogPreview), undefined)
    f.finish(); await accepted
    assert.equal(f.session.getSnapshot().preparing, false)
    assert.equal(f.find(AssistantAvatarCatalogPreview)!.props.selected.id, 'test')
    assert.equal(f.manager.getSelected().id, 'codingns-default', '预览不提前采用新形象')
    assert.equal(f.value.assistant.appearance!.engineConsent, undefined)
    assert.equal(f.writes(), 0, '资源准备不能提前提交正式配置')
  })
}

test('拒绝许可不安装、不预览；精灵图和已安装引擎无需再次确认', async (t) => {
  const missing = fixture(); t.after(missing.dispose)
  missing.render(); await setImmediate(); missing.choose(); await setImmediate()
  missing.controller().cancelConsent()
  assert.equal(missing.find(AssistantAvatarCatalogPreview), undefined)
  assert.equal(missing.calls.some((call) => call.endpoint === 'avatar/installEngine'), false)
  for (const [format, installed] of [['codex-pet', false], ['cubism-model', true]] as const) {
    const f = fixture(format, installed); t.after(f.dispose)
    f.render(); await setImmediate(); f.choose(); await setImmediate()
    assert.equal(f.controller().consentOpen, false)
    assert.ok(f.find(AssistantAvatarCatalogPreview))
    assert.equal(f.calls.some((call) => call.endpoint === 'avatar/installEngine'), false)
  }
})

test('安装失败保留待预览选择，重试就绪后恢复；未就绪答复不能误报成功', async (t) => {
  const f = fixture(); t.after(f.dispose)
  f.render(); await setImmediate(); f.choose(); await setImmediate()
  const accepted = f.controller().acceptConsent(); await setImmediate()
  f.fail(); await accepted
  assert.match(f.controller().error, /下载失败/u)
  assert.equal(f.find(AssistantAvatarCatalogPreview), undefined)
  f.controller().retry(); await setImmediate(); f.finish(false); await setImmediate()
  assert.match(f.controller().error, /仍未就绪/u)
  assert.equal(f.find(AssistantAvatarCatalogPreview), undefined)
  f.controller().retry(); await setImmediate(); f.finish(); await setImmediate()
  assert.equal(f.controller().error, '')
  assert.ok(f.find(AssistantAvatarCatalogPreview))
})

for (const reset of [false, true]) {
  test(`${reset ? '关闭配置' : '取消安装'}后迟到的成功答复不能触发预览`, async (t) => {
    const f = fixture(); t.after(f.dispose)
    f.render(); await setImmediate(); f.choose(); await setImmediate()
    const accepted = f.controller().acceptConsent(); await setImmediate()
    const request = f.calls.find((call) => call.endpoint === 'avatar/installEngine')!
    if (reset) f.session.reset()
    else f.controller().cancelInstall()
    assert.equal(request.signal!.aborted, true)
    f.finish(); await accepted
    assert.equal(f.find(AssistantAvatarCatalogPreview), undefined)
    assert.equal(f.session.getSnapshot().preparing, false)
    assert.equal(f.manager.getSelected().id, 'codingns-default')
  })
}

test('安装完成重建同一 Live2D 形象的失败状态，不重建其他渲染器', (t) => {
  const f = fixture(); t.after(f.dispose)
  for (const kind of ['live2d', 'image']) {
    const props = { services: f.services, model: { id: 'test', name: '测试', renderer: kind, source: '/model', spriteVersion: 2 as const },
      state: 'idle' as const, surface: 'dialog' as const, size: 100 }
    const renderer = createHookRenderer(AssistantAvatarSlot, props); t.after(() => renderer.dispose())
    const before = renderer.render()
    invalidateAssistantAvatarRuntime()
    const after = renderer.render()
    assert.equal(before.key !== after.key, kind === 'live2d')
  }
})

for (const installed of [false, true]) {
  test(`关闭窗口后迟到的引擎状态（installed=${installed}）不能安装或采用形象`, async (t) => {
    const f = fixture(); t.after(f.dispose)
    const status = { installed, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: installed ? 'managed' : 'missing' } as const
    let complete!: (value: AssistantAvatarEngineStatus) => void
    let queriedSignal: AbortSignal | undefined
    let queries = 0; let installs = 0; let selections = 0
    const manager = {
      engineStatus: async (signal?: AbortSignal) => {
        if (++queries === 1) return status
        queriedSignal = signal
        return new Promise<AssistantAvatarEngineStatus>((resolve) => { complete = resolve })
      },
      installEngine: async () => { installs++; return { ...status, installed: true, source: 'managed' } },
    } as unknown as AssistantAvatarManager
    const appearance = { ...normalizeAssistantAppearance(), engineConsent: { version: ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION, acceptedAt: 1 } }
    const renderer = createHookRenderer(useAssistantAvatarEngine, { services: f.services, manager, appearance, disabled: false })
    renderer.render(); await setImmediate()
    const pending = renderer.render().ensure(() => { selections++ })
    renderer.dispose()
    complete(status)
    assert.equal(await pending, false)
    assert.equal(installs, 0)
    assert.equal(selections, 0)
    assert.equal(queriedSignal?.aborted, true)
  })
}

test('快速重复重试只保留一份安装请求和一次选择回调', async (t) => {
  const f = fixture(); t.after(f.dispose)
  f.render(); await setImmediate(); f.choose(); await setImmediate()
  const accepted = f.controller().acceptConsent(); await setImmediate()
  f.fail(); await accepted
  const controller = f.controller()
  controller.retry(); controller.retry()
  await setImmediate()
  const requests = f.calls.filter((call) => call.endpoint === 'avatar/installEngine')
  assert.equal(requests.length, 2, '首次失败后仅新增一份重试请求')
  f.finish(); await setImmediate()
  assert.ok(f.find(AssistantAvatarCatalogPreview))
  assert.equal(f.session.getSnapshot().preparing, false)
})
