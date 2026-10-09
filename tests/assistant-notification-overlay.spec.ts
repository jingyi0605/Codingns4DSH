import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { isValidElement } from 'react'
import type { ReactElement } from 'react'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { GlobalVoiceOverlay } from '../src/client/features/global-voice-assistant.js'
import { FloatingAssistantAvatar } from '../src/client/avatar/floating.js'
import { AssistantNotificationBubble } from '../src/client/avatar/notification-bubble.js'
import { AssistantLoadedView } from '../src/client/features/assistant-view-loader.js'
import { AssistantNotificationCenter } from '../src/host/features/assistant-notifications.js'
import { HostRouter } from '../src/features/host-router.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { DESKTOP_ASSISTANT_CHANNEL } from '../src/shared/desktop-assistant.js'
import type { DesktopAssistantNoticeEvent } from '../src/shared/desktop-assistant.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'

function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
}
const settle = async () => { for (let index = 0; index < 8; index++) await setImmediate() }

test('网页与原生共用通知事实；原生气泡只导航会话，本体才打开助理；卸载终止轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'dshDesktopBoot')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { innerWidth: 1024, innerHeight: 900 }) })
  Object.defineProperty(globalThis, 'dshDesktopBoot', { configurable: true, value: {} })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'dshDesktopBoot', previous); else Reflect.deleteProperty(globalThis, 'dshDesktopBoot') })
  const center = new AssistantNotificationCenter(); center.configure(true, ['project'])
  center.consume({ type: 'request-opened', requestKind: 'question', requestId: 'q', target: { hostId: 'local', workspaceId: 'project', sessionId: 'target' }, generation: center.generation })
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  value.assistant.profile = { initialized: true, name: '助理', createdAt: 1 }
  value.assistant.appearance = { ...normalizeAssistantAppearance(undefined), floatingEnabled: true }
  const listeners = new Set<() => void>(), opened: string[] = [], calls: string[] = []
  let ownerId = '', openSequence = 0, events: DesktopAssistantNoticeEvent[] = []
  let presentation: any
  const translator = resolveCodingNsTranslator()
  const services = { settings: { getSnapshot: () => ({ value, status: 'ready', writable: true, revision: 1 }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } },
    locale: { bind: () => translator, subscribe: () => () => {}, getSnapshot: () => 'zh' }, hostRouter: new HostRouter(),
    uiContext: { get: (name: string) => name === 'uiWorkspace' ? { openSession: async (id: string) => { opened.push(id) } } : undefined },
    rpc: { async call(channel: string, endpoint: string, payload: any) {
      calls.push(endpoint)
      if (channel === DESKTOP_ASSISTANT_CHANNEL) {
        ownerId = payload.ownerId
        if (endpoint === 'update') { presentation = payload.presentation; if (payload.noticeAck) events = events.filter((event) => event.sequence > payload.noticeAck.sequence) }
        return { ok: true, value: { available: true, visible: true, owned: true, openSequence, generation: 4, noticeEvents: events } }
      }
      return { ok: true, value: endpoint.endsWith('/read') ? center.read(payload) : endpoint.endsWith('/ack') ? center.ack(payload) : await center.target(payload) }
    } } } as unknown as CodingNsClientServices
  const renderer = createHookRenderer(GlobalVoiceOverlay, { services })
  const pollUntil = async (check: () => boolean): Promise<ReactElement> => {
    let tree = renderer.render()
    for (let attempt = 0; attempt < 8 && !check(); attempt++) {
      // 串行在途动作结束后才安排下一次读取，按可控时钟等待真实消费结果。
      t.mock.timers.tick(1000); await settle(); tree = renderer.render(); await settle()
    }
    assert.ok(check(), '通知动作应在有界读取内完成')
    return tree
  }
  t.after(() => {
    renderer.dispose(); center.dispose()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window')
  })
  renderer.render(); await settle(); let tree = renderer.render(); await settle()
  assert.ok(presentation.notification); assert.equal(presentation.state, 'idle'); assert.equal(presentation.reaction, 'question')
  assert.equal(presentation.notificationSnapshot.pendingCount, 1)
  assert.equal(presentation.notificationSnapshot.items[0].noticeId, presentation.notification.noticeId)
  assert.equal('target' in presentation.notificationSnapshot.items[0], false)
  assert.ok(!elements(tree).some((element) => element.type === FloatingAssistantAvatar || element.type === AssistantNotificationBubble))
  const noticeId = center.read().primary!.noticeId
  events = [{ sequence: 1, ownerId, generation: 4, noticeId, noticeGeneration: center.generation, type: 'notice-action', action: 'open' }]
  t.mock.timers.tick(1000); await settle(); tree = renderer.render()
  assert.deepEqual(opened, ['target']); assert.ok(center.read().items[0]!.read)
  assert.ok(!elements(tree).some((element) => element.type === AssistantLoadedView), '气泡导航不能额外打开助理工作台')
  assert.ok(!calls.some((endpoint) => /send|answer|approval|voice\/start/u.test(endpoint)))
  events = [{ sequence: 2, ownerId, generation: 4, noticeId, noticeGeneration: center.generation, type: 'notice-action', action: 'dismiss' }]
  await pollUntil(() => presentation.notification === undefined)
  assert.equal(presentation.notification, undefined)
  assert.equal(presentation.notificationSnapshot.primary, null)
  assert.equal(presentation.notificationSnapshot.pendingCount, 1, '收起气泡后原生仍持有待办入口')
  assert.equal(presentation.reaction, undefined)
  openSequence = 1; tree = await pollUntil(() => elements(renderer.render()).some((element) => element.type === AssistantLoadedView))
  assert.ok(elements(tree).some((element) => element.type === AssistantLoadedView), '本体保留原有打开助理行为')
  value.assistant.notifications!.enabled = false; for (const listener of listeners) listener(); renderer.render(); await settle(); renderer.render(); await settle()
  assert.equal(presentation.notification, undefined); assert.equal(presentation.reaction, undefined)
  assert.equal(presentation.notificationSnapshot, undefined)
  renderer.dispose(); await settle(); const count = calls.length
  t.mock.timers.tick(60_000); await settle(); assert.equal(calls.length, count)
})
