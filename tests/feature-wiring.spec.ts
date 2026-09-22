import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureRegistry, type FeatureModule } from '../dist/features/index.js'
import { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler } from '../dist/host/rpc.js'
import { CodingNsRpcTable } from '../dist/host/rpc-table.js'
import { createAuthFeature } from '../dist/host/features/index.js'
import { cliAdaptersFeature, lanAccessFeature, reverseProxyFeature } from '../dist/client/features/index.js'
import {
  enabledFeatureNames,
  isFeatureEnabled,
  type CodingNsSettings,
} from '../dist/shared/index.js'

/** 录制启停事件的测试模块。 */
function featureOf(
  name: string,
  events: string[],
  options: {
    enabledByDefault?: boolean
    dependencies?: string[]
    alwaysEnabled?: boolean
  } = {},
): FeatureModule {
  return {
    descriptor: {
      name,
      version: '1.0.0',
      enabledByDefault: options.enabledByDefault ?? false,
      dependencies: options.dependencies ?? [],
      runtime: 'client',
      ...(options.alwaysEnabled === true
        ? { ui: { label: name, description: `${name} 说明`, alwaysEnabled: true } }
        : {}),
    },
    start: () => { events.push(`start:${name}`) },
    dispose: () => { events.push(`dispose:${name}`) },
  }
}

function settingsOf(modules: Record<string, boolean>): CodingNsSettings {
  return { controlBaseUrl: 'https://channel.codingns.com:1443', controlBaseUrls: ['https://channel.codingns.com:1443'], modules, lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 } }
}

test('设置开关驱动模块启停，常驻模块不受开关影响', async () => {
  const events: string[] = []
  const registry = new FeatureRegistry({})
  registry.registerMany([
    featureOf('lanAccess', events, { enabledByDefault: true, alwaysEnabled: true }),
    featureOf('reverseProxy', events),
  ])

  const sync = (settings?: CodingNsSettings): Promise<void> =>
    registry.reconcile(enabledFeatureNames(registry.descriptors(), settings))

  await sync(undefined)
  assert.deepEqual(events, ['start:lanAccess'])
  assert.equal(registry.getState('lanAccess'), 'enabled')
  assert.equal(registry.getState('reverseProxy'), 'disabled')

  await sync(settingsOf({ reverseProxy: true }))
  assert.deepEqual(events, ['start:lanAccess', 'start:reverseProxy'])
  assert.equal(registry.getState('reverseProxy'), 'enabled')

  await sync(settingsOf({ reverseProxy: false }))
  assert.deepEqual(events, ['start:lanAccess', 'start:reverseProxy', 'dispose:reverseProxy'])
  assert.equal(registry.getState('reverseProxy'), 'disabled')

  // 常驻模块即使在设置里被写成 false 也保持启用。
  await sync(settingsOf({ lanAccess: false }))
  assert.equal(registry.getState('lanAccess'), 'enabled')
})

test('reconcile 会带上依赖，也不会在停用阶段误伤被依赖的模块', async () => {
  const events: string[] = []
  const registry = new FeatureRegistry({})
  registry.registerMany([
    featureOf('auth', events),
    featureOf('tunnel', events, { dependencies: ['auth'] }),
  ])

  await registry.reconcile(['tunnel'])
  assert.deepEqual(events, ['start:auth', 'start:tunnel'])

  await registry.reconcile(['auth'])
  assert.deepEqual(events, ['start:auth', 'start:tunnel', 'dispose:tunnel'])
  assert.equal(registry.getState('auth'), 'enabled')
})

test('模块在 start 中拿到宿主服务，登记的资源随停用释放', async () => {
  const disposed: string[] = []
  const services = { marker: 'host-services' }
  const registry = new FeatureRegistry(services)
  let observed: unknown
  registry.register({
    descriptor: { name: 'terminal', version: '1.0.0', enabledByDefault: true, dependencies: [], runtime: 'host' },
    start: (context) => {
      observed = context.services
      context.resources.add(() => { disposed.push('terminal') })
    },
  })

  await registry.reconcile(['terminal'])
  assert.deepEqual(observed, services)
  await registry.disable('terminal')
  assert.deepEqual(disposed, ['terminal'])
})

test('没有 ui 描述的模块不出现在设置页，非法 ui 会被注册表拒绝', () => {
  const registry = new FeatureRegistry({})
  registry.register(featureOf('auth', [], { enabledByDefault: true }))
  assert.equal(registry.getModule('auth').descriptor.ui, undefined)

  const invalid = new FeatureRegistry({})
  assert.throws(() => invalid.register({
    descriptor: {
      name: 'broken',
      version: '1.0.0',
      enabledByDefault: false,
      dependencies: [],
      runtime: 'client',
      ui: { label: '', description: '说明' },
    },
    start: () => undefined,
  }), /ui\.label/u)
})

test('isFeatureEnabled 对未表达意图的模块回落到 enabledByDefault', () => {
  const descriptor = {
    name: 'files',
    version: '1.0.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client' as const,
  }
  assert.equal(isFeatureEnabled(descriptor, undefined), true)
  assert.equal(isFeatureEnabled(descriptor, settingsOf({ files: false })), false)
})

test('RPC 表按命名空间分发，未登记或格式非法的端点返回 null', async () => {
  const table = new CodingNsRpcTable()
  const calls: string[] = []
  const unregister = table.register('auth', (action, payload) => {
    calls.push(`${action}:${JSON.stringify(payload)}`)
    return { action }
  })

  const target = table.resolve('auth/login')
  assert.notEqual(target, null)
  assert.deepEqual(await target?.handler(target.action, { email: 'a@b.c' }), { action: 'login' })
  assert.deepEqual(calls, ['login:{"email":"a@b.c"}'])

  assert.equal(table.resolve('terminal/list'), null)
  assert.equal(table.resolve('auth'), null)
  assert.equal(table.resolve('/login'), null)

  unregister()
  assert.equal(table.resolve('auth/login'), null)

  table.register('auth', () => null)
  assert.throws(() => table.register('auth', () => null), /已登记/u)
})

test('RPC 表允许各模块独立登记，主分发不需要知道模块名', () => {
  const table = new CodingNsRpcTable()
  table.register('auth', () => null)
  table.register('terminal', () => null)
  assert.deepEqual(table.namespaces(), ['auth', 'terminal'])
})

test('RPC 主处理器把分发结果转成 Connection 结果，不向外抛错', async () => {
  const table = new CodingNsRpcTable()
  table.register('auth', (action) => {
    if (action === 'login') return { account: 'a@b.c' }
    throw new Error('账号或密码错误')
  })
  const handler = createCodingNsRpcHandler(table)
  const signal = new AbortController().signal

  assert.deepEqual(await handler('auth/login', {}, signal), {
    ok: true,
    value: { account: 'a@b.c' },
  })

  const rejected = await handler('auth/logout', {}, signal)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.ok === false ? rejected.error.message : '', '账号或密码错误')

  const unknown = await handler('terminal/list', {}, signal)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.ok === false ? unknown.error.code : '', 'CODINGNS_RPC_NOT_FOUND')
})

test('远程设置 RPC 返回版本并只允许修改 CodingNS 字段', async () => {
  let current = settingsOf({})
  let revision = 4
  let received: unknown
  const provider = {
    writable: true,
    describe: () => [{ ns: 'codingns', revision }],
    get: () => current,
    mutate: async (_namespace: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[], expectedRevision?: number) => {
      received = { ops, expectedRevision }
      const operation = ops[0]
      if (operation?.op === 'set' && operation.path.join('.') === 'modules.reverseProxy') {
        current = settingsOf({ reverseProxy: operation.value === true })
      }
      revision += 1
    },
  }
  const handler = createCodingNsSettingsRpcHandler(provider as never)

  assert.deepEqual(await handler('get', {}), { value: settingsOf({}), revision: 4 })
  assert.deepEqual(await handler('set', {
    ops: [{ op: 'set', path: ['modules', 'reverseProxy'], value: true }],
    expectedRevision: 4,
  }), { value: settingsOf({ reverseProxy: true }), revision: 5 })
  assert.deepEqual(received, {
    ops: [{ op: 'set', path: ['modules', 'reverseProxy'], value: true }],
    expectedRevision: 4,
  })
  await handler('set', {
    ops: [{ op: 'set', path: ['controlBaseUrls'], value: ['https://channel.codingns.com:1443', 'https://control.example.com'] }],
  })
  assert.deepEqual(received, {
    ops: [{ op: 'set', path: ['controlBaseUrls'], value: ['https://channel.codingns.com:1443', 'https://control.example.com'] }],
    expectedRevision: undefined,
  })
  await assert.rejects(
    handler('set', { ops: [{ op: 'set', path: ['modules', 'auth'], value: false }] }),
    /禁止修改设置字段/u,
  )
})

test('auth 模块通过服务登记 auth 命名空间，停用后自动注销', async () => {
  const table = new CodingNsRpcTable()
  const registry = new FeatureRegistry({ rpc: table })
  registry.register(createAuthFeature())

  await registry.reconcile(['auth'])
  assert.deepEqual(table.namespaces(), ['auth'])

  const target = table.resolve('auth/snapshot')
  assert.notEqual(target, null)
  assert.deepEqual(await target?.handler(target.action, {}), {
    status: 'logged_out',
    account: null,
    currentDevice: null,
    binding: null,
    expiresAt: null,
    errorCode: null,
  })

  await registry.disable('auth')
  assert.deepEqual(table.namespaces(), [])
})

test('本地端口映射面板归属局域网访问，不混入中转访问服务', () => {
  assert.equal(lanAccessFeature.settingsPanel?.name, 'LanAccessPanel')
  assert.equal(reverseProxyFeature.settingsPanel?.name, 'ReverseProxyPanel')
})

test('外部 Agent 作为独立 Client 设置模块登记且默认启用', () => {
  assert.equal(cliAdaptersFeature.descriptor.name, 'cliAdapters')
  assert.equal(cliAdaptersFeature.descriptor.runtime, 'client')
  assert.equal(cliAdaptersFeature.descriptor.ui?.label, '外部Agent集成')
  assert.equal(cliAdaptersFeature.descriptor.ui?.alwaysEnabled, undefined)
  assert.equal(cliAdaptersFeature.settingsPanel?.name, 'CliAdaptersPanel')
})
