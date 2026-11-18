import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'

test('a bridge without native maintenance does not start background compaction', async () => {
  let attempts = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'zcode', name: 'ZCode' },
    async detect() { return { installed: true, version: '1', command: 'zcode' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'usage', inputTokens: 1, outputTokens: 1, contextUsageRatio: 0.9 }
      yield { type: 'finish', reason: 'stop' }
    },
    async compact() { attempts++; return { compacted: true } },
  } as never], { zcode: true }, {
    autoCompactionSettleMs: 1,
    nativeSessions: { get: () => undefined, flush: async () => {}, appendCompactionEvent: () => true } as never,
  })
  registry.setSession('s', { adapterId: 'zcode', providerSessionId: 'native' })
  try {
    await Array.fromAsync(registry.execute({ sessionId: 's', adapterId: 'zcode', messages: [], prompt: 'go' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(attempts, 0, 'an older bridge cannot provide the required history transaction lock')
  } finally { await registry.dispose() }
})

test('authoritative context ratio can trigger fallback compaction without a token count', async () => {
  let attempts = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'zcode', name: 'ZCode' }, async detect() { return { installed: true, version: '1', command: 'zcode' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'usage', inputTokens: 1, outputTokens: 1, contextUsageRatio: 0.9 }
      yield { type: 'finish', reason: 'stop' }
    },
    async compact() { attempts++; return { compacted: true } },
  } as never], { zcode: true }, { autoCompactionSettleMs: 1 })
  registry.setSession('s', { adapterId: 'zcode', providerSessionId: 'native' })
  try {
    await Array.fromAsync(registry.execute({ sessionId: 's', adapterId: 'zcode', messages: [], prompt: 'go' }))
    const deadline = Date.now() + 250
    while (!attempts && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(attempts, 1)
  } finally { await registry.dispose() }
})
