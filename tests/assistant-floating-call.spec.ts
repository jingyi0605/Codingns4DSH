import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createElement, isValidElement } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GlobalVoiceOverlay } from '../src/client/features/global-voice-assistant.js'
import { AssistantWorkbench } from '../src/client/features/assistant-workbench.js'
import { AssistantLoadedView } from '../src/client/features/assistant-view-loader.js'
import { ASSISTANT_WORKBENCH_OPEN_EVENT } from '../src/client/features/assistant-workbench-entry.js'
import { AssistantRealtimeCall, AssistantRealtimeCallView } from '../src/client/features/assistant-realtime-call.js'
import { FloatingAssistantAvatar, FloatingVoiceCall } from '../src/client/avatar/floating.js'
import { FloatingCallBadge, FloatingCallCaption, floatingCallCaptionLayout, floatingCallStatus } from '../src/client/features/assistant-floating-call.js'
import type { FloatingCallInfo } from '../src/client/features/assistant-floating-call.js'
import { registerGlobalVoiceAdapter } from '../src/client/global-voice-runtime-registry.js'
import type { GlobalVoiceAdapter } from '../src/client/global-voice-runtime-registry.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { BUILTIN_ASSISTANT_AVATAR, normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { CodingNsClientServices, CodingNsRpcClient } from '../src/client/features/types.js'
import { DESKTOP_ASSISTANT_CHANNEL, type DesktopAssistantStatus } from '../src/shared/desktop-assistant.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const t = resolveCodingNsTranslator()
const call: FloatingCallInfo = { startedAt: Date.now() - 125000, state: 'speaking', pending: false, microphoneMuted: false, speakerMuted: false,
  userText: '请检查这个项目', assistantText: '第一句完整回复。\n第二句完整回复。' }
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}
function find(tree: unknown, type: unknown): ReactElement<any> {
  // 外层控制保持不变，动态边界只负责把同一份 props 交给已加载工作台。
  if (type === AssistantWorkbench) {
    const lazy = elements(tree).find((element) => element.type === AssistantLoadedView)
    if (lazy) return createElement(AssistantWorkbench, lazy.props.viewProps)
  }
  const item = elements(tree).find((element) => element.type === type)
  assert.ok(item, `没有找到组件 ${String(type)}`)
  return item
}

function fixture(context: TestContext, floatingEnabled = false, rpc: CodingNsRpcClient = { call: async () => ({ ok: true, value: undefined }) }) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const window = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844, isSecureContext: true })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  value.assistant.profile = { initialized: true, name: '小鱼', createdAt: 1 }
  value.assistant.appearance = { ...normalizeAssistantAppearance(undefined), floatingEnabled }
  Object.assign(value.assistant.voice, { initialized: true, provider: 'sherpa-onnx', asrEncoder: 'encoder', asrDecoder: 'decoder', asrJoiner: 'joiner', asrTokens: 'tokens' })
  const changes = new Set<() => void>()
  const listeners = new Set<(event: any) => void>()
  let starts = 0; let stops = 0
  let startOperation = async () => {}
  const emit = (event: any) => { for (const listener of listeners) listener(event) }
  const adapter = { configuredOwnerId: 'call-owner', ownerId: undefined as string | undefined, capabilities: { realtime: true },
    isMicrophoneMuted: false, isSpeakerMuted: false,
    subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener) },
    async start() { starts++; await startOperation(); adapter.ownerId = 'call-owner'; emit({ type: 'state', state: 'listening' }) },
    async stop() { stops++; adapter.ownerId = undefined; emit({ type: 'state', state: 'disabled' }) },
    setMicrophoneMuted(muted: boolean) { adapter.isMicrophoneMuted = muted }, setSpeakerMuted(muted: boolean) { adapter.isSpeakerMuted = muted },
  }
  const services = { locale: { bind: () => t, getSnapshot: () => ({ revision: 1 }), subscribe: () => () => {} },
    settings: { getSnapshot: () => ({ value, writable: true, revision: 1, status: 'ready' }), subscribe: (listener: () => void) => { changes.add(listener); return () => changes.delete(listener) } },
    rpc,
  } as unknown as CodingNsClientServices
  const unregister = registerGlobalVoiceAdapter(services, adapter as unknown as GlobalVoiceAdapter)
  const renderer = createHookRenderer(GlobalVoiceOverlay, { services })
  const extraCleanup: (() => void)[] = []
  const initial = renderer.render()
  window.dispatchEvent(new Event(ASSISTANT_WORKBENCH_OPEN_EVENT))
  context.after(() => { for (const dispose of extraCleanup) dispose(); renderer.dispose(); unregister(); if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window') })
  return { services, adapter, window, renderer, initial, emit, value, counts: () => ({ starts, stops }),
    onDispose(dispose: () => void) { extraCleanup.push(dispose) },
    startWith(operation: () => Promise<void>) { startOperation = operation }, changed() { for (const listener of changes) listener() } }
}

test('Desktop 首帧、等待显示和反复轮询均不渲染内部形象，工作台开关不隐藏原生窗口', async (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'dshDesktopBoot')
  Object.defineProperty(globalThis, 'dshDesktopBoot', { configurable: true, value: {} })
  context.after(() => { if (previous) Object.defineProperty(globalThis, 'dshDesktopBoot', previous); else Reflect.deleteProperty(globalThis, 'dshDesktopBoot') })
  let status: DesktopAssistantStatus = { available: true, owned: true, visible: false, openSequence: 0 }
  const updates: { visible: boolean; state: string }[] = []
  const f = fixture(context, true, { call: async (channel, action, payload) => {
    if (channel !== DESKTOP_ASSISTANT_CHANNEL) return { ok: true, value: undefined }
    if (action === 'update') updates.push((payload as any).presentation)
    return { ok: true, value: { ...status } }
  } })
  const noInternal = (tree: unknown): void => {
    assert.ok(!elements(tree).some((element) => element.type === FloatingAssistantAvatar || element.type === FloatingVoiceCall))
  }
  const sync = async (state: string): Promise<void> => {
    const count = updates.length
    f.emit({ type: 'state', state }); f.renderer.render()
    for (let attempt = 0; updates.length <= count && attempt < 100; attempt++) await delay(2)
    assert.ok(updates.length > count, '状态变化应立即刷新，而不是等待一秒轮询')
    await delay(0)
  }
  noInternal(f.initial)
  find(f.renderer.render(), AssistantWorkbench).props.onClose()
  noInternal(f.renderer.render())
  await sync('listening'); noInternal(f.renderer.render())
  status = { ...status, visible: true }
  await sync('speaking'); noInternal(f.renderer.render())
  status = { ...status, visible: false }
  await sync('thinking'); noInternal(f.renderer.render())
  f.window.dispatchEvent(new Event(ASSISTANT_WORKBENCH_OPEN_EVENT))
  assert.ok(find(f.renderer.render(), AssistantWorkbench))
  await sync('listening'); noInternal(f.renderer.render())
  find(f.renderer.render(), AssistantWorkbench).props.onClose(); noInternal(f.renderer.render())
  assert.ok(updates.every((update) => update.visible), '工作台打开和关闭时必须保持原生悬浮请求')

  status = { ...status, error: '原生渲染进程退出' }
  await sync('speaking')
  assert.ok(find(f.renderer.render(), FloatingAssistantAvatar), '原生明确失败才显示页面回退')
  assert.ok(elements(f.renderer.render()).some((element) => element.props['data-codingns-desktop-avatar-fallback']))
  status = { ...status, available: false, error: undefined }
  await sync('thinking')
  assert.ok(find(f.renderer.render(), FloatingAssistantAvatar), '不支持原生的形象必须保留页面入口')
  f.value.assistant.appearance.floatingEnabled = false; f.changed(); noInternal(f.renderer.render())
  await sync('listening')
  f.value.assistant.appearance.floatingEnabled = true; f.changed()
  status = { ...status, available: true }
  noInternal(f.renderer.render())
  await sync('speaking'); noInternal(f.renderer.render())
})

test('收起和恢复保留同一通话、计时、静音及完整累计字幕，不重复启动或挂断', async (context) => {
  const f = fixture(context)
  await find(f.renderer.render(), AssistantWorkbench).props.onStart()
  const before = find(f.renderer.render(), AssistantWorkbench)
  const startedAt = before.props.callStartedAt
  f.adapter.setMicrophoneMuted(true); f.adapter.setSpeakerMuted(true)
  before.props.onMinimize()
  let tree = f.renderer.render()
  assert.equal(find(tree, AssistantWorkbench).props.minimized, true)
  assert.equal(elements(tree).filter((element) => element.type === FloatingVoiceCall).length, 1)
  assert.equal(elements(tree).filter((element) => element.type === FloatingAssistantAvatar).length, 0)
  f.emit({ type: 'reply', text: '第一句。' }); f.renderer.render()
  f.emit({ type: 'reply', text: '第一句。第二句。第三句。' })
  f.emit({ type: 'state', state: 'speaking' })
  tree = f.renderer.render()
  const floating = find(tree, FloatingVoiceCall)
  assert.equal(floating.props.call.assistantText, '第一句。第二句。第三句。')
  assert.equal(floating.props.call.startedAt, startedAt)
  assert.equal(floating.props.call.microphoneMuted, true); assert.equal(floating.props.call.speakerMuted, true)
  floating.props.onOpen()
  const restored = find(f.renderer.render(), AssistantWorkbench)
  assert.equal(restored.props.minimized, false); assert.equal(restored.props.callStartedAt, startedAt)
  assert.equal(restored.props.liveAssistantText, '第一句。第二句。第三句。')
  assert.deepEqual(f.counts(), { starts: 1, stops: 0 })
  restored.props.onMinimize(); f.renderer.render()
  f.emit({ type: 'state', state: 'disabled' })
  tree = f.renderer.render()
  assert.equal(elements(tree).some((element) => element.type === FloatingVoiceCall), false)
  assert.equal(find(tree, AssistantWorkbench).props.minimized, false)
})

test('页面隐藏仍每十秒续签通话租约，慢心跳不并发，恢复展示不重复启动通话', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelectorAll: () => [] })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  let complete: (() => void) | undefined; let beats = 0
  const f = fixture(context, false, { call: async (_channel, endpoint) => {
    if (endpoint === 'assistant/voice/heartbeat') { beats++; await new Promise<void>((resolve) => { complete = resolve }) }
    return { ok: true, value: undefined }
  } })
  context.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
  await find(f.renderer.render(), AssistantWorkbench).props.onStart(); f.renderer.render()
  const before = f.counts()
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))
  context.mock.timers.tick(10_000); await delay(0); assert.equal(beats, 1)
  context.mock.timers.tick(20_000); await delay(0); assert.equal(beats, 1)
  complete?.(); await delay(0)
  context.mock.timers.tick(10_000); await delay(0); assert.equal(beats, 2)
  complete?.(); await delay(0)
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); f.renderer.render()
  assert.deepEqual(f.counts(), before)
})

test('启用悬浮助手时融合通话，切换开关仍只有一个入口且不影响音频租约', async (context) => {
  const f = fixture(context, true)
  await find(f.renderer.render(), AssistantWorkbench).props.onStart()
  find(f.renderer.render(), AssistantWorkbench).props.onMinimize()
  let tree = f.renderer.render()
  assert.ok(find(tree, FloatingAssistantAvatar).props.call)
  assert.equal(elements(tree).some((element) => element.type === FloatingVoiceCall), false)
  f.value.assistant.appearance.floatingEnabled = false; f.changed()
  tree = f.renderer.render()
  assert.ok(find(tree, FloatingVoiceCall).props.call)
  assert.equal(elements(tree).some((element) => element.type === FloatingAssistantAvatar), false)
  f.value.assistant.appearance.floatingEnabled = true; f.changed()
  find(f.renderer.render(), FloatingAssistantAvatar).props.onOpen()
  assert.equal(elements(f.renderer.render()).some((element) => element.type === FloatingAssistantAvatar), false)
  assert.deepEqual(f.counts(), { starts: 1, stops: 0 })
})

test('连接中可以收起，启动失败恢复窗口并移除通话球', async (context) => {
  const f = fixture(context)
  let reject!: (error: Error) => void
  f.startWith(() => new Promise((_resolve, rejectStart) => { reject = rejectStart }))
  const started = find(f.renderer.render(), AssistantWorkbench).props.onStart()
  find(f.renderer.render(), AssistantWorkbench).props.onMinimize()
  assert.equal(find(f.renderer.render(), FloatingVoiceCall).props.call.pending, true)
  reject(new Error('连接失败')); await started
  const tree = f.renderer.render()
  assert.equal(elements(tree).some((element) => element.type === FloatingVoiceCall), false)
  assert.equal(find(tree, AssistantWorkbench).props.minimized, false)
  assert.equal(find(tree, AssistantWorkbench).props.message, '连接失败')
})

test('收起期间致命错误停止通话并恢复错误窗口，不留下悬浮通话状态', async (context) => {
  const f = fixture(context)
  await find(f.renderer.render(), AssistantWorkbench).props.onStart()
  find(f.renderer.render(), AssistantWorkbench).props.onMinimize(); f.renderer.render()
  f.emit({ type: 'error', message: '上传失败', recoverable: false })
  const tree = f.renderer.render()
  assert.equal(elements(tree).some((element) => element.type === FloatingVoiceCall), false)
  assert.equal(find(tree, AssistantWorkbench).props.minimized, false)
  assert.equal(find(tree, AssistantWorkbench).props.message, '上传失败')
  assert.equal(f.counts().stops, 1)
})

test('拖动悬浮组件不误恢复，单击与键盘可恢复，字幕区独立接收滚动', (context) => {
  const f = fixture(context)
  let opened = 0
  const component = FloatingVoiceCall({ services: f.services, call, onOpen: () => { opened++ } })
  const renderer = createHookRenderer(component.type as any, component.props)
  f.onDispose(() => renderer.dispose())
  let tree = renderer.render() as ReactElement<any>
  const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} }
  const event = (clientX: number, clientY: number) => ({ button: 0, isPrimary: true, pointerId: 1, clientX, clientY, currentTarget: target, preventDefault() {} })
  let button = elements(tree).find((element) => element.props.role === 'button')!
  const originalX = tree.props.style.left
  button.props.onPointerDown(event(300, 750)); button.props.onPointerMove(event(220, 680))
  button.props.onPointerUp(event(220, 680)); button.props.onClick()
  assert.equal(opened, 0)
  tree = renderer.render() as ReactElement<any>
  assert.ok(tree.props.style.left < originalX)
  button = elements(tree).find((element) => element.props.role === 'button')!
  button.props.onPointerDown(event(220, 680)); button.props.onPointerUp(event(220, 680)); button.props.onClick()
  button.props.onKeyDown({ key: 'Enter', preventDefault() {} }); button.props.onKeyDown({ key: ' ', preventDefault() {} })
  assert.equal(opened, 3)
  assert.equal(elements(button).some((element) => element.type === FloatingCallCaption), false)
  assert.ok(find(tree, FloatingCallCaption))
  f.window.innerWidth = 320; f.window.innerHeight = 568; f.window.dispatchEvent(new Event('resize'))
  tree = renderer.render() as ReactElement<any>
  assert.ok(tree.props.style.left + tree.props.style.width <= 320)
  assert.ok(tree.props.style.top + tree.props.style.height <= 568)
})

test('隐藏窗口退出模态呈现和动画渲染，恢复后设备状态仍保留', (context) => {
  const f = fixture(context)
  const props = { services: f.services, t, name: '小鱼', model: BUILTIN_ASSISTANT_AVATAR, pending: false, startedAt: call.startedAt,
    state: 'speaking', userText: call.userText, assistantText: call.assistantText, onHangup() {}, onMinimize() {} }
  const renderer = createHookRenderer(AssistantRealtimeCall, props)
  f.onDispose(() => renderer.dispose())
  let view = renderer.render()
  view.props.onMicrophone()
  view = renderer.render({ ...props, minimized: true } as typeof props)
  assert.equal(view.props.avatar, null); assert.equal(view.props.microphoneMuted, true)
  view = renderer.render(props)
  assert.equal(view.props.microphoneMuted, true); assert.ok(view.props.avatar)
  const markup = renderToStaticMarkup(createElement(AssistantWorkbench, { services: f.services, active: true, pending: false, minimized: true,
    partialText: '', realtimeAvailable: true, onStart() {}, onStop() {}, onClose() {}, onMinimize() {} }))
  assert.ok(markup.includes('hidden=""')); assert.ok(markup.includes('display:none')); assert.ok(markup.includes('aria-modal="false"'))
  assert.ok(!markup.includes('data-codingns-avatar-slot="dialog"'))
  assert.deepEqual(f.counts(), { starts: 0, stops: 0 })
})

test('悬浮字幕保留全部句子并转义文本，两种入口都有时长与点击恢复文案', (context) => {
  context.mock.method(Date, 'now', () => 126000)
  const assistantText = Array.from({ length: 20 }, (_, index) => `完整第${index + 1}句。`).join('\n') + '<script>测试</script>'
  const info = { ...call, startedAt: 1000, assistantText }
  const markup = renderToStaticMarkup(createElement(FloatingCallCaption, { call: info, t, ...floatingCallCaptionLayout(0, 0, 76, 84, 390, 844), onOpen() {} }))
  for (let i = 1; i <= 20; i++) assert.ok(markup.includes(`完整第${i}句。`))
  assert.ok(markup.includes('overflow-y:auto')); assert.ok(markup.includes('tabindex="0"')); assert.ok(markup.includes('&lt;script&gt;'))
  assert.ok(!markup.includes('<script>')); assert.ok(markup.includes('aria-label="恢复实时对话"'))
  const services = { locale: { bind: () => t, subscribe: () => () => {}, getSnapshot: () => ({ revision: 1 }) } } as unknown as CodingNsClientServices
  for (const component of [createElement(FloatingVoiceCall, { services, call: info, onOpen() {} }),
    createElement(FloatingAssistantAvatar, { services, model: BUILTIN_ASSISTANT_AVATAR, state: 'speaking', size: 192, call: info, onOpen() {} })]) {
    const html = renderToStaticMarkup(component)
    assert.equal((html.match(/data-codingns-floating-call-caption/g) ?? []).length, 1)
    assert.ok(html.includes('data-codingns-floating-call-status="speaking"')); assert.ok(html.includes('02:05'))
  }
  const full = renderToStaticMarkup(createElement(AssistantRealtimeCallView, { name: '小鱼', t, pending: false, duration: '02:05', microphoneMuted: false, speakerMuted: false,
    userText: '', assistantText: '', avatar: null, onMicrophone() {}, onSpeaker() {}, onHangup() {}, onMinimize() {} }))
  assert.ok(full.includes('aria-label="收起通话"')); assert.equal((full.match(/<button/g) ?? []).length, 4)
})

test('发声提示依据播放状态，文字已出现、思考、麦克风静音和关闭声音都正确区分', () => {
  assert.equal(floatingCallStatus(call), 'speaking')
  assert.equal(floatingCallStatus({ ...call, microphoneMuted: true }), 'speaking')
  assert.equal(floatingCallStatus({ ...call, speakerMuted: true }), 'silent')
  for (const [state, expected] of [['thinking', 'thinking'], ['listening', 'listening'], ['error', 'error']]) assert.equal(floatingCallStatus({ ...call, state }), expected)
  assert.equal(floatingCallStatus({ ...call, state: 'listening', microphoneMuted: true }), 'muted')
  assert.equal(floatingCallStatus({ ...call, pending: true }), 'connecting')
  const muted = renderToStaticMarkup(createElement(FloatingCallBadge, { call: { ...call, speakerMuted: true }, t }))
  assert.ok(muted.includes('data-speaking="false"')); assert.ok(muted.includes('声音已关闭'))
})

test('四角与窄屏字幕气泡保持屏幕边距，缩小视口和横屏不裁掉恢复入口', () => {
  for (const [vw, vh] of [[390, 844], [320, 568], [844, 390], [1280, 720]]) for (const [width, height] of [[76, 84], [192, 208], [320, 347]]) {
    for (const [x, y] of [[0, 0], [vw - width, 0], [0, vh - height], [vw - width, vh - height], [(vw - width) / 2, (vh - height) / 2]]) {
      const { style } = floatingCallCaptionLayout(x, y, width, height, vw, vh)
      const left = x + Number(style.left); const captionWidth = Number(style.width); const maxHeight = Number(style.maxHeight)
      const top = style.top === undefined ? y + height - Number(style.bottom) - maxHeight : y + Number(style.top)
      assert.ok(left >= 12 && left + captionWidth <= vw - 12)
      assert.ok(top >= 12 && top + maxHeight <= vh - 12, JSON.stringify({ vw, vh, width, height, x, y, style }))
    }
  }
})
