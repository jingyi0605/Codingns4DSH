import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import { createCodingNsNativeSessionBridge } from '../data/build/dist/host/native-session-bridge.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'

function bridgeFixture(openTurn = false) {
  const events: any[] = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'old question' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 3, data: { turn: 1, step: 1 } },
    ...openTurn ? [] : [{ type: 'turn/end', seq: 4, data: { turn: 1, reason: 'stop' } }],
  ]
  const session = { header: { sessionFormatVersion: 4 }, surface: { nodes: [2] }, snapshotEvents: () => [...events],
    append(type: string, data: any, options?: any) { const event = { type, data, seq: events.length, ...options }; events.push(event); return event } }
  const bridge = createCodingNsNativeSessionBridge({ get: (name: string) => name === 'sessions' ? { get: () => session, list: () => [session] } : undefined } as never)
  return { events, bridge }
}

test('standalone compaction includes the last historical user message and keeps the full summary', () => {
  const { events, bridge } = bridgeFixture()
  const summary = 'retain important facts '.repeat(40)
  for (const phase of ['start', 'summary', 'end'] as const) bridge.appendCompactionEvent!('s', { type: 'context-compaction', phase, compactionId: 'c', summary })
  const projected = events.find(e => e.type === 'compaction/summary')
  assert.ok(projected, 'a standalone compaction must appear immediately, even when history ends in a user message')
  assert.equal(projected.data.summary[0].text, summary.trim(), 'the collapsed native view must retain the complete summary')
  assert.deepEqual(projected.data.shadowedSeqs, [2])
  assert.equal(events.find(e => e.type === 'compaction/start').data.turn, null)
})

test('compaction between steps belongs to the still open turn', () => {
  const { events, bridge } = bridgeFixture(true)
  bridge.appendCompactionEvent!('s', { type: 'context-compaction', phase: 'start', compactionId: 'c' })
  assert.equal(events.at(-1).data.turn, 1, 'closed steps do not imply a closed turn')
})

test('accepted ZCode compaction cannot report success when its completion wait times out', { timeout: 2000 }, async () => {
  const stdout = new PassThrough(), stderr = new PassThrough()
  const keepAlive = setInterval(() => {}, 1000)
  const projected: any[] = []
  const driver = new ZcodeAppServerDriver({ desktopRuntime: null, binaries: ['fake'], compactionTimeoutMs: 40,
    spawnSync: (() => ({ status: 0, stdout: '3.18.2', stderr: '' })) as never,
    spawn: (() => ({ stdout, stderr, kill() { stdout.end(); stderr.end(); return true }, stdin: { write(line: string) {
      const r = JSON.parse(line)
      const result = r.method === 'session/resume' ? { session: { sessionId: 'native' } }
        : r.method === 'session/read' ? { snapshot: { projection: { contextUsed: 80000 } } }
        : r.method === 'session/compact' ? { compact: { state: 'accepted' } } : {}
      stdout.write(JSON.stringify({ id: r.id, result }) + '\n')
    } } })) as never,
  })
  try {
    await assert.rejects(driver.compact({ sessionId: 's', providerSessionId: 'native', onCompactionEvent: (e: any) => projected.push(e) } as never),
      (error: any) => error.code === 'CODINGNS_COMPACTION_TIMEOUT')
    assert.equal(projected.some(e => e.phase === 'summary'), false)
  } finally { clearInterval(keepAlive); driver.dispose() }
})
