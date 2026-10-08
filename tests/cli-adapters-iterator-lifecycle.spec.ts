import assert from 'node:assert/strict'
import test from 'node:test'
import type { CodingNsAgentEvent } from '../src/shared/contracts/cli-adapter.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'

function driver(executeTurn: () => AsyncIterable<CodingNsAgentEvent>) {
  return { descriptor: { id: 'lifecycle', name: '生命周期测试' },
    async detect() { return { installed: true, version: 'test', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } }, executeTurn }
}
const input = () => ({ adapterId: 'lifecycle', sessionId: 'same-session', messages: [], prompt: '测试' })

test('Registry 在消费者收到 stop、cancel 或 error 后退出时执行驱动 finally', async () => {
  for (const reason of ['stop', 'cancel', 'error'] as const) {
    let released = 0
    const registry = new CodingNsCliAdapterRegistry([driver(async function* () {
      try { yield { type: 'finish', reason } } finally { released++ }
    })])
    try {
      for await (const _event of registry.execute(input())) break
      assert.equal(released, 1, `${reason} 必须释放驱动迭代器`)
      for await (const _event of registry.execute(input())) break
      assert.equal(released, 2)
    } finally { await registry.dispose() }
  }
})

test('Registry 在消费者提前放弃正文时关闭流，不继续拉取模型输出', async () => {
  let released = false
  let advanced = false
  const registry = new CodingNsCliAdapterRegistry([driver(async function* () {
    try { yield { type: 'text-delta', text: '开头' }; advanced = true }
    finally { released = true }
  })])
  try {
    for await (const _event of registry.execute(input())) break
    assert.equal(released, true)
    assert.equal(advanced, false)
  } finally { await registry.dispose() }
})

test('Registry 保留主动挂起的工具流，续段最终结束时才释放', async () => {
  let released = 0
  let calls = 0
  const registry = new CodingNsCliAdapterRegistry([driver(async function* () {
    calls++
    try {
      yield { type: 'tool-event', toolName: 'test', callId: 'call', status: 'completed' }
      yield { type: 'text-delta', text: '工具之后的回答' }
      yield { type: 'finish', reason: 'stop' }
    } finally { released++ }
  })])
  try {
    for await (const event of registry.execute({ ...input(), splitToolSteps: true })) if (event.type === 'step-boundary') break
    assert.equal(released, 0)
    const resumed = []
    for await (const event of registry.execute({ ...input(), splitToolSteps: true })) {
      resumed.push(event)
      if (event.type === 'finish') break
    }
    assert.equal(calls, 1)
    assert.equal(released, 1)
    assert.deepEqual(resumed, [{ type: 'text-delta', text: '工具之后的回答' }, { type: 'finish', reason: 'stop' }])
  } finally { await registry.dispose() }
})
