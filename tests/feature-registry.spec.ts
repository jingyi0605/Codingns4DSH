import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FeatureRegistry,
  FeatureRegistryError,
  type FeatureModule,
} from '../dist/features/index.js'

function moduleOf(name: string, dependencies: string[] = [], hooks: Partial<FeatureModule> = {}): FeatureModule {
  return {
    descriptor: {
      name,
      version: '1.0.0',
      enabledByDefault: false,
      dependencies,
      runtime: 'host',
    },
    start: async (context) => {
      context.resources.add(() => undefined)
      await hooks.start?.(context)
    },
    drain: hooks.drain,
    dispose: hooks.dispose,
  }
}

test('按依赖顺序启动，并按逆依赖顺序停用', async () => {
  const events: string[] = []
  const registry = new FeatureRegistry({})
  registry.register(moduleOf('base', [], { start: () => { events.push('start:base') }, dispose: () => { events.push('dispose:base') } }))
  registry.register(moduleOf('terminal', ['base'], { start: () => { events.push('start:terminal') }, dispose: () => { events.push('dispose:terminal') } }))

  await registry.start('terminal')
  assert.deepEqual(events, ['start:base', 'start:terminal'])
  assert.equal(registry.getState('base'), 'enabled')
  assert.equal(registry.getState('terminal'), 'enabled')

  await registry.disable('base')
  assert.deepEqual(events, ['start:base', 'start:terminal', 'dispose:terminal', 'dispose:base'])
  assert.equal(registry.getState('base'), 'disabled')
  assert.equal(registry.getState('terminal'), 'disabled')
})

test('模块启动失败时进入 failed 并释放已登记资源', async () => {
  let disposed = 0
  let attempts = 0
  const registry = new FeatureRegistry({})
  registry.register({
    descriptor: { name: 'broken', version: '1.0.0', enabledByDefault: false, dependencies: [], runtime: 'host' },
    start: (context) => {
      attempts += 1
      context.resources.add(() => { disposed += 1 })
      if (attempts === 1) throw new Error('boom')
    },
  })

  await assert.rejects(
    registry.start('broken'),
    (error) => error instanceof FeatureRegistryError && error.code === 'FEATURE_START_FAILED',
  )
  assert.equal(registry.getState('broken'), 'failed')
  assert.equal(disposed, 1)
  assert.match(registry.getSnapshot('broken').reason ?? '', /boom/u)
  await registry.start('broken')
  assert.equal(registry.getState('broken'), 'enabled')
})

test('drain 只进入 draining，dispose 才释放资源并回到 disabled', async () => {
  const events: string[] = []
  const registry = new FeatureRegistry({})
  registry.register(moduleOf('stream', [], {
    drain: () => { events.push('drain') },
    dispose: () => { events.push('dispose') },
  }))
  await registry.start('stream')
  await registry.drain('stream')
  assert.equal(registry.getState('stream'), 'draining')
  assert.deepEqual(events, ['drain'])
  await registry.dispose('stream')
  assert.equal(registry.getState('stream'), 'disabled')
  assert.deepEqual(events, ['drain', 'dispose'])
})

test('drain 失败时 dispose 仍然清理模块资源', async () => {
  let resourceDisposed = false
  let moduleDisposed = false
  const registry = new FeatureRegistry({})
  registry.register({
    descriptor: { name: 'drain-fails', version: '1.0.0', enabledByDefault: false, dependencies: [], runtime: 'host' },
    start: (context) => { context.resources.add(() => { resourceDisposed = true }) },
    drain: () => { throw new Error('drain failed') },
    dispose: () => { moduleDisposed = true },
  })
  await registry.start('drain-fails')
  await assert.rejects(registry.dispose('drain-fails'), /Failed to dispose feature/u)
  assert.equal(registry.getState('drain-fails'), 'disabled')
  assert.equal(resourceDisposed, true)
  assert.equal(moduleDisposed, true)
})

test('缺失依赖、循环依赖和重复注册会被拒绝', () => {
  const missing = new FeatureRegistry({})
  missing.register(moduleOf('child', ['missing']))
  assert.throws(() => missing.validate(), (error) => error instanceof FeatureRegistryError && error.code === 'FEATURE_DEPENDENCY_MISSING')

  const cyclic = new FeatureRegistry({})
  cyclic.register(moduleOf('a', ['b']))
  cyclic.register(moduleOf('b', ['a']))
  assert.throws(() => cyclic.validate(), (error) => error instanceof FeatureRegistryError && error.code === 'FEATURE_DEPENDENCY_CYCLE')

  assert.throws(() => cyclic.register(moduleOf('a')), (error) => error instanceof FeatureRegistryError && error.code === 'FEATURE_ALREADY_REGISTERED')
})

test('描述符的运行时字段必须满足契约', () => {
  const registry = new FeatureRegistry({})
  assert.throws(() => registry.register({
    descriptor: { name: 'bad', version: '1.0.0', enabledByDefault: 'yes' as unknown as boolean, dependencies: [], runtime: 'host' },
    start: () => undefined,
  }), (error) => error instanceof FeatureRegistryError && error.code === 'FEATURE_INVALID_DESCRIPTOR')
})

test('reconcile 按期望集合启动模块，并把未期望的模块停用', async () => {
  const events: string[] = []
  const registry = new FeatureRegistry({})
  registry.register(moduleOf('base', [], { start: () => { events.push('base') } }))
  registry.register({
    ...moduleOf('default', ['base']),
    descriptor: { ...moduleOf('default').descriptor, enabledByDefault: true, dependencies: ['base'] },
    start: (context) => { events.push('default'); context.resources.add(() => undefined) },
  })
  registry.register(moduleOf('off', [], { start: () => { events.push('off') } }))
  await registry.reconcile(['default'])
  assert.deepEqual(events, ['base', 'default'])
  assert.equal(registry.getState('off'), 'disabled')

  await registry.reconcile([])
  assert.equal(registry.getState('default'), 'disabled')
  assert.equal(registry.getState('base'), 'disabled')
})

test('重复并发 start 不会重复创建同一模块', async () => {
  let starts = 0
  const registry = new FeatureRegistry({})
  registry.register(moduleOf('once', [], {
    start: async () => {
      starts += 1
      await Promise.resolve()
    },
  }))
  await Promise.all([registry.start('once'), registry.start('once')])
  assert.equal(starts, 1)
  assert.equal(registry.getState('once'), 'enabled')
})
