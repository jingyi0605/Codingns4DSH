import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DshCapabilityRegistry,
  DSH_CAPABILITY_MATRIX,
  createDshCapabilityRegistry,
  createCapabilityProfile,
  type DshCapabilityRoute,
} from '../data/build/dist/index.js'
import { FeatureRegistry, FeatureRegistryError } from '../data/build/dist/features/index.js'

function route(overrides: Partial<DshCapabilityRoute<unknown>>): DshCapabilityRoute<unknown> {
  return {
    id: 'route',
    capability: 'settings.store',
    supportedDsh: '>=0.1.5-rc.3 <0.1.8-0',
    runtime: 'host',
    priority: 1,
    status: 'supported',
    introducedIn: '0.1.5-rc.3',
    detect: () => true,
    create: () => 'value',
    ...overrides,
  }
}

test('能力 Registry 按版本和优先级选择唯一路由，并冻结 Profile', () => {
  const registry = new DshCapabilityRegistry('0.1.7-rc.2', 'host')
  registry.register(route({ id: 'legacy', supportedDsh: '>=0.1.5-rc.3 <0.1.7-0', priority: 1, create: () => 'legacy' }))
  registry.register(route({ id: 'modern', supportedDsh: '>=0.1.7-rc.2 <0.1.8-0', priority: 2, create: () => 'modern' }))
  const profile = registry.resolve({})
  assert.equal(profile.capabilities.get('settings.store')?.routeId, 'modern')
  assert.equal(profile.capabilities.get('settings.store')?.value, 'modern')
  assert.equal(Object.isFrozen(profile), true)
  assert.equal(registry.resolve({}), profile)
})

test('探测异常和无路由都有结构化诊断', () => {
  const registry = new DshCapabilityRegistry('0.1.6-alpha.2', 'host')
  registry.register(route({ id: 'broken', detect: () => { throw new Error('探测失败') } }))
  const profile = registry.resolve({})
  assert.equal(profile.capabilities.get('settings.store')?.status, 'unavailable')
  assert.ok(profile.diagnostics.some((item) => item.code === 'CAPABILITY_DETECT_FAILED'))
  assert.ok(profile.diagnostics.some((item) => item.code === 'CAPABILITY_UNAVAILABLE'))
})

test('FeatureRegistry 根据能力要求阻止、禁用或允许降级', async () => {
  const profile = createCapabilityProfile('0.1.6-alpha.2', 'host', new Map([
    ['settings.store', { capability: 'settings.store', dshVersion: '0.1.6-alpha.2', status: 'unavailable', reason: 'missing' }],
  ]), [{ code: 'CAPABILITY_UNAVAILABLE', capability: 'settings.store', dshVersion: '0.1.6-alpha.2', message: 'missing' }])
  const registry = new FeatureRegistry({}, profile)
  registry.register({
    descriptor: { name: 'required', version: '1.0.0', enabledByDefault: false, dependencies: [], runtime: 'host', requires: [{ capability: 'settings.store', required: true }] },
    start: () => { throw new Error('不应启动') },
  })
  await assert.rejects(registry.start('required'), (error) => error instanceof FeatureRegistryError && error.code === 'FEATURE_CAPABILITY_MISSING')
  assert.equal(registry.getSnapshot('required').state, 'failed')

  let started = false
  registry.register({
    descriptor: { name: 'optional', version: '1.0.0', enabledByDefault: false, dependencies: [], runtime: 'host', requires: [{ capability: 'settings.store', required: false, fallback: 'disable' }] },
    start: () => { started = true },
  })
  await registry.start('optional')
  assert.equal(started, false)
  assert.equal(registry.getSnapshot('optional').state, 'disabled')
})

test('能力矩阵覆盖插件当前测试的三个 DSH 版本', () => {
  const settingsRoutes = DSH_CAPABILITY_MATRIX.filter((route) => route.capability === 'settings.store')
  assert.ok(settingsRoutes.some((route) => route.supportedDsh.includes('0.1.5-rc.3')))
  assert.ok(settingsRoutes.some((route) => route.supportedDsh.includes('0.1.7-rc.2')))
  assert.ok(settingsRoutes.every((route) => route.consumers.length > 0))
})

test('三个 DSH fixture 都能解析到集中式设置路由', () => {
  const fixtures = [
    ['0.1.5-rc.3', { settings: { register: () => undefined }, connection: {} }, 'settings-scope'],
    ['0.1.6-alpha.2', { settings: { register: () => undefined }, connection: {} }, 'settings-scope'],
    ['0.1.7-rc.2', { settings: { describe: () => [], mutate: async () => undefined }, connection: {} }, 'config-settings'],
  ] as const
  for (const [version, context, routeId] of fixtures) {
    const profile = createDshCapabilityRegistry(version, 'host', context).resolve(context)
    assert.equal(profile.capabilities.get('settings.store')?.routeId, routeId)
    assert.notEqual(profile.capabilities.get('connection.rpc')?.status, 'unavailable')
  }
})
