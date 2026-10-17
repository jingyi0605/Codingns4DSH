import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../src/host/cli-adapters/claude-driver.js'
import { createSubagentBridgeRuntime, getSubagentBridge, setSubagentBridge } from '../src/host/cli-bridge/bridge-holder.js'
import type { CodingNsAgentEvent, CodingNsCliTurnInput } from '../src/shared/contracts/cli-adapter.js'

const providerSessionId = 'retained-claude-conversation'
const retry = (attempt: number, error = 'server_error', status: number | null = 502) => ({
  type: 'system', subtype: 'api_retry', session_id: providerSessionId,
  attempt, max_retries: 10, retry_delay_ms: 536, error_status: status, error,
})

/** Leave stdout open between a retry notice and its eventual provider outcome. */
function replay(afterRetry: (send: (value: object) => void, close: () => void) => void) {
  let killed = false
  let launches = 0
  let args: readonly string[] = []
  const sent: object[] = []
  const input: Record<string, unknown>[] = []
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.301', stderr: '' })) as never,
    spawn: ((_command: string, argv: readonly string[]) => {
      launches++
      args = argv
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
      stdin.on('data', data => input.push(JSON.parse(String(data))))
      const send = (value: object): void => { sent.push(value); stdout.write(`${JSON.stringify(value)}\n`) }
      queueMicrotask(() => {
        send({ type: 'system', subtype: 'init', session_id: providerSessionId })
        send(retry(1))
        setImmediate(() => {
          if (!killed) afterRetry(send, () => { stdout.end(); stderr.end() })
        })
      })
      return { stdin, stdout, stderr, kill() { killed = true; stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  return { driver, sent, input, launches: () => launches, args: () => args, killed: () => killed }
}

async function collect(driver: ClaudeCodeDriver, input: Partial<CodingNsCliTurnInput> = {}): Promise<CodingNsAgentEvent[]> {
  const events: CodingNsAgentEvent[] = []
  for await (const event of driver.executeTurn({
    sessionId: 'claude-retry', messages: [], prompt: 'Continue the assigned task', modelId: 'sonnet',
    permission: { sandboxMode: 'workspace-write', approvalPolicy: 'never' }, ...input,
  })) events.push(event)
  return events
}

for (const role of ['ordinary', 'lead', 'teammate'] as const) {
  test(`Claude ${role} keeps the same invocation alive through API retries`, async t => {
    const previous = getSubagentBridge()
    t.after(() => setSubagentBridge(previous))
    const caller = {}, signal = new AbortController().signal
    setSubagentBridge(createSubagentBridgeRuntime({
      baseUrl: 'http://127.0.0.1:1', token: 'unused-test-token',
      teamAccess: sessionId => role === 'ordinary' ? undefined : {
        caller, signal, identity: { sessionId, teamId: 'team', name: role, role },
      },
    }))
    const f = replay(send => {
      send(retry(2, 'rate_limit', 429))
      send(retry(3, 'unknown', null))
      send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Recovered' } } })
      send({ type: 'result', subtype: 'success', result: 'Recovered', session_id: providerSessionId })
    })
    t.after(() => f.driver.dispose())
    const resumed = role === 'teammate'
    const events = await collect(f.driver, resumed ? { providerSessionId } : {})
    assert.deepEqual(events.filter(event => event.type === 'finish'), [{ type: 'finish', reason: 'stop' }])
    assert.equal(events.filter(event => event.type === 'text-delta').map(event => event.text).join(''), 'Recovered')
    assert.equal(events.filter(event => event.type === 'session-binding').length, resumed ? 0 : 1)
    assert.equal(f.launches(), 1, 'The adapter must leave retries to the existing Claude invocation')
    assert.equal(f.input.filter(message => message.type === 'user').length, 1, 'A retry must not replay the prompt')
    assert.equal(f.args().includes('--allowedTools'), role !== 'ordinary')
    assert.equal(f.args().includes('--resume'), resumed)
    assert.equal(f.args()[f.args().indexOf('--model') + 1], 'sonnet', 'Retries must not silently change models')
    assert.equal(f.killed(), true, 'The actual terminal result still releases the process')
  })
}

test('Claude reports the final SDK failure after retries are exhausted', async t => {
  const f = replay(send => {
    send(retry(10))
    send({ type: 'result', subtype: 'error_during_execution', is_error: true,
      api_error_status: 502, errors: ['502 Upstream service temporarily unavailable'] })
  })
  t.after(() => f.driver.dispose())
  const events = await collect(f.driver)
  assert.deepEqual(events.filter(event => event.type === 'finish'), [{ type: 'finish', reason: 'error',
    failure: { message: '502 Upstream service temporarily unavailable', code: '502' } }])
  assert.equal(f.launches(), 1)
  assert.equal(f.killed(), true)
})

test('Claude remains interruptible while waiting for its own retry', async t => {
  const controller = new AbortController()
  const f = replay(() => controller.abort())
  t.after(() => f.driver.dispose())
  const events = await collect(f.driver, { signal: controller.signal })
  assert.deepEqual(events.filter(event => event.type === 'finish'), [{ type: 'finish', reason: 'cancel' }])
  assert.equal(f.killed(), true)
})

test('Claude retry followed by stdout EOF cannot become a successful turn', async t => {
  const f = replay((_send, close) => close())
  t.after(() => f.driver.dispose())
  await assert.rejects(collect(f.driver), /Claude Code/)
})

test('Claude still reports a genuine error event after a retry notice', async t => {
  const f = replay(send => send({ type: 'error', error: { message: 'Request rejected', code: 'BAD_REQUEST' } }))
  t.after(() => f.driver.dispose())
  const events = await collect(f.driver)
  assert.deepEqual(events.filter(event => event.type === 'finish'), [{ type: 'finish', reason: 'error',
    failure: { message: 'Request rejected', code: 'BAD_REQUEST' } }])
})
