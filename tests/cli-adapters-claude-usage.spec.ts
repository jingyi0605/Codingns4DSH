import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { knownClaudeContextWindow } from '../data/build/dist/host/cli-adapters/model-catalog.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { createCodingNsNativeSessionBridge } from '../data/build/dist/host/native-session-bridge.js'

const input = { sessionId: 'claude-usage', messages: [], prompt: '测试', modelId: 'claude-sonnet-4-6' }

test('Claude context uses the latest main-agent request instead of cumulative billing tokens', (t) => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  t.after(() => driver.dispose())
  for (const inputTokens of [100, 150]) {
    parse(driver, { type: 'assistant', message: { model: input.modelId, content: [],
      usage: { input_tokens: inputTokens, cache_read_input_tokens: 40, output_tokens: 3 } } })
  }
  const delta = parse(driver, { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } })[0]!
  assert.equal(delta.contextTokens, 190)
  const child = parse(driver, { type: 'assistant', parent_tool_use_id: 'child-tool',
    message: { model: 'claude-opus-4-7', content: [], usage: { input_tokens: 900, output_tokens: 1 } } })
  assert.deepEqual(child, [])
  const result = parse(driver, { type: 'result', usage: { input_tokens: 250, cache_read_input_tokens: 80, output_tokens: 8 },
    modelUsage: { [input.modelId]: { contextWindow: 200_000 }, 'claude-opus-4-7': { contextWindow: 1_000_000 } } })[0]!
  assert.equal(result.inputTokens, 250)
  assert.equal(result.contextTokens, 190)
  assert.equal(result.contextWindow, 200_000)
  assert.equal(result.contextUsageRatio, 0.00095)
  const otherSession = parse(driver, { type: 'result', usage: { input_tokens: 250, output_tokens: 8 } },
    { ...input, sessionId: 'other-claude-session' })[0]!
  assert.equal(otherSession.contextTokens, undefined)
})

test('Claude provider window can replace the catalog placeholder in native history', (t) => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  t.after(() => driver.dispose())
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  const session = { snapshotEvents: () => [...events], append(type: string, data: unknown) {
    const event = { type, seq: events.length, data }; events.push(event); return event
  } }
  const bridge = createCodingNsNativeSessionBridge({ get(name: string) {
    return name === 'sessions' ? { get: () => session, list: () => [session] } : undefined
  } } as never)
  bridge.appendRequestContext?.(input.sessionId, { provider: 'claude-code', model: input.modelId,
    contextWindow: 1_000_000, confirmed: true, source: 'catalog' })
  for (const value of [
    { type: 'assistant', message: { model: input.modelId, content: [], usage: { input_tokens: 100, output_tokens: 3 } } },
    { type: 'result', usage: { input_tokens: 100, output_tokens: 3 }, modelUsage: { [input.modelId]: { contextWindow: 200_000 } } },
  ]) {
    for (const event of parse(driver, value)) if (event.type === 'usage') bridge.appendUsageSample?.(input.sessionId, event as never)
  }
  assert.equal(events.filter(event => event.type === 'request/context').at(-1)?.data.contextWindow, 200_000)
  assert.equal(events.at(-1)?.data.stream[0].chunk.usage.contextWindow, 200_000)
})

test('Claude preserves SDK result errors and cancellation', (t) => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  t.after(() => driver.dispose())
  const value = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Model unavailable', 'Request rejected'] }
  assert.deepEqual(parse(driver, value), [{ type: 'finish', reason: 'error', failure: { message: 'Model unavailable\nRequest rejected' } }])
  assert.deepEqual(parse(driver, value, { ...input, signal: AbortSignal.abort() } as typeof input), [{ type: 'finish', reason: 'cancel' }])
})

function parse(driver: ClaudeCodeDriver, value: Record<string, unknown>, turnInput: typeof input = input) {
  return (driver as unknown as {
    parseEvent(value: Record<string, unknown>, input: typeof input): readonly Record<string, unknown>[]
  }).parseEvent(value, turnInput)
}

test('Claude Code 从 assistant.message.usage 提取用量并补齐上下文占用', () => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  try {
    assert.equal(knownClaudeContextWindow(' CLAUDE-SONNET-4-6 '), 200_000)
    assert.equal(knownClaudeContextWindow('claude-opus-4-6'), 200_000)
    assert.equal(knownClaudeContextWindow('claude-sonnet-4-6[1m]'), 1_000_000)
    assert.equal(knownClaudeContextWindow('anthropic/claude-sonnet-4.5-20250929'), 200_000)
    assert.equal(knownClaudeContextWindow('claude-sonnet-4-5[1m]'), 1_000_000)
    assert.deepEqual(parse(driver, {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: '完成' }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 5,
          output_tokens: 3,
        },
      },
    }), [{
      type: 'usage',
      inputTokens: 100,
      outputTokens: 3,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      uncachedInputTokens: 100,
      totalTokens: 148,
      cacheHitRate: 27.5862,
      contextTokens: 145,
    }])
  } finally {
    driver.dispose()
  }
})
test('Claude result model names alone do not establish a provider context window', () => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  try {
    assert.deepEqual(parse(driver, {
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 3 },
      modelUsage: { 'claude-sonnet-4-5-20250929': { inputTokens: 100, outputTokens: 3 } },
    }, { ...input, modelId: 'provider-default' }), [{
      type: 'usage',
      inputTokens: 100,
      outputTokens: 3,
    }, { type: 'finish', reason: 'stop' }])
  } finally {
    driver.dispose()
  }
})

test('Claude Code 不把 output-only 的 message_delta 当成空上下文', () => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  try {
    assert.deepEqual(parse(driver, {
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: 3 } },
    }), [{
      type: 'usage',
      inputTokens: 0,
      outputTokens: 3,
    }])
  } finally {
    driver.dispose()
  }
})

test('Claude Code 将模型不可用的错误结果报告为失败', () => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  assert.deepEqual(parse(driver, {
    type: 'result',
    is_error: true,
    api_error_status: 404,
    result: "There's an issue with the selected model (claude-sonnet-5). It may not exist or you may not have access to it.",
  }), [{
    type: 'finish',
    reason: 'error',
    failure: {
      message: "There's an issue with the selected model (claude-sonnet-5). It may not exist or you may not have access to it.",
      code: '404',
    },
  }])
})

test('Claude Code 优先使用 result.modelUsage 报告的上下文窗口', () => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  try {
    assert.deepEqual(parse(driver, {
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 5 },
      modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200_000 } },
    }), [{
      type: 'usage',
      inputTokens: 100,
      outputTokens: 3,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      uncachedInputTokens: 100,
      totalTokens: 148,
      cacheHitRate: 27.5862,
      contextWindow: 200_000,
    }, { type: 'finish', reason: 'stop' }])
  } finally {
    driver.dispose()
  }
})

test('Claude Code 新会话在首个 usage 前写入已知上下文窗口', async () => {
  const contexts: unknown[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'claude-code', name: 'Claude Code' },
    async detect() { return { installed: true, version: '2.1.284', command: 'claude' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } as const },
  }], {}, {
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      async ensure(sessionId: string) { return sessionId },
      async flush() {},
      appendRequestContext(_sessionId: string, context: unknown) { contexts.push(context); return true },
      subscribe() { return () => {} },
    } as never,
  })

  for await (const _chunk of registry.execute({
    adapterId: 'claude-code', sessionId: 'claude-context-preload', modelId: 'claude-sonnet-4-6', messages: [], prompt: '测试',
  })) { /* 消费完整流 */ }

  assert.deepEqual(contexts, [{
    provider: 'codingns-cli-claude-code', model: 'claude-sonnet-4-6', contextWindow: 200_000, confirmed: true, source: 'catalog',
  }])
})
