import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'

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
