import assert from 'node:assert/strict'
import test from 'node:test'
import { attachLoadedEngine, createEngineLoader } from '../src/client/engine-loader.js'
import { TerminalSurfaceCache } from '../src/client/terminal/surface-cache.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('引擎不预加载，并发共用 Promise，失败后可重试', async () => {
  let calls = 0
  const engine = {}
  const load = createEngineLoader(async () => { if (++calls === 1) throw new Error('离线'); return engine })
  assert.equal(calls, 0)
  const first = load()
  assert.equal(load(), first)
  await assert.rejects(first, /离线/u)
  assert.equal(await load(), engine)
  assert.equal(await load(), engine)
  assert.equal(calls, 2)
})

for (const cancelledBy of ['unmount', 'abort']) {
  test(`终端加载期间 ${cancelledBy} 后不挂载迟到引擎`, async () => {
    const controller = new AbortController()
    let resolve!: (value: object) => void
    let mounts = 0
    const dispose = attachLoadedEngine(() => new Promise((done) => { resolve = done }), controller.signal,
      () => { mounts++; return () => undefined }, () => assert.fail('不应报错'))
    if (cancelledBy === 'unmount') dispose()
    else controller.abort()
    resolve({})
    await tick()
    assert.equal(mounts, 0)
  })
}

test('切换会话只拆挂视图，共用 surface 和常驻连接，模型销毁才清理屏幕', async () => {
  const controller = new AbortController()
  const cache = new TerminalSurfaceCache<{ dispose(): void }>()
  let created = 0
  let disposed = 0
  let detached = 0
  const attached: unknown[] = []
  const mount = () => attachLoadedEngine(async () => ({}), controller.signal, () => {
    attached.push(cache.get(controller, () => { created++; return { dispose: () => { disposed++ } } }))
    return () => { detached++ }
  }, () => assert.fail('不应报错'))
  const first = mount()
  await tick()
  first()
  const second = mount()
  await tick()
  assert.equal(created, 1)
  assert.equal(disposed, 0)
  assert.equal(attached[0], attached[1])
  controller.abort()
  second()
  assert.equal(disposed, 1)
  assert.equal(detached, 2)
})

test('未取消的加载失败反馈 UI；取消后的失败不更新旧视图', async () => {
  const errors: unknown[] = []
  const controller = new AbortController()
  const failed = async () => { throw new Error('分块下载失败') }
  const first = attachLoadedEngine(failed, controller.signal, () => () => undefined, (error) => errors.push(error))
  await tick()
  first()
  const second = attachLoadedEngine(failed, controller.signal, () => () => undefined, (error) => errors.push(error))
  second()
  await tick()
  assert.equal(errors.length, 1)
})

test('挂载内部同步销毁模型也只清理一次', async () => {
  const controller = new AbortController()
  let released = 0
  const dispose = attachLoadedEngine(async () => ({}), controller.signal, () => {
    controller.abort()
    return () => { released++ }
  }, () => assert.fail('不应报错'))
  await tick()
  dispose()
  assert.equal(released, 1)
})
