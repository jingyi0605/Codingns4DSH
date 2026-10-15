import assert from 'node:assert/strict'
import test from 'node:test'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import { createInteractionTranslation } from '../src/host/features/interaction-translation.js'
import { questionTranslationFields, answerTranslationFields, translatedAnswer, translatedField, planApproval } from '../src/shared/contracts/interaction-translation.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createInteractionPresentationBridge } from '../src/dsh-capabilities/client/interaction-presentation-adapter.js'
import { displayQuestionHistory, questionHistoryFields, readQuestionHistory } from '../src/dsh-capabilities/client/question-history-adapter.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'

const questions = [{ id: 'mode', header: 'Mode', question: 'Which mode?', detail: 'Keep `src/main.ts` unchanged.', options: [
  { label: 'Read only', description: 'Inspect files.' }, { label: 'Review', description: 'Review changes.' },
], multiSelect: true }]
const makeRecord = (original: string, translated = `译文:${original}`) => ({ original, translated, targetLanguage: 'zh' as const, bilingual: false })

function fixture() {
  const calls: { direction: string; text: string }[] = []
  let config = { adapterId: 'codex', translationEnabled: true }
  const service = {
    enabled: true, cacheKey: 'one', inputLanguage: 'en', outputLanguage: 'zh', nativeEnabled: false,
    translateOutput: async (_adapter: string, _kind: string, text: string) => { calls.push({ direction: 'output', text }); return makeRecord(text) },
    translateInputDetailed: async (_adapter: string, text: string) => { calls.push({ direction: 'input', text }); return { translated: `English:${text}` } },
  }
  const engine = createInteractionTranslation(service as any, () => config)
  const request = (fields = questionTranslationFields(questions), direction = 'output') => ({ sessionId: 's1', direction, fields })
  return { service, engine, calls, request, setConfig: (next: typeof config) => { config = next } }
}

test('question text, headings, detail, labels and descriptions are independent fields', async () => {
  const f = fixture()
  const before = structuredClone(questions)
  const fields = questionTranslationFields(questions)
  assert.equal(fields.length, 7)
  const result = await f.engine.translate(f.request())
  assert.deepEqual(f.calls.map(call => call.text).sort(), fields.map(field => field.text).sort())
  assert.ok(f.calls.every(call => !call.text.includes('"options"')))
  assert.equal(translatedField(result, 'q.0.question', questions[0]!.question), '译文:Which mode?')
  assert.deepEqual(questions, before)
})

test('same translated labels never change selected values, IDs or multi-select order', async () => {
  const f = fixture()
  f.service.translateOutput = async (_adapter, _kind, text) => makeRecord(text, '查看')
  await f.engine.translate(f.request())
  const answer = { answers: [{ id: 'mode', selected: ['Review', 'Read only'], custom: '请保留文件' }] }
  const before = structuredClone(answer)
  const result = await f.engine.translate(f.request(answerTranslationFields(answer), 'input'))
  assert.deepEqual(translatedAnswer(answer, result), { answers: [{ id: 'mode', selected: ['Review', 'Read only'], custom: 'English:请保留文件' }] })
  assert.deepEqual(answer, before)
  assert.deepEqual(f.calls, [{ direction: 'input', text: '请保留文件' }])
})

test('approval comes from the original named option, including a non-first approve option', () => {
  const q = { ...questions[0]!, multiSelect: false, intent: { kind: 'plan-review', approve: 'Review', callId: 'call-1' } }
  assert.equal(planApproval([q])?.option, 1)
  assert.equal(planApproval([{ ...q, intent: { kind: 'plan-review', approve: '查看' } }]), undefined)
  assert.equal(planApproval([{ ...q, multiSelect: true }]), undefined)
  assert.equal(q.intent.approve, 'Review')
})

test('translation is gated by the module and per-session switch, with native opt-in', async () => {
  const f = fixture()
  f.setConfig({ adapterId: 'codex', translationEnabled: false })
  assert.equal((await f.engine.translate(f.request())).enabled, false)
  f.setConfig({ adapterId: 'dsh' } as any)
  assert.equal((await f.engine.translate(f.request())).enabled, false)
  f.service.nativeEnabled = true
  assert.equal((await f.engine.translate(f.request())).enabled, true)
  f.service.enabled = false
  assert.equal((await f.engine.translate(f.request())).enabled, false)
})

test('completed fields are cached per session and configuration; failures are retried', async () => {
  const f = fixture()
  const request = f.request([{ key: 'todo.0', text: 'Inspect files' }])
  await f.engine.translate(request)
  await f.engine.translate(request)
  assert.equal(f.calls.length, 1)
  await f.engine.translate({ ...request, sessionId: 's2' })
  assert.equal(f.calls.length, 2)
  f.service.cacheKey = 'two'
  await f.engine.translate(request)
  assert.equal(f.calls.length, 3)
  f.service.translateOutput = async () => { throw new Error('offline') }
  f.service.cacheKey = 'three'
  assert.equal((await f.engine.translate(request)).records['todo.0']?.failed, true)
  f.service.translateOutput = async (_adapter, _kind, text) => makeRecord(text, '检查文件')
  assert.equal((await f.engine.translate(request)).records['todo.0']?.translated, '检查文件')
})

test('batch workers cap concurrent fields and a settings change discards stale results', async () => {
  const f = fixture()
  let active = 0, peak = 0
  f.service.translateOutput = async (_adapter, _kind, text) => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return makeRecord(text)
  }
  await f.engine.translate(f.request(Array.from({ length: 20 }, (_, i) => ({ key: `q.${i}`, text: `Question ${i}` }))))
  assert.equal(peak, 4)
  let release!: () => void
  f.service.translateOutput = async (_adapter, _kind, text) => { await new Promise<void>(resolve => { release = resolve }); return makeRecord(text) }
  const pending = f.engine.translate(f.request([{ key: 'q', text: 'New question' }]))
  await new Promise(resolve => setImmediate(resolve))
  f.service.cacheKey = 'new-language'
  release()
  assert.deepEqual(await pending, { enabled: false, records: {} })
})

test('malformed fields are rejected before translation and unavailable fields keep their original text', async () => {
  const f = fixture()
  await assert.rejects(f.engine.translate(f.request([{ key: 'q', text: 'a' }, { key: 'q', text: 'b' }])), /Invalid translation field/)
  await assert.rejects(f.engine.translate(f.request([{ key: 'q', text: 'a'.repeat(64_001) }])), /Invalid translation field/)
  assert.equal(f.calls.length, 0)
  assert.equal(translatedField({ enabled: true, records: { q: makeRecord('old') } }, 'q', 'new'), 'new')
  const answer = { answers: [{ id: 'a', selected: [], custom: '原文' }] }
  assert.deepEqual(translatedAnswer(answer, { enabled: false, records: { 'a.0.custom': makeRecord('原文', 'Wrong') } }), answer)
})

test('disposing translation prevents late result publication', async () => {
  const f = fixture()
  let release!: () => void
  f.service.translateOutput = async (_adapter, _kind, text) => { await new Promise<void>(resolve => { release = resolve }); return makeRecord(text) }
  const pending = f.engine.translate(f.request([{ key: 'q', text: 'Question' }]))
  await new Promise(resolve => setImmediate(resolve))
  f.engine.dispose()
  release()
  assert.deepEqual(await pending, { enabled: false, records: {} })
})

test('interaction capability reports unsupported older fixtures and requires the actual Slot API', () => {
  const context = { slots: { inject() {}, register() {}, entries() { return [] }, subscribe() { return () => {} } } }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2']) {
    const profile = createDshCapabilityRegistry(version, 'client', context).getProfile(context)
    assert.equal(profile.capabilities.get('conversation.interaction-translation')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some(d => d.capability === 'conversation.interaction-translation'))
  }
  for (const version of ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3']) {
    assert.equal(createDshCapabilityRegistry(version, 'client', context).getProfile(context).capabilities.get('conversation.interaction-translation')?.status, 'ready', version)
    assert.equal(createDshCapabilityRegistry(version, 'client', {}).getProfile({}).capabilities.get('conversation.interaction-translation')?.status, 'unavailable')
  }
})

test('question presentation claims only the enabled session and releases its registration', () => {
  let options: any
  let disposed = false
  const bridge = createInteractionPresentationBridge({ slots: {
    inject: (_key: string, fn: () => unknown) => fn(),
    register: (value: unknown) => { options = value; return () => { disposed = true } },
    entries: (name: string) => name === 'conversation.composer' ? [{
      component: () => null, options: {}, children: { 'conversation.plan-review.actions': { kind: 'list', scope: 'session' } },
      select: (owner: any) => owner.pendingInteraction,
    }] : [],
    subscribe: () => () => {},
  } })
  const stop = bridge.questions('enabled', () => null, (() => null) as any)
  const card = { kind: 'question', key: 'q', sessionId: 'enabled', questions,
    ...Object.fromEntries(['subscribe', 'snapshot', 'answer', 'dismiss', 'engage', 'takeTime', 'holdFocus', 'releaseFocus'].map(name => [name, () => {}])) }
  assert.equal(options.select({ sessionId: 'enabled', pendingInteraction: card }), card)
  assert.equal(options.select({ sessionId: 'disabled', pendingInteraction: card }), null)
  assert.equal(options.select({ sessionId: 'enabled', pendingInteraction: { kind: 'approval' } }), null)
  stop()
  assert.equal(disposed, true)
})

test('translated questions register alongside the native composer in the real Slot registry', async () => {
  const core = new SlotCore()
  core.register({ name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session-maybe' } } } as any, () => null)
  core.register({ name: 'conversation.composer', select: () => null,
    children: { 'conversation.plan-review.actions': { kind: 'list', scope: 'session' } },
  } as any, () => null)
  const slots = {
    register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
    inject: (_key: string, callback: () => () => void) => callback(),
  }
  const bridge = createInteractionPresentationBridge({ slots })
  const stopFirst = bridge.questions('first', () => null, (() => null) as any)
  const stopSecond = bridge.questions('second', () => null, (() => null) as any)
  assert.equal(core.entries('conversation.composer').length, 3)
  const inject = () => ({ open: () => {} })
  const action = () => null
  const removeAction = core.register({ name: 'conversation.plan-review.actions', id: 'preview', locale: 'question', inject } as any, action)
  await new Promise(resolve => setImmediate(resolve))
  const copy = core.entries('codingns.translation.plan-actions.first')[0]!
  assert.equal(copy.component, action)
  assert.equal(copy.inject, inject)
  assert.equal(copy.locale, 'question')
  assert.equal(core.entries('codingns.translation.plan-actions.second').length, 1)
  stopFirst()
  assert.equal(core.specDynamic('codingns.translation.plan-actions.first'), undefined)
  assert.equal(core.entries('conversation.plan-review.actions').length, 1)
  removeAction()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(core.entries('codingns.translation.plan-actions.second').length, 0)
  stopSecond()
  assert.equal(core.entries('conversation.composer').length, 1)
  assert.equal(core.specDynamic('conversation.plan-review.actions')?.kind, 'list')
})

test('Plan action child slots retain rendering ownership without changing native declarations', () => {
  const core = new SlotCore()
  core.register({ name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session-maybe' } } } as any, () => null)
  core.register({ name: 'conversation.composer', select: () => null,
    children: { 'conversation.plan-review.actions': { kind: 'list', scope: 'session' } },
  } as any, () => null)
  const original = (props: any) => props.renderSlot('native.plan.menu', { requestKey: 'q' })
  core.register({ name: 'conversation.plan-review.actions', id: 'menu',
    children: { 'native.plan.menu': { kind: 'list', scope: 'session' } },
  } as any, original)
  const item = () => null
  core.register({ name: 'native.plan.menu', id: 'open' } as any, item)
  const bridge = createInteractionPresentationBridge({ slots: {
    register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
    inject: (_key: string, callback: () => () => void) => callback(),
  } })
  const stop = bridge.questions('first', () => null, createElement)
  const entry = core.entries('codingns.translation.plan-actions.first')[0]!
  const child = 'codingns.translation.plan-actions.first.native.plan.menu'
  const forwarded = (entry.component as any)({ renderSlot: (key: string, owner: unknown) => {
    assert.ok(entry.children?.[key], 'the mirrored action owns every rendered child')
    return { key, owner }
  } })
  assert.equal(forwarded.type, original)
  assert.deepEqual(forwarded.type(forwarded.props), { key: child, owner: { requestKey: 'q' } })
  assert.equal(core.entries(child)[0]?.component, item)
  stop()
  assert.equal(core.specDynamic(child), undefined)
  assert.equal(core.entries('native.plan.menu')[0]?.component, item)
})

test('history translation changes display copies only, including late answers', () => {
  const block = { kind: 'tool-result', args: { text: () => undefined }, call: { name: 'ask_user_question', argsRaw: JSON.stringify({ questions }) },
    content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'c1' }) }] }
  const before = { ...block, call: { ...block.call }, content: block.content.map(part => ({ ...part })) }
  const answers = [{ id: 'mode', selected: ['Read only'], custom: 'Keep the file.' }]
  const history = readQuestionHistory(block, answers)!
  const fields = questionHistoryFields(history)
  const records = Object.fromEntries(fields.map(field => [field.key, makeRecord(field.text)]))
  const display = displayQuestionHistory(block, history, { enabled: true, records })
  assert.equal(JSON.parse(display.block.call.argsRaw).questions[0].question, '译文:Which mode?')
  assert.deepEqual(display.answers[0], { id: 'mode', selected: ['译文:Read only'], custom: '译文:Keep the file.' })
  assert.equal(JSON.parse(display.block.content[0].text).pending, true)
  assert.equal(display.block.args, block.args)
  assert.equal(display.block.args.text('description'), undefined)
  assert.deepEqual(block, before)
  assert.deepEqual(answers, [{ id: 'mode', selected: ['Read only'], custom: 'Keep the file.' }])
  assert.equal(readQuestionHistory({ phase: 'preparing', argsRaw: '{"questions":[' }), undefined)
})

test('repeated option text shares one translation without merging field identities', async () => {
  const f = fixture()
  const result = await f.engine.translate(f.request([{ key: 'q.0.o.0.label', text: 'Review' }, { key: 'q.0.o.1.label', text: 'Review' }]))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(Object.keys(result.records), ['q.0.o.0.label', 'q.0.o.1.label'])
})

test('external plan approvals translate only the displayed plan and preserve the actual decision', async () => {
  const requests: any[] = [], responses: any[] = [], translations: string[] = []
  const projector = new CodingNsDshMessageProjector({ adapterId: 'zcode', sessionId: 's1', translationEnabled: true,
    nativeSessions: { requestApproval: async (_id: string, request: any) => { requests.push(request); return 'rejected' } } as any,
    respondPermission: response => { responses.push(response) },
    translation: { shouldTranslate: () => true, translateOutput: async (_id: string, _kind: string, text: string) => { translations.push(text); return makeRecord(text, '检查源代码。') } } as any,
  })
  const event = { type: 'permission-request' as const, requestId: 'p1', kind: 'plan', toolName: 'exitPlanMode', detail: 'Inspect the source.' }
  await projector.push(event)
  assert.equal(requests[0].reason, '检查源代码。')
  assert.equal(responses[0].approved, false)
  assert.equal(responses[0].requestId, 'p1')
  assert.equal(event.detail, 'Inspect the source.')
  await projector.push({ ...event, kind: 'tool', toolName: 'bash', requestId: 'p2' })
  assert.equal(translations.length, 1)
  assert.equal(requests[1].reason, 'Inspect the source.')
})

test('concurrent history panels share the same translation concurrency limit', async () => {
  const f = fixture()
  let active = 0, peak = 0
  f.service.translateOutput = async (_adapter, _kind, text) => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return makeRecord(text)
  }
  await Promise.all(Array.from({ length: 6 }, (_, panel) => f.engine.translate(f.request(
    Array.from({ length: 4 }, (_, field) => ({ key: `q.${field}`, text: `Panel ${panel} field ${field}` })),
  ))))
  assert.equal(peak, 4)
})

test('the original Plan component receives its unchanged card and can render its extension slot', () => {
  let options: any, presentation: any, received: any
  const native = { component: () => null, options: {}, select: (owner: any) => owner.pendingInteraction,
    children: { 'conversation.plan-review.actions': { kind: 'list', scope: 'session' } } }
  const bridge = createInteractionPresentationBridge({ slots: {
    inject: (_key: string, fn: () => unknown) => fn(),
    register: (value: unknown, component: unknown) => { options = value; presentation = component; return () => {} },
    entries: (name: string) => name === 'conversation.composer' ? [native] : [],
    subscribe: () => () => {},
  } })
  bridge.questions('s1', () => null, ((_component: unknown, props: unknown) => props) as any)
  const question = { ...questions[0]!, multiSelect: false, intent: { kind: 'plan-review', approve: 'Review', callId: 'c1' } }
  const card = { key: 'request', questions: [question] }
  const result = presentation({ matched: card, renderSlot: (name: string, owner: unknown) => { received = { name, owner }; return 'plan-actions' } })
  assert.deepEqual(options.children, { 'codingns.translation.plan-actions.s1': { kind: 'list', scope: 'session' } })
  assert.equal(result.matched, card)
  const rendered = result.render(card)
  assert.equal(rendered.matched, card)
  const review = { plan: question.detail, approve: question.options[1], decline: question.options[0], callId: 'c1' }
  assert.equal(rendered.renderSlot('conversation.plan-review.actions', { requestKey: card.key, review }), 'plan-actions')
  assert.equal(received.name, 'codingns.translation.plan-actions.s1')
  assert.equal(received.owner.requestKey, card.key)
  assert.equal(received.owner.review.plan, question.detail)
  assert.equal(received.owner.review.approve, question.options[1])
  assert.equal(received.owner.review.decline, question.options[0])
  assert.equal(received.owner.review.callId, 'c1')
})

test('custom reply translation is not blocked by pending history translations', async () => {
  const f = fixture()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  f.service.translateOutput = async (_adapter, _kind, text) => { await blocked; return makeRecord(text) }
  const history = f.engine.translate(f.request())
  const reply = await f.engine.translate(f.request([{ key: 'a.0.custom', text: '我的回复' }], 'input'))
  assert.equal(reply.records['a.0.custom']?.translated, 'English:我的回复')
  release()
  await history
})
