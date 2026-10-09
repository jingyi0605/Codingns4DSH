import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import { Script, runInNewContext } from 'node:vm'
import { createElement, isValidElement } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readDesktopAssistantPresentation, readDesktopAssistantNoticeFeedback, readDesktopAssistantNotificationSnapshot, readDesktopAssistantLayout, desktopAssistantLayout, desktopAssistantNotificationHeight } from '../src/shared/desktop-assistant.js'
import type { DesktopAssistantFrame, DesktopAssistantNoticeEvent, DesktopAssistantNotification, DesktopAssistantPresentation } from '../src/shared/desktop-assistant.js'
import { BUILTIN_ASSISTANT_AVATAR } from '../src/shared/assistant-avatar.js'
import { DesktopAssistantController } from '../src/host/desktop-assistant/controller.js'
import { bindDesktopAssistantNotifications, confirmDesktopAssistantNotification, desktopAssistantNotificationPresentation, getDesktopAssistantNotifications } from '../src/host/desktop-assistant/notifications.js'
import { AssistantNotificationCenter } from '../src/host/features/assistant-notifications.js'
import { createGlobalVoiceRpcFeature } from '../src/host/features/global-voice-rpc.js'
import { FeatureRegistry } from '../src/features/index.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { memoryAssistantConversationStorage } from './assistant-fixtures.js'
import { connectDesktopAssistant } from '../src/client/avatar/desktop-bridge.js'
import { DesktopAssistantAvatar, sendDesktopAssistantNotice, sendDesktopAssistantNoticePage } from '../src/client/avatar/desktop-view.js'
import { AssistantNotificationBubble } from '../src/client/avatar/notification-bubble.js'
import { buildMacAssistantScript, buildMacDesktopFocusScript } from '../src/host/desktop-assistant/mac-agent.js'
import { buildWinAssistantScript } from '../src/host/desktop-assistant/win-agent.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import type { AssistantNotificationSnapshot } from '../src/shared/assistant-notifications.js'

const owner = 'companion:notification-owner'
const notification: DesktopAssistantNotification = { noticeId: 'notice-safe', generation: 7, kind: 'question', availability: 'ready', hostLabel: '本机', workspaceLabel: '项目', sessionTitle: '会话', text: '需要你回答' }
const presentation = { visible: true, state: 'speaking' as const, label: '打开助理', caption: '通话字幕', notification, reaction: 'question' as const }
const frame: DesktopAssistantFrame = { ...presentation, model: BUILTIN_ASSISTANT_AVATAR, size: 144 }
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await delay(2) }
  assert.fail('等待条件未满足')
}
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
}
function fixture(project?: (value: DesktopAssistantPresentation) => DesktopAssistantFrame, confirm?: (event: DesktopAssistantNoticeEvent) => void, page?: (cursor?: string) => void) {
  let events: (value: Record<string, unknown>) => void = () => {}
  let readFrame: () => DesktopAssistantFrame | undefined = () => undefined
  const commands: Record<string, unknown>[] = [], confirmations: DesktopAssistantNoticeEvent[] = []
  const controller = new DesktopAssistantController({ supported: true, readFrame: (value) => project ? project(value) : ({ ...frame, ...value }),
    openPage: async (read) => { readFrame = read; return { url: 'http://127.0.0.1/?token=test', close: async () => {} } },
    launch: async (onEvent) => { events = onEvent; return { send: (value) => commands.push(value), stop: async () => {} } },
    onNoticePresented: (value) => { confirm?.(value); confirmations.push(value) }, onNoticePage: page, deadlineMs: 1000 })
  const event = (type: string, action?: string, patch: Record<string, unknown> = {}): void => {
    const current = readFrame()!
    events({ ev: type, ...current.identity, noticeId: current.notification?.noticeId, noticeGeneration: current.notification?.generation, action, ...patch })
  }
  return { controller, commands, confirmations, readFrame: () => readFrame(), event, native: (value: Record<string, unknown>) => events(value) }
}
async function started(f: ReturnType<typeof fixture>): Promise<void> {
  f.controller.attach(owner)
  const start = f.controller.update(owner, 1, presentation)
  await until(() => f.commands.some((value) => value.cmd === 'load'))
  f.native({ ev: 'loaded' }); await start
}

test('2.3 通知 DTO 只复制安全文本；非法可选字段保持旧形象和字幕', () => {
  const actual = readDesktopAssistantPresentation({ ...presentation, notification: { ...notification, target: { sessionId: 'secret' }, token: 'secret' } })
  assert.deepEqual(actual.notification, notification)
  assert.ok(!JSON.stringify(actual).includes('secret'))
  for (const value of [null, { ...notification, generation: -1 }, { ...notification, noticeId: '' }, { ...notification, text: 'x'.repeat(241) }, { ...notification, kind: 'run' }]) {
    const parsed = readDesktopAssistantPresentation({ ...presentation, notification: value, reaction: 'unknown' })
    assert.equal(parsed.notification, undefined); assert.equal(parsed.reaction, undefined)
    assert.equal(parsed.caption, presentation.caption); assert.equal(parsed.state, 'speaking')
  }
})

test('2.3 主页面失败反馈只保留有界安全文本及事件身份，拒绝无效反馈载荷', () => {
  const feedback = { generation: 3, sequence: 8, noticeId: notification.noticeId, noticeGeneration: notification.generation, message: '目标已失效' }
  assert.deepEqual(readDesktopAssistantNoticeFeedback({ ...feedback, target: 'secret', token: 'secret' }), feedback)
  assert.equal(readDesktopAssistantNoticeFeedback({ ...feedback, message: '一\n二' }).message, '一 二')
  for (const value of [null, [], { ...feedback, sequence: -1 }, { ...feedback, generation: '3' },
    { ...feedback, noticeId: '' }, { ...feedback, message: '' }, { ...feedback, message: 'x'.repeat(241) }]) {
    assert.throws(() => readDesktopAssistantNoticeFeedback(value), /通知反馈无效/u)
  }
})

test('2.3 原生共享安全快照白名单往返；主气泡收起后未读和待处理列表仍保留', () => {
  const { generation, ...notice } = notification
  const snapshot: AssistantNotificationSnapshot = { generation, revision: 8, serverNow: 100, primary: null,
    items: [{ ...notice, createdAt: 100, read: false, presentation: 'collapsed', lifecycle: 'active' }],
    unreadCount: 1, pendingCount: 1, cursor: 'page-two', capabilities: [{ hostId: 'remote', completed: false, error: false,
      requests: false, resolve: false, navigation: true, recovery: false, reason: '远端版本缺少事件能力' }] }
  const unsafe = { ...snapshot, token: 'secret', items: snapshot.items.map((item) => ({ ...item, token: 'secret', target: { sessionId: 'secret' } })),
    capabilities: snapshot.capabilities.map((item) => ({ ...item, endpoint: 'secret' })) }
  assert.deepEqual(readDesktopAssistantNotificationSnapshot(unsafe), snapshot)
  assert.deepEqual(readDesktopAssistantPresentation({ ...presentation, notification: undefined, notificationSnapshot: unsafe }).notificationSnapshot, snapshot)
  for (const patch of [{ generation: -1 }, { items: Array(51).fill(snapshot.items[0]) }, { primary: {} }, { cursor: 'x'.repeat(2049) },
    { items: [{ ...snapshot.items[0], read: 'false' }] }, { capabilities: [{ ...snapshot.capabilities[0], navigation: undefined }] }]) {
    const parsed = readDesktopAssistantPresentation({ ...presentation, notificationSnapshot: { ...snapshot, ...patch } })
    assert.equal(parsed.notificationSnapshot, undefined); assert.equal(parsed.caption, presentation.caption)
  }
  const html = renderToStaticMarkup(createElement(DesktopAssistantAvatar, { frame: { ...frame, notification: undefined, notificationSnapshot: snapshot } }))
  assert.ok(html.includes('data-codingns-native-notice')); assert.ok(html.includes('查看会话')); assert.ok(html.includes('远端版本缺少事件能力'))
})

test('2.3 原生分页通过 Host 读取有界缓存；列表点击按实际ID回传，旧页和错误身份无效', async () => {
  const { generation, ...notice } = notification
  const first = { ...notice, noticeId: 'notice-first', createdAt: 100, read: false, presentation: 'collapsed' as const, lifecycle: 'active' as const }
  const second = { ...first, noticeId: 'notice-second', connectionGeneration: 9 }
  let connectionGeneration = 9
  const services = {} as CodingNsHostServices, pages: Array<string | undefined> = []
  let cursor: string | undefined
  const cleanup = bindDesktopAssistantNotifications(services, { read: (input) => ({ generation, revision: 8, serverNow: 100, primary: null,
    items: input?.cursor === 'page-two' ? [{ ...second, connectionGeneration }] : [first], unreadCount: 2, pendingCount: 2, cursor: input?.cursor === 'page-two' ? null : 'page-two', capabilities: [] }), presented() {} })
  const f = fixture((value) => ({ ...frame, notification: undefined, ...desktopAssistantNotificationPresentation(services, value, { ...(cursor === undefined ? {} : { cursor }), limit: 20 }) }), undefined,
    (value) => { pages.push(value); cursor = value })
  await started(f); f.native({ ev: 'shown' })
  try {
    const previous = f.readFrame()!
    assert.equal(previous.notification, undefined)
    assert.equal(f.commands.at(-1)?.notification, true, '没有主气泡时仍保留原生未读入口的几何空间')
    f.native({ ev: 'notice-page', ...previous.identity, cursor: 'page-two', ownerId: 'old' })
    f.native({ ev: 'notice-page', ...previous.identity, cursor: 'x'.repeat(2049) })
    assert.equal(pages.length, 0)
    f.native({ ev: 'notice-page', ...previous.identity, cursor: 'page-two' })
    await until(() => f.readFrame()?.notificationSnapshot?.items[0]?.noticeId === second.noticeId)
    assert.deepEqual(pages, ['page-two']); assert.equal(f.controller.status(owner).noticeEvents?.length, 0)
    f.native({ ev: 'notice-action', ...previous.identity, noticeId: first.noticeId, noticeGeneration: generation, action: 'open' })
    f.event('notice-action', 'open', { noticeId: 'unknown', noticeGeneration: generation })
    assert.equal(f.controller.status(owner).noticeEvents?.length, 0)
    f.event('notice-action', 'open', { noticeId: second.noticeId, noticeGeneration: generation, connectionGeneration: 9 })
    assert.equal(f.controller.status(owner).noticeEvents?.[0]?.noticeId, second.noticeId)
    assert.equal(f.controller.status(owner).noticeEvents?.[0]?.connectionGeneration, 9)
    assert.equal(f.controller.status(owner).openSequence, 0)
    const beforeReconnect = f.readFrame()!
    connectionGeneration = 10; await f.controller.refresh()
    f.native({ ev: 'notice-action', ...beforeReconnect.identity, noticeId: second.noticeId, noticeGeneration: generation, connectionGeneration: 9, action: 'open' })
    assert.equal(f.controller.status(owner).noticeEvents?.length, 1, '旧连接伴随页消息不能操作重连后的通知')
    assert.equal(f.controller.status(owner).noticeEvents?.[0]?.connectionGeneration, 9, '已排队动作保留点击时连接代次供主页面再次验证')
    f.native({ ev: 'notice-page', ...f.readFrame()!.identity, cursor: null })
    await until(() => f.readFrame()?.notificationSnapshot?.items[0]?.noticeId === first.noticeId)
    assert.deepEqual(pages, ['page-two', undefined], 'Windows 空游标兼容返回首页')
  } finally { await f.controller.dispose(); cleanup() }
})

test('2.3 原生共用气泡的分页和列表动作只回传安全身份，不持有DSH认证或任意目标', (context) => {
  const { generation, ...notice } = notification, events: Record<string, unknown>[] = []
  const snapshot: AssistantNotificationSnapshot = { generation, revision: 8, serverNow: 100, primary: null, items: [{ ...notice,
    createdAt: 100, read: false, presentation: 'collapsed', lifecycle: 'active' }], unreadCount: 1, pendingCount: 1, cursor: 'page-two', capabilities: [] }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'webkit')
  Object.defineProperty(globalThis, 'webkit', { configurable: true, value: { messageHandlers: { assistant: { postMessage: (value: string) => events.push(JSON.parse(value)) } } } })
  const current = { ...frame, notification: undefined, notificationSnapshot: snapshot, nativeVisible: true, identity: { ownerId: owner, generation: 3, sequence: 5 } }
  const renderer = createHookRenderer(DesktopAssistantAvatar, { frame: current })
  context.after(() => { renderer.dispose(); if (previous) Object.defineProperty(globalThis, 'webkit', previous); else Reflect.deleteProperty(globalThis, 'webkit') })
  const bubble = elements(renderer.render()).find((item) => item.type === AssistantNotificationBubble)!
  assert.deepEqual(bubble.props.frame, snapshot)
  bubble.props.onOpen(notice.noticeId, generation); bubble.props.onDismiss(notice.noticeId, generation); bubble.props.onPage('page-two')
  assert.deepEqual(events.filter((item) => item.type === 'notice-action').map((item) => item.action), ['open', 'dismiss'])
  assert.deepEqual(events.find((item) => item.type === 'notice-page'), { type: 'notice-page', ...current.identity, cursor: 'page-two' })
  assert.ok(events.every((item) => !('target' in item) && !('token' in item)))
  const oldPage = bubble.props.onPage
  renderer.render({ frame: { ...current, identity: { ...current.identity, sequence: 6 } } })
  oldPage('page-two'); sendDesktopAssistantNoticePage(current, 'x'.repeat(2049))
  assert.equal(events.filter((item) => item.type === 'notice-page').length, 1, '旧组件不能为新版本翻页')
})

test('单条未读直接保留完整卡片区域，列表展开不改变形象屏幕锚点', async () => {
  const { generation, ...notice } = notification
  const snapshot: AssistantNotificationSnapshot = { generation, revision: 8, serverNow: 100, primary: null,
    items: [{ ...notice, createdAt: 100, read: false, presentation: 'collapsed', lifecycle: 'active' }], unreadCount: 1, pendingCount: 1, cursor: null, capabilities: [] }
  const current = { ...frame, notification: undefined, notificationSnapshot: snapshot, caption: '' }
  const f = fixture(value => ({ ...current, visible: value.visible }))
  await started(f); f.native({ ev: 'shown' })
  try {
    const compact = f.commands.at(-1)!
    assert.equal(compact.notificationHeight, 276)
    f.native({ ev: 'notice-expansion', ...f.readFrame()!.identity, expanded: true })
    await until(() => f.commands.at(-1)?.notificationHeight === 276)
    const expanded = f.commands.at(-1)!
    assert.equal(Number(expanded.height), Number(compact.height))
    f.native({ ev: 'notice-expansion', ...f.readFrame()!.identity, ownerId: 'old', expanded: false })
    assert.equal(f.commands.at(-1)!.notificationHeight, 276)
    f.native({ ev: 'notice-expansion', ...f.readFrame()!.identity, expanded: false })
    await until(() => f.commands.at(-1)?.notificationHeight === 276)
    const areas = [{ x: -1024, y: 0, width: 1024, height: 768 }], anchor = { x: -350, y: 400 }
    const a = desktopAssistantLayout(anchor, 144, 276, false, areas), b = desktopAssistantLayout(anchor, 144, 276, false, areas)
    assert.deepEqual({ x: a.bounds.x + a.avatar.x, y: a.bounds.y + a.avatar.y }, anchor)
    assert.deepEqual({ x: b.bounds.x + b.avatar.x, y: b.bounds.y + b.avatar.y }, anchor)
    assert.equal(a.notification!.height, 276)
    assert.equal(a.bounds.height, b.bounds.height)
    assert.equal(desktopAssistantNotificationHeight({ ...current, notificationSnapshot: { ...snapshot, unreadCount: 0, pendingCount: 0,
      capabilities: [{ hostId: 'local', completed: true, error: true, requests: true, resolve: true, navigation: true, recovery: false, reason: '启动恢复有限' }] } }), 0)
  } finally { await f.controller.dispose() }
})

test('原生管道保留所见连接与类型，当前呈现序列也不能替旧连接点击改写身份', async (context) => {
  const current = { ...frame, notification: { ...notification, connectionGeneration: 9 } }
  const f = fixture(value => ({ ...current, ...value, notification: current.notification }))
  await started(f); f.native({ ev: 'shown' })
  try {
    for (const patch of [{ connectionGeneration: 8 }, { connectionGeneration: -1 }, { connectionGeneration: 9, noticeKind: 'completed' }]) f.event('notice-action', 'open', patch)
    assert.equal(f.controller.status(owner).noticeEvents!.length, 0)
    const emitted: Record<string, unknown>[] = []
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'webkit')
    Object.defineProperty(globalThis, 'webkit', { configurable: true, value: { messageHandlers: { assistant: { postMessage: (value: string) => emitted.push(JSON.parse(value)) } } } })
    context.after(() => { if (previous) Object.defineProperty(globalThis, 'webkit', previous); else Reflect.deleteProperty(globalThis, 'webkit') })
    sendDesktopAssistantNotice(f.readFrame()!, 'notice-action', 'open')
    assert.equal(emitted[0]!.connectionGeneration, 9)
    assert.equal(emitted[0]!.noticeKind, 'question')
    f.native({ ...emitted[0], ev: emitted[0]!.type })
    assert.equal(f.controller.status(owner).noticeEvents![0]!.connectionGeneration, 9)
  } finally { await f.controller.dispose() }
})

test('2.3 presented 必须在窗口真实 shown 后确认；展示幂等，身份与通知代次逐项验证', async () => {
  const f = fixture(); await started(f)
  try {
    f.event('notice-presented'); assert.equal(f.confirmations.length, 0)
    f.native({ ev: 'shown' })
    for (const patch of [{ ownerId: 'companion:old-owner' }, { generation: -1 }, { sequence: 999 }, { noticeId: 'old' }, { noticeGeneration: 6 }]) f.event('notice-presented', undefined, patch)
    assert.equal(f.confirmations.length, 0)
    f.event('notice-presented'); f.event('notice-presented')
    assert.equal(f.confirmations.length, 1)
    const status = f.controller.status(owner)
    assert.equal(status.noticeEvents?.length, 1)
    await f.controller.update(owner, 2, presentation, { generation: status.generation!, sequence: status.noticeEvents![0]!.sequence })
    f.event('notice-presented'); assert.equal(f.controller.status(owner).noticeEvents?.length, 0)
  } finally { await f.controller.dispose() }
})

test('2.3 两次通知点击有序且不增加 openSequence；dismiss 不恢复焦点', async () => {
  const f = fixture(); await started(f); f.native({ ev: 'shown' })
  try {
    f.event('notice-action', 'open'); f.event('notice-action', 'dismiss'); f.event('notice-action', 'open')
    assert.deepEqual(f.controller.status(owner).noticeEvents?.map((value) => value.action), ['open', 'dismiss', 'open'])
    assert.equal(f.controller.status(owner).openSequence, 0)
    assert.equal(f.commands.filter((value) => value.cmd === 'notice-open').length, 2)
    f.native({ ev: 'open' }); assert.equal(f.controller.status(owner).openSequence, 1)
  } finally { await f.controller.dispose() }
})

test('2.3 Host 同ID完成升级错误会更新呈现版本；旧回调无效，新错误真实渲染后重新确认', async () => {
  let current: DesktopAssistantNotification = { ...notification, kind: 'completed', text: '已经完成' }
  const f = fixture((value) => ({ ...frame, ...value, notification: current }))
  await started(f); f.native({ ev: 'shown' })
  try {
    f.event('notice-presented')
    const previous = f.readFrame()!
    assert.equal(f.confirmations.length, 1)
    current = { ...current, kind: 'error', text: '执行失败' }
    // 主页面没有发来 update；仅 Host 中心更新也必须生成新的呈现版本。
    await f.controller.refresh()
    assert.ok(f.readFrame()!.identity!.sequence > previous.identity!.sequence)
    assert.equal(f.controller.status(owner).noticeEvents?.length, 0, '未消费的旧首展确认不能确认新错误')
    f.native({ ev: 'notice-presented', ...previous.identity, noticeId: current.noticeId, noticeGeneration: current.generation })
    f.native({ ev: 'notice-action', ...previous.identity, noticeId: current.noticeId, noticeGeneration: current.generation, action: 'open' })
    assert.equal(f.confirmations.length, 1)
    assert.equal(f.commands.filter((value) => value.cmd === 'notice-open').length, 0)
    f.event('notice-presented'); f.event('notice-presented')
    assert.equal(f.confirmations.length, 2)
    assert.equal(f.confirmations[1]!.noticeKind, 'error')
    assert.equal(f.controller.status(owner).noticeEvents?.length, 1)
    const version = f.readFrame()!.identity!.sequence
    await f.controller.update(owner, 2, presentation)
    assert.equal(f.readFrame()!.identity!.sequence, version, '主页面旧通知不能覆盖最终Host快照')
    f.event('notice-presented'); assert.equal(f.confirmations.length, 2)
  } finally { await f.controller.dispose() }
})

test('2.3 Host 中心首展确认失败明确回传且可重试，失败不写入已呈现去重标记', async () => {
  let blocked = true
  const f = fixture(undefined, () => { if (blocked) throw new Error('中心换代') })
  await started(f); f.native({ ev: 'shown' })
  try {
    f.event('notice-presented')
    assert.equal(f.confirmations.length, 0)
    assert.equal(f.controller.status(owner).noticeEvents?.length, 0)
    assert.ok(f.commands.some((value) => value.cmd === 'notice-result' && value.accepted === false))
    assert.match(f.controller.status(owner).noticeError!, /呈现确认失败/u)
    blocked = false; f.event('notice-presented')
    assert.equal(f.confirmations.length, 1)
    assert.equal(f.controller.status(owner).noticeEvents?.length, 1)
    assert.equal(f.controller.status(owner).noticeError, undefined)
  } finally { await f.controller.dispose() }
})

test('2.3 队列32条满时明确拒绝、不恢复焦点；旧 ack 不移除更新动作，清空后可重试', async () => {
  const f = fixture(); await started(f); f.native({ ev: 'shown' })
  try {
    for (let index = 0; index < 32; index++) f.event('notice-action', 'dismiss')
    const full = f.controller.status(owner)
    f.event('notice-action', 'open')
    assert.equal(f.controller.status(owner).noticeEvents?.length, 32)
    assert.match(f.controller.status(owner).noticeError!, /队列已满/u)
    assert.equal(f.commands.filter((value) => value.cmd === 'notice-open').length, 0)
    await f.controller.update(owner, 2, presentation, { generation: full.generation! - 1, sequence: 32 })
    assert.equal(f.controller.status(owner).noticeEvents?.length, 32)
    await f.controller.update(owner, 3, presentation, { generation: full.generation!, sequence: 31 })
    assert.equal(f.controller.status(owner).noticeEvents?.length, 1)
    f.event('notice-action', 'open')
    assert.equal(f.controller.status(owner).noticeEvents?.length, 2)
    await f.controller.update(owner, 4, presentation, { generation: full.generation!, sequence: 31 })
    assert.deepEqual(f.controller.status(owner).noticeEvents?.map((value) => value.sequence), [32, 33])
    assert.equal(f.commands.filter((value) => value.cmd === 'notice-open').length, 1)
  } finally { await f.controller.dispose() }
})

test('2.3 owner 切换、通知替换与关闭后旧消息不可操作，不能误开助理', async () => {
  const f = fixture(); await started(f); f.native({ ev: 'shown' })
  const oldFrame = f.readFrame()!
  try {
    await f.controller.update(owner, 2, { ...presentation, notification: { ...notification, noticeId: 'new' } })
    f.native({ ev: 'notice-action', ...oldFrame.identity, noticeId: notification.noticeId, noticeGeneration: notification.generation, action: 'open' })
    assert.equal(f.controller.status(owner).noticeEvents?.length, 0)
    f.controller.attach('companion:next-owner'); f.event('notice-action', 'open', { ownerId: owner })
    assert.equal(f.commands.filter((value) => value.cmd === 'notice-open').length, 0)
    await f.controller.detach('companion:next-owner'); f.event('notice-action', 'open')
    assert.equal(f.controller.status(owner).openSequence, 0)
  } finally { await f.controller.dispose() }
})

test('2.3 主页面串行处理并在成功后 ack，重复 status 不重做；错误身份不消费', async () => {
  const handled: number[] = [], acks: unknown[] = []
  let updates = 0, processing = 0, maxProcessing = 0
  const events: DesktopAssistantNoticeEvent[] = [1, 2, 3].map((sequence) => ({ sequence, ownerId: owner, generation: 8, noticeId: notification.noticeId,
    noticeGeneration: 7, type: sequence === 1 ? 'notice-presented' : 'notice-action', ...(sequence === 1 ? {} : { action: 'dismiss' as const }) }))
  const handle = async (event: DesktopAssistantNoticeEvent): Promise<void> => { processing++; maxProcessing = Math.max(maxProcessing, processing); await delay(2); handled.push(event.sequence); processing-- }
  const bridge = connectDesktopAssistant({ call: async (_channel, method, payload) => {
    if (method === 'update') { updates++; acks.push((payload as any).noticeAck) }
    return { ok: true, value: { available: true, visible: true, owned: true, openSequence: 0, generation: 8,
      noticeEvents: [...events, { ...events[0], sequence: 4, ownerId: 'old' }] } }
  } }, owner, () => {}, () => assert.fail('通知不能调用打开助理'), 3, { onNoticePresented: handle, onNoticeAction: handle })
  try {
    bridge.update(presentation); await until(() => updates >= 3)
    assert.deepEqual(handled, [1, 2, 3]); assert.equal(maxProcessing, 1)
    assert.deepEqual(acks.find((value) => (value as any)?.sequence === 3), { generation: 8, sequence: 3 })
  } finally { bridge.dispose() }
})

test('2.3 原生安全组件与字幕独立、文本转义；动作仅携带身份，不含凭证', (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'webkit')
  const events: Record<string, unknown>[] = []
  Object.defineProperty(globalThis, 'webkit', { configurable: true, value: { messageHandlers: { assistant: { postMessage: (value: string) => events.push(JSON.parse(value)) } } } })
  const visible = { ...frame, nativeVisible: true, identity: { ownerId: owner, generation: 1, sequence: 3 } }
  const renderer = createHookRenderer(DesktopAssistantAvatar, { frame: visible })
  context.after(() => { renderer.dispose(); if (previous) Object.defineProperty(globalThis, 'webkit', previous); else Reflect.deleteProperty(globalThis, 'webkit') })
  const tree = renderer.render()
  const bubble = elements(tree).find((item) => item.type === AssistantNotificationBubble)!
  assert.deepEqual(bubble.props.frame, notification)
  bubble.props.onOpen(notification.noticeId, notification.generation); bubble.props.onDismiss(notification.noticeId, notification.generation); bubble.props.onPresented(notification.noticeId, notification.generation)
  assert.deepEqual(events.filter((value) => value.type === 'notice-action').map((value) => value.action), ['open', 'dismiss'])
  assert.equal(events.filter((value) => value.type === 'open').length, 0)
  assert.ok(events.every((value) => !('target' in value) && !('token' in value)))
  const oldOpen = bubble.props.onOpen
  renderer.render({ frame: { ...visible, notification: { ...notification, noticeId: 'new-notice' } } })
  oldOpen(notification.noticeId, notification.generation)
  assert.equal(events.filter((value) => value.type === 'notice-action').length, 2, '旧DOM不能打开新通知')
  const sameId = renderer.render({ frame: visible })
  const beforeUpgrade = elements(sameId).find((item) => item.type === AssistantNotificationBubble)!
  const upgraded = renderer.render({ frame: { ...visible, notification: { ...notification, kind: 'error' }, identity: { ...visible.identity, sequence: 4 } } })
  const afterUpgrade = elements(upgraded).find((item) => item.type === AssistantNotificationBubble)!
  assert.notEqual(beforeUpgrade.props.onPresented, afterUpgrade.props.onPresented, '同ID升级会重新触发共用气泡的可见DOM确认')
  beforeUpgrade.props.onOpen(notification.noticeId, notification.generation)
  beforeUpgrade.props.onPresented(notification.noticeId, notification.generation)
  assert.equal(events.filter((value) => value.type === 'notice-action').length, 2, '同ID升级后的旧DOM不能操作新版本')
  sendDesktopAssistantNotice({ ...visible, nativeVisible: false }, 'notice-presented')
  assert.equal(events.filter((value) => value.type === 'notice-presented').length, 1)
  const html = renderToStaticMarkup(createElement(DesktopAssistantAvatar, { frame: { ...visible, caption: '<script>字幕</script>', notification: { ...notification, text: '<img src=x onerror=run>' } } }))
  assert.ok(html.includes('data-codingns-native-notice')); assert.ok(html.includes('data-codingns-native-caption'))
  assert.ok(html.includes('&lt;img')); assert.ok(html.includes('&lt;script&gt;'))
})

test('2.3 导航失败不触发原生错误回退，也不阻塞后续收起动作', async () => {
  const statuses: Array<{ available: boolean; error?: string; noticeError?: string }> = []
  let attaches = 0, updates = 0, dismisses = 0, opens = 0
  const feedback: unknown[] = []
  const events: DesktopAssistantNoticeEvent[] = ['open', 'dismiss'].map((action, index) => ({ sequence: index + 1, ownerId: owner,
    generation: 8, noticeId: notification.noticeId, noticeGeneration: 7, type: 'notice-action', action: action as 'open' | 'dismiss' }))
  const bridge = connectDesktopAssistant({ call: async (_channel, method, payload) => {
    if (method === 'attach') attaches++
    if (method === 'update') updates++
    if (method === 'update' && (payload as any).noticeFeedback) feedback.push((payload as any).noticeFeedback)
    return { ok: true, value: { available: true, owned: true, visible: true, openSequence: 0, generation: 8, noticeEvents: events } }
  } }, owner, (status) => statuses.push(status), () => assert.fail('不能误开助理'), 3, { onNoticeAction: async (event) => {
    if (event.action === 'open') { opens++; throw new Error('目标已失效') }
    dismisses++
  } })
  try {
    bridge.update(presentation); await until(() => updates >= 4)
    assert.equal(opens, 1); assert.equal(dismisses, 1); assert.equal(attaches, 1)
    assert.ok(statuses.every((status) => status.available && !status.error))
    assert.ok(statuses.some((status) => status.noticeError === '目标已失效'))
    assert.deepEqual(feedback, [{ generation: 8, sequence: 1, noticeId: notification.noticeId, noticeGeneration: notification.generation, message: '目标已失效' }])
  } finally { bridge.dispose() }
})

test('2.3 主页面导航失败反馈经原队列核对，Host中心快照更新不能覆盖错误，旧反馈不污染新通知', async () => {
  const services = {} as CodingNsHostServices
  const snapshot: AssistantNotificationSnapshot = { generation: notification.generation, revision: 1, serverNow: 100,
    primary: { ...notification, createdAt: 100, read: false, presentation: 'queued', lifecycle: 'active' },
    items: [], unreadCount: 1, pendingCount: 1, cursor: null, capabilities: [] }
  const cleanup = bindDesktopAssistantNotifications(services, { read: () => snapshot, presented() {} })
  const f = fixture((value) => ({ ...frame, ...desktopAssistantNotificationPresentation(services, value) }))
  await started(f); f.native({ ev: 'shown' })
  try {
    f.event('notice-action', 'open')
    const status = f.controller.status(owner), event = status.noticeEvents![0]!
    const feedback = { generation: status.generation!, sequence: event.sequence, noticeId: notification.noticeId,
      noticeGeneration: notification.generation, message: '<script>目标已失效</script>' }
    await f.controller.update(owner, 2, presentation, undefined, { ...feedback, generation: status.generation! - 1 })
    assert.equal(f.readFrame()!.noticeError, undefined)
    await f.controller.update(owner, 3, presentation, undefined, { ...feedback, sequence: 999 })
    assert.equal(f.readFrame()!.noticeError, undefined)
    const identity = f.readFrame()!.identity
    await f.controller.update(owner, 4, presentation, { generation: status.generation!, sequence: event.sequence }, feedback)
    assert.equal(f.controller.status(owner).noticeEvents?.length, 0)
    assert.equal(f.readFrame()!.noticeError, feedback.message)
    assert.deepEqual(f.readFrame()!.identity, identity, '错误提示不会让模型或呈现版本换代')
    await f.controller.refresh()
    assert.equal(f.readFrame()!.noticeError, feedback.message, 'Host中心独立刷新保留当前动作失败信息')
    const html = renderToStaticMarkup(createElement(DesktopAssistantAvatar, { frame: f.readFrame()! }))
    assert.ok(html.includes('&lt;script&gt;目标已失效&lt;/script&gt;'))
    f.event('notice-action', 'dismiss')
    assert.equal(f.readFrame()!.noticeError, undefined, '新的用户动作清除上一操作错误')
    await f.controller.update(owner, 5, presentation, undefined, feedback)
    assert.equal(f.readFrame()!.noticeError, undefined, '已消费事件的旧反馈不能再次注入')
  } finally { await f.controller.dispose(); cleanup() }
})

test('2.3 通知处理期间卸载后，迟到失败不更新页面状态，也不继续消费动作', async () => {
  let reject: (error: Error) => void = () => {}
  let handling = false, statuses = 0, detaches = 0, acks = 0
  const event: DesktopAssistantNoticeEvent = { sequence: 1, ownerId: owner, generation: 8, noticeId: notification.noticeId,
    noticeGeneration: 7, type: 'notice-action', action: 'open' }
  const bridge = connectDesktopAssistant({ call: async (_channel, method, payload) => {
    if (method === 'detach') detaches++
    if (method === 'update' && (payload as any).noticeAck?.sequence > 0) acks++
    return { ok: true, value: { available: true, owned: true, visible: true, openSequence: 0, generation: 8, noticeEvents: [event] } }
  } }, owner, () => { statuses++ }, () => assert.fail('不能误开助理'), 3, { onNoticeAction: () => new Promise<void>((_resolve, rejectPromise) => {
    handling = true; reject = rejectPromise
  }) })
  await until(() => handling)
  const before = statuses
  bridge.dispose(); reject(new Error('迟到失败'))
  await until(() => detaches > 0)
  assert.equal(statuses, before); assert.equal(acks, 0)
})

test('2.4 四边缘、多屏负坐标、小屏和不同逻辑 DPI 保持锚点，收起恢复紧凑区', () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: -1280, y: 0, width: 1280, height: 720 }, { x: 0, y: 0, width: 360, height: 260 }]) {
    for (const position of [{ x: area.x + 8, y: area.y + 8 }, { x: area.x + area.width - 150, y: area.y + area.height - 160 }]) {
      const compact = desktopAssistantLayout(position, 144, false, false, [area])
      const expanded = desktopAssistantLayout(position, 144, true, true, [area])
      const captions = desktopAssistantLayout(position, 144, false, true, [area])
      assert.equal(compact.bounds.x + compact.avatar.x, expanded.bounds.x + expanded.avatar.x)
      assert.equal(compact.bounds.y + compact.avatar.y, expanded.bounds.y + expanded.avatar.y)
      assert.equal(compact.bounds.x + compact.avatar.x, captions.bounds.x + captions.avatar.x)
      assert.equal(compact.bounds.y + compact.avatar.y, captions.bounds.y + captions.avatar.y)
      assert.equal(compact.bounds.width, 144); assert.equal(compact.bounds.height, 156)
      assert.ok(expanded.bounds.x >= area.x && expanded.bounds.x + expanded.bounds.width <= area.x + area.width)
      assert.ok(expanded.bounds.y >= area.y && expanded.bounds.y + expanded.bounds.height <= area.y + area.height)
      assert.ok(expanded.notification!.width <= 320); assert.ok(expanded.notification!.height <= 276)
      assert.ok(expanded.caption!.height >= 40, '屏幕边缘字幕仍保留可读的一行和滚动区域')
      assert.ok(captions.caption!.height >= 40, '只有通话字幕时必须选空间充足的一侧，不依赖虚构的通知区')
      assert.deepEqual(readDesktopAssistantLayout(captions), captions)
      assert.deepEqual(readDesktopAssistantLayout(expanded), expanded)
      const notice = expanded.notification!, caption = expanded.caption!
      assert.ok(notice.y + notice.height <= caption.y || caption.y + caption.height <= notice.y, '同侧堆叠仍保留通知与字幕独立区域')
    }
  }
})

test('2.4 原生布局必需区域、有限坐标和窗口内边界严格校验，无效消息保留上一份布局', async () => {
  const valid = desktopAssistantLayout({ x: -1200, y: 280 }, 144, true, true, [{ x: -1280, y: 0, width: 1280, height: 720 }])
  assert.deepEqual(readDesktopAssistantLayout({ ...valid, token: 'secret', avatar: { ...valid.avatar, token: 'secret' } }), valid)
  const invalid = [null, [], {}, { bounds: valid.bounds }, { avatar: valid.avatar },
    { ...valid, bounds: { ...valid.bounds, width: 0 } }, { ...valid, bounds: { ...valid.bounds, height: 4097 } },
    { ...valid, bounds: { ...valid.bounds, x: Infinity } }, { ...valid, avatar: { ...valid.avatar, x: -1 } },
    { ...valid, avatar: { ...valid.avatar, x: valid.bounds.width } }, { ...valid, notification: null },
    { ...valid, caption: { ...valid.caption, height: valid.bounds.height + 1 } }]
  for (const value of invalid) assert.equal(readDesktopAssistantLayout(value), undefined)
  const f = fixture(); await started(f)
  try {
    f.native({ ev: 'layout', layout: valid })
    assert.deepEqual(f.readFrame()!.layout, valid)
    for (const value of invalid) f.native({ ev: 'layout', layout: value })
    assert.deepEqual(f.readFrame()!.layout, valid)
    assert.equal(f.controller.status(owner).error, undefined)
  } finally { await f.controller.dispose() }
})

test('2.3/2.4 平台脚本只响应经Host确认的notice-open恢复；布局、DPI与透明点击区可审查', async () => {
  const mac = buildMacAssistantScript(), windows = buildWinAssistantScript('C:\\sdk')
  assert.doesNotThrow(() => new Script(mac))
  assert.ok(mac.includes("if(m.cmd==='notice-open'){focusDesktop(true);return}"))
  assert.ok(mac.includes('setIgnoresMouseEvents(!inside)'))
  assert.ok(windows.includes('if (cmd == "notice-open") { FocusDesktop(); return; }'))
  assert.ok(windows.includes('TransformFromDevice')); assert.ok(windows.includes('AddHook(HitTest)'))
  assert.ok(windows.includes('message==0x02E0'))
  const bridgeMac = mac.slice(mac.indexOf("else if(msg.type==='notice-presented'"), mac.indexOf('var bridgeHandler'))
  assert.ok(!bridgeMac.includes('focusDesktop('), '未校验的原生消息只回传，不能先恢复主窗口')
  const entry = await readFile(new URL('../src/client/avatar/desktop-entry.ts', import.meta.url), 'utf8')
  assert.ok(entry.includes('key: JSON.stringify(frame.model)'))
  assert.ok(!entry.includes("method: 'POST'"))
  const calls: unknown[][] = [], emitted: unknown[] = []
  const nil = { isNil: () => true }, app = { isNil: () => false, terminated: false, bundleURL: { isNil: () => false } }
  const config = { setActivates() {}, setCreatesNewApplicationInstance() {}, setAllowsRunningApplicationSubstitution() {}, setPromptsUserIfNeeded() {} }
  const objc = Object.assign((value: unknown) => value, { NSRunningApplication: { runningApplicationWithProcessIdentifier: () => app }, NSWorkspaceOpenConfiguration: { configuration: config }, NSURL: { URLWithString: (value: string) => value },
    NSWorkspace: { sharedWorkspace: { openURLsWithApplicationAtURLConfigurationCompletionHandler: (...args: unknown[]) => calls.push(args) } } })
  const focus = runInNewContext(buildMacDesktopFocusScript() + '\nfocusDesktop', { $: objc, ObjC: { unwrap: (value: unknown) => value }, parentPid: 123, emit: (event: unknown) => emitted.push(event), safe: (fn: unknown) => fn }) as (notice?: boolean) => void
  focus(true); (calls[0]![3] as Function)(app, nil)
  assert.deepEqual(emitted, [], '通知恢复不能再发送旧 openSequence 事件')
})

test('2.3 Host通知中心独立展示快照可覆盖隐藏页面旧数据，注销不移除后续中心', () => {
  const services = {} as CodingNsHostServices
  const snapshot: AssistantNotificationSnapshot = { generation: 7, revision: 1, serverNow: 100, primary: { ...notification, createdAt: 100, read: false, presentation: 'queued', lifecycle: 'active' }, items: [], unreadCount: 1, pendingCount: 1, cursor: null, capabilities: [] }
  const first = bindDesktopAssistantNotifications(services, { read: () => snapshot, presented() {} })
  assert.equal(desktopAssistantNotificationPresentation(services, { ...presentation, caption: '保留字幕' }).caption, '保留字幕')
  assert.deepEqual(desktopAssistantNotificationPresentation(services, presentation).notification, notification)
  const second = bindDesktopAssistantNotifications(services, { read: () => ({ ...snapshot, primary: null }), presented() {} })
  first(); assert.equal(desktopAssistantNotificationPresentation(services, presentation).notification, undefined)
  second(); assert.equal(desktopAssistantNotificationPresentation(services, presentation).notification, notification)
})

test('2.3 原生首展回传与当前 Host 中心身份再次对齐，抢占/类型升级/换代均拒绝迟到确认', () => {
  const services = {} as CodingNsHostServices, confirmed: unknown[] = []
  const snapshot: AssistantNotificationSnapshot = { generation: 7, revision: 1, serverNow: 100, primary: { ...notification,
    connectionGeneration: 9, createdAt: 100, read: false, presentation: 'queued', lifecycle: 'active' }, items: [], unreadCount: 1, pendingCount: 1, cursor: null, capabilities: [] }
  const cleanup = bindDesktopAssistantNotifications(services, { read: () => snapshot, presented: (value) => confirmed.push(value) })
  const event: DesktopAssistantNoticeEvent = { ownerId: owner, generation: 3, sequence: 1, noticeId: notification.noticeId,
    noticeGeneration: notification.generation, noticeKind: notification.kind, connectionGeneration: 9, type: 'notice-presented' }
  try {
    for (const patch of [{ noticeId: 'old' }, { noticeGeneration: 6 }, { noticeKind: 'completed' as const }, { connectionGeneration: 8 }, { connectionGeneration: undefined }]) {
      assert.throws(() => confirmDesktopAssistantNotification(services, { ...event, ...patch }), /身份已失效/u)
    }
    assert.equal(confirmed.length, 0)
    confirmDesktopAssistantNotification(services, event)
    assert.deepEqual(confirmed, [{ noticeId: notification.noticeId, generation: notification.generation, action: 'presented', kind: notification.kind, connectionGeneration: 9 }])
  } finally { cleanup() }
})

test('2.3/2.4 真实中心在隐藏主页面期间首展计时、收起未读和独立分页，不依赖主页面 update', async () => {
  let now = 1000, cursor: string | undefined
  const services = {} as CodingNsHostServices, target = { hostId: 'local', workspaceId: 'workspace', sessionId: 'session' }
  const center = new AssistantNotificationCenter({ now: () => now })
  center.configure(true, ['workspace'])
  center.consume({ type: 'turn-completed', turnId: 'turn:1', generation: center.generation, target })
  const cleanup = bindDesktopAssistantNotifications(services, { read: (input) => center.read(input), presented: (input) => { center.ack(input) } })
  const f = fixture((value) => ({ model: frame.model, size: frame.size, ...desktopAssistantNotificationPresentation(services, value, { cursor, limit: 20 }) }),
    (event) => confirmDesktopAssistantNotification(services, event), (value) => { center.read({ cursor: value, limit: 20 }); cursor = value })
  await started(f)
  try {
    // 主页面只发了一次启动帧；中心和控制器后续刷新不读取网页计时器。
    now = 8000; await f.controller.refresh()
    assert.equal(center.read().primary!.presentation, 'queued'); assert.equal(center.read().primary!.deadline, undefined)
    f.event('notice-presented'); assert.equal(center.read().primary!.deadline, undefined)
    f.native({ ev: 'shown' }); f.event('notice-presented')
    assert.equal(center.read().primary!.presentedAt, now); assert.equal(center.read().primary!.deadline, 13000)
    await f.controller.refresh(); now = 12999; f.event('notice-presented')
    assert.equal(center.read().primary!.deadline, 13000, '重复原生帧不能重置实际首展时间')
    now = 13000; await f.controller.refresh()
    assert.equal(f.readFrame()!.notification, undefined); assert.equal(f.readFrame()!.reaction, undefined)
    assert.equal(f.readFrame()!.notificationSnapshot!.unreadCount, 1)
    assert.equal(f.commands.at(-1)!.notificationHeight, 276, '计时收起后仍直接显示单条未读卡片')
    f.native({ ev: 'notice-expansion', ...f.readFrame()!.identity, expanded: true, ownerId: 'old' })
    assert.equal(f.commands.at(-1)!.notificationHeight, 276)
    f.native({ ev: 'notice-expansion', ...f.readFrame()!.identity, expanded: true })
    await until(() => f.commands.at(-1)!.notificationHeight === 276)
    f.native({ ev: 'notice-expansion', ...f.readFrame()!.identity, expanded: false })
    await until(() => f.commands.at(-1)!.notificationHeight === 276)
    for (let index = 0; index < 24; index++) {
      now++
      center.consume({ type: 'request-opened', requestId: `request:${index}`, requestKind: 'question', generation: center.generation, target })
    }
    await f.controller.refresh()
    const first = f.readFrame()!, next = first.notificationSnapshot!.cursor!
    assert.equal(first.notificationSnapshot!.items.length, 20)
    f.native({ ev: 'notice-page', ...first.identity, cursor: next })
    await until(() => f.readFrame()!.notificationSnapshot!.items.length === 5)
    assert.equal(f.readFrame()!.notificationSnapshot!.pendingCount, 24)
    assert.equal(f.controller.status(owner).openSequence, 0, '首展、展开和翻页均不打开助理')
    const old = f.readFrame()!, clicked = old.notificationSnapshot!.items[0]!
    center.configure(false, ['workspace']); await f.controller.refresh()
    f.native({ ev: 'notice-action', ...old.identity, noticeId: clicked.noticeId, noticeGeneration: old.notificationSnapshot!.generation, action: 'open' })
    assert.equal(f.commands.filter((command) => command.cmd === 'notice-open').length, 0, '中心换代后的旧列表不能恢复窗口')
  } finally { await f.controller.dispose(); cleanup(); center.dispose() }
})

test('2.3 真实全局助理登记同一 Host 中心，原生首展确认进入认证读取，销毁注销来源', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const settings = structuredClone(DEFAULT_CODINGNS_SETTINGS), events = new Map<string, Set<(...args: any[]) => unknown>>()
  settings.modules.globalVoiceAssistant = true
  settings.assistant.profile = { name: '小鱼', initialized: true, createdAt: 1 }
  settings.assistant.managedWorkspaceIds = ['w']
  settings.assistant.appearance = { ...settings.assistant.appearance!, floatingEnabled: true }
  const session = { id: 's', title: '受管会话', header: { id: 's' }, snapshotEvents: () => [] }
  const on = (name: string, listener: (...args: any[]) => unknown): (() => void) => {
    const listeners = events.get(name) ?? new Set(); listeners.add(listener); events.set(name, listeners)
    return () => { listeners.delete(listener) }
  }
  const rpc = new CodingNsRpcTable()
  const services = { rpc, dshVersion: '0.2.1-alpha.1', settings: { get: () => settings, watch: () => () => {}, update: async () => {} }, events: { on },
    nativeSessions: { get: (id: string) => id === 's' ? session : undefined, subscribe: (handlers: any) => on('native', handlers.onEvent) },
    dshContext: { get(name: string) {
      if (name === 'sessions') return { get: (id: string) => id === 's' ? session : undefined }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [], list: () => [{ id: 'w', displayName: '项目', sessionIds: ['s'], archivedSessionIds: [] }] }
      if (name === 'sessionQuery') return { listSessions: () => [], readSurface: async () => assert.fail('原生通知不得索引正文') }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'api', model: 'chat' }) }
      if (name === 'llm') return { listProviders: () => [], listModels: async () => [], async *stream() { assert.fail('原生通知不得调用模型') } }
    } },
  } as unknown as CodingNsHostServices
  const registry = new FeatureRegistry(services)
  registry.register(createGlobalVoiceRpcFeature({ conversationStorage: memoryAssistantConversationStorage() }))
  t.after(() => registry.reconcile([]))
  await registry.reconcile(['globalVoiceRpc'])
  for (const [type, data, seq] of [['turn/start', { turn: 1 }, 1], ['turn/end', { turn: 1, reason: { kind: 'completed' } }, 2]] as const) {
    for (const handler of events.get('native') ?? []) handler(session, { type, data, seq })
  }
  const source = getDesktopAssistantNotifications(services)!
  assert.ok(source, '全局助理必须真实登记中心，而不是仅提供孤立绑定函数')
  const snapshot = source.read({ limit: 1 }), notice = snapshot.primary!
  assert.equal(snapshot.items.length, 1); assert.equal(notice.kind, 'completed')
  const safe = desktopAssistantNotificationPresentation(services, presentation)
  assert.equal(safe.notification!.noticeId, notice.noticeId); assert.equal(safe.caption, presentation.caption)
  confirmDesktopAssistantNotification(services, { ownerId: owner, generation: 3, sequence: 1, noticeId: notice.noticeId,
    noticeGeneration: snapshot.generation, noticeKind: notice.kind, type: 'notice-presented' })
  const route = rpc.resolve('assistant/notifications/read')!
  const authenticated = await route.handler(route.action, {}, undefined) as AssistantNotificationSnapshot
  assert.equal(authenticated.primary!.presentation, 'shown')
  assert.equal(authenticated.primary!.deadline! - authenticated.primary!.presentedAt!, 5000)
  await registry.reconcile([])
  assert.equal(getDesktopAssistantNotifications(services), undefined)
})
