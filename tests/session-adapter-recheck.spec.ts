import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_ADAPTER_RECHECK_DELAYS_MS,
  createSessionAdapterRecheck,
} from '../data/build/dist/client/session-adapter-recheck.js'

function fakeTimers() {
  const timers = new Map()
  let nextId = 1
  return {
    setTimer(callback, delayMs) {
      const id = nextId++
      timers.set(id, { callback, delayMs })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    get size() { return timers.size },
    /** 触发当前唯一的定时器，返回它声明的延迟。 */
    async fire() {
      const [[id, timer]] = [...timers]
      timers.delete(id)
      timer.callback()
      await new Promise((resolve) => setImmediate(resolve))
      return timer.delayMs
    },
  }
}

test('新建会话在 Host 写入绑定后立即停止补读', async () => {
  const timers = fakeTimers()
  const confirmed = new Set()
  let refreshes = 0
  const recheck = createSessionAdapterRecheck({
    refresh: async () => { refreshes += 1; return new Set(confirmed) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  recheck.note('new-session')
  recheck.note('new-session')
  assert.equal(timers.size, 1, '重复登记同一会话只安排一个定时器')

  assert.equal(await timers.fire(), SESSION_ADAPTER_RECHECK_DELAYS_MS[0])
  assert.equal(refreshes, 1)
  assert.equal(timers.size, 1, '第一次补读还没拿到绑定，继续等待')

  confirmed.add('new-session')
  assert.equal(await timers.fire(), SESSION_ADAPTER_RECHECK_DELAYS_MS[1], '补读间隔逐步变长')
  assert.equal(refreshes, 2)
  assert.equal(timers.size, 0, 'Host 已确认绑定，不再补读')
  recheck.dispose()
})

test('始终没有绑定的原生会话补读次数有限', async () => {
  const timers = fakeTimers()
  let refreshes = 0
  const recheck = createSessionAdapterRecheck({
    refresh: async () => { refreshes += 1; return new Set() },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  recheck.note('native-dsh')
  while (timers.size > 0) await timers.fire()
  assert.equal(refreshes, SESSION_ADAPTER_RECHECK_DELAYS_MS.length)

  recheck.note('native-dsh')
  assert.equal(timers.size, 0, '已经放弃补读的会话不会被反复重新登记')
  recheck.dispose()
})

test('读取失败按一次尝试计数，停用后清理定时器', async () => {
  const timers = fakeTimers()
  let refreshes = 0
  const recheck = createSessionAdapterRecheck({
    refresh: async () => { refreshes += 1; throw new Error('offline') },
    delaysMs: [10, 20, 30],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  recheck.note('session-a')
  while (timers.size > 0) await timers.fire()
  assert.equal(refreshes, 3)

  recheck.note('session-b')
  recheck.dispose()
  assert.equal(timers.size, 0)
  recheck.note('session-c')
  assert.equal(timers.size, 0, '停用后不再安排补读')
})
