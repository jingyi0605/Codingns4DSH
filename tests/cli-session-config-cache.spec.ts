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

test('较早在途读取完成后不会覆盖刚写入的会话选择', async () => {
  let release: (() => void) | undefined
  const rpc = {
    call: async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true as const, value: { adapterId: 'codex', modelId: '旧模型' } }
    },
  }
  const pending = loadCliSessionConfig(rpc, 'session-race')
  rememberCliSessionConfig(rpc, 'session-race', { adapterId: 'zcode', providerId: 'real-provider', modelId: '新模型' })
  release?.()
  assert.deepEqual(await pending, { adapterId: 'codex', modelId: '旧模型' })
  assert.deepEqual(await loadCliSessionConfig(rpc, 'session-race'), { adapterId: 'zcode', providerId: 'real-provider', modelId: '新模型' })
})

test('强制读取会跳过短期快照', async () => {
  let calls = 0
  const rpc = {
    call: async (_channel: string, endpoint: string) => {
      assert.equal(endpoint, 'cli/session/get')
      calls += 1
      return { ok: true as const, value: { adapterId: calls === 1 ? 'codex' : 'zcode', modelId: calls === 1 ? 'gpt-5' : 'provider/model' } }
    },
  }
  await loadCliSessionConfig(rpc, 'session-3')
  assert.deepEqual(await loadCliSessionConfig(rpc, 'session-3', { force: true }), { adapterId: 'zcode', modelId: 'provider/model' })
  assert.equal(calls, 2)
})
