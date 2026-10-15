import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { knownClaudeContextWindow } from '../data/build/dist/host/cli-adapters/model-catalog.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'

const input = { sessionId: 'claude-usage', messages: [], prompt: '测试', modelId: 'claude-sonnet-4-6' }

function parse(driver: ClaudeCodeDriver, value: Record<string, unknown>, turnInput: typeof input = input) {
  return (driver as unknown as {
    parseEvent(value: Record<string, unknown>, input: typeof input): readonly Record<string, unknown>[]
  }).parseEvent(value, turnInput)
}

test('Claude Code 从 assistant.message.usage 提取用量并补齐上下文占用', () => {
  const driver = new ClaudeCodeDriver({ binaries: ['fake-claude'] })
  try {
    assert.equal(knownClaudeContextWindow(' CLAUDE-SONNET-4-6 '), 1_000_000)
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
      contextWindow: 1_000_000,
      contextTokens: 145,
      contextUsageRatio: 0.000145,
    }])
  } finally {
    driver.dispose()
  }
})
test('Claude Code 从 result.modelUsage 的模型键恢复已知上下文窗口', () => {
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
      contextWindow: 200_000,
      contextTokens: 100,
      contextUsageRatio: 0.0005,
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
      contextWindow: 1_000_000,
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
      contextTokens: 145,
      contextUsageRatio: 0.000725,
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
    provider: 'claude-code', model: 'claude-sonnet-4-6', contextWindow: 1_000_000, confirmed: true, source: 'catalog',
  }])
})
