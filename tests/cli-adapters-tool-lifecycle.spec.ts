import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { CursorCliDriver } from '../src/host/cli-adapters/cursor-driver.js'
import { KiroCliDriver } from '../src/host/cli-adapters/kiro-driver.js'
import { CommandCodeDriver } from '../src/host/cli-adapters/command-code-driver.js'
import { QoderCliDriver } from '../src/host/cli-adapters/qoder-driver.js'
import { CodeBuddyCliDriver, WorkBuddyCliDriver } from '../src/host/cli-adapters/codebuddy-driver.js'
import { GrokBuildDriver } from '../src/host/cli-adapters/grok-driver.js'
import { GeminiCliDriver } from '../src/host/cli-adapters/gemini-driver.js'
import { MiniMaxCodeDriver } from '../src/host/cli-adapters/mcode-driver.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsDshToolHistoryProjector } from '../src/host/cli-adapters/dsh-tool-history.js'
import type { CodingNsCliDriver } from '../src/host/cli-adapters/driver.js'
import type { CodingNsAgentEvent } from '../src/shared/contracts/cli-adapter.js'

interface Options {
  binaries: string[]
  sessionRoots: string[]
  spawn: typeof spawn
  spawnSync: typeof spawnSync
}
const factories: Record<string, (options: Options) => CodingNsCliDriver> = {
  Cursor: options => new CursorCliDriver(options),
  Kiro: options => new KiroCliDriver(options),
  CommandCode: options => new CommandCodeDriver({ ...options, enableAcp: true }),
  Qoder: options => new QoderCliDriver(options),
  QoderCN: options => new QoderCliDriver({ ...options, variant: 'qoder-cn' }),
  CodeBuddy: options => new CodeBuddyCliDriver(options),
  WorkBuddy: options => new WorkBuddyCliDriver({ ...options, platform: 'darwin' }),
  Grok: options => new GrokBuildDriver(options),
  Gemini: options => new GeminiCliDriver(options),
  MiniMax: options => new MiniMaxCodeDriver(options),
}

/** Exercise the actual ACP driver and Registry; each update keeps its real wire shape. */
function harness(create: (options: Options) => CodingNsCliDriver, turns: readonly (readonly object[])[], failedPrompts: readonly number[] = []) {
  let prompts = 0
  let kills = 0
  const driver = create({
    binaries: ['fake-acp-agent'], sessionRoots: [],
    spawnSync: (() => ({ status: 0, stdout: 'agent 1.2.3 --acp', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      const child = new EventEmitter()
      const emit = (message: object) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
      return Object.assign(child, {
        stdout, stderr,
        stdin: { write(line: string) {
          const request = JSON.parse(line) as { id?: number; method?: string }
          if (request.id === undefined) return true
          if (request.method === 'session/prompt') {
            const updates = [...turns[prompts++] ?? []]
            const failed = failedPrompts.includes(prompts)
            const next = () => {
              const update = updates.shift()
              if (update === undefined) emit(failed
                ? { id: request.id, error: { code: -32000, message: 'Provider connection lost' } }
                : { id: request.id, result: { stopReason: 'end_turn' } })
              else {
                emit({ method: 'session/update', params: { sessionId: 'provider', update } })
                setImmediate(next)
              }
            }
            setImmediate(next)
          } else emit({ id: request.id, result: request.method === 'session/new' || request.method === 'session/load' ? { sessionId: 'provider' } : {} })
          return true
        } },
        kill() { kills++; stdout.end(); stderr.end(); child.emit('exit', 0); return true },
      })
    }) as never,
  })
  const registry = new CodingNsCliAdapterRegistry([driver])
  const run = async (sessionId = 'lifecycle', splitToolSteps = false, options: { signal?: AbortSignal; onEvent?: (event: CodingNsAgentEvent) => void } = {}) => {
    const steps: CodingNsAgentEvent[][] = []
    for (let index = 0; index < 20; index++) {
      const step: CodingNsAgentEvent[] = []
      for await (const event of registry.execute({ adapterId: driver.descriptor.id, sessionId, prompt: 'continue', messages: [], splitToolSteps, ...(options.signal ? { signal: options.signal } : {}) })) {
        step.push(event)
        options.onEvent?.(event)
      }
      steps.push(step)
      if (!step.some(event => event.type === 'step-boundary')) return steps
    }
    assert.fail('Provider did not finish in 20 steps')
  }
  return { driver, registry, run, prompts: () => prompts, kills: () => kills }
}

const start = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash', status: 'in_progress', rawInput: { command: 'task' } })
const update = (id: string, fields: object) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, ...fields })
const text = (value: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })

test('cancelled tools returning late cannot suspend their iterator into the next user turn', async () => {
  const controller = new AbortController()
  let runs = 0
  const driver: CodingNsCliDriver = {
    descriptor: { id: 'late-cancel', name: 'Late cancel', protocol: 'acp', capabilities: [] },
    supportsToolStepSplitting: true,
    async detect() { return { installed: true, command: 'fake', version: '1' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      runs++
      const callId = `call-${runs}`
      yield { type: 'tool-event', callId, toolName: 'Bash', status: 'running' }
      // Some real CLIs keep stdout open until the long-running command returns.
      if (runs === 1) controller.abort()
      yield { type: 'tool-event', callId, toolName: 'Bash', status: 'completed', output: 'done', outputMode: 'snapshot' }
      yield { type: 'text-delta', text: 'Final' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const registry = new CodingNsCliAdapterRegistry([driver])
  const input = { adapterId: driver.descriptor.id, sessionId: 'late-cancel', prompt: 'run', messages: [], splitToolSteps: true }
  try {
    const cancelled: CodingNsAgentEvent[] = []
    for await (const event of registry.execute({ ...input, signal: controller.signal })) cancelled.push(event)
    assert.equal(cancelled.some(event => event.type === 'step-boundary'), false)
    assert.deepEqual(cancelled.at(-1), { type: 'finish', reason: 'cancel' })
    const next: CodingNsAgentEvent[] = []
    for await (const event of registry.execute(input)) next.push(event)
    assert.equal(runs, 2)
    assert.equal(next.some(event => event.type === 'tool-event' && event.callId === 'call-2'), true)
    assert.equal(next.at(-1)?.type, 'step-boundary')
    const final: CodingNsAgentEvent[] = []
    for await (const event of registry.execute(input)) final.push(event)
    assert.equal(runs, 2)
    assert.equal(final.some(event => event.type === 'text-delta' && event.text === 'Final'), true)
  } finally { await registry.dispose() }
})

for (const [name, create] of Object.entries(factories)) {
  test(`${name}: ACP partial output and metadata leave tool status unchanged`, { timeout: 8000 }, async () => {
    const fixture = harness(create, [[
      start('call-1'),
      update('call-1', { rawOutput: 'partial' }),
      update('call-1', { status: 'in_progress', rawOutput: 'still running' }),
      update('call-1', { status: 'completed', rawOutput: 'done' }),
      update('call-1', { title: 'Bash finished' }),
      start('call-2'), update('call-2', { status: 'failed', rawOutput: 'failure' }),
      update('call-2', { title: 'Failure details' }), text('Final'),
    ]])
    try {
      const events = (await fixture.run()).flat()
      const tools = events.filter(event => event.type === 'tool-event')
      assert.deepEqual(tools.map(event => event.status), ['running', undefined, 'running', 'completed', undefined, 'running', 'failed', undefined])
      assert.equal(tools[1]?.output, 'partial')
      assert.equal(events.some(event => event.type === 'text-delta' && event.text === 'Final'), true)
      assert.equal(fixture.prompts(), 1)
    } finally { await fixture.registry.dispose() }
  })
}

for (const name of ['Cursor', 'Kiro', 'CommandCode', 'Qoder', 'QoderCN', 'CodeBuddy', 'WorkBuddy']) {
  test(`${name}: parallel partial output and late metadata preserve step boundaries`, { timeout: 8000 }, async () => {
    const fixture = harness(factories[name]!, [[
      start('call-1'), start('call-2'), update('call-1', { rawOutput: 'partial' }),
      update('call-2', { status: 'completed', rawOutput: 'second done' }),
      update('call-1', { status: 'completed', rawOutput: 'first done' }),
      update('call-1', { title: 'Bash finished' }), text('Intermediate'),
      start('call-3'), update('call-3', { status: 'completed', rawOutput: 'third done' }), text('Final'),
    ]])
    try {
      const steps = await fixture.run('parallel', true)
      assert.equal(steps.length, 3)
      assert.deepEqual(steps.map(step => step.filter(event => event.type === 'tool-event' && event.status === 'completed').map(event => event.callId)), [['call-2', 'call-1'], ['call-3'], []])
      assert.equal(steps[2]?.some(event => event.type === 'text-delta' && event.text === 'Final'), true)
      assert.equal(fixture.prompts(), 1)
      const calls: string[] = []
      const results: string[] = []
      for (const step of steps) {
        const projector = new CodingNsDshToolHistoryProjector({
          appendToolCall(sessionId: string, call: { callId: string }) {
            calls.push(call.callId)
            return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: calls.length }
          },
          appendToolResult(_handle: unknown, result: { output: string }) { results.push(result.output); return true },
        } as never, 'parallel')
        for (const event of step) if (event.type === 'tool-event') projector.observe(event)
        projector.finalize('stop')
      }
      assert.deepEqual(calls, ['call-1', 'call-2', 'call-3'])
      assert.deepEqual(results, ['second done', 'first done', 'third done'])
    } finally { await fixture.registry.dispose() }
  })

  test(`${name}: failed provider turn can resume without old pending tools`, { timeout: 8000 }, async () => {
    const fixture = harness(factories[name]!, [
      [start('old-call'), update('old-call', { rawOutput: 'interrupted' })],
      [start('new-call'), update('new-call', { status: 'completed', rawOutput: 'done' }), text('Final')],
    ], [1])
    try {
      if (['Cursor', 'Kiro', 'CommandCode'].includes(name)) {
        const interrupted = (await fixture.run('resume', true)).flat()
        assert.equal(interrupted.some(event => event.type === 'finish' && event.reason === 'error'), true)
      } else await assert.rejects(fixture.run('resume', true), /Provider connection lost/u)
      const steps = await fixture.run('resume', true)
      assert.equal(steps.length, 2)
      assert.equal(steps[1]?.some(event => event.type === 'text-delta' && event.text === 'Final'), true)
      assert.equal(fixture.prompts(), 2)
    } finally { await fixture.registry.dispose() }
  })

  test(`${name}: cancellation releases the turn before the next prompt`, { timeout: 8000 }, async () => {
    const fixture = harness(factories[name]!, [
      [start('old-call'), update('old-call', { rawOutput: 'interrupted' })],
      [start('new-call'), update('new-call', { status: 'completed', rawOutput: 'done' }), text('Final')],
    ])
    const controller = new AbortController()
    try {
      try {
        const interrupted = (await fixture.run('cancel', true, { signal: controller.signal, onEvent(event) {
          if (event.type === 'tool-event' && event.callId === 'old-call') controller.abort()
        } })).flat()
        assert.equal(interrupted.some(event => event.type === 'finish' && event.reason === 'cancel'), true)
      } catch (error) {
        assert.equal(controller.signal.aborted, true)
        assert.match(String(error), /abort|cancel|请求已取消/u)
      }
      const steps = await fixture.run('cancel', true)
      assert.equal(steps.length, 2)
      assert.equal(steps[1]?.some(event => event.type === 'text-delta' && event.text === 'Final'), true)
      assert.equal(fixture.prompts(), 2)
    } finally { await fixture.registry.dispose() }
  })

  test(`${name}: concurrent sessions keep pending tool batches separate`, { timeout: 8000 }, async () => {
    const fixture = harness(factories[name]!, [
      [start('left'), update('left', { rawOutput: 'partial' }), update('left', { status: 'completed', rawOutput: 'left done' }), text('Left final')],
      [start('right'), update('right', { status: 'completed', rawOutput: 'right done' }), text('Right final')],
    ])
    try {
      const runs = await Promise.all([fixture.run('left-session', true), fixture.run('right-session', true)])
      assert.deepEqual(runs.map(steps => steps.length), [2, 2])
      const finals = runs.map(steps => steps[1]!.filter(event => event.type === 'text-delta').map(event => event.text).join('')).sort()
      assert.deepEqual(finals, ['Left final', 'Right final'])
      assert.equal(fixture.prompts(), 2)
    } finally { await fixture.registry.dispose() }
  })
}
