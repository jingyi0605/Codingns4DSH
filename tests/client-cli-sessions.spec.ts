import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveCliSession, listCliSessions, restoreCliSession } from '../data/build/dist/client/cli-catalog.js'
import type { CodingNsCliSessionRecord } from '../data/build/dist/shared/contracts/cli-adapter.js'

const record: CodingNsCliSessionRecord = {
  dshSessionId: 'dsh-session-1',
  adapterId: 'codex',
  providerSessionId: 'thread-1',
  modelId: 'gpt-5-codex',
  effortId: 'high',
  title: '修复登录问题',
  status: 'idle',
  createdAt: '2026-09-22T08:00:00.000Z',
  updatedAt: '2026-09-22T08:01:00.000Z',
}

test('Client 会话列表兼容 Host 的 items 包装并过滤不完整记录', async () => {
  const rpc = {
    call: async (_channel: string, endpoint: string) => {
      assert.equal(endpoint, 'cli/session/list')
      return { ok: true as const, value: { items: [{ ...record, rawStoreRef: '/host/private/session.jsonl' }, { dshSessionId: 'missing' }] } }
    },
  }
  assert.deepEqual(await listCliSessions(rpc), [record])
})

test('恢复外部会话先保存选择和 provider 绑定', async () => {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      return { ok: true as const, value: {} }
    },
  }
  await restoreCliSession(rpc, record)
  assert.deepEqual(calls, [{
    endpoint: 'cli/session/set',
    payload: {
      sessionId: 'dsh-session-1',
      adapterId: 'codex',
      modelId: 'gpt-5-codex',
      effortId: 'high',
      providerSessionId: 'thread-1',
    },
  }])
})

test('移除外部会话调用 Host 的原生归档链路', async () => {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      return { ok: true as const, value: {} }
    },
  }

  await archiveCliSession(rpc, record.dshSessionId)

  assert.deepEqual(calls, [{
    endpoint: 'cli/session/archive',
    payload: { sessionId: 'dsh-session-1' },
  }])
})
