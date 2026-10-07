import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createCodingNsSettingsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { DEFAULT_ASSISTANT_APPEARANCE } from '../data/build/dist/shared/assistant-avatar.js'
import { VoiceConversationDialog } from '../data/build/dist/client/features/voice-conversation-dialog.js'
import { AssistantAppearanceEditor, AssistantAppearancePanel } from '../data/build/dist/client/avatar/settings-panel.js'
import { GlobalVoiceOverlay } from '../data/build/dist/client/features/global-voice-assistant.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import type { AssistantProfileSettings, CodingNsSettings } from '../src/shared/contracts/config.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import type { CodingNsSettingsOperation } from '../src/dsh-capabilities/settings-store.js'

const locale = { bind: () => resolveCodingNsTranslator(), subscribe: () => () => undefined, getSnapshot: () => 'zh' }
const appearance = { ...DEFAULT_ASSISTANT_APPEARANCE, floatingEnabled: true }

test('旧助理配置补上形象默认值，语音模型和受管范围原样保留', () => {
  const input = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  input.assistant.managedWorkspaceIds = ['workspace-a']
  input.assistant.voice.modelId = 'existing-model'
  const result = CodingNsSettingsSchema(input)
  assert.deepEqual(result.assistant.appearance, DEFAULT_ASSISTANT_APPEARANCE)
  assert.deepEqual(result.assistant.managedWorkspaceIds, ['workspace-a'])
  assert.equal(result.assistant.voice.modelId, 'existing-model')
})

test('性格背景经过设置 schema 与写入校验保留，旧档案无需增加必填字段', async () => {
  const input = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  input.assistant.profile = { name: '小鱼', personality: '耐心、直说重点', initialized: true, createdAt: 1 }
  assert.equal(CodingNsSettingsSchema(input).assistant.profile!.personality, '耐心、直说重点')
  input.assistant.profile = { name: '旧助理', initialized: true, createdAt: 1 }
  assert.equal(CodingNsSettingsSchema(input).assistant.profile!.initialized, true)
  let writes = 0
  const handler = createCodingNsSettingsRpcHandler({ writable: true, describe: () => [{ ns: 'codingns', revision: 1, value: input }], get: () => input, mutate: async () => { writes++ } })
  for (const personality of [123, '长'.repeat(4001)]) await assert.rejects(handler('set', { expectedRevision: 1, ops: [{ op: 'set', path: ['assistant', 'profile'], value: { ...input.assistant.profile, personality } }] }), /档案/u)
  assert.equal(writes, 0)
})

test('形象 RPC 只写子字段，拒绝非法整段写入并沿用版本和只读策略', async () => {
  let current: CodingNsSettings = { ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, managedWorkspaceIds: ['workspace-a'] } }
  const oldVoice = current.assistant.voice
  let writable = true
  let writes = 0
  const provider = {
    get writable() { return writable },
    describe: () => [{ ns: 'codingns', revision: 7, value: current }],
    get: () => current,
    mutate: async (_namespace: string, operations: readonly CodingNsSettingsOperation[], revision?: number) => {
      assert.equal(revision, 7)
      writes++
      assert.deepEqual(operations.map((operation) => operation.path), [['assistant', 'appearance']])
      current = { ...current, assistant: { ...current.assistant, appearance: operations[0]!.value as typeof appearance } }
    },
  }
  const handler = createCodingNsSettingsRpcHandler(provider)
  await handler('set', { expectedRevision: 7, ops: [{ op: 'set', path: ['assistant', 'appearance'], value: appearance }] })
  assert.equal(current.assistant.voice, oldVoice)
  assert.deepEqual(current.assistant.managedWorkspaceIds, ['workspace-a'])
  assert.deepEqual(current.assistant.appearance, appearance)
  const invalid = { ...appearance, selectedId: 'missing' }
  for (const [path, value] of [[['assistant', 'appearance'], invalid], [['assistant'], { ...current.assistant, appearance: invalid }]] as const) {
    await assert.rejects(handler('set', { expectedRevision: 7, ops: [{ op: 'set', path, value }] }), /清单/u)
  }
  writable = false
  await assert.rejects(handler('set', { expectedRevision: 7, ops: [{ op: 'set', path: ['assistant', 'appearance'], value: appearance }] }), /只读/u)
  assert.equal(writes, 1)
})

test('开启和关闭对话形象都保留已有转写、语音和调试控制', () => {
  const services = { locale } as unknown as CodingNsClientServices
  const props = { services, t: resolveCodingNsTranslator(), active: false, pending: false, partialText: '正在识别', transcript: ['完整识别'],
    realtimeAvailable: true, onStart: () => {}, onStop: () => {}, onClose: () => {}, onClear: () => {}, onDebug: () => {}, onConfigure: () => {} }
  for (const dialogEnabled of [true, false]) {
    const html = renderToStaticMarkup(createElement(VoiceConversationDialog, { ...props, appearance: { ...appearance, dialogEnabled }, state: 'speaking' }))
    assert.equal(html.includes('data-codingns-avatar-slot="dialog"'), dialogEnabled)
    for (const content of ['正在识别', '完整识别', props.t('voice.dialog.start'), props.t('assistant.debug.open'), props.t('voice.setup.reconfigure'), props.t('avatar.settingsTitle')]) assert.ok(html.includes(content))
    assert.ok(html.includes('data-codingns-avatar-settings-toggle'))
    assert.ok(html.includes('aria-expanded="false"'))
  }
  const old = renderToStaticMarkup(createElement(VoiceConversationDialog, props))
  assert.ok(!old.includes('data-codingns-avatar-slot'))
})

test('对话内形象表单使用当前共享清单，并遵守只读状态', () => {
  const model = { id: 'custom-pet', name: '我的宠物', renderer: 'image', source: '/pets/custom.png', spriteVersion: 2 as const }
  const value = { ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant,
    appearance: { ...appearance, selectedId: model.id, models: [...appearance.models, model] } } }
  let writes = 0
  for (const writable of [true, false]) {
    const snapshot = { value, status: 'ready' as const, writable, revision: 1 }
    // 存储方法依赖 this，确保编辑器订阅包装没有丢失接收者。
    const store = { snapshot, getSnapshot() { return this.snapshot }, subscribe() { return () => {} }, mutate() { writes++; return false } }
    const services = { locale, settings: store } as unknown as CodingNsClientServices
    const html = renderToStaticMarkup(createElement(AssistantAppearanceEditor, { services, enabled: true }))
    assert.ok(html.includes('data-codingns-avatar-settings-editor'))
    assert.ok(!html.includes('data-codingns-avatar-catalog="true"'))
    assert.ok(!html.includes('浏览兼容形象包（GitHub）'))
    assert.equal((html.match(/data-codingns-avatar-add="true"/gu) ?? []).length, 1)
    assert.ok(html.includes('添加方式')); assert.ok(html.includes('自定义素材'))
    assert.ok(!html.includes('data-codingns-avatar-custom-add'), '默认只展开包安装字段，不堆叠自定义表单')
    assert.ok(html.includes('我的宠物'))
    assert.ok(html.includes('data-codingns-avatar-selected="custom-pet"'))
    assert.ok(html.includes('data-codingns-avatar-third-party-badge="true"'))
    assert.ok(html.indexOf('data-codingns-avatar-list') < html.indexOf('data-codingns-third-party-enabled'))
    assert.ok(html.indexOf('data-codingns-third-party-enabled') < html.indexOf('data-codingns-avatar-floating-size'))
    const labels = html.match(/<label\b[^>]*>/gu) ?? []
    assert.ok(labels.every((label) => label.includes('font-size:13px') && label.includes('font-weight:400')), '形象选项统一使用常规 13px 标签')
    const controls = html.match(/<(?:input|select|button)\b[^>]*>/gu) ?? []
    assert.ok(controls.length > 5)
    assert.equal(controls.every((control) => control.includes('disabled=""')), !writable)
  }
  assert.equal(writes, 0)
})

test('悬浮入口仅在助理已创建且开关打开时显示，旧配置与重置状态不显示', () => {
  let calls = 0
  const profiles: [string, AssistantProfileSettings | undefined][] = [
    ['旧配置无档案', undefined],
    ['未创建或已重置', { name: '我的助理', initialized: false, createdAt: null }],
    ['已创建', { name: '小鱼', initialized: true, createdAt: 1 }],
  ]
  for (const [name, profile] of profiles) for (const floatingEnabled of [true, false]) {
    const value = { ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant,
      ...(profile === undefined ? {} : { profile }), managedWorkspaceIds: ['old-project'],
      // 旧语音已初始化也不能放行悬浮；已创建助理不要求语音初始化。
      voice: { ...DEFAULT_CODINGNS_SETTINGS.assistant.voice, initialized: profile?.initialized !== true },
      appearance: { ...appearance, floatingEnabled } } }
    const services = { locale, settings: { getSnapshot: () => ({ value }), subscribe: () => () => {} }, rpc: { call: () => { calls++; throw new Error('不应调用') } } } as unknown as CodingNsClientServices
    const html = renderToStaticMarkup(createElement(GlobalVoiceOverlay, { services }))
    const visible = profile?.initialized === true && floatingEnabled
    assert.equal(html.includes('data-codingns-floating-avatar'), visible, `${name}，悬浮开关 ${floatingEnabled}`)
    assert.equal(html.includes('data-codingns-avatar-slot="floating"'), visible)
    assert.equal(html.includes('data-codingns-global-voice="true" aria-hidden="true"'), !visible)
    if (visible) assert.ok(html.includes('aria-haspopup="dialog"'))
  }
  assert.equal(calls, 0)
})

test('关闭模块时形象设置禁用，未写入任何配置', () => {
  const snapshot = { value: DEFAULT_CODINGNS_SETTINGS, status: 'ready' as const, writable: true, revision: 1 }
  let writes = 0
  const services = { locale, settings: { getSnapshot: () => snapshot, mutate: () => { writes++; return false } } } as unknown as CodingNsClientServices
  const html = renderToStaticMarkup(createElement(AssistantAppearancePanel, { services, snapshot, enabled: false, notify: () => {} }))
  const controls = html.match(/<(?:input|select|button)\b[^>]*>/gu) ?? []
  assert.ok(controls.length > 5)
  assert.ok(controls.every((control) => control.includes('disabled=""')))
  assert.equal(writes, 0)
})
