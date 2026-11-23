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

test('流式分步在 step 边界挂起迭代器，续段继续读同一条 Provider 流', async () => {
  let released = 0
  let calls = 0
  const streamSplit = { ...driver(async function* () {
    calls++
    try {
      yield { type: 'text-delta', text: '第一段' }
      yield { type: 'step-boundary' }
      yield { type: 'text-delta', text: '第二段' }
      yield { type: 'finish', reason: 'stop' }
    } finally { released++ }
  }), supportsStreamStepSplitting: true }
  const registry = new CodingNsCliAdapterRegistry([streamSplit])
  try {
    const first = []
    for await (const event of registry.execute(input())) {
      first.push(event)
      if (event.type === 'step-boundary') break
    }
    assert.deepEqual(first, [{ type: 'text-delta', text: '第一段' }, { type: 'step-boundary' }])
    assert.equal(released, 0, 'step 边界只是挂起，不能关闭仍在续跑的 Provider 流')
    const resumed = []
    for await (const event of registry.execute(input())) {
      resumed.push(event)
      if (event.type === 'finish') break
    }
    assert.equal(calls, 1, '续段必须复用同一个驱动迭代器，而不是重新开始一轮')
    assert.deepEqual(resumed, [{ type: 'text-delta', text: '第二段' }, { type: 'finish', reason: 'stop' }])
    assert.equal(released, 1)
  } finally { await registry.dispose() }
})

test('ZCode forwards an explicit steer to the active driver and resumes the same stream', async () => {
  const prompts: string[] = []
  const steers: string[] = []
  let released = 0
  const zcode = {
    ...driver(async function* (turn: { prompt: string }) {
      prompts.push(turn.prompt)
      try {
        yield { type: 'step-boundary' }
        yield { type: 'text-delta', text: steers.at(-1) ?? '' }
        yield { type: 'finish', reason: 'stop' }
      } finally { released++ }
    }),
    descriptor: { id: 'zcode', name: 'ZCode' },
    supportsStreamStepSplitting: true,
    steer(_sessionId: string, prompt: string) { steers.push(prompt) },
  }
  const registry = new CodingNsCliAdapterRegistry([zcode])
  const first = { ...input(), adapterId: 'zcode', prompt: 'first request' }
  try {
    for await (const event of registry.execute(first)) if (event.type === 'step-boundary') break
    assert.equal(released, 0)
    const second = { ...first, prompt: 'new direction' }
    const events = []
    for await (const event of registry.execute(second)) events.push(event)
    assert.deepEqual(events, [{ type: 'text-delta', text: second.prompt }, { type: 'finish', reason: 'stop' }])
    assert.deepEqual(prompts, [first.prompt])
    assert.deepEqual(steers, [second.prompt])
    assert.equal(released, 1)
  } finally { await registry.dispose() }
})
