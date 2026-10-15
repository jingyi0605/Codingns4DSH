import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'

type Message = Record<string, any>
type Connection = {
  readonly requests: Message[]
  killed: boolean
  emit(message: Message): void
  reply(request: Message, result: Message): void
  update(update: Message, meta?: Message, sessionId?: string): void
}

function createReplay(onRequest: (request: Message, connection: Connection) => void) {
  const connections: Connection[] = []
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.52', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const connection: Connection = {
        requests: [], killed: false,
        emit(message) { stdout.write(`${JSON.stringify(message)}\n`) },
        reply(request, result) { this.emit({ jsonrpc: '2.0', id: request.id, result }) },
        update(update, meta, sessionId = 'provider-session') {
          this.emit({ method: 'session/update', params: { sessionId, update, ...(meta === undefined ? {} : { _meta: meta }) } })
        },
      }
      connections.push(connection)
      return {
        stdout, stderr,
        stdin: { write(data: string) {
          const request = JSON.parse(data)
          connection.requests.push(request)
          if (request.method === 'initialize') connection.reply(request, {})
          else if (request.method === 'session/new' || request.method === 'session/load') connection.reply(request, { sessionId: 'provider-session' })
          else onRequest(request, connection)
        } },
        kill() { connection.killed = true; stdout.end(); stderr.end(); return true },
      }
    }) as never,
  })
  return { driver, connections }
}

const turn = { sessionId: 'host-session', messages: [], prompt: 'Continue' }

async function createTimeline(driver: GrokBuildDriver, options: {
  canInject?: boolean
  inject?: () => boolean
  askQuestions?: (sessionId: string, request: Message) => Promise<unknown>
} = {}) {
  const table = new CodingNsRpcTable()
  const registry = new CodingNsCliAdapterRegistry([driver])
  const history: Message[] = []
  let listener: (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<any>
  let step = 0
  let continued = false
  const features = new FeatureRegistry({
    rpc: table,
    events: { on(_name, next) { listener = next; return () => {} } },
    nativeSessions: {
      available: true, store: undefined, controller: undefined,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      async ensure() { return null },
      async flush() {},
      appendRequestContext() { return true },
      canInjectNextStep() { return options.canInject !== false },
      injectNextStep() { continued = options.inject?.() ?? true; return continued },
      appendToolCall(sessionId, call) {
        history.push({ type: 'tool/call', step, call })
        return { sessionId, turn: 1, step, callId: call.callId, callSeq: history.length }
      },
      appendToolResult(handle, result) {
        history.push({ type: 'tool/result', step: handle.step, callId: handle.callId, result })
        return true
      },
      ...(options.askQuestions ? { askQuestions: options.askQuestions } : {}),
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: turn.sessionId, adapterId: 'grok' })
  return {
    history,
    async run() {
      const allChunks: Message[] = []
      do {
        continued = false
        step++
        assert.ok(step < 100, 'A continuation must make progress')
        const blocks: Message[] = []
        for await (const chunk of listener!({ sessionId: turn.sessionId, messages: [{ role: 'user', content: turn.prompt }] }, async function* () {})) {
          allChunks.push(chunk)
          if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning') && chunk.block.text.trim()) blocks.push(chunk.block)
          // DSH appends assistant content at step settlement, after any native tool writes.
          if (chunk.type === 'finish' && blocks.length) history.push({ type: 'assistant/message', step, blocks: [...blocks] })
        }
      } while (continued)
      return allChunks
    },
    async dispose() { await features.disable('cliAdapters') },
  }
}

for (const metadata of [true, false]) {
  test(`Grok persists assistant messages before parallel tool batches (${metadata ? 'native' : 'legacy'} metadata)`, { timeout: 5_000 }, async () => {
    const replay = createReplay((request, connection) => {
      if (request.method !== 'session/prompt') return
      for (let modelCall = 0; modelCall < 3; modelCall++) {
        const meta = metadata ? { promptId: request.params._meta.promptId, streamStartMs: 100 + modelCall } : undefined
        connection.update({ sessionUpdate: 'agent_thought_chunk', text: `Thinking ${modelCall}.` }, meta)
        connection.update({ sessionUpdate: 'agent_message_chunk', text: `Reply ${modelCall}.` }, meta)
        if (modelCall === 2) break
        // Parallel calls start together and finish in reverse order.
        for (const index of [0, 1]) connection.update({ sessionUpdate: 'tool_call', toolCallId: `call-${modelCall}-${index}`, title: 'read_file', status: 'pending', rawInput: { path: 'example.ts' } }, meta)
        for (const index of [1, 0]) connection.update({ sessionUpdate: 'tool_call_update', toolCallId: `call-${modelCall}-${index}`, status: 'completed', rawOutput: 'file contents' }, meta)
      }
      connection.reply(request, { stopReason: 'end_turn' })
    })
    const timeline = await createTimeline(replay.driver)
    try {
      await timeline.run()
      assert.deepEqual(timeline.history.map(row => [row.type, row.step]), [
        ['assistant/message', 1],
        ['tool/call', 2], ['tool/call', 2], ['tool/result', 2], ['tool/result', 2],
        ['assistant/message', 3],
        ['tool/call', 4], ['tool/call', 4], ['tool/result', 4], ['tool/result', 4],
        ['assistant/message', 5],
      ])
      assert.deepEqual(timeline.history.filter(row => row.type === 'assistant/message').map(row => row.blocks.map(block => block.text)), [
        ['Thinking 0.', 'Reply 0.'], ['Thinking 1.', 'Reply 1.'], ['Thinking 2.', 'Reply 2.'],
      ])
      assert.equal(replay.connections.length, 1)
      assert.equal(replay.connections[0].requests.filter(request => request.method === 'session/prompt').length, 1)
      assert.equal(replay.connections[0].requests.some(request => request.method === 'session/cancel'), false)
      assert.equal(replay.connections[0].killed, false)
    } finally { await timeline.dispose() }
  })
}

test('Grok separates the exported 16-model-call, 82-tool timeline and settles aggregate usage once', { timeout: 5_000 }, async () => {
  // Preserve the reported session's event shape without copying its private content.
  const toolCounts = [3, 6, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 5, 4, 0]
  const textCalls = new Set([0, 1, 3, 5, 15])
  const replay = createReplay((request, connection) => {
    if (request.method !== 'session/prompt') return
    for (const [modelCall, toolCount] of toolCounts.entries()) {
      const meta = { promptId: request.params._meta.promptId, streamStartMs: 100 + modelCall }
      if (modelCall !== 3 && modelCall !== 14) connection.update({ sessionUpdate: 'agent_thought_chunk', text: `Thinking ${modelCall}.` }, meta)
      if (textCalls.has(modelCall)) connection.update({ sessionUpdate: 'agent_message_chunk', text: `Reply ${modelCall}.` }, meta)
      for (let tool = 0; tool < toolCount; tool++) connection.update({ sessionUpdate: 'tool_call', toolCallId: `call-${modelCall}-${tool}`, title: 'read_file', status: 'pending', rawInput: { path: 'example.ts' } }, meta)
      for (let tool = 0; tool < toolCount; tool++) {
        connection.update({ sessionUpdate: 'tool_call_update', toolCallId: `call-${modelCall}-${tool}`, status: 'in_progress' }, meta)
        connection.update({ sessionUpdate: 'tool_call_update', toolCallId: `call-${modelCall}-${tool}`, status: tool === 0 ? 'failed' : 'completed', rawOutput: 'tool result' }, meta)
      }
    }
    connection.update({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: {
      inputTokens: 1249970, outputTokens: 10226, totalTokens: 1260196, cachedReadTokens: 1079168, cacheCreationTokens: 0, modelCalls: 16,
    } })
    connection.reply(request, { stopReason: 'end_turn' })
  })
  const timeline = await createTimeline(replay.driver)
  try {
    const chunks = await timeline.run()
    const messages = timeline.history.filter(row => row.type === 'assistant/message')
    const calls = timeline.history.filter(row => row.type === 'tool/call')
    const results = timeline.history.filter(row => row.type === 'tool/result')
    assert.equal(messages.length, 15)
    assert.equal(messages.flatMap(row => row.blocks).filter(block => block.type === 'reasoning').length, 14)
    assert.equal(messages.flatMap(row => row.blocks).filter(block => block.type === 'text').length, 5)
    assert.equal(calls.length, 82)
    assert.equal(results.length, 82)
    assert.equal(new Set(calls.map(row => row.step)).size, 15)
    assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 30)
    for (let modelCall = 0; modelCall < 15; modelCall++) {
      const batch = calls.filter(row => row.call.callId.startsWith(`call-${modelCall}-`))
      assert.equal(new Set(batch.map(row => row.step)).size, 1, 'Parallel calls belong to one tool step')
      for (const call of batch) assert.equal(results.find(row => row.callId === call.call.callId)?.step, call.step)
      if (modelCall === 14) continue // This model call contains only tools.
      const message = messages.find(row => row.blocks.some(block => block.text === `Reply ${modelCall}.` || block.text === `Thinking ${modelCall}.`))
      assert.ok(message)
      assert.ok(message.step < batch[0].step)
      assert.ok(timeline.history.indexOf(message) < timeline.history.indexOf(batch[0]))
    }
    assert.deepEqual(messages.at(-1)?.blocks.map(block => block.text), ['Thinking 15.', 'Reply 15.'])
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'usage'), [{ type: 'usage', usage: {
      inputTokens: 170802, outputTokens: 10226, totalTokens: 1260196, cacheReadTokens: 1079168, cacheWriteTokens: 0,
    } }])
    assert.equal(replay.connections[0].requests.filter(request => request.method === 'session/prompt').length, 1)
  } finally { await timeline.dispose() }
})

test('Grok retains single-step fallback when DSH cannot inject continuation', { timeout: 3_000 }, async () => {
  const replay = createReplay((request, connection) => {
    if (request.method !== 'session/prompt') return
    connection.update({ sessionUpdate: 'agent_message_chunk', text: 'Before.' }, { streamStartMs: 1 })
    connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call', title: 'read_file', status: 'completed' }, { streamStartMs: 1 })
    connection.update({ sessionUpdate: 'agent_message_chunk', text: 'After.' }, { streamStartMs: 2 })
    connection.reply(request, { stopReason: 'end_turn' })
  })
  const timeline = await createTimeline(replay.driver, { canInject: false })
  try {
    const chunks = await timeline.run()
    assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
    assert.deepEqual(timeline.history.at(-1)?.blocks.map(block => block.text), ['Before.', 'After.'])
    assert.equal(replay.connections[0].requests.filter(request => request.method === 'session/prompt').length, 1)
  } finally { await timeline.dispose() }
})

test('Grok discards a suspended prompt when next-step injection fails', { timeout: 5_000 }, async () => {
  let prompts = 0
  const replay = createReplay((request, connection) => {
    if (request.method !== 'session/prompt') return
    prompts++
    if (prompts === 1) {
      connection.update({ sessionUpdate: 'agent_message_chunk', text: 'Before tools.' }, { streamStartMs: 1 })
      connection.update({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'read_file', status: 'pending' }, { streamStartMs: 1 })
      return
    }
    connection.update({ sessionUpdate: 'agent_message_chunk', text: 'Fresh reply.' }, { streamStartMs: 2 })
    connection.reply(request, { stopReason: 'end_turn' })
  })
  const timeline = await createTimeline(replay.driver, { inject: () => false })
  try {
    await timeline.run()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(replay.connections[0].killed, true)
    assert.ok(replay.connections[0].requests.some(request => request.method === 'session/cancel' && request.id === undefined))
    await timeline.run()
    assert.equal(prompts, 2)
    assert.equal(replay.connections.length, 2)
    assert.ok(replay.connections[1].requests.some(request => request.method === 'session/load'))
    assert.deepEqual(timeline.history.map(row => row.blocks.map(block => block.text)), [['Before tools.'], ['Fresh reply.']])
  } finally { await timeline.dispose() }
})

test('Grok keeps a question and its answer between the surrounding assistant messages', { timeout: 5_000 }, async () => {
  let prompt: Message
  let questions = 0
  const replay = createReplay((request, connection) => {
    if (request.method === 'session/prompt') {
      prompt = request
      connection.update({ sessionUpdate: 'agent_message_chunk', text: 'Choose a format.' }, { streamStartMs: 1 })
      connection.update({ sessionUpdate: 'tool_call', toolCallId: 'question', title: 'ask_user_question', status: 'pending',
        _meta: { 'x.ai/tool': { namespace: 'grok_build', name: 'ask_user_question' } },
        rawInput: { questions: [{ id: 'format', question: 'Which format?', options: [{ label: 'PNG' }] }] },
      }, { streamStartMs: 1 })
      connection.emit({ jsonrpc: '2.0', id: 77, method: '_x.ai/ask_user_question', params: {
        sessionId: 'provider-session', toolCallId: 'question', questions: [{ id: 'format', question: 'Which format?', options: [{ label: 'PNG' }] }],
      } })
    } else if (request.id === 77 && request.result) {
      connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'question', status: 'completed', rawOutput: request.result }, { streamStartMs: 1 })
      connection.update({ sessionUpdate: 'agent_message_chunk', text: 'PNG selected.' }, { streamStartMs: 2 })
      connection.reply(prompt, { stopReason: 'end_turn' })
    }
  })
  const timeline = await createTimeline(replay.driver, { async askQuestions(_sessionId, request) {
    questions++
    return { requestId: request.requestId, answers: [{ id: 'format', selected: ['PNG'] }] }
  } })
  try {
    await timeline.run()
    assert.equal(questions, 1)
    assert.deepEqual(timeline.history.map(row => [row.type, row.step]), [
      ['assistant/message', 1], ['tool/call', 2], ['tool/result', 2], ['assistant/message', 3],
    ])
    assert.deepEqual(timeline.history[0].blocks.map(block => block.text), ['Choose a format.'])
    assert.deepEqual(timeline.history[3].blocks.map(block => block.text), ['PNG selected.'])
    assert.equal(replay.connections[0].requests.filter(request => request.method === 'session/prompt').length, 1)
  } finally { await timeline.dispose() }
})

for (const source of ['notification', 'response'] as const) {
  test(`Grok preserves cancellation from a ${source}`, { timeout: 3_000 }, async () => {
    const replay = createReplay((request, connection) => {
      if (request.method !== 'session/prompt') return
      if (source === 'notification') connection.update({ sessionUpdate: 'turn_completed', stop_reason: 'cancelled' })
      // A terminal notification must not be overwritten by a generic success response.
      connection.reply(request, { stopReason: source === 'response' ? 'cancelled' : 'end_turn' })
    })
    try {
      const events = []
      for await (const event of replay.driver.executeTurn(turn)) events.push(event)
      assert.deepEqual(events.at(-1), { type: 'finish', reason: 'cancel' })
    } finally { replay.driver.dispose() }
  })
}

test('Grok closes a failed question turn before resuming with an image', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-grok-lifecycle-'))
  const imagePath = join(root, 'screenshot.png')
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=', 'base64')
  writeFileSync(imagePath, image)
  let prompts = 0
  let oldPromptId: string | undefined
  const replay = createReplay((request, connection) => {
    if (request.method !== 'session/prompt') return
    prompts++
    if (prompts === 1) {
      oldPromptId = request.params._meta?.promptId
      connection.emit({ jsonrpc: '2.0', id: 77, method: '_x.ai/ask_user_question', params: {
        sessionId: 'provider-session', toolCallId: 'question-1',
        questions: [{ question: 'Provide the article?', options: [{ label: 'Screenshot' }] }],
      } })
      return
    }
    assert.deepEqual(request.params.prompt.at(-1), { type: 'image', data: image.toString('base64'), mimeType: 'image/png' })
    assert.equal(typeof request.params._meta?.promptId, 'string')
    assert.notEqual(request.params._meta.promptId, oldPromptId)
    const meta = { promptId: request.params._meta.promptId, streamStartMs: 200 }
    // A late update from the abandoned prompt must not finish the image turn.
    connection.update({ sessionUpdate: 'agent_message_chunk', text: 'Please paste the article.' }, { promptId: oldPromptId })
    connection.update({ sessionUpdate: 'turn_completed', prompt_id: oldPromptId, stop_reason: 'end_turn' })
    connection.update({ sessionUpdate: 'agent_message_chunk', text: 'I can read the screenshot.' }, meta)
    connection.update({ sessionUpdate: 'turn_completed', prompt_id: meta.promptId, stop_reason: 'end_turn' })
    connection.reply(request, { stopReason: 'end_turn' })
  })
  try {
    const projector = new CodingNsDshMessageProjector({
      adapterId: 'grok', sessionId: turn.sessionId,
      nativeSessions: { askQuestions: async () => null },
      respondQuestion: response => replay.driver.respondQuestion(turn.sessionId, response),
    })
    await assert.rejects(async () => {
      for await (const event of replay.driver.executeTurn(turn)) {
        if (event.type === 'question-request') await new Promise(resolve => setImmediate(resolve))
        await projector.push(event)
      }
    }, /DSH/u)
    assert.equal(replay.connections[0]?.killed, true, 'An abandoned process cannot leak unscoped updates into the next turn')
    assert.ok(replay.connections[0]?.requests.some(request => request.method === 'session/cancel' && request.id === undefined))
    assert.ok(replay.connections[0]?.requests.some(request => request.id === 77 && request.result?.outcome === 'cancelled'))

    const events = []
    for await (const event of replay.driver.executeTurn({ ...turn, prompt: '', attachments: [{ kind: 'image', path: imagePath }] })) events.push(event)
    assert.equal(replay.connections.length, 2)
    assert.equal(replay.connections[1]?.requests.find(request => request.method === 'session/load')?.params.sessionId, 'provider-session')
    assert.deepEqual(events.filter(event => event.type === 'text-delta').map(event => event.text), ['I can read the screenshot.'])
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
  } finally {
    replay.driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Grok ignores updates belonging to another session or prompt', { timeout: 3_000 }, async () => {
  const replay = createReplay((request, connection) => {
    if (request.method !== 'session/prompt') return
    const promptId = request.params._meta?.promptId
    connection.update({ sessionUpdate: 'turn_failed', message: 'Another session failed' }, { promptId }, 'other-session')
    connection.update({ sessionUpdate: 'agent_message_chunk', text: 'Stale reply' }, { promptId: 'old-prompt' })
    connection.update({ sessionUpdate: 'turn_failed', prompt_id: 'old-prompt', message: 'Old failure' })
    connection.update({ sessionUpdate: 'agent_message_chunk', text: 'Current reply' }, { promptId })
    connection.reply(request, { stopReason: 'end_turn' })
  })
  try {
    const events = []
    for await (const event of replay.driver.executeTurn(turn)) events.push(event)
    assert.deepEqual(events.filter(event => event.type === 'text-delta').map(event => event.text), ['Current reply'])
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
  } finally { replay.driver.dispose() }
})

for (const metadata of [true, false]) {
  test(`Grok separates thinking and text across model calls (${metadata ? 'native metadata' : 'legacy tool boundaries'})`, { timeout: 3_000 }, async () => {
    const replay = createReplay((request, connection) => {
      if (request.method !== 'session/prompt') return
      for (let step = 0; step < 3; step++) {
        const meta = metadata ? { promptId: request.params._meta?.promptId, streamStartMs: 100 + step } : undefined
        connection.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `Thinking ${step}.` } }, meta)
        connection.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' More.' } }, meta)
        connection.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Reply ${step}.` } }, meta)
        if (step < 2) connection.update({ sessionUpdate: 'tool_call_update', toolCallId: `tool-${step}`, title: 'search', status: 'completed' }, meta)
      }
      connection.reply(request, { stopReason: 'end_turn' })
    })
    try {
      const projector = new CodingNsDshMessageProjector({ adapterId: 'grok', sessionId: turn.sessionId })
      const chunks = []
      for await (const event of replay.driver.executeTurn(turn)) chunks.push(...await projector.push(event))
      for (const channel of ['reasoning', 'text']) {
        const blocks = chunks.filter(chunk => chunk.type === 'block-end' && (chunk.block as Message)?.type === channel && (chunk.block as Message).text.trim() !== '')
        assert.equal(new Set(blocks.map(block => block.index)).size, 3)
        assert.deepEqual(blocks.map(block => (block.block as Message).text), [0, 1, 2].map(step => channel === 'reasoning' ? `Thinking ${step}. More.` : `Reply ${step}.`))
      }
    } finally { replay.driver.dispose() }
  })
}

test('Grok cancellation does not wait for a response to the ACP cancel notification', { timeout: 3_000 }, async () => {
  const controller = new AbortController()
  const replay = createReplay((request, connection) => {
    if (request.method === 'session/prompt') connection.update({ sessionUpdate: 'agent_message_chunk', text: 'Working' })
  })
  try {
    const events = []
    for await (const event of replay.driver.executeTurn({ ...turn, signal: controller.signal })) {
      events.push(event)
      if (event.type === 'text-delta') controller.abort()
    }
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'cancel' })
    assert.ok(replay.connections[0]?.requests.some(request => request.method === 'session/cancel' && request.id === undefined))
    assert.equal(replay.connections[0]?.killed, true)
  } finally { replay.driver.dispose() }
})
