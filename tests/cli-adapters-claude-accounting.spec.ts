import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClaudeCodeDriver } from '../src/host/cli-adapters/claude-driver.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'

type RecordValue = Record<string, any>
const firstUsage = { input_tokens: 100, output_tokens: 114, cache_read_input_tokens: 40, cache_creation_input_tokens: 5 }
const lastUsage = { input_tokens: 200, output_tokens: 57, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 }
const totalUsage = { input_tokens: 300, output_tokens: 171, cache_read_input_tokens: 100, cache_creation_input_tokens: 15 }
const assistant = (id: string, usage: object | undefined, tools: readonly string[] = []): RecordValue => ({
  type: 'assistant', message: { id, model: 'claude-sonnet-4-6', ...(usage === undefined ? {} : { usage }),
    content: tools.map(tool => ({ type: 'tool_use', id: tool, name: 'Read', input: { file_path: 'fixture.txt' } })),
  },
})
const toolResult = (id: string): RecordValue => ({ type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: id, content: 'Fixture contents' },
] } })

function transcript(options: { parallel?: boolean; aggregate?: boolean; perRequest?: boolean; error?: boolean; duplicate?: boolean } = {}): RecordValue[] {
  const tools = options.parallel ? ['read-1', 'read-2'] : ['read-1']
  const first = assistant('message-1', options.perRequest === false ? undefined : firstUsage, tools)
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'message-1', model: 'claude-sonnet-4-6',
      ...(options.perRequest === false ? {} : { usage: { ...firstUsage, output_tokens: 0 } }),
    } } },
    first, ...(options.duplicate ? [first] : []), ...tools.map(toolResult),
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished' } } },
    assistant('message-2', options.perRequest === false ? undefined : lastUsage),
    { type: 'result', ...(options.aggregate === false ? {} : { usage: totalUsage }),
      modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } },
      ...(options.error ? { is_error: true, errors: ['Request failed'] } : {}),
    },
  ]
}

function replayDriver(transcripts: readonly (readonly RecordValue[])[]) {
  let spawns = 0
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'], sessionRoots: [],
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.288', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      const rows = transcripts[spawns++]!
      queueMicrotask(() => {
        for (const row of rows) stdout.write(JSON.stringify(row) + '\n')
        stdout.end(); stderr.end()
      })
      return { stdout, stderr, kill() { return true } }
    }) as never,
  })
  return { driver, spawns: () => spawns }
}

/** Exercise the public driver and the Registry's real continuation boundaries. */
async function settle(registry: CodingNsCliAdapterRegistry, splitToolSteps = true) {
  const chunks: RecordValue[] = []
  const settlements: { step: number; usage: RecordValue }[] = []
  let continued: boolean
  let steps = 0
  do {
    continued = false
    assert.ok(++steps < 10, 'A continuation must make progress')
    const projector = new CodingNsDshMessageProjector({ adapterId: 'claude-code', sessionId: 'accounting' })
    const stepChunks: RecordValue[] = []
    for await (const event of registry.execute({ adapterId: 'claude-code', sessionId: 'accounting', messages: [], prompt: 'Read the fixture', splitToolSteps })) {
      if (event.type === 'step-boundary') continued = true
      stepChunks.push(...await projector.push(event))
    }
    stepChunks.push(...await projector.complete())
    chunks.push(...stepChunks)
    settlements.push(...stepChunks.filter(chunk => chunk.type === 'usage').map(chunk => ({ step: steps, usage: chunk.usage })))
  } while (continued)
  return { steps, settlements, usages: settlements.map(value => value.usage), finish: chunks.at(-1) }
}

test('Claude tool-step accounting does not add an earlier request to the cumulative result twice', async () => {
  const replay = replayDriver([transcript()])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const result = await settle(registry)
    assert.equal(result.steps, 2)
    assert.equal(replay.spawns(), 1, 'Both steps resume the same provider invocation')
    assert.deepEqual(result.usages.map(usage => usage.outputTokens), [114, 57])
    assert.deepEqual(result.usages.map(usage => usage.inputTokens), [100, 200])
    assert.deepEqual(result.usages.map(usage => usage.cacheReadTokens), [40, 60])
    assert.deepEqual(result.usages.map(usage => usage.cacheWriteTokens), [5, 10])
    assert.equal(result.usages.reduce((sum, usage) => sum + usage.outputTokens, 0), 171)
    assert.equal(result.usages.reduce((sum, usage) => sum + usage.totalTokens, 0), 586)
  } finally { await registry.dispose() }
})

test('Claude preserves complete aggregate usage when DSH does not split tool steps', async () => {
  const replay = replayDriver([transcript()])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const result = await settle(registry, false)
    assert.equal(result.steps, 1)
    assert.deepEqual(result.usages.map(usage => usage.outputTokens), [171])
    assert.equal(result.usages[0].inputTokens, 300)
  } finally { await registry.dispose() }
})

test('Claude parallel tool results and duplicate assistant snapshots settle each usage only once', async () => {
  const replay = replayDriver([transcript({ parallel: true, duplicate: true })])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const result = await settle(registry)
    assert.equal(result.steps, 3)
    assert.deepEqual(result.usages.map(usage => usage.outputTokens), [114, 57])
    assert.equal(replay.spawns(), 1)
  } finally { await registry.dispose() }
})

test('Claude retains request accounting when the terminal result omits usage', async () => {
  const replay = replayDriver([transcript({ aggregate: false })])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const result = await settle(registry)
    assert.deepEqual(result.usages.map(usage => usage.outputTokens), [114, 57])
  } finally { await registry.dispose() }
})

test('Claude aggregate-only accounting is preserved across an otherwise empty tool step', async () => {
  const replay = replayDriver([transcript({ perRequest: false })])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const result = await settle(registry)
    assert.equal(result.steps, 2)
    assert.deepEqual(result.usages.map(usage => usage.outputTokens), [171])
    assert.equal(result.usages[0].inputTokens, 300)
  } finally { await registry.dispose() }
})

test('Claude deducts only the output-only snapshot actually settled in a preceding step', async () => {
  const rows = transcript()
  rows.splice(2, 0, { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 114 } } })
  const replay = replayDriver([rows])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const result = await settle(registry)
    assert.deepEqual(result.usages.map(usage => usage.outputTokens), [114, 57])
    assert.equal(result.usages.reduce((sum, usage) => sum + usage.inputTokens, 0), 300)
    assert.equal(result.usages.reduce((sum, usage) => sum + (usage.cacheReadTokens ?? 0), 0), 100)
    assert.equal(result.usages.reduce((sum, usage) => sum + (usage.cacheWriteTokens ?? 0), 0), 15)
  } finally { await registry.dispose() }
})

test('Claude emits a zero remainder when the aggregate contains only an already-settled request', async () => {
  const replay = replayDriver([[assistant('message-1', firstUsage, ['read-1']), toolResult('read-1'), { type: 'result', usage: firstUsage }]])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const result = await settle(registry)
    assert.deepEqual(result.usages.map(usage => usage.outputTokens), [114, 0])
    assert.equal(result.usages[1].inputTokens, 0)
    assert.equal(result.usages[1].cacheReadTokens, 0)
    assert.equal(result.usages[1].cacheWriteTokens, 0)
    assert.equal(result.usages[1].cacheHitRate, undefined)
  } finally { await registry.dispose() }
})

test('Claude does not subtract one user turn\'s accounting from the next turn or an error result', async () => {
  const replay = replayDriver([transcript(), transcript({ error: true })])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const first = await settle(registry)
    const next = await settle(registry)
    assert.deepEqual(first.usages.map(usage => usage.outputTokens), [114, 57])
    assert.deepEqual(next.usages.map(usage => usage.outputTokens), [114, 57])
    assert.equal(replay.spawns(), 2)
    assert.equal(typeof next.finish?.reason, 'object')
    assert.match(JSON.stringify(next.finish), /Request failed/)
  } finally { await registry.dispose() }
})

// Load pinned DSH libraries into memory; no server, profile, or provider is started.
const runtime = process.env.CODINGNS_STAGE0_RUNTIME_DIR
  ?? join(homedir(), '.local/share/codingns/deepseek-harness/0.2.1-alpha.3/node_modules/@deepseek-ai')
test('real DSH billing projection records the Claude turn aggregate exactly once', { skip: !existsSync(join(runtime, 'dsh-token-meter/lib/index.js')) }, async () => {
  const [{ Context }, { SessionProjectionRegistry }, { Session }, { TokenMeter }] = await Promise.all([
    'cordis/lib/index.js', 'dsh-session-projection/lib/index.js', 'dsh-session/lib/index.js', 'dsh-token-meter/lib/index.js',
  ].map(path => import(pathToFileURL(join(runtime, path)).href)))
  const ctx = new Context(), projections = new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const replay = replayDriver([transcript()])
  const registry = new CodingNsCliAdapterRegistry([replay.driver])
  try {
    const result = await settle(registry)
    const session = new Session('claude-accounting-fixture')
    session.append('turn/start', { turn: 1 })
    const bridge = createCodingNsNativeSessionBridge({ get: (key: string) => key === 'sessions' ? { get: () => session, list: () => [session] } : undefined } as never)
    for (const { step, usage } of result.settlements) {
      session.append('step/start', { turn: 1, step })
      assert.equal(bridge.appendUsageSample?.(session.id, usage as never), true)
      session.append('assistant/message', { turn: 1, step, message: { role: 'assistant', content: [] }, stream: [], usage }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
    const expected = { uncachedInputTokens: 300, outputTokens: 171, cacheReadTokens: 100, cacheWriteTokens: 15 }
    assert.deepEqual(projections.snapshot(session).values.tokenUsage, expected)
    const checkpoint = JSON.parse(JSON.stringify(projections.checkpoint(session)))
    assert.deepEqual(projections.viewCheckpoint(checkpoint).tokenUsage, expected)
    assert.deepEqual(projections.restore({}, session.snapshotEvents(), 0, session.header, 0).snapshot.values.tokenUsage, expected)
  } finally { await registry.dispose() }
})
