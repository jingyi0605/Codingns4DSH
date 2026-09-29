import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
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
    supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2',
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
  registry.register(route({ id: 'legacy', supportedDsh: '>=0.1.5-rc.3 <=0.1.6', priority: 1, create: () => 'legacy' }))
  registry.register(route({ id: 'modern', supportedDsh: '>=0.1.7-rc.2 <=0.1.7-rc.2', priority: 2, create: () => 'modern' }))
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

test('能力矩阵覆盖插件当前测试的四个 DSH 版本', () => {
  const settingsRoutes = DSH_CAPABILITY_MATRIX.filter((route) => route.capability === 'settings.store')
  assert.ok(settingsRoutes.some((route) => route.supportedDsh.includes('0.1.5-rc.3')))
  assert.ok(settingsRoutes.some((route) => route.supportedDsh.includes('0.1.7-rc.2')))
  assert.ok(settingsRoutes.some((route) => route.supportedDsh.includes('0.2.0-rc.1')))
  assert.ok(settingsRoutes.every((route) => route.consumers.length > 0))
})

test('PeerHost 八项能力已进入矩阵并覆盖支持版本', () => {
  const capabilities = [
    'peer-host.store', 'peer-host.handshake', 'peer-host.http-proxy', 'peer-host.ws-proxy',
    'peer-host.aggregate', 'peer-host.relay-route', 'peer-host.native-navigation',
    'peer-host.remote-web-context-fallback',
  ]
  for (const capability of capabilities) {
    const routes = DSH_CAPABILITY_MATRIX.filter((route) => route.capability === capability)
    assert.ok(routes.length > 0)
    assert.ok(routes.every((route) => route.consumers.length > 0))
    assert.ok(routes.some((route) => route.supportedDsh.includes('0.1.5-rc.3')))
    assert.ok(routes.some((route) => route.supportedDsh.includes('0.1.7-rc.2')))
  }
})

test('PeerHost 未注入适配器时生成不可用诊断', () => {
  const host = createDshCapabilityRegistry('0.1.6-alpha.2', 'host', {}).getProfile({})
  const client = createDshCapabilityRegistry('0.1.6-alpha.2', 'client', {}).getProfile({})
  assert.equal(host.capabilities.get('peer-host.store')?.status, 'unavailable')
  assert.equal(client.capabilities.get('peer-host.native-navigation')?.status, 'unavailable')
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

test('PeerHost 三版本 fixture 明确区分原生导航、Remote Web Context 和 Relay', () => {
  const versions = ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2'] as const
  for (const version of versions) {
    const hostContext = {
      peerHostStore: {},
      peerHostHandshake: {},
      peerHostHttpProxy: {},
      peerHostWsProxy: {},
      peerHostAggregate: {},
    }
    const hostProfile = createDshCapabilityRegistry(version, 'host', hostContext).getProfile(hostContext)
    assert.equal(hostProfile.capabilities.get('peer-host.store')?.status, 'ready')
    assert.equal(hostProfile.capabilities.get('peer-host.relay-route')?.status, 'unavailable')

    const clientContext = version === '0.1.7-rc.2'
      ? { peerHostNativeNavigation: {} }
      : { peerHostRemoteWebContextFallback: {} }
    const clientProfile = createDshCapabilityRegistry(version, 'client', clientContext).getProfile(clientContext)
    assert.equal(clientProfile.capabilities.get('peer-host.remote-web-context-fallback')?.status, version === '0.1.7-rc.2' ? 'unavailable' : 'ready')
    assert.equal(clientProfile.capabilities.get('peer-host.native-navigation')?.status, version === '0.1.7-rc.2' ? 'ready' : 'unavailable')
  }
})

test('0.2.0-rc.1/rc.2 Host fixture 都按服务形状解析到 020 路由', () => {
  const context = {
    settings: { describe: () => [], mutate: async () => undefined, configure: () => () => undefined },
    connection: {
      rpc: { handle: () => undefined, intercept: () => undefined },
      fetch: { register: () => undefined },
      operator: {},
      admit: () => undefined,
      requestRejection: () => undefined,
    },
    typert: {
      local: {},
      remotes: { register: () => undefined, list: () => [] },
      contexts: { getHost: () => undefined, getClient: () => undefined },
    },
    sessions: { get: () => undefined, list: () => [] },
    subagents: { startContinuable: async () => undefined, sendMessage: async () => undefined },
    agentTeams: { listMembers: () => [], spawnTeammate: async () => undefined },
    agents: { get: () => undefined, list: () => [] },
  }
  const expectations = [
    ['settings.store', 'settings-forms-020'],
    ['connection.rpc', 'connection-rpc-020'],
    ['connection.peer', 'connection-peer-admission-020'],
    ['connection.attachment', 'connection-rpc-attachment-020'],
    ['connection.uplink', 'connection-rpc-uplink-020'],
    ['typert.remote', 'remote-context-stream-020'],
    ['typert.context', 'typert-context-registry-020'],
    ['typert.stream', 'typert-remote-stream-020'],
    ['session.format-v4', 'session-format-v4'],
    ['subagent.continuable', 'subagent-continuable-020'],
    ['agent-team.native', 'agent-team-native-020'],
  ] as const
  for (const version of ['0.2.0-rc.1', '0.2.0-rc.2'] as const) {
    const profile = createDshCapabilityRegistry(version, 'host', context).getProfile(context)
    for (const [capability, routeId] of expectations) {
      const resolution = profile.capabilities.get(capability)
      assert.equal(resolution?.routeId, routeId, capability)
      assert.equal(resolution?.status, 'ready', capability)
    }
  }
})

test('0.2.0-rc.1/rc.2 Client fixture 都按服务形状与图标事实解析到 020 路由', () => {
  const context = {
    configForms: { get: () => undefined },
    locale: {},
    theme: {},
    uiConversation: {},
    sidebarRight: {},
    remote: { $mount: () => undefined, $stream: () => undefined },
    typert: { contexts: { getHost: () => undefined, getClient: () => undefined } },
    modules: { version: 'client' },
  }
  const facts = { primitives: { IconPlusOutlineRegular: () => null, IconChevronDownOutlineRegular: () => null } }
  const expectations = [
    ['settings.store', 'config-forms-020'],
    ['ui.icon.plus', 'regular-plus-icon-020'],
    ['ui.icon.chevron', 'regular-chevron-icon-020'],
    ['locale.runtime', 'locale-runtime-020'],
    ['theme.runtime', 'theme-runtime-020'],
    ['conversation.tool-call', 'conversation-events-020'],
    ['sidebar.right', 'sidebar-right-dock-020'],
    ['typert.remote', 'remote-context-stream-020-client'],
    ['typert.context', 'typert-context-registry-020-client'],
    ['typert.stream', 'typert-remote-stream-020-client'],
    ['client.boot-graph', 'client-web-boot-graph-020'],
  ] as const
  for (const version of ['0.2.0-rc.1', '0.2.0-rc.2'] as const) {
    const profile = createDshCapabilityRegistry(version, 'client', context, facts).getProfile(context)
    for (const [capability, routeId] of expectations) {
      const resolution = profile.capabilities.get(capability)
      assert.equal(resolution?.routeId, routeId, capability)
      assert.equal(resolution?.status, 'ready', capability)
    }
  }
})

test('0.2.0-rc.1 fixture 缺失结构时保持不可用并生成诊断', () => {
  const hostProfile = createDshCapabilityRegistry('0.2.0-rc.1', 'host', {}).getProfile({})
  for (const capability of ['typert.context', 'typert.stream', 'session.format-v4', 'subagent.continuable', 'agent-team.native'] as const) {
    assert.equal(hostProfile.capabilities.get(capability)?.status, 'unavailable', capability)
  }
  const clientProfile = createDshCapabilityRegistry('0.2.0-rc.1', 'client', {}).getProfile({})
  for (const capability of ['ui.icon.plus', 'ui.icon.chevron', 'client.boot-graph'] as const) {
    assert.equal(clientProfile.capabilities.get(capability)?.status, 'unavailable', capability)
  }
  assert.ok(clientProfile.diagnostics.some((item) => item.code === 'CAPABILITY_UNAVAILABLE'))
})

test('0.1.7 fixture 即使携带同名结构也不会误解析 0.2 专属能力', () => {
  const context = {
    settings: { describe: () => [], mutate: async () => undefined },
    connection: {},
    typert: { remotes: {}, contexts: {} },
    sessions: { get: () => undefined, list: () => [] },
    subagents: { startContinuable: async () => undefined, sendMessage: async () => undefined },
    agentTeams: { listMembers: () => [], spawnTeammate: async () => undefined },
    agents: {},
  }
  const profile = createDshCapabilityRegistry('0.1.7-rc.2', 'host', context).getProfile(context)
  assert.equal(profile.capabilities.get('settings.store')?.routeId, 'config-settings')
  for (const capability of ['typert.context', 'typert.stream', 'session.format-v4', 'subagent.continuable', 'agent-team.native'] as const) {
    assert.equal(profile.capabilities.get(capability)?.status, 'unavailable', capability)
  }
})

test('客户端探测在 Cordis 的 inject 限制下仍解析 settings.store', async () => {
  const app = new Context()
  await app.plugin((ctx) => {
    ctx.provide('theme', {})
    ctx.provide('modules', { version: 'client' })
    ctx.provide('configForms', { get: () => undefined })
  })
  let probe: Context | undefined
  await app.plugin((ctx) => {
    // 业务插件的 inject 链里没有 configForms：探测上下文和线上一致。
    ctx.inject(['theme'], (child) => { probe = child })
  })
  assert.ok(probe, 'inject 回调没有拿到子上下文')
  // 未注入的服务在 Cordis 代理上直接读取会抛 without-inject，旧探测因此短路失败。
  assert.throws(() => Reflect.get(probe as Context, 'configForms'), /without inject/u)

  const profile = createDshCapabilityRegistry('0.2.0-rc.1', 'client', probe, {}).getProfile(probe)
  const resolution = profile.capabilities.get('settings.store')
  assert.equal(resolution?.routeId, 'config-forms-020')
  assert.equal(resolution?.status, 'ready')
  assert.equal(profile.capabilities.get('client.boot-graph')?.status, 'ready')
  assert.equal(profile.diagnostics.some((item) => item.code === 'CAPABILITY_DETECT_FAILED'), false)
})

test('必需能力缺失只影响该模块，同一轮同步里其余模块照常启停', async () => {
  const profile = createCapabilityProfile('0.1.6-alpha.2', 'host', new Map([
    ['settings.store', { capability: 'settings.store', dshVersion: '0.1.6-alpha.2', status: 'unavailable', reason: 'missing' }],
  ]), [{ code: 'CAPABILITY_UNAVAILABLE', capability: 'settings.store', dshVersion: '0.1.6-alpha.2', message: 'missing' }])
  const registry = new FeatureRegistry({}, profile)
  const started: string[] = []
  registry.register({
    descriptor: { name: 'before', version: '1.0.0', enabledByDefault: false, dependencies: [], runtime: 'host' },
    start: () => { started.push('before') },
  })
  registry.register({
    descriptor: {
      name: 'broken',
      version: '1.0.0',
      enabledByDefault: false,
      dependencies: [],
      runtime: 'host',
      requires: [{ capability: 'settings.store', required: true, fallback: 'disable' }],
    },
    start: () => { started.push('broken') },
  })
  registry.register({
    descriptor: { name: 'after', version: '1.0.0', enabledByDefault: false, dependencies: [], runtime: 'host' },
    start: () => { started.push('after') },
  })

  await assert.rejects(
    registry.reconcile(['before', 'broken', 'after']),
    (error) => error instanceof FeatureRegistryError && error.code === 'FEATURE_CAPABILITY_MISSING',
  )

  assert.deepEqual(started, ['before', 'after'])
  assert.equal(registry.getState('broken'), 'failed')
  assert.equal(registry.getState('after'), 'enabled')
})

test('0.2 代能力路由只声明下界，rc.2 与后续版本沿用同一路由', () => {
  const modernRoutes = DSH_CAPABILITY_MATRIX.filter((route) => route.supportedDsh.startsWith('>=0.2.0-rc.1'))
  assert.ok(modernRoutes.length > 0)
  assert.ok(modernRoutes.every((route) => route.supportedDsh === '>=0.2.0-rc.1'))

  const registry = new DshCapabilityRegistry('0.3.0', 'host')
  registry.register(route({ id: 'modern', supportedDsh: '>=0.2.0-rc.1', create: () => 'modern' }))
  const profile = registry.resolve({})
  assert.equal(profile.capabilities.get('settings.store')?.routeId, 'modern')
  assert.equal(profile.capabilities.get('settings.store')?.value, 'modern')
})
