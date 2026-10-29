import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupLegacyAssistantSettings } from '../data/build/dist/host/settings.js'

const namespace = '@jingyi0605/codingns4dsh'

test('startup cleanup removes only stale assistant keys and preserves unrelated settings', async () => {
  let value: Record<string, unknown> = {
    controlBaseUrl: 'https://control.example.com',
    modules: { globalVoiceAssistant: true, terminalEnhancement: true },
    assistant: { profile: { name: 'legacy' }, voice: { initialized: true } },
    terminalEnhancement: { defaultProfile: 'bash' },
  }
  const operations: unknown[] = []
  const provider = {
    describe: () => [{ ns: namespace, value, revision: 7, writable: true }],
    mutate: async (_ns: string, ops: readonly { op: 'unset'; path: string[] }[]) => {
      operations.push(...ops)
      for (const operation of ops) {
        if (operation.path.length === 1) delete value[operation.path[0]!]
        else {
          const parent = value[operation.path[0]!] as Record<string, unknown>
          delete parent[operation.path[1]!]
        }
      }
    },
  }

  assert.deepEqual(await cleanupLegacyAssistantSettings(provider), { status: 'cleaned' })
  assert.deepEqual(operations, [
    { op: 'unset', path: ['assistant'] },
    { op: 'unset', path: ['modules', 'globalVoiceAssistant'] },
  ])
  assert.deepEqual(value, {
    controlBaseUrl: 'https://control.example.com',
    modules: { terminalEnhancement: true },
    terminalEnhancement: { defaultProfile: 'bash' },
  })
})

test('cleanup is idempotent and does not touch read-only settings', async () => {
  const readonlyProvider = {
    describe: () => [{ ns: namespace, value: { assistant: { profile: {} } }, revision: 2, writable: false }],
    mutate: async () => { throw new Error('must not write') },
  }
  assert.deepEqual(await cleanupLegacyAssistantSettings(readonlyProvider), { status: 'skipped', reason: 'readonly' })

  const cleanProvider = {
    describe: () => [{ ns: namespace, value: { modules: { terminalEnhancement: true } }, revision: 3, writable: true }],
  }
  assert.deepEqual(await cleanupLegacyAssistantSettings(cleanProvider), { status: 'unchanged' })
})

test('cleanup uses replace when the provider cannot express unset operations', async () => {
  let replaced: unknown
  const provider = {
    describe: () => [{ ns: namespace, value: { assistant: { profile: {} }, modules: { globalVoiceAssistant: true } }, revision: 4, writable: true }],
    replace: async (_ns: string, next: object, revision: number) => { replaced = { next, revision } },
  }
  assert.deepEqual(await cleanupLegacyAssistantSettings(provider), { status: 'cleaned' })
  assert.deepEqual(replaced, { next: { modules: {} }, revision: 4 })
})

test('missing settings do not block startup or trigger a write', async () => {
  let writes = 0
  const provider = {
    describe: () => [],
    mutate: async () => { writes += 1 },
  }
  assert.deepEqual(await cleanupLegacyAssistantSettings(provider), { status: 'skipped', reason: 'missing' })
  assert.equal(writes, 0)
})
