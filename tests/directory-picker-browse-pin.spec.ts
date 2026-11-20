import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForFreeDirectoryPicker } from '../src/host/directory-picker-browse-pin.js'

type Holder = {
  capability: () => { kind: string }
  ctx: { fiber: { name: string; dispose: () => Promise<void> } }
}

const timing = { pollMs: 5, graceMs: 40, deadlineMs: 400 }

function makeContext(initial: Holder | undefined, loaderEntries: Array<{ options: { id: string }; fiber: unknown }> = []) {
  const state = { holder: initial, removed: [] as string[] }
  const ctx = {
    get: (name: string) => (name === 'directoryPicker' ? state.holder : undefined),
    loader: {
      entries: () => loaderEntries,
      store: Object.fromEntries(loaderEntries.map((entry) => [entry.options.id, {
        fiber: { dispose: async () => { state.holder = undefined } },
      }])),
      remove: (id: string) => { state.removed.push(id) },
    },
  }
  return { ctx: ctx as never, state }
}

function holder(kind: string, onDispose: () => void = () => {}): Holder {
  return {
    capability: () => ({ kind }),
    ctx: { fiber: { name: `${kind}-picker`, dispose: async () => { onDispose() } } },
  }
}

test('空闲的 directoryPicker 直接放行', async () => {
  const { ctx } = makeContext(undefined)
  assert.equal(await waitForFreeDirectoryPicker(ctx, timing), 'free')
})

test('已经是浏览后端时不重复挂载', async () => {
  const { ctx } = makeContext(holder('browse'))
  assert.equal(await waitForFreeDirectoryPicker(ctx, timing), 'already-browse')
})

test('原生选择器在宽限期内自行退出时不主动移除', async () => {
  const { ctx, state } = makeContext(holder('native'))
  setTimeout(() => { state.holder = undefined }, 10)
  assert.equal(await waitForFreeDirectoryPicker(ctx, timing), 'free')
  assert.deepEqual(state.removed, [])
})

test('原生选择器超过宽限期仍占用时经 Loader 移除后放行', async () => {
  const native = holder('native')
  const { ctx, state } = makeContext(native, [{ options: { id: 'leaked-native' }, fiber: native.ctx.fiber }])
  assert.equal(await waitForFreeDirectoryPicker(ctx, timing), 'free')
  assert.deepEqual(state.removed, ['leaked-native'])
})

test('找不到 Loader 条目时直接停掉占用者的 Fiber', async () => {
  const { ctx, state } = makeContext(undefined)
  const native = holder('native', () => { state.holder = undefined })
  state.holder = native
  assert.equal(await waitForFreeDirectoryPicker(ctx, timing), 'free')
  assert.equal(state.holder, undefined)
})

test('清不掉的占用者会在报错里写明占用者名称与类型', async () => {
  const stubborn = holder('native')
  const { ctx } = makeContext(stubborn)
  await assert.rejects(
    waitForFreeDirectoryPicker(ctx, { pollMs: 5, graceMs: 20, deadlineMs: 120 }),
    /native-picker.*native.*无法挂载目录浏览后端/u,
  )
})

test('无法判断类型的占用者不会被移除，超时后报错', async () => {
  let disposed = false
  const unknown = holder('mystery', () => { disposed = true })
  const { ctx } = makeContext(unknown)
  await assert.rejects(
    waitForFreeDirectoryPicker(ctx, { pollMs: 5, graceMs: 20, deadlineMs: 100 }),
    /mystery-picker.*mystery/u,
  )
  assert.equal(disposed, false)
})
