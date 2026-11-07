import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { PiAgentDriver } from '../src/host/cli-adapters/pi-driver.js'
import { PiPerformanceTracker } from '../src/host/cli-adapters/pi-performance.js'
import { grokPerformanceProjection } from '../src/host/cli-adapters/grok-performance-projection.js'
import { piPerformanceProjection } from '../src/host/cli-adapters/pi-performance-projection.js'

test('Pi measures observed assistant output from message lifecycle timestamps', () => {
  const tracker = new PiPerformanceTracker()
  tracker.observe({ type: 'turn_start' }, 100)
  tracker.observe({ type: 'message_start', message: { role: 'assistant', id: 'assistant-1' } }, 110)
  tracker.observe({
    type: 'message_update',
    usage: { output: 12 },
    assistantMessageEvent: { type: 'text_delta', delta: 'first' },
  }, 125)
  const sample = tracker.observe({
    type: 'message_end',
    message: { role: 'assistant', id: 'assistant-1', usage: { output: 120 } },
  }, 1_125)

  assert.deepEqual(sample && {
    startedAt: sample.startedAt,
    firstTokenAt: sample.firstTokenAt,
    completedAt: sample.completedAt,
    outputTokens: sample.outputTokens,
  }, { startedAt: 110, firstTokenAt: 125, completedAt: 1_125, outputTokens: 120 })
})

test('Pi measures tool-call-only assistant messages and keeps Pi samples out of Grok statistics', () => {
  const tracker = new PiPerformanceTracker()
  tracker.observe({ type: 'turn_start' }, 0)
  tracker.observe({ type: 'message_start', message: { role: 'assistant', id: 'assistant-tool' } }, 10)
  tracker.observe({
    type: 'message_update',
    usage: { output: 4 },
    assistantMessageEvent: { type: 'toolcall_start', id: 'call-1', toolName: 'bash' },
  }, 20)
  const sample = tracker.observe({
    type: 'message_end',
    message: { role: 'assistant', id: 'assistant-tool', usage: { output: 40 } },
  }, 420)
  assert.equal(sample?.outputTokens, 40)

  const event = {
    type: 'assistant/attempt',
    time: 500,
    data: { stream: [{
      type: 'chunk',
      chunk: {
        type: 'usage',
        codingnsRequestPerformance: { adapterId: 'pi', id: sample!.id, samples: [sample!] },
      },
    }] },
  }
  const piState = piPerformanceProjection.apply(piPerformanceProjection.init(), event)
  const grokState = grokPerformanceProjection.apply(grokPerformanceProjection.init(), event)
  assert.equal(piState.decodeTokens, 40)
  assert.equal(grokState.decodeTokens, 0)
})

test('Pi does not invent speed when the provider sends only a final message', () => {
  const tracker = new PiPerformanceTracker()
  tracker.observe({ type: 'turn_start' }, 0)
  const sample = tracker.observe({
    type: 'message_end',
    message: { role: 'assistant', usage: { output: 40 } },
  }, 100)
  assert.equal(sample, undefined)
})

test('Pi driver emits observed timing before the final usage event', async () => {
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'],
    spawnSync: (() => ({ status: 0, stdout: 'pi 1.5.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        write(data: string): void {
          const request = JSON.parse(data) as { id: number; type?: string }
          if (request.type === 'get_state') {
            stdout.write(`${JSON.stringify({ id: request.id, type: 'response', success: true, data: { sessionId: 'pi-performance' } })}\n`)
            return
          }
          if (request.type === 'get_session_stats') {
            stdout.write(`${JSON.stringify({ id: request.id, type: 'response', success: true, data: {} })}\n`)
            return
          }
          if (request.type !== 'prompt') return
          stdout.write(`${JSON.stringify({ id: request.id, type: 'response', success: true, data: { disposition: 'accepted' } })}\n`)
          setImmediate(() => {
            const messages = [
              { type: 'turn_start' },
              { type: 'message_start', message: { role: 'assistant', id: 'assistant-1' } },
              { type: 'message_update', usage: { output: 12 }, assistantMessageEvent: { type: 'text_delta', delta: 'first' } },
              { type: 'message_end', message: { role: 'assistant', id: 'assistant-1', usage: { output: 120 } } },
              { type: 'agent_settled' },
            ]
            let index = 0
            const emit = (): void => {
              const message = messages[index++]
              if (message === undefined) return
              stdout.write(`${JSON.stringify(message)}\n`)
              if (index < messages.length) setTimeout(emit, 2)
            }
            emit()
          })
        },
      }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'pi-performance', messages: [], prompt: '统计' })) chunks.push(chunk)
  const observation = chunks.find((chunk) => chunk.type === 'usage-observation')
  assert.equal(observation?.requestPerformance?.adapterId, 'pi')
  assert.equal(observation?.requestPerformance?.samples[0]?.outputTokens, 120)
  assert.equal(chunks.find((chunk) => chunk.type === 'usage')?.outputTokens, 120)
  driver.dispose()
})
