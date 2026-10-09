import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantConfigurationSession } from '../src/client/features/assistant-configuration-session.js'
import { AssistantNotificationSettings } from '../src/client/features/assistant-configuration-view.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { normalizeAssistantNotificationSettings } from '../src/shared/assistant-notifications.js'
import { normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { assistantNotificationReaction, desktopAssistantNotification, GlobalVoiceOverlay } from '../src/client/features/global-voice-assistant.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import type { AssistantNotificationSnapshot } from '../src/shared/assistant-notifications.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'

function fixture() {
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS); delete value.assistant.notifications
  const snapshot = { value, status: 'ready' as const, writable: true, revision: 1 }; let writes = 0
  const services = { settings: { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => { writes++; return true } },
    rpc: { call: async () => ({ ok: true, value: undefined }) },
    locale: { bind: () => resolveCodingNsTranslator(), subscribe: () => () => {}, getSnapshot: () => 'zh' } } as unknown as CodingNsClientServices
  return { value, services, writes: () => writes }
}

test('通知开关和自动关闭时长统一写草稿并进入保存补丁，取消恢复旧配置', async (t) => {
  const f = fixture(); const draft = new AssistantConfigurationSession(f.services); t.after(() => draft.dispose())
  for (const key of ['enabled', 'completed', 'error', 'question', 'approval', 'autoClose']) await draft.set(`assistant.notifications.${key}`, false)
  await draft.set('assistant.notifications.autoCloseSeconds', 45)
  assert.equal(f.writes(), 0); assert.equal(f.value.assistant.notifications, undefined); draft.sync()
  assert.deepEqual(normalizeAssistantNotificationSettings(draft.getSnapshot().value!.assistant.notifications), { enabled: false, completed: false, error: false, question: false, approval: false, autoClose: false, autoCloseSeconds: 45 })
  assert.deepEqual(draft.configurationPatch().map((item) => item.path), ['enabled', 'completed', 'error', 'question', 'approval', 'autoClose', 'autoCloseSeconds'].map((key) => ['notifications', key]))
  assert.equal(normalizeAssistantAppearance(f.value.assistant.appearance).floatingEnabled, false); assert.equal(f.value.assistant.voice.initialized, false)
  draft.reset(); assert.equal(draft.configurationPatch().length, 0)
  const reset = normalizeAssistantNotificationSettings(draft.getSnapshot().value!.assistant.notifications)
  assert.ok([reset.enabled, reset.completed, reset.error, reset.question, reset.approval].every(Boolean)); assert.equal(reset.autoClose, false); assert.equal(reset.autoCloseSeconds, 30)
})

test('旧配置通知开关全开但不打开悬浮或麦克风；只读表单保留开关和时长选择', () => {
  const f = fixture(); const t = resolveCodingNsTranslator()
  const html = renderToStaticMarkup(createElement(AssistantNotificationSettings, { services: f.services, value: f.value.assistant, disabled: true, t, onError: () => {} }))
  assert.equal((html.match(/role="switch"/gu) ?? []).length, 6); assert.equal((html.match(/checked=""/gu) ?? []).length, 5)
  assert.equal((html.match(/<input[^>]*disabled=""/gu) ?? []).length, 6)
  assert.equal((html.match(/<select[^>]*disabled=""/gu) ?? []).length, 1); assert.ok(html.includes('15秒')); assert.ok(html.includes('60秒'))
  const overlay = renderToStaticMarkup(createElement(GlobalVoiceOverlay, { services: f.services }))
  assert.ok(!overlay.includes('data-codingns-floating-avatar')); assert.ok(!overlay.includes('data-codingns-assistant-notifications')); assert.equal(f.writes(), 0)
})

test('通知情绪独立于语音状态，原生展示帧只保留安全文本与身份', () => {
  for (const [kind, reaction] of [['completed', 'success'], ['error', 'concerned'], ['question', 'question'], ['approval', 'approval']] as const) {
    const notice = { noticeId: 'safe', kind, hostLabel: '远端', workspaceLabel: '项目', sessionTitle: '会话', text: '提醒', availability: 'ready' as const,
      createdAt: 1, lifecycle: 'active' as const, presentation: 'shown' as const, read: false, connectionGeneration: 8 }
    const frame: AssistantNotificationSnapshot = { generation: 2, revision: 3, serverNow: 1, primary: notice, items: [notice], unreadCount: 1, pendingCount: 0, cursor: null, capabilities: [] }
    assert.equal(assistantNotificationReaction(frame), reaction)
    const safe = desktopAssistantNotification(frame)!
    assert.deepEqual(Object.keys(safe).sort(), ['noticeId', 'generation', 'kind', 'hostLabel', 'workspaceLabel', 'sessionTitle', 'text', 'availability'].sort())
    assert.equal(safe.generation, 2)
  }
  assert.equal(assistantNotificationReaction(undefined), undefined); assert.equal(desktopAssistantNotification(undefined), undefined)
})

test('原生闭合设置schema保留图片、精灵、Live2D和双展示情绪映射，旧配置不增加必填资源', () => {
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  const models = [
    { id: 'reaction-image', name: '图片', renderer: 'image', source: '/idle.png', spriteVersion: 2 as const, reactionSources: { success: '/success.png' },
      surfaces: { dialog: { renderer: 'live2d', source: '/model.model3.json', spriteVersion: 2 as const, reactionMotionGroups: { success: 'Happy' }, reactionExpressions: { success: 'Smile' } } } },
    { id: 'reaction-sprite', name: '精灵', renderer: 'spritesheet', source: '/sprite.png', spriteVersion: 1 as const, reactionMotionGroups: { question: { row: 2, frames: 4, interval: 100 } } },
    { id: 'reaction-live2d', name: '模型', renderer: 'live2d', source: '/model.model3.json', spriteVersion: 2 as const, reactionMotionGroups: { success: 'Happy' }, reactionExpressions: { success: 'Smile' } },
  ]
  value.assistant.appearance = { ...normalizeAssistantAppearance(value.assistant.appearance), models }
  const saved = CodingNsSettingsSchema(value).assistant.appearance!
  for (const model of models) {
    const actual = saved.models.find(item => item.id === model.id)!
    for (const field of ['reactionSources', 'reactionMotionGroups', 'reactionExpressions', 'surfaces'] as const) assert.deepEqual(actual[field], (model as typeof actual)[field])
  }
  assert.doesNotThrow(() => CodingNsSettingsSchema(DEFAULT_CODINGNS_SETTINGS))
})
