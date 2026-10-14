import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { createQuestionAnswerTranslation, NativeQuestionTranslation, NativeTranslatedContent, NativeTodoTranslation, registerSessionTranslationInteractions } from '../src/client/session-translation-interactions.js'
import { CodingNsSettingsBridge } from '../src/client/settings-bridge.js'
import { readAgentQuestions } from '../src/host/cli-adapters/interaction-events.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
let nextId = 0
function fixture() {
  const sent: any[] = []
  const listeners = new Set<() => void>()
  let closed = false
  class NativeCard {
    #key = 'request-' + ++nextId
    get key() { return this.#key }
    get sessionId() { return 'session-' + this.#key }
    kind = 'question' as const
    dismissal = 'cancel' as const
    questions = readAgentQuestions([{ question: 'Which civilization?', header: 'History', options: [
      { label: 'Egyptians', description: 'Developed hieroglyphics' },
      { label: 'Chinese', description: 'Developed oracle bone script' },
    ] }])
    snapshot() { assert.ok(this.#key); return { closed, channel: 'rpc' as const, state: 'continued' as const } }
    subscribe(listener: () => void) { assert.ok(this.#key); listeners.add(listener); return () => { listeners.delete(listener) } }
    async answer(answer: any) { assert.ok(this.#key); sent.push(answer) }
    async dismiss() { throw new Error('Only the native component owns dismissal') }
    engage() { assert.ok(this.#key) }
    takeTime() {}
    holdFocus() {}
    releaseFocus() {}
    liveKeys() { return new Set([this.#key]) }
  }
  const card = new NativeCard()
  const settings = { value: { sessionTranslation: { inputLanguage: 'en', outputLanguage: 'zh' } }, status: 'ready', revision: 0, writable: true }
  const services: any = { dshVersion: '0.2.1-alpha.2', rpc: { call: async (_channel: string, action: string) => {
    assert.equal(action, 'cli/session/get')
    return { ok: true, value: { adapterId: 'opencode', translationEnabled: true } }
  } } }
  services.settings = new CodingNsSettingsBridge({ getSnapshot: () => settings, subscribe: () => () => {} } as any, services.rpc)
  return { card, sent, services, listeners, close() { closed = true; for (const listener of listeners) listener() } }
}
const translated = async (fields: readonly { key: string; text: string }[]) => ({
  enabled: true, records: Object.fromEntries(fields.map(field => [field.key, { original: field.text, translated: 'English:' + field.text, targetLanguage: 'en' as const, bilingual: false }])),
})

test('native card methods retain their receiver and option data stays original', async () => {
  const f = fixture()
  const bridge = createQuestionAnswerTranslation(f.card, async () => { throw new Error('Options must not be translated on submission') })
  assert.equal(bridge.card.questions, f.card.questions)
  assert.equal(bridge.card.key, f.card.key)
  assert.deepEqual((bridge.card as typeof f.card).liveKeys(), new Set([f.card.key]))
  bridge.card.engage()
  const answer = { answers: [{ id: 'question-1', selected: ['Chinese'] }] }
  await bridge.card.answer(answer)
  assert.equal(f.sent[0], answer)
  bridge.dispose()
})

test('native custom replies translate once without changing the draft or taking over dismissal', async () => {
  const f = fixture()
  let release!: () => void
  const bridge = createQuestionAnswerTranslation(f.card, async fields => { await new Promise<void>(resolve => { release = resolve }); return translated(fields) })
  const value = { answers: [{ id: 'question-1', selected: ['Egyptians'], custom: '保留原文件' }] }
  const pending = bridge.card.answer(value)
  assert.equal(bridge.card.answer(value), pending)
  release()
  await pending
  assert.deepEqual(f.sent, [{ answers: [{ id: 'question-1', selected: ['Egyptians'], custom: 'English:保留原文件' }] }])
  assert.equal(value.answers[0].custom, '保留原文件')
  assert.equal(f.listeners.size, 0)
})

for (const cancellation of ['close', 'unmount']) test(cancellation + ' cancels translation before a late native submission', async () => {
  const f = fixture()
  let release!: () => void
  const bridge = createQuestionAnswerTranslation(f.card, async fields => { await new Promise<void>(resolve => { release = resolve }); return translated(fields) })
  const pending = bridge.card.answer({ answers: [{ id: 'question-1', selected: [], custom: '稍等' }] })
  const rejected = assert.rejects(pending, /abort/i)
  if (cancellation === 'close') f.close(); else bridge.dispose()
  release()
  await rejected
  assert.equal(f.sent.length, 0)
  assert.equal(f.listeners.size, 0)
})

test('input translation failure lets the native flow submit the original custom reply', async () => {
  const f = fixture()
  const bridge = createQuestionAnswerTranslation(f.card, async () => { throw new Error('offline') })
  const value = { answers: [{ id: 'question-1', selected: [], custom: '保持原样' }] }
  await bridge.card.answer(value)
  assert.deepEqual(f.sent, [value])
})

test('native text boundary reads the real settings bridge and creates no question controls', () => {
  const f = fixture()
  const original = createElement('section', { 'data-native': true })
  const renderer = createHookRenderer(NativeTranslatedContent, { sessionId: f.card.sessionId, services: f.services, kind: 'question' as const, enabled: true, children: original })
  const tree = renderer.render()
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.style.display, 'contents')
  assert.equal(tree.props.children, original)
  renderer.dispose()
})

test('todo translation retains the native progress component and its collapsed state owner', async () => {
  const f = fixture()
  const original = createElement('section', { 'data-testid': 'todo-panel' })
  const renderer = createHookRenderer(NativeTodoTranslation, { sessionId: f.card.sessionId, services: f.services, original, todos: [] })
  renderer.render()
  await tick()
  const tree = renderer.render()
  assert.equal(tree.type, NativeTranslatedContent)
  assert.equal(tree.props.children, original)
  assert.equal(tree.props.enabled, true)
  renderer.dispose()
})

for (const version of ['0.2.1-alpha.1', '0.2.1-alpha.2']) test('DSH ' + version + ' renders its original composer with its store, hooks, and locale', async () => {
  const f = fixture()
  f.services.dshVersion = version
  const core = new SlotCore()
  core.register({ name: 'root', children: {
    'conversation.composer': { kind: 'chain', scope: 'session-maybe' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  } } as any, () => null)
  const nativeComponent = () => null
  const store = { key: 'native-drafts' }
  const inject = () => ({ keyedHooks: { questionCard: () => f.card } })
  core.register({ name: 'conversation.composer', locale: 'native-questions', store, inject,
    select: (owner: any) => owner.pendingInteraction ?? null,
    children: { 'conversation.plan-review.actions': { kind: 'list', scope: 'session' } },
  } as any, nativeComponent)
  const native = core.entries('conversation.composer')[0]!
  f.services.slots = {
    register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
    inject: (_key: string, callback: () => () => void) => callback(),
  }
  const stop = registerSessionTranslationInteractions(f.services)
  const coordinator = core.entries('conversation.input.left')[0]!
  const host = createHookRenderer(coordinator.component as any, { sessionId: f.card.sessionId })
  host.render()
  await tick()
  host.render()
  const owner = { sessionId: f.card.sessionId, pendingInteraction: f.card }
  const elected = core.entries('conversation.composer').find(entry => entry.select?.(owner as never) != null)!
  assert.notEqual(elected, native)
  assert.equal(elected.store, native.store)
  assert.equal(elected.inject, native.inject)
  assert.equal(elected.locale, native.locale)
  const useStore = () => ({ progressByRequest: {} })
  const wrapper = (elected.component as any)({ matched: f.card, useStore })
  const panel = wrapper.type(wrapper.props)
  assert.equal(panel.type, NativeQuestionTranslation)
  const renderer = createHookRenderer(panel.type, panel.props)
  const boundary = renderer.render() as any
  assert.equal(boundary.type, NativeTranslatedContent)
  assert.equal(boundary.props.children.type, nativeComponent)
  assert.equal(boundary.props.children.props.useStore, useStore)
  assert.equal(boundary.props.children.props.matched.questions, f.card.questions)
  renderer.dispose()
  host.dispose()
  stop()
  assert.deepEqual(core.entries('conversation.composer'), [native])
})
