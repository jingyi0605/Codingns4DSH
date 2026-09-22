import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../dist/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../dist/host/cli-adapters/session-store.js'

test('Host 会话索引串行持久化并支持归档筛选', async () => {
  const writes = []
  const store = new CodingNsCliSessionStore({ persistence: { async write(records) { writes.push(records) } } })
  store.upsert('dsh-1', { adapterId: 'codex', providerSessionId: 'thread-1', title: '修复登录', status: 'active' })
  store.upsert('dsh-2', { adapterId: 'kimi', title: '整理文档' })
  store.archive('dsh-2')
  await store.flush()

  assert.equal(writes.length, 3)
  assert.deepEqual(store.list().map((record) => record.dshSessionId), ['dsh-1'])
  assert.deepEqual(store.list({ includeArchived: true }).map((record) => record.dshSessionId), ['dsh-2', 'dsh-1'])
  assert.equal(store.get('dsh-1')?.providerSessionId, 'thread-1')
  store.upsert('dsh-1', { adapterId: 'gemini' })
  assert.equal(store.get('dsh-1')?.providerSessionId, undefined)
})

test('Registry 在 session-binding 和完成时更新持久化会话摘要', async () => {
  const store = new CodingNsCliSessionStore()
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'session-binding', providerSessionId: 'provider-1' }
      yield { type: 'text-delta', text: '完成' }
      yield { type: 'finish', reason: 'stop' }
    },
  }], {}, { sessionStore: store })

  registry.setSession('dsh-1', { adapterId: 'fake', modelId: 'm1' })
  const chunks = []
  for await (const chunk of registry.execute({ sessionId: 'dsh-1', adapterId: 'fake', messages: [], prompt: '修复登录', cwd: '/workspace' })) chunks.push(chunk)
  await store.flush()

  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.deepEqual(registry.getSession('dsh-1'), { adapterId: 'fake', modelId: 'm1', providerSessionId: 'provider-1' })
  assert.deepEqual(store.get('dsh-1'), {
    dshSessionId: 'dsh-1', adapterId: 'fake', modelId: 'm1', providerSessionId: 'provider-1',
    title: '修复登录', cwd: '/workspace', status: 'idle',
    createdAt: store.get('dsh-1')?.createdAt, updatedAt: store.get('dsh-1')?.updatedAt,
  })
})
