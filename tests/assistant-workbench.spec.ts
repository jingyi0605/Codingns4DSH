import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantWorkbench, AssistantConfigurationPage, AssistantConfigurationFields, AssistantCapabilityFields, AssistantVoiceFields, AssistantWorkspaceFields, AssistantConversationView, readAssistantDraft, assistantDraftPayload, handleAssistantWorkbenchEscape } from '../src/client/features/assistant-workbench.js'
import { AssistantComposerView as AssistantComposer, AssistantStatusBadge } from '../src/client/features/assistant-workbench-controls.js'
import { AssistantConfigurationTabBar, AssistantConfigurationTabs, type AssistantConfigurationTab } from '../src/client/features/assistant-configuration-tabs.js'
import { AssistantPanel } from '../src/client/features/assistant-panel.js'
import { AssistantAvatarPicker } from '../src/client/avatar/catalog-picker.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { BUILTIN_ASSISTANT_AVATAR, normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { DEFAULT_ASSISTANT_PERSONALITY } from '../src/shared/assistant-lifecycle.js'
import { getAssistantAvatarPreset } from '../src/shared/assistant-avatar-legacy.js'
import { DEFAULT_ASSISTANT_TTS_SETTINGS, MOSS_BUILTIN_VOICES, type AssistantTtsSnapshot } from '../src/shared/assistant-tts.js'
import { ASSISTANT_VOICE_MODEL_CATALOG } from '../src/shared/voice-models.js'
import { DEFAULT_LIGHT_VOICE_MODEL_ID } from '../src/shared/voice-initialization.js'
import { registerGlobalVoiceAdapter, type GlobalVoiceAdapter } from '../src/client/global-voice-runtime-registry.js'
import type { AssistantConversationSnapshot } from '../src/shared/contracts/assistant.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
const t = resolveCodingNsTranslator()
const props = { active: false, pending: false, partialText: '', realtimeAvailable: false, onStart() {}, onStop() {}, onClose() {} }
function fixture(initialized: boolean) {
  let calls = 0
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  value.assistant.profile = { name: '小鱼', initialized, createdAt: initialized ? 1 : null }
  const snapshot = { value, writable: true, status: 'ready' as const, revision: 1 }
  const services = { locale: { bind: () => t, getSnapshot: () => 'zh', subscribe: () => () => {} },
    settings: { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => { calls++; return true } },
    rpc: { call: async () => { calls++; return { ok: true, value: undefined } } },
  } as unknown as CodingNsClientServices
  return { services, snapshot, calls: () => calls }
}
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}

test('形象菜单消费 Escape 时只收起菜单，下一次 Escape 才关闭助理窗口', () => {
  const document = new EventTarget()
  let menuOpen = true; let menuClosed = 0; let windowClosed = 0; let propagated = 0
  // 宿主菜单在捕获阶段标记按键已处理，窗口监听位于其后的冒泡阶段。
  document.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape' || !menuOpen) return
    event.preventDefault(); menuOpen = false; menuClosed++
  })
  document.addEventListener('keydown', (event) => handleAssistantWorkbenchEscape(event as KeyboardEvent, () => { windowClosed++ }))
  document.addEventListener('keydown', () => { propagated++ })
  const press = (key: string) => document.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key }))
  press('Escape'); assert.equal(menuClosed, 1); assert.equal(windowClosed, 0)
  press('Enter'); assert.equal(windowClosed, 0)
  press('Escape'); assert.equal(windowClosed, 1)
  assert.equal(propagated, 2, '只有未被内层处理的关闭按键才阻止外层继续传播')
})
function configurationPage(f: ReturnType<typeof fixture>, tab: AssistantConfigurationTab) {
  const value = f.snapshot.value.assistant
  return createElement(AssistantConfigurationPage, { tab, services: f.services, value, draft: readAssistantDraft(value), catalog: { models: [], default: null, errors: [] },
    appearance: normalizeAssistantAppearance(value.appearance), tts: undefined, workspaces: [], t, disabled: false, onChange() {}, onDebug() {}, onError() {} })
}

test('首次创建只有名称、模型、性格背景和形象，不初始化语音资源', () => {
  const f = fixture(false)
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, services: f.services }))
  for (const text of ['创建你的助理', '名称', '对话模型', '性格背景', '形象', '创建并开始对话']) assert.ok(markup.includes(text), text)
  for (const text of ['预览</strong>', '试聊', '试听声音', '浏览器默认声音', '<form', 'data-codingns-preview-tts']) assert.ok(!markup.includes(text), text)
  for (const marker of ['data-codingns-assistant-status', 'data-codingns-assistant-composer-dock', 'data-codingns-assistant-reset', 'aria-label="清理对话"']) assert.ok(!markup.includes(marker), marker)
  assert.equal((markup.match(/<label\b/gu) ?? []).length, 4)
  assert.ok(markup.includes('鱼妞'))
  const fields = AssistantConfigurationFields({ draft: readAssistantDraft(f.snapshot.value.assistant), catalog: undefined,
    appearance: normalizeAssistantAppearance(f.snapshot.value.assistant.appearance), initializing: true, t, disabled: false, onChange: () => {} })
  const picker = elements(fields).find((element) => element.type === AssistantAvatarPicker)!
  assert.deepEqual(picker.props.choices.map((choice: { label: string }) => choice.label), ['鱼妞', '鱼仔'])
  assert.ok(markup.includes(DEFAULT_ASSISTANT_PERSONALITY))
  assert.ok(markup.includes('/api/codingns/assistant-avatar-basic/female-v1.png'))
  assert.ok(markup.includes('data-codingns-assistant-preview'))
  for (const text of ['更多设置', 'data-codingns-assistant-capabilities', 'type="checkbox"', '<legend']) assert.ok(!markup.includes(text), text)
  assert.ok(markup.includes('flex-wrap:wrap'), '窄屏配置与预览可上下排列')
  assert.ok(!markup.includes('data-codingns-voice-settings'))
  assert.ok(!markup.includes('data-codingns-avatar-settings-editor'))
  assert.ok(!markup.includes('data-codingns-assistant-chat'))
  assert.equal(f.calls(), 0)
})

test('索引等待、查询失败和超时恢复空闲，后续轮询仍能显示真实构建活动', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  // AbortSignal.timeout 使用原生计时器，测试中接入可推进的时钟，避免真实等待十秒。
  context.mock.method(AbortSignal, 'timeout', (delay: number) => {
    assert.equal(delay, 10_000)
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), delay)
    return controller.signal
  })
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() })
  const f = fixture(true)
  f.snapshot.value.assistant.managedWorkspaceIds = ['workspace']
  let reply: 'not-built' | 'building' | 'incomplete' | 'ready' | 'error' | 'hang' = 'not-built'
  let queries = 0
  const endpoints: string[] = []
  const services = { ...f.services, rpc: { call: async (_channel: string, endpoint: string, _payload: unknown, signal?: AbortSignal) => {
    endpoints.push(endpoint)
    if (endpoint === 'assistant/lifecycle/read') return { ok: true, value: { profile: f.snapshot.value.assistant.profile,
      conversation: { revision: 0, summary: '', messages: [], pendingMessage: null, active: null, compressing: false, error: null } } }
    if (endpoint !== 'assistant/debug') return { ok: true, value: undefined }
    queries++
    if (reply === 'error') throw new Error('状态查询失败')
    if (reply === 'hang') return new Promise((_resolve, reject) => {
      assert.ok(signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return { ok: true, value: { indexState: reply, workspaces: [] } }
  } } } as unknown as CodingNsClientServices
  const renderer = createHookRenderer(AssistantWorkbench, { ...props, services })
  context.after(() => {
    renderer.dispose()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const status = () => elements(renderer.render()).find((element) => element.type === AssistantStatusBadge)!.props.status
  const next = async (state: typeof reply) => { reply = state; context.mock.timers.tick(3000); await setImmediate() }
  assert.equal(status(), 'idle', '尚未收到索引快照时不猜测执行状态')
  await setImmediate(); assert.equal(status(), 'idle')
  await next('building'); assert.equal(status(), 'updating')
  await next('incomplete'); assert.equal(status(), 'idle', '等待会话结束不代表正在索引')
  await next('building'); assert.equal(status(), 'updating')
  await next('error'); assert.equal(status(), 'idle', '失败后清除旧的构建证明')
  await next('building'); assert.equal(status(), 'updating')
  await next('hang'); assert.equal(status(), 'updating')
  const beforeTimeout = queries
  context.mock.timers.tick(10_000); await setImmediate()
  assert.equal(status(), 'idle', '查询超时不能永久保持认知更新')
  assert.equal(queries, beforeTimeout)
  await next('ready'); assert.equal(status(), 'idle')
  assert.equal(queries, beforeTimeout + 1, '超时后继续查询')
  await next('building'); assert.equal(status(), 'updating')
  assert.ok(endpoints.every((endpoint) => ['assistant/lifecycle/read', 'assistant/chat/models', 'assistant/tts/catalog', 'assistant/debug'].includes(endpoint)), '状态查询不重建或取消后台索引')
})

test('未创建助理选择男生后，初始化预览使用对应生图 URL', () => {
  const f = fixture(false)
  f.snapshot.value.assistant.appearance = normalizeAssistantAppearance({ selectedId: 'codingns-basic-male' })
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, services: f.services }))
  assert.ok(markup.includes('data-codingns-avatar-selected="codingns-basic-male"'))
  assert.ok(markup.includes('/api/codingns/assistant-avatar-basic/male-v1.png'))
  assert.ok(!markup.includes('<canvas'))
  assert.equal(f.calls(), 0)
})

test('日常视图名称右侧显示状态，底部输入栏支持附件和电话，不再展示维护工具', () => {
  const f = fixture(true)
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, services: f.services }))
  for (const text of ['小鱼', 'aria-label="清理对话"', 'aria-label="配置"', 'aria-label="关闭"', '发送消息', 'aria-label="发送"', 'aria-label="添加附件"']) assert.ok(markup.includes(text), text)
  for (const text of ['>配置</button>', '>关闭</button>', '>清理对话</button>', '新对话', '最近对话', '对话维护', '压缩对话', 'data-codingns-assistant-tools', '重置助理', 'Sherpa-ONNX', '项目认知更新中', 'data-codingns-assistant-configuration', 'data-codingns-assistant-preview', 'data-codingns-assistant-maintenance']) assert.ok(!markup.includes(text), text)
  assert.ok(markup.indexOf('aria-label="清理对话"') < markup.indexOf('aria-label="配置"'), '清理图标位于配置左侧')
  assert.ok(!markup.includes('data-codingns-assistant-confirmation'), '读取或渲染不隐式打开确认或清理')
  assert.match(markup, /<strong[^>]*>小鱼<\/strong><span[^>]*data-codingns-assistant-status="idle"/u)
  assert.match(markup, /<\/div><footer data-codingns-assistant-composer-dock="true"[^>]*flex-shrink:0/u, '输入栏在正文滚动容器外')
  assert.ok(markup.indexOf('data-codingns-assistant-composer') > markup.indexOf('data-codingns-assistant-scroll'))
  assert.ok(markup.includes('type="file"')); assert.ok(markup.includes('multiple=""'))
  assert.match(markup, /<button[^>]*disabled=""[^>]*aria-label="开始实时对话"[^>]*><svg/u, '语音不可用时保留禁用的麦克风图标')
  assert.ok(!markup.includes('>开始实时对话</button>'))
  assert.equal(f.calls(), 0)
})

test('实时通话替换聊天内容和输入栏，沿用当前形象与独立挂断入口', () => {
  const f = fixture(true)
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, active: true, services: f.services, state: 'speaking', liveUserText: '查询项目', liveAssistantText: '正在核对。' }))
  for (const text of ['data-codingns-realtime-call', 'data-codingns-call-avatar', 'aria-label="挂断"', '切换扬声器', '查询项目', '正在核对。']) assert.ok(markup.includes(text), text)
  assert.ok(!markup.includes('发送消息')); assert.ok(!markup.includes('aria-label="配置"'))
  assert.equal(f.calls(), 0)
})

test('未创建时不把未登记的大肥鱼旧选择当作内置形象或预览，读取不改写旧配置', () => {
  const f = fixture(false)
  const assistant = f.snapshot.value.assistant
  assistant.appearance = normalizeAssistantAppearance({ selectedId: 'codingns-preset-whale-live2d' })
  const before = structuredClone(assistant)
  const draft = readAssistantDraft(assistant)
  assert.equal(draft.avatarId, BUILTIN_ASSISTANT_AVATAR.id)
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, services: f.services }))
  assert.ok(!markup.includes('codingns-preset-whale-live2d'))
  assert.ok(!markup.includes('大肥鱼'))
  assert.ok(!markup.includes('<canvas'))
  assert.ok(markup.includes('第三方形象为外部依赖'))
  assert.deepEqual(assistant, before)
  assert.equal(f.calls(), 0)
})

test('手工登记的大肥鱼可用于创建，形象选项标记第三方并说明 Live2D 引擎要求', () => {
  const f = fixture(false)
  const model = getAssistantAvatarPreset('codingns-preset-whale-live2d')!.model
  f.snapshot.value.assistant.appearance = normalizeAssistantAppearance({ selectedId: model.id, models: [model] })
  assert.equal(readAssistantDraft(f.snapshot.value.assistant).avatarId, model.id)
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, services: f.services }))
  assert.ok(markup.includes('大肥鱼 · Live2D 桌前'))
  assert.ok(markup.includes('data-codingns-avatar-third-party-badge="true"'))
  assert.ok(markup.includes('Live2D 引擎需在 Host 单独安装'))
  assert.ok(markup.includes('<canvas'))
  assert.equal(f.calls(), 0)
})

test('已创建助理的旧预设继续兼容，配置选项标记第三方', () => {
  const f = fixture(true)
  f.snapshot.value.assistant.appearance = normalizeAssistantAppearance({ selectedId: 'codingns-preset-whale-live2d' })
  assert.equal(readAssistantDraft(f.snapshot.value.assistant).avatarId, 'codingns-preset-whale-live2d')
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, initialConfiguration: true, services: f.services }))
  assert.ok(markup.includes('<canvas'), '基本信息页的预览继续使用已有形象')
  const appearance = renderToStaticMarkup(configurationPage(f, 'appearance'))
  assert.ok(appearance.includes('大肥鱼 · Live2D 桌前'))
  assert.ok(appearance.includes('data-codingns-avatar-third-party-badge="true"'))
  assert.equal(f.calls(), 0)
})

test('旧用户创建保留项目和音色资料，初始化仅预填身份与形象', () => {
  const f = fixture(false)
  const assistant = f.snapshot.value.assistant
  delete assistant.profile
  assistant.managedWorkspaceIds = ['old-project']
  assistant.model = { provider: 'api', model: 'fixed' }
  assistant.voice = { ...assistant.voice, initialized: true }
  assistant.appearance = normalizeAssistantAppearance({ floatingEnabled: true, selectedId: 'legacy-avatar', models: [{ id: 'legacy-avatar', name: '旧形象', renderer: 'image', source: '/fixture/avatar.png', spriteVersion: 2 }] })
  assistant.tts = { ...DEFAULT_ASSISTANT_TTS_SETTINGS, selectedId: 'moss:Lingyu', backend: 'moss-onnx' }
  const before = structuredClone(assistant)
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, services: f.services }))
  for (const text of ['创建你的助理', 'data-codingns-assistant-configuration', 'data-codingns-assistant-preview', '旧形象']) assert.ok(markup.includes(text), text)
  assert.ok(!markup.includes('data-codingns-assistant-chat'))
  assert.ok(!markup.includes('old-project'))
  const draft = readAssistantDraft(assistant)
  assert.deepEqual(assistantDraftPayload(draft, true), { name: '我的助理', model: { provider: 'api', model: 'fixed' }, personality: DEFAULT_ASSISTANT_PERSONALITY, avatarId: 'legacy-avatar' })
  assert.deepEqual(draft.managedWorkspaceIds, ['old-project'])
  assert.equal(draft.voiceId, 'moss:Lingyu')
  assert.equal(draft.ttsBackend, 'browser')
  assert.ok(markup.includes('data-codingns-avatar-selected="legacy-avatar"'))
  assert.ok(!markup.includes('<option value="moss:Lingyu"'))
  assert.deepEqual(assistant, before)
  assert.equal(f.calls(), 0)
})

test('创建后的配置分为四个标签，基本信息只显示三项字段，不堆叠其他管理页', () => {
  const f = fixture(true)
  f.snapshot.value.assistant.managedWorkspaceIds = ['old-project']
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, initialConfiguration: true, services: f.services }))
  for (const text of ['基本信息', '形象管理', '声音管理', '更多设置', '性格背景', '保存配置', '取消']) assert.ok(markup.includes(text), text)
  assert.equal((markup.match(/role="tab"/gu) ?? []).length, 4)
  assert.equal((markup.match(/aria-selected="true"/gu) ?? []).length, 1)
  assert.equal((markup.match(/<label\b/gu) ?? []).length, 3)
  for (const text of ['试聊', '试听声音', '<form', '试聊与试听不会加入正式对话']) assert.ok(!markup.includes(text), text)
  for (const marker of ['data-codingns-avatar-settings-editor', 'data-codingns-voice-settings', 'data-codingns-assistant-projects', 'data-codingns-assistant-maintenance', 'old-project', '<details open']) assert.ok(!markup.includes(marker), marker)
  assert.ok(!markup.includes('<option value="moss:Lingyu"'))
  assert.equal(f.calls(), 0)
})

test('各标签的管理内容独立，声音页分输入和输出两组，项目和提示词归更多设置', () => {
  const f = fixture(true)
  f.snapshot.value.assistant.managedWorkspaceIds = ['old-project']
  const basic = renderToStaticMarkup(configurationPage(f, 'basic'))
  const appearance = renderToStaticMarkup(configurationPage(f, 'appearance'))
  const voice = renderToStaticMarkup(configurationPage(f, 'voice'))
  const more = renderToStaticMarkup(configurationPage(f, 'more'))
  assert.ok(basic.includes('性格背景')); assert.ok(!basic.includes('data-codingns-avatar-list'))
  assert.ok(appearance.includes('data-codingns-avatar-settings-editor'))
  assert.ok(appearance.includes('鱼妞')); assert.ok(appearance.includes('data-codingns-avatar-list="true"'))
  assert.ok(!appearance.includes('data-codingns-voice-settings')); assert.ok(!appearance.includes('data-codingns-assistant-projects'))
  assert.ok(voice.includes('data-codingns-voice-initialization')); assert.ok(voice.includes('启用语音'))
  assert.ok(!voice.includes('data-codingns-assistant-voice-selection')); assert.ok(voice.includes('data-codingns-voice-settings'))
  assert.ok(voice.includes('语音输入')); assert.ok(voice.includes('语音输出')); assert.ok(!voice.includes('高级声音设置'))
  assert.ok(!voice.includes('data-codingns-avatar-settings-editor')); assert.ok(!voice.includes('data-codingns-assistant-projects'))
  assert.ok(more.includes('data-codingns-assistant-projects')); assert.ok(more.includes('old-project'))
  assert.ok(!more.includes('语音识别模型')); assert.ok(more.includes('索引提示词'))
  assert.ok(voice.includes('data-codingns-voice-model-manager'), '识别模型组件仍在声音页内，而非二级弹窗')
  assert.ok(voice.includes('语音识别模型')); assert.ok(voice.includes('role="radiogroup"'))
  assert.ok(voice.indexOf('data-codingns-voice-model-manager') < voice.indexOf('data-codingns-voice-settings-group="output"'), '识别设置属于输入组')
  assert.ok(!more.includes('data-codingns-voice-settings')); assert.ok(!more.includes('data-codingns-avatar-settings-editor'))
  assert.ok(more.includes('data-codingns-assistant-reset="true"')); assert.ok(more.includes('重置助理'))
  for (const page of [basic, appearance, voice]) assert.ok(!page.includes('data-codingns-assistant-reset'))
  assert.equal(f.calls(), 0)
})

test('更多设置中的重置入口只请求确认，读取或渲染不会执行重置', () => {
  const f = fixture(true)
  let requested = 0
  const page = AssistantConfigurationPage({ ...configurationPage(f, 'more').props, onReset: () => { requested++ } })
  const reset = elements(page).find((element) => element.props['data-codingns-assistant-reset'])!
  assert.equal(reset.props.disabled, false)
  assert.equal(requested, 0); assert.equal(f.calls(), 0)
  reset.props.onClick(); assert.equal(requested, 1); assert.equal(f.calls(), 0)
  const readonly = AssistantConfigurationPage({ ...configurationPage(f, 'more').props, disabled: true, onReset() {} })
  assert.equal(elements(readonly).find((element) => element.props['data-codingns-assistant-reset'])!.props.disabled, true)
})

test('未初始化、浏览器播报和 MOSS 配置均提供两个默认收起的声音设置，打开页面不自动下载', () => {
  for (const modelId of [undefined, ASSISTANT_VOICE_MODEL_CATALOG[0]!.id]) {
    for (const backend of ['browser', 'moss-onnx'] as const) {
      const f = fixture(true)
      f.snapshot.value.assistant.voice = { ...f.snapshot.value.assistant.voice, modelId }
      f.snapshot.value.assistant.tts = { ...DEFAULT_ASSISTANT_TTS_SETTINGS, backend }
      const markup = renderToStaticMarkup(configurationPage(f, 'voice'))
      assert.equal((markup.match(/type="radio"/gu) ?? []).length, ASSISTANT_VOICE_MODEL_CATALOG.length)
      const checked = markup.match(/<input[^>]*type="radio"[^>]*checked=""[^>]*>/u)?.[0]
      assert.ok(checked?.includes(`value="${modelId ?? DEFAULT_LIGHT_VOICE_MODEL_ID}"`))
      for (const kind of ['input', 'output']) {
        const group = markup.match(new RegExp(`<details[^>]*data-codingns-voice-settings-group="${kind}"[^>]*>`, 'u'))?.[0]
        assert.ok(group); assert.ok(!group.includes('open=""'), `${kind} 默认折叠`)
      }
      assert.ok(markup.includes('当前模型')); assert.ok(markup.includes('验证可用性'))
      assert.ok(!markup.includes('role="dialog"'), '识别设置不需要再打开二级窗口')
      assert.equal(f.calls(), 0, '渲染不能触发下载或配置写入')
    }
  }
})

test('麦克风与识别仅在输入组，输出设备、音色和播报参数仅在输出组', () => {
  const f = fixture(true)
  const dispose = registerGlobalVoiceAdapter(f.services, { outputDeviceSupported: true } as GlobalVoiceAdapter)
  try {
    const markup = renderToStaticMarkup(configurationPage(f, 'voice'))
    const inputIndex = markup.indexOf('data-codingns-voice-settings-group="input"')
    const outputIndex = markup.indexOf('data-codingns-voice-settings-group="output"')
    const input = markup.slice(inputIndex, outputIndex); const output = markup.slice(outputIndex)
    for (const text of ['输入设备', '浏览器默认麦克风', '语音识别模型', 'role="radiogroup"']) assert.ok(input.includes(text), text)
    for (const text of ['输出设备', '音色设置', '播报控制', '语速（倍）', '音量（%）']) assert.ok(output.includes(text), text)
    assert.ok(!input.includes('data-codingns-voice-settings="true"')); assert.ok(!input.includes('输出设备'))
    assert.ok(!output.includes('role="radiogroup"')); assert.ok(!output.includes('输入设备'))
    assert.ok(markup.indexOf('data-codingns-voice-initialization') < inputIndex, '向导保留在两组设置之上')
    assert.equal(f.calls(), 0)
  } finally { dispose() }
})

test('标签支持点击及方向键、Home/End 导航，焦点和页关联保持一致', () => {
  let selected: AssistantConfigurationTab = 'basic'
  let focused = -1; let prevented = 0
  const bar = AssistantConfigurationTabBar({ id: 'config', active: 'basic', t, onChange: (tab) => { selected = tab } })
  const controls = elements(bar).filter((element) => element.props.role === 'tab')
  assert.deepEqual(controls.map((element) => element.props.tabIndex), [0, -1, -1, -1])
  assert.deepEqual(controls.map((element) => element.props['aria-controls']), ['config-panel-basic', 'config-panel-appearance', 'config-panel-voice', 'config-panel-more'])
  controls[1]!.props.onClick(); assert.equal(selected, 'appearance')
  const event = (key: string) => ({ key, preventDefault: () => { prevented++ }, currentTarget: { parentElement: { querySelectorAll: () => controls.map((_, index) => ({ focus: () => { focused = index } })) } } })
  controls[0]!.props.onKeyDown(event('ArrowLeft')); assert.equal(selected, 'more'); assert.equal(focused, 3)
  controls[3]!.props.onKeyDown(event('ArrowRight')); assert.equal(selected, 'basic'); assert.equal(focused, 0)
  controls[1]!.props.onKeyDown(event('End')); assert.equal(selected, 'more')
  controls[2]!.props.onKeyDown(event('Home')); assert.equal(selected, 'basic')
  controls[0]!.props.onKeyDown(event('Enter')); assert.equal(prevented, 4)
})

test('未访问的管理页不挂载，已访问页隐藏后保留表单，更多设置隐藏共享预览', () => {
  const mounted: string[] = []
  const content = (name: string) => createElement(function Page() { mounted.push(name); return createElement('input', { value: `${name}-draft`, readOnly: true }) })
  const panels = { basic: content('basic'), appearance: content('appearance'), voice: content('voice'), more: content('more') }
  const render = (active: AssistantConfigurationTab, visited: readonly AssistantConfigurationTab[]) => renderToStaticMarkup(createElement(AssistantConfigurationTabs, { active, visited, panels,
    preview: createElement('span', null, 'shared-preview'), t, onChange() {} }))
  const first = render('basic', ['basic'])
  assert.deepEqual(mounted, ['basic']); assert.equal((first.match(/role="tabpanel"/gu) ?? []).length, 4)
  mounted.length = 0
  const switched = render('appearance', ['basic', 'appearance'])
  assert.deepEqual(mounted, ['basic', 'appearance'])
  assert.match(switched, /hidden=""[^>]*data-codingns-configuration-page="basic"[^>]*display:none[^>]*>.*basic-draft/u)
  const back = render('basic', ['basic', 'appearance'])
  assert.ok(back.includes('appearance-draft'))
  const advanced = render('more', ['basic', 'appearance', 'more'])
  assert.match(advanced, /hidden=""[^>]*data-codingns-configuration-preview="true"[^>]*display:none/u)
})

test('跨页编辑共用一份草稿，切换标签不丢基本信息、项目或声音的修改', () => {
  const f = fixture(true)
  let draft = readAssistantDraft(f.snapshot.value.assistant)
  const onChange = (patch: Partial<typeof draft>) => { draft = { ...draft, ...patch } }
  const basic = AssistantConfigurationFields({ draft, catalog: undefined, appearance: normalizeAssistantAppearance(), includeAvatar: false, t, disabled: false, onChange })
  elements(basic).find((element) => element.type === 'textarea')!.props.onChange({ currentTarget: { value: '自定义性格' } })
  const projects = AssistantWorkspaceFields({ draft, workspaces: [{ workspaceId: 'w1', title: '项目一', sessionIds: [] }], t, disabled: false, onChange })
  elements(projects).find((element) => element.type === 'input')!.props.onChange({ currentTarget: { checked: true } })
  const voices = AssistantVoiceFields({ draft, tts: { settings: DEFAULT_ASSISTANT_TTS_SETTINGS, voices: MOSS_BUILTIN_VOICES, status: { ready: true, busy: false, phase: '', downloadedBytes: 0, totalBytes: null, error: null } }, t, disabled: false, onChange })
  elements(voices).find((element) => element.type === 'select')!.props.onChange({ currentTarget: { value: 'moss:Lingyu' } })
  const saved = assistantDraftPayload(draft)
  assert.equal(saved.personality, '自定义性格'); assert.deepEqual(saved.managedWorkspaceIds, ['w1']); assert.equal(saved.voiceId, 'moss:Lingyu')
  assert.equal(saved.ttsBackend, 'moss-onnx'); assert.equal(f.calls(), 0)
})

test('重置标记优先于旧素材及范围，设置卡片只保留统一入口', () => {
  const f = fixture(false)
  f.snapshot.value.assistant.managedWorkspaceIds = ['old-project']
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { ...props, services: f.services }))
  assert.ok(markup.includes('data-codingns-assistant-configuration'))
  const panel = renderToStaticMarkup(createElement(AssistantPanel, { services: f.services, enabled: true, snapshot: f.snapshot, notify() {} }))
  assert.equal((panel.match(/<button/gu) ?? []).length, 1)
  assert.ok(!panel.includes('<select'))
})

test('连续消息显示文字、语音、流式回复及摘要，不重复已提交的回复', () => {
  const active = { requestId: 'v', provider: 'api', model: 'm', generation: 1, state: 'running' as const, text: '继续核对', error: null, startedAt: 1, finishedAt: null }
  const conversation: AssistantConversationSnapshot = { revision: 1, summary: '偏好简短回答', messages: [
    { id: 't-user', role: 'user', text: '文字问题', source: 'text', createdAt: 1 }, { id: 't-assistant', role: 'assistant', text: '文字回复', source: 'text', createdAt: 1 },
  ], pendingMessage: { id: 'v-user', role: 'user', text: '语音追问', source: 'voice', createdAt: 2 }, active, compressing: false, error: null }
  const markup = renderToStaticMarkup(createElement(AssistantConversationView, { conversation, name: '小鱼', t }))
  for (const text of ['文字问题', '文字回复', '语音追问', '继续核对', '偏好简短回答']) assert.ok(markup.includes(text), text)
  const committed = renderToStaticMarkup(createElement(AssistantConversationView, { t, name: '小鱼', conversation: { ...conversation, pendingMessage: null, messages: [...conversation.messages,
    { id: 'v-user', role: 'user', text: '语音追问', source: 'voice', createdAt: 2 }, { id: 'v-assistant', role: 'assistant', text: active.text, source: 'voice', createdAt: 2 }] } }))
  assert.equal((committed.match(/继续核对/gu) ?? []).length, 1)
})

test('文字对话在首段正文前展示工具，状态更新可见，完成后保留且不重复', () => {
  const call = { id: 'search', name: 'web_search', kind: 'web-search' as const, state: 'running' as const, startedAt: 1, finishedAt: null, arguments: '{"queries":["北京天气"]}', result: '' }
  const active = { requestId: 'search-turn', provider: 'api', model: 'm', generation: 1, state: 'running' as const, text: '', error: null, startedAt: 1, finishedAt: null, toolCalls: [call] }
  const conversation: AssistantConversationSnapshot = { revision: 1, summary: '', messages: [],
    pendingMessage: { id: 'search-turn-user', role: 'user', text: '查一下天气', source: 'text', createdAt: 1 }, active, compressing: false, error: null }
  const render = (snapshot: AssistantConversationSnapshot) => renderToStaticMarkup(createElement(AssistantConversationView, { conversation: snapshot, name: '小鱼', t }))
  const running = render(conversation)
  for (const text of ['data-codingns-assistant-tool="web_search"', 'data-state="running"', '进行中', '北京天气']) assert.ok(running.includes(text), text)
  assert.ok(!running.includes('Hello')); assert.match(running, /<details\b[^>]*>/u); assert.ok(!/<details\b[^>]*\bopen\b/u.test(running))
  const completed = { ...active, state: 'completed' as const, text: '北京今天晴。', finishedAt: 3,
    toolCalls: [{ ...call, state: 'completed' as const, finishedAt: 2, result: '<script>天气来源</script>' }] }
  const committed = render({ ...conversation, active: completed, pendingMessage: null, messages: [conversation.pendingMessage!,
    { id: 'search-turn-assistant', role: 'assistant', source: 'text', createdAt: 3, text: completed.text, toolCalls: completed.toolCalls }] })
  assert.equal((committed.match(/data-codingns-assistant-tool="web_search"/gu) ?? []).length, 1)
  assert.ok(committed.includes('已完成')); assert.ok(committed.includes('北京今天晴。'))
  assert.ok(committed.includes('&lt;script&gt;天气来源&lt;/script&gt;')); assert.ok(!committed.includes('<script>'))
  const failed = render({ ...conversation, active: { ...active, toolCalls: [{ ...call, state: 'failed', finishedAt: 2, result: '搜索提供商不可用' }] } })
  assert.ok(failed.includes('失败')); assert.ok(failed.includes('搜索提供商不可用'))
  const cancelled = render({ ...conversation, active: { ...active, toolCalls: [{ ...call, state: 'cancelled', finishedAt: 2 }] } })
  assert.ok(cancelled.includes('已取消'))
  const plain = render({ ...conversation, active: { ...active, text: '普通回答', toolCalls: [] } })
  assert.ok(plain.includes('普通回答')); assert.ok(!plain.includes('data-codingns-assistant-tools'))
})

test('聊天把工具穿插在调用前后正文之间，流式状态更新和最终提交保持顺序', () => {
  const first = '先看项目。'; const second = '接着查天气。'; const last = '最后回答。'
  const tool = { id: 'project', name: 'assistant_list_workspaces', kind: 'workspace' as const, state: 'running' as const, startedAt: 1, finishedAt: null, arguments: '{}', result: '', textOffset: first.length }
  const active = { requestId: 'timeline', provider: 'api', model: 'm', generation: 1, state: 'running' as const, text: first + second + last, error: null, startedAt: 1, finishedAt: null,
    toolCalls: [tool, { ...tool, id: 'weather', name: 'web_search', kind: 'web-search' as const, textOffset: (first + second).length }] }
  const conversation: AssistantConversationSnapshot = { revision: 1, summary: '', messages: [], pendingMessage: { id: 'timeline-user', role: 'user', text: '帮我看看', source: 'text', createdAt: 1 }, active, compressing: false, error: null }
  const completed = { ...active, state: 'completed' as const, toolCalls: active.toolCalls.map((call) => ({ ...call, state: 'completed' as const, finishedAt: 2 })) }
  const snapshots = [conversation, { ...conversation, active: completed }, { ...conversation, active: completed, pendingMessage: null, messages: [conversation.pendingMessage!,
    { id: 'timeline-assistant', role: 'assistant' as const, source: 'text' as const, createdAt: 2, text: completed.text, toolCalls: completed.toolCalls }] }]
  for (const snapshot of snapshots) {
    const markup = renderToStaticMarkup(createElement(AssistantConversationView, { conversation: snapshot, name: '小鱼', t }))
    const positions = ['帮我看看', first, 'data-codingns-assistant-tool="assistant_list_workspaces"', second, 'data-codingns-assistant-tool="web_search"', last].map((part) => markup.indexOf(part))
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)), '调用信息必须在对应正文段之间')
    assert.equal((markup.match(/data-codingns-assistant-tool=/gu) ?? []).length, 2)
  }
})

test('输入事件支持中文输入法与换行，禁用和空输入不能提交', () => {
  let sent = 0; let changed = ''
  const make = (value = '问题', disabled = false) => AssistantComposer({ t, value, disabled, onChange: (value) => { changed = value }, onSend: () => { sent++ }, label: 'awb.send' })
  const input = elements(make()).find((element) => element.type === 'textarea')!
  input.props.onChange({ currentTarget: { value: '新问题' } }); assert.equal(changed, '新问题')
  for (const [shiftKey, isComposing] of [[true, false], [false, true]]) input.props.onKeyDown({ key: 'Enter', shiftKey, nativeEvent: { isComposing }, preventDefault() {} })
  assert.equal(sent, 0)
  input.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} }); assert.equal(sent, 1)
  make('', false).props.onSubmit({ preventDefault() {} }); make('问题', true).props.onSubmit({ preventDefault() {} }); assert.equal(sent, 1)
})

test('身份四项只产生草稿，创建载荷不带工作区或音色，能力配置在创建后统一保存', () => {
  const f = fixture(false)
  let draft = readAssistantDraft(f.snapshot.value.assistant)
  const onChange = (patch: Partial<typeof draft>) => { draft = { ...draft, ...patch } }
  const fields = AssistantConfigurationFields({ draft, t, catalog: { models: [{ provider: 'api', model: 'fixed', label: '固定' }], default: null, errors: [] },
    appearance: normalizeAssistantAppearance(), disabled: false, onChange })
  const controls = elements(fields)
  controls.find((element) => element.type === 'input' && element.props.type !== 'checkbox')!.props.onChange({ currentTarget: { value: '小鱼' } })
  assert.equal(controls.filter((element) => element.type === 'label' || element.type === AssistantAvatarPicker).length, 4)
  const picker = controls.find((element) => element.type === AssistantAvatarPicker)!
  picker.props.onChoose({ id: 'unknown' }); assert.equal(draft.avatarId, 'codingns-default')
  picker.props.onChoose(picker.props.choices[1]); assert.equal(draft.avatarId, 'codingns-basic-male')
  picker.props.onChoose(picker.props.choices[0]); assert.equal(draft.avatarId, 'codingns-default')
  const personality = controls.find((element) => element.type === 'textarea')!
  assert.equal(personality.props.maxLength, 4000)
  assert.equal(personality.props.value, DEFAULT_ASSISTANT_PERSONALITY)
  personality.props.onChange({ currentTarget: { value: '耐心的编程伙伴，直说重点。' } })
  const selects = controls.filter((element) => element.type === 'select')
  selects[0]!.props.onChange({ currentTarget: { value: JSON.stringify(['api', 'fixed']) } })
  assert.deepEqual(assistantDraftPayload(draft, true), { name: '小鱼', model: { provider: 'api', model: 'fixed' }, personality: '耐心的编程伙伴，直说重点。', avatarId: 'codingns-default' })
  const tts: AssistantTtsSnapshot = { settings: DEFAULT_ASSISTANT_TTS_SETTINGS, voices: MOSS_BUILTIN_VOICES, status: { ready: true, busy: false, phase: '', downloadedBytes: 0, totalBytes: null, error: null } }
  const capabilities = elements(AssistantCapabilityFields({ draft, t, tts, workspaces: [{ workspaceId: 'w1', title: '项目一', sessionIds: [] }], disabled: false, onChange }))
  capabilities.find((element) => element.type === 'input' && element.props.type === 'checkbox')!.props.onChange({ currentTarget: { checked: true } })
  capabilities.find((element) => element.type === 'select')!.props.onChange({ currentTarget: { value: 'moss:Lingyu' } })
  assert.deepEqual(assistantDraftPayload(draft), { name: '小鱼', model: { provider: 'api', model: 'fixed' }, personality: '耐心的编程伙伴，直说重点。', managedWorkspaceIds: ['w1'], avatarId: 'codingns-default', voiceId: 'moss:Lingyu', ttsBackend: 'moss-onnx' })
  assert.deepEqual(assistantDraftPayload(draft, false, false), { name: '小鱼', model: { provider: 'api', model: 'fixed' }, personality: '耐心的编程伙伴，直说重点。', managedWorkspaceIds: ['w1'], avatarId: 'codingns-default' }, '最新工作台保存身份与项目时不写回声音草稿，保留向导和音色面板的权威结果')
  assert.equal(f.calls(), 0, '表单编辑和预览不会先写正式配置')
})

test('标准性格只填入未创建且缺省的草稿，已有设定与用户清空不被覆盖', () => {
  for (const initialized of [false, true]) {
    const f = fixture(initialized)
    const assistant = f.snapshot.value.assistant
    for (const personality of ['自定义性格背景', '']) {
      assistant.profile = { ...assistant.profile!, personality }
      const before = structuredClone(assistant)
      const draft = readAssistantDraft(assistant)
      assert.equal(draft.personality, personality)
      assert.equal(assistantDraftPayload(draft, !initialized).personality, personality)
      assert.deepEqual(assistant, before)
    }
    delete assistant.profile!.personality
    assert.equal(readAssistantDraft(assistant).personality, initialized ? '' : DEFAULT_ASSISTANT_PERSONALITY)
  }
})

test('未安装 MOSS 时能力控件拒绝无效音色，保留声音资料并以浏览器作为可用选择', () => {
  const f = fixture(true)
  f.snapshot.value.assistant.tts = { ...DEFAULT_ASSISTANT_TTS_SETTINGS, backend: 'moss-onnx', selectedId: 'moss:Lingyu' }
  const draft = readAssistantDraft(f.snapshot.value.assistant, false)
  assert.equal(draft.ttsBackend, 'browser')
  let changes = 0
  for (const tts of [undefined, { settings: DEFAULT_ASSISTANT_TTS_SETTINGS, voices: MOSS_BUILTIN_VOICES, status: { ready: false, busy: false, phase: '', downloadedBytes: 0, totalBytes: null, error: null } }]) {
    const field = AssistantCapabilityFields({ draft, t, tts, workspaces: [], disabled: false, onChange: () => { changes++ } })
    const select = elements(field).find((element) => element.type === 'select')!
    assert.equal(select.props.value, 'browser')
    assert.equal(elements(select).filter((element) => element.type === 'option').length, 1)
    select.props.onChange({ currentTarget: { value: 'moss:Lingyu' } })
  }
  assert.equal(changes, 0)
  assert.equal(f.snapshot.value.assistant.tts.selectedId, 'moss:Lingyu')
})
