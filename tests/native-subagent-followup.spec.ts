import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { dispatchNativeSubagent, nativeSubagentEventCursor, readNativeSubagentLifecycle, trackNativeSubagentFollowup, waitNativeSubagentLifecycle } from '../data/build/dist/host/cli-adapters/native-subagent-dispatch.js'

for (const adapterId of ['command-code', 'grok']) {
  test(`${adapterId} follow-up ignores restored first-turn results after idle session eviction`, async () => {
    const id = `cold-followup-${adapterId}`
    const rows: any[] = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'FIRST' }] } } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const session = { header: { id }, snapshotEvents: () => [...rows] }
    let loaded = true
    const listeners = new Set<any>()
    const sessions = {
      get: () => loaded ? session : undefined,
      subscribe: (handler: any) => { listeners.add(handler); return () => listeners.delete(handler) },
    }
    const emit = (row: any) => { rows.push(row); for (const listener of [...listeners]) listener.onEvent(session, row) }
    const first = await dispatchNativeSubagent({ startActivation: async () => ({ childId: id }) } as never, sessions as never,
      { adapterId, prompt: 'First', parentAgent: {}, parentId: `parent-${id}`, background: false })
    assert.equal(first.text, 'FIRST')
    loaded = false
    const cursor = nativeSubagentEventCursor(sessions as never, id)
    assert.equal(cursor, 0, 'An idle evicted child has no in-memory event cursor')
    loaded = true
    trackNativeSubagentFollowup(sessions as never, id, cursor, 'followup-message')
    await delay(75)
    assert.equal(readNativeSubagentLifecycle(id)?.status, 'running', 'Restored history must not finish the new observation')
    emit({ type: 'turn/start', seq: 4, data: { turn: 2 } })
    emit({ type: 'user/message', seq: 5, data: { id: 'unrelated-message' } })
    emit({ type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: 'UNRELATED' }] } } })
    emit({ type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'completed' } } })
    await delay(75)
    assert.equal(readNativeSubagentLifecycle(id)?.status, 'running')
    emit({ type: 'turn/start', seq: 8, data: { turn: 3 } })
    emit({ type: 'user/message', seq: 9, data: { id: 'followup-message' } })
    emit({ type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: 'ACK' }] } } })
    emit({ type: 'turn/end', seq: 11, data: { turn: 3, reason: { kind: 'completed' } } })
    const result = await waitNativeSubagentLifecycle(id, 1_000)
    assert.equal(result?.status, 'completed')
    assert.equal(result?.text, 'ACK')
    assert.equal(listeners.size, 0)
  })
}
