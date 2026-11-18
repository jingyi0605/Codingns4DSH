import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createNativeLlmTextAdapter, NativeLlmRequestError } from '../src/dsh-capabilities/host/llm-text-adapter.js'
import { translationFailure } from '../src/host/features/session-translation-runtime.js'
import { isDshVersionAtLeast } from '../src/shared/contracts/version.js'

const model = { provider: 'fixture', model: 'fixture' }

test('rc.3 and rc.4 retain shared LLM/settings routes and old hosts degrade by structure', () => {
  const context = {
    settings: { describe() {}, mutate() {}, configure() {} },
    llm: { listProviders() { return [] }, async listModels() { return [] }, async *stream() {} },
  }
  for (const version of ['0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4']) {
    const profile = createDshCapabilityRegistry(version, 'host', context).resolve(context)
    assert.equal(profile.capabilities.get('llm.text')?.routeId, 'llm-text-021', version)
    assert.equal(profile.capabilities.get('settings.store')?.routeId, 'settings-forms-020', version)
    const absent = createDshCapabilityRegistry(version, 'host', {}).resolve({})
    assert.equal(absent.capabilities.get('llm.text')?.status, 'unavailable')
    assert.equal(absent.capabilities.get('settings.store')?.status, 'unavailable')
  }
  assert.equal(isDshVersionAtLeast('0.2.2-rc.3', '0.2.2-rc.4'), false)
  assert.equal(isDshVersionAtLeast('0.2.2-rc.4', '0.2.2-rc.4'), true)
  assert.equal(isDshVersionAtLeast('0.2.2-rc.10', '0.2.2-rc.4'), true)
})

for (const throws of [false, true]) {
  test(`partial refusal remains a failed text completion (${throws ? 'iterator throw' : 'error finish'})`, async () => {
    const failure = { code: 'CONTENT_REFUSED', message: 'Provider refused: network timeout 429' }
    const context = { llm: {
      listProviders() { return [] },
      async listModels() { return [] },
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'Unaccepted draft' }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } }
        if (throws) throw Object.assign(new Error(failure.message), { code: failure.code, failure })
        yield { type: 'finish', reason: { kind: 'error', failure } }
      },
    } }
    const adapter = createNativeLlmTextAdapter(context, '0.2.2-rc.4')!
    const previews: string[] = []
    await assert.rejects(adapter.reply(model, '', [], new AbortController().signal, text => previews.push(text)), error => {
      assert.equal((error as { failure: typeof failure }).failure.code, 'CONTENT_REFUSED')
      assert.deepEqual(translationFailure(error), { code: 'provider', retryable: false })
      return true
    })
    assert.deepEqual(previews, ['Unaccepted draft'])
  })
}

test('old malformed responses retain their code and caller cancellation wins over refusal', async () => {
  const malformed = new NativeLlmRequestError({ code: 'MALFORMED_RESPONSE', message: 'Invalid provider frame' })
  assert.equal(malformed.failure.code, 'MALFORMED_RESPONSE')
  assert.deepEqual(translationFailure(malformed), { code: 'provider', retryable: false })
  const controller = new AbortController()
  controller.abort(new DOMException('Cancelled', 'AbortError'))
  assert.deepEqual(translationFailure(new NativeLlmRequestError({
    code: 'CONTENT_REFUSED', message: 'Refused',
  }), controller.signal), { code: 'cancelled', retryable: false })
})
