import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCliSessionConfig, rememberCliSessionConfig } from '../data/build/dist/client/cli-session-config-cache.js'

test('会话配置并发读取合并为一次 RPC，并在短期内复用快照', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const rpc = {
    call: async (_channel: string, endpoint: string) => {
      assert.equal(endpoint, 'cli/session/get')
      calls += 1
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true as const, value: { adapterId: 'claude-code', modelId: 'sonnet' } }
    },
  }
  const first = loadCliSessionConfig(rpc, 'session-1')
  const second = loadCliSessionConfig(rpc, 'session-1')
  assert.equal(calls, 1)
  release?.()
  assert.deepEqual(await first, { adapterId: 'claude-code', modelId: 'sonnet' })
  assert.deepEqual(await second, { adapterId: 'claude-code', modelId: 'sonnet' })
  assert.deepEqual(await loadCliSessionConfig(rpc, 'session-1'), { adapterId: 'claude-code', modelId: 'sonnet' })
  assert.equal(calls, 1)
})

test('会话配置写入会立即替换共享快照', async () => {
  let calls = 0
  const rpc = {
    call: async () => {
      calls += 1
      return { ok: true as const, value: { adapterId: 'dsh' } }
    },
  }
  await loadCliSessionConfig(rpc, 'session-2')
  rememberCliSessionConfig(rpc, 'session-2', { adapterId: 'codex', modelId: 'gpt-5-codex' })
  assert.deepEqual(await loadCliSessionConfig(rpc, 'session-2'), { adapterId: 'codex', modelId: 'gpt-5-codex' })
  assert.equal(calls, 1)
})
