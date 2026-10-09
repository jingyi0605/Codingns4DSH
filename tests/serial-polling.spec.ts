import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { startSerialPolling } from '../src/client/serial-polling.js'

test('断线按短周期恢复检查，重连恢复正常周期，隐藏和停用期间不轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  let calls = 0
  let disconnected = true
  const polling = startSerialPolling(async () => { calls += 1; if (calls === 2) disconnected = false }, 30_000, {
    document: document as unknown as Document, getIntervalMs: () => disconnected ? 5_000 : 30_000,
  })
  t.after(() => polling.dispose())
  await setImmediate()
  t.mock.timers.tick(4_999); await setImmediate(); assert.equal(calls, 1)
  t.mock.timers.tick(1); await setImmediate(); assert.equal(calls, 2)
  t.mock.timers.tick(29_999); await setImmediate(); assert.equal(calls, 2)
  t.mock.timers.tick(1); await setImmediate(); assert.equal(calls, 3)
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))
  t.mock.timers.tick(60_000); await setImmediate(); assert.equal(calls, 3)
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'))
  await setImmediate(); assert.equal(calls, 4)
  polling.dispose(); t.mock.timers.tick(60_000); await setImmediate(); assert.equal(calls, 4)
})
