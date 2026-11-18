import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'

/**
 * 插件侧自动压缩的两条硬约束：
 * 1. 压缩期间不开新回合（等它收尾），既不报「已有一轮执行正在进行」，也不让压缩那轮的
 *    输出混进用户回合；
 * 2. 压缩成功后必须先拿到**新**的用量读数才允许重新判定，否则会拿压缩前的旧规模重复压。
 */
function createFixture(options: { compactMs?: number } = {}) {
  const compactMs = options.compactMs ?? 300
  let compactAttempts = 0
  let maintenanceHeld = false
  let maintenanceCalls = 0
  const driver = {
    descriptor: { id: 'zcode', name: 'ZCode' },
    async detect() { return { installed: true, version: '1', command: 'zcode' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'usage', inputTokens: 100, outputTokens: 10, totalTokens: 110,
        contextTokens: 100_000, contextWindow: 1_000_000, contextUsageRatio: 0.1 }
      yield { type: 'finish', reason: 'stop' }
    },
    async readAutoCompactThreshold() { return undefined },
    async compact(input: { signal?: AbortSignal }) {
      assert.equal(maintenanceHeld, true, 'background compaction must own native maintenance before writing its lifecycle')
      compactAttempts += 1
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, compactMs)
        input.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
      })
      return { compacted: true }
    },
  }
  const compactionEvents: any[] = []
  const nativeSessions = {
    async runMaintenance<T>(_sessionId: string, job: (signal: AbortSignal) => Promise<T>) {
      maintenanceCalls++
      maintenanceHeld = true
      try { return await job(new AbortController().signal) }
      finally { maintenanceHeld = false }
    },
    appendCompactionEvent: (_sessionId: string, event: unknown) => { compactionEvents.push(event); return true },
  }
  const registry = new CodingNsCliAdapterRegistry([driver as never], { zcode: true }, {
    autoCompactionSettleMs: 10,
    // 正式默认阈值是窗口的 80%；这里压到 10% 才能用 10 万 tokens 的样例触发。
    autoCompactionThresholdRatio: 0.1,
    nativeSessions: nativeSessions as never,
  })
  registry.setSession('dsh', { adapterId: 'zcode', providerSessionId: 'native-1', modelId: 'glm' })
  return { registry, attempts: () => compactAttempts, compactionEvents, maintenanceCalls: () => maintenanceCalls }
}
test('自动压缩进行中，用户新回合等它收尾而不是报「已有一轮执行正在进行」', { timeout: 20_000 }, async () => {
  const fixture = createFixture({ compactMs: 300 })
  try {
    for await (const _event of fixture.registry.execute({ sessionId: 'dsh', adapterId: 'zcode', messages: [], prompt: '第一轮', cwd: process.cwd() })) { /* 驱动整轮 */ }
    const started = Date.now()
    while (fixture.attempts() < 1 && Date.now() - started < 2_000) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fixture.attempts(), 1, '阈值已过，自动压缩应已启动')
    assert.equal(fixture.maintenanceCalls(), 1)

    const before = Date.now()
    const events: any[] = []
    for await (const event of fixture.registry.execute({ sessionId: 'dsh', adapterId: 'zcode', messages: [], prompt: '第二轮', cwd: process.cwd() })) {
      events.push(event)
    }
    const waited = Date.now() - before
    const finish = events.at(-1)
    assert.equal(finish?.type, 'finish', `第二轮应正常结束；events=${events.map(e => e.type).join(',')}`)
    assert.equal(finish?.reason, 'stop')
    // 等待压缩收尾，而不是立刻开跑（立刻开跑会让两股输出交织）。
    assert.ok(waited >= 100, `第二轮应等压缩收尾，实际只等了 ${waited}ms`)
  } finally { await fixture.registry.dispose() }
})

test('压缩成功后必须先拿到新的用量读数，才允许再次触发', { timeout: 20_000 }, async () => {
  const fixture = createFixture({ compactMs: 20 })
  try {
    for await (const _event of fixture.registry.execute({ sessionId: 'dsh', adapterId: 'zcode', messages: [], prompt: '一轮', cwd: process.cwd() })) { /* 驱动整轮 */ }
    const deadline = Date.now() + 3_000
    while (fixture.attempts() < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fixture.attempts(), 1)
    // 压缩完成后旧基线已作废：在收到新的用量上报之前不能再压。
    await new Promise(resolve => setTimeout(resolve, 800))
    assert.equal(fixture.attempts(), 1, '压缩后未收到新用量就不应重复压缩')
  } finally { await fixture.registry.dispose() }
})

test('用户取消等待压缩时立即结束，不发起下一轮原生请求', { timeout: 2000 }, async () => {
  const fixture = createFixture({ compactMs: 600 })
  try {
    for await (const _ of fixture.registry.execute({ sessionId: 'dsh', adapterId: 'zcode', messages: [], prompt: 'first' })) { /* complete */ }
    while (fixture.attempts() === 0) await new Promise(resolve => setTimeout(resolve, 5))
    const controller = new AbortController()
    const start = Date.now()
    const next = Array.fromAsync(fixture.registry.execute({ sessionId: 'dsh', adapterId: 'zcode', messages: [], prompt: 'next', signal: controller.signal }))
    setTimeout(() => controller.abort(), 20)
    assert.deepEqual(await next, [{ type: 'finish', reason: 'cancel' }])
    assert.ok(Date.now() - start < 200)
  } finally { await fixture.registry.dispose() }
})
