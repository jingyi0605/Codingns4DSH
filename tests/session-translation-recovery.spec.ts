import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionTranslationRecovery, SessionTranslationCancelled } from '../src/host/features/session-translation-recovery.js'
import type { SessionTranslationService } from '../src/host/features/session-translation-service.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS } from '../src/shared/contracts/session-translation.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function harness(translate: (text: string) => Promise<{ translated: string; failed?: boolean }>) {
  let deactivate: (() => void) | undefined
  const calls: { adapterId: string; kind: string; text: string }[] = []
  const service = {
    enabled: true, nativeEnabled: true, inputLanguage: 'en', outputLanguage: 'zh',
    onDeactivate(listener: () => void) { deactivate = listener; return () => { deactivate = undefined } },
    async translateInputDetailed(adapterId: string, text: string) { calls.push({ adapterId, kind: 'input', text }); return translate(text) },
    async translateOutput(adapterId: string, kind: string, text: string) {
      calls.push({ adapterId, kind, text })
      return { original: text, translated: 'Translated output', targetLanguage: 'zh', outputKind: kind, bilingual: false }
    },
  } as unknown as SessionTranslationService
  const recovery = createSessionTranslationRecovery(service, sessionId => ({ adapterId: sessionId === 'native' ? 'dsh' : 'codex', translationEnabled: sessionId !== 'disabled' }))
  return { recovery, calls, deactivate: () => deactivate?.() }
}

test('input failure waits for a matching choice, retries repeatedly, and rejects stale or duplicate decisions', async () => {
  let attempts = 0
  const { recovery, calls } = harness(async text => ++attempts < 3 ? { translated: text, failed: true } : { translated: 'Hello' })
  try {
    let settled = false
    const result = recovery.translateInput('native', 'dsh', '你好').then(value => { settled = true; return value })
    await flush()
    assert.equal(settled, false)
    const first = recovery.pending({ sessionId: 'native' })[0]!
    assert.equal(first.record.failed, true)
    assert.deepEqual(recovery.pending({ sessionId: 'other' }), [])
    assert.equal(recovery.resolve({ sessionId: 'other', id: first.id, choice: 'send' }).accepted, false)
    assert.equal(recovery.resolve({ sessionId: 'native', id: first.id, choice: 'retry' }).accepted, true)
    assert.equal(recovery.resolve({ sessionId: 'native', id: first.id, choice: 'send' }).accepted, false)
    await flush()
    assert.equal(settled, false)
    const second = recovery.pending({ sessionId: 'native' })[0]!
    assert.notEqual(first.id, second.id)
    recovery.resolve({ sessionId: 'native', id: second.id, choice: 'retry' })
    assert.equal((await result).translated, 'Hello')
    assert.equal(calls.length, 3)
    assert.deepEqual(recovery.pending({ sessionId: 'native' }), [])
  } finally { recovery.dispose() }
})

test('send directly preserves the complete original; cancel never returns a sendable translation', async () => {
  const original = '请检查 `src/main.ts`\n\nKeep this line.'
  const { recovery } = harness(async () => { throw new Error('Network failure') })
  try {
    const sent = recovery.translateInput('external', 'codex', original)
    await flush()
    const request = recovery.pending({ sessionId: 'external' })[0]!
    recovery.resolve({ sessionId: 'external', id: request.id, choice: 'send' })
    assert.equal((await sent).translated, original)
    assert.equal((await sent).failed, true)
    const cancelled = recovery.translateInput('external', 'codex', original)
    const rejected = assert.rejects(cancelled, SessionTranslationCancelled)
    await flush()
    recovery.resolve({ sessionId: 'external', id: recovery.pending({ sessionId: 'external' })[0]!.id, choice: 'cancel' })
    await rejected
    assert.deepEqual(recovery.pending({ sessionId: 'external' }), [])
  } finally { recovery.dispose() }
})

test('abort, feature disable, session disposal and host disposal release waiting submissions', async () => {
  for (const mode of ['abort', 'disable', 'session', 'host'] as const) {
    const { recovery, deactivate } = harness(async text => ({ translated: text, failed: true }))
    const controller = new AbortController()
    const rejected = assert.rejects(recovery.translateInput('native', 'dsh', '你好', controller.signal))
    await flush()
    if (mode === 'abort') controller.abort()
    if (mode === 'disable') deactivate()
    if (mode === 'session') recovery.cancelSession('native')
    if (mode === 'host') recovery.dispose()
    await rejected
    assert.deepEqual(recovery.pending({ sessionId: 'native' }), [])
    recovery.dispose()
  }
})

test('an interrupted translation cannot create a late failure prompt even if its provider ignores abort', async () => {
  let complete!: (value: { translated: string; failed: boolean }) => void
  const { recovery } = harness(() => new Promise(resolve => { complete = resolve }))
  const rejected = assert.rejects(recovery.translateInput('native', 'dsh', '你好'), SessionTranslationCancelled)
  await flush()
  recovery.cancelSession('native')
  await rejected
  complete({ translated: '你好', failed: true })
  await flush()
  assert.deepEqual(recovery.pending({ sessionId: 'native' }), [])
  recovery.dispose()
})

test('manual output retry preserves reasoning versus reply kind and validates the session', async () => {
  const { recovery, calls } = harness(async text => ({ translated: text }))
  try {
    for (const sessionId of ['native', 'external']) {
      for (const outputKind of ['assistant', 'reasoning'] as const) {
        const result = await recovery.retryOutput({ sessionId, outputKind, original: 'Original output' })
        assert.equal(result.outputKind, outputKind)
        assert.equal(result.translated, 'Translated output')
        assert.equal(calls.at(-1)!.adapterId, sessionId === 'native' ? 'dsh' : 'codex')
      }
    }
    await assert.rejects(recovery.retryOutput({ sessionId: 'disabled', outputKind: 'assistant', original: 'text' }), /disabled/)
    await assert.rejects(recovery.retryOutput({ sessionId: 'native', outputKind: 'input', original: 'text' }), /Invalid/)
  } finally { recovery.dispose() }
})

test('disabling user translation cancels a pending submission without sending the original', async () => {
  const { recovery } = harness(async text => ({ translated: text, failed: true }))
  try {
    const submitted = recovery.translateInput('native', 'dsh', '你好')
    const rejected = assert.rejects(submitted, SessionTranslationCancelled)
    await flush()
    assert.equal(recovery.pending({ sessionId: 'native' }).length, 1)
    recovery.cancelDisabled({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, nativeEnabled: true, inputEnabled: false })
    await rejected
    assert.deepEqual(recovery.pending({ sessionId: 'native' }), [])
  } finally { recovery.dispose() }
})

test('disabling input for one agent cancels only its pending submissions', async () => {
  const { recovery } = harness(async text => ({ translated: text, failed: true }))
  try {
    const native = recovery.translateInput('native', 'dsh', '你好')
    const external = recovery.translateInput('external', 'codex', '你好')
    const rejected = assert.rejects(external, SessionTranslationCancelled)
    await flush()
    recovery.cancelDisabled({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, nativeEnabled: true,
      inputEnabled: false, adapterOptions: { dsh: { inputEnabled: true }, codex: { inputEnabled: false } },
    })
    await rejected
    assert.deepEqual(recovery.pending({ sessionId: 'external' }), [])
    const pending = recovery.pending({ sessionId: 'native' })[0]!
    assert.ok(pending)
    recovery.resolve({ sessionId: 'native', id: pending.id, choice: 'send' })
    assert.equal((await native).translated, '你好')
  } finally { recovery.dispose() }
})
