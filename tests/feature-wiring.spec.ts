import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureRegistry, type FeatureModule } from '../data/build/dist/features/index.js'
import { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcError, CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createAuthFeature } from '../data/build/dist/host/features/index.js'
import {
  cliAdaptersFeature,
  debugFeature,
  lanAccessFeature,
  mobileAccessFeature,
  reverseProxyFeature,
  terminalEnhancementFeature,
  workspaceSessionEnhancementFeature,
} from '../data/build/dist/client/features/index.js'
import {
  enabledFeatureNames,
  isFeatureEnabled,
  type CodingNsSettings,
} from '../data/build/dist/shared/index.js'

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

test('RPC 主处理器将未认证拒绝记录为 warning，其他异常仍记录为 error', async () => {
  const table = new CodingNsRpcTable()
  table.register('auth', (action) => {
    if (action === 'snapshot') throw new CodingNsRpcError('CODINGNS_RPC_UNAUTHENTICATED', 'Codingns4DSH 尚未登录')
    throw new Error('控制站不可用')
  })
  const handler = createCodingNsRpcHandler(table)
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (...args: unknown[]) => warnings.push(args)
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    const unauthenticated = await handler('auth/snapshot', {}, new AbortController().signal)
    const failed = await handler('auth/login', {}, new AbortController().signal)
    assert.equal(unauthenticated.ok, false)
    assert.equal(failed.ok, false)
    assert.equal(warnings.length, 1)
    assert.equal(errors.length, 1)
    assert.deepEqual((warnings[0]?.[1] as { code?: string }).code, 'CODINGNS_RPC_UNAUTHENTICATED')
  } finally {
    console.warn = originalWarn
    console.error = originalError
  }
})

test('中继模块未登录时等待认证，不请求 DSH 设备列表', async () => {
  const calls: string[] = []
  const globalScope = globalThis as typeof globalThis & {
    addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void
    removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void
  }
  const previousAddEventListener = globalScope.addEventListener
  const previousRemoveEventListener = globalScope.removeEventListener
  globalScope.addEventListener = () => undefined
  globalScope.removeEventListener = () => undefined
  try {
    const disposer = reverseProxyFeature.start({
      services: {
        rpc: {
          call: async (_channel: string, endpoint: string) => {
            calls.push(endpoint)
            assert.equal(endpoint, 'auth/snapshot')
            return {
              ok: true,
              value: { status: 'logged_out', account: null, currentDevice: null, binding: null, expiresAt: null, errorCode: null },
            }
          }
        },
      },
    } as never)
    await new Promise((resolve) => setImmediate(resolve))
    await disposer?.()
  } finally {
    if (previousAddEventListener === undefined) delete globalScope.addEventListener
    else globalScope.addEventListener = previousAddEventListener
    if (previousRemoveEventListener === undefined) delete globalScope.removeEventListener
    else globalScope.removeEventListener = previousRemoveEventListener
  }
  assert.deepEqual(calls, ['auth/snapshot'])
})

test('远程设置 RPC 返回版本并只允许修改 Codingns4DSH 字段', async () => {
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
    ops: [{ op: 'set', path: ['modules', 'debug'], value: false }],
  })
  await handler('set', {
    ops: [{ op: 'set', path: ['modules', 'fileManagement'], value: true }],
  })
  await handler('set', {
    ops: [{ op: 'set', path: ['fileManagement', 'sessionChangedFiles'], value: false }],
  })
  await handler('set', {
    ops: [{ op: 'set', path: ['controlBaseUrls'], value: ['https://channel.codingns.com:1443', 'https://control.example.com'] }],
  })
  assert.deepEqual(received, {
    ops: [{ op: 'set', path: ['controlBaseUrls'], value: ['https://channel.codingns.com:1443', 'https://control.example.com'] }],
    expectedRevision: undefined,
  })
  await handler('set', {
    ops: [{ op: 'set', path: ['terminalEnhancement'], value: {
      defaultProfile: 'system',
      appearance: { theme: 'inherit' },
    } }],
  })
  assert.deepEqual(received, {
    ops: [{ op: 'set', path: ['terminalEnhancement'], value: {
      defaultProfile: 'system',
      appearance: { theme: 'inherit' },
    } }],
    expectedRevision: undefined,
  })
  await handler('set', {
    ops: [
      { op: 'set', path: ['modules', 'workspaceSessionEnhancement'], value: true },
      { op: 'set', path: ['workspaceSessionEnhancement', 'showAdapterLogo'], value: false },
    ],
  })
  assert.deepEqual(received, {
    ops: [
      { op: 'set', path: ['modules', 'workspaceSessionEnhancement'], value: true },
      { op: 'set', path: ['workspaceSessionEnhancement', 'showAdapterLogo'], value: false },
    ],
    expectedRevision: undefined,
  })
  await assert.rejects(
    handler('set', { ops: [{ op: 'set', path: ['modules', 'auth'], value: false }] }),
    /禁止修改设置字段/u,
  )
  await handler('set', {
    ops: [
      { op: 'set', path: ['subscriptionUsage', 'timeoutSecs'], value: 30 },
      { op: 'set', path: ['subscriptionUsage', 'refreshIntervalMins'], value: 15 },
    ],
  })
  assert.deepEqual(received, {
    ops: [
      { op: 'set', path: ['subscriptionUsage', 'timeoutSecs'], value: 30 },
      { op: 'set', path: ['subscriptionUsage', 'refreshIntervalMins'], value: 15 },
    ],
    expectedRevision: undefined,
  })
  await assert.rejects(
    handler('set', { ops: [{ op: 'set', path: ['subscriptionUsage', 'unknownField'], value: 1 }] }),
    /禁止修改设置字段/u,
  )
  // 外部 Agent 子代理托管的开关同样经设置 RPC 写入，未知子字段必须被拒绝。
  await handler('set', { ops: [{ op: 'set', path: ['subagentBridge', 'enabled'], value: true }] })
  assert.deepEqual(received, {
    ops: [{ op: 'set', path: ['subagentBridge', 'enabled'], value: true }],
    expectedRevision: undefined,
  })
  await assert.rejects(
    handler('set', { ops: [{ op: 'set', path: ['subagentBridge', 'unknownField'], value: 1 }] }),
    /禁止修改设置字段/u,
  )
  // 并发上限是子代理托管的第二个可写字段：过去它硬编码为 5，外部 Agent 并发
  // 开出一批子代理时超限调用会被静默回退，用户无从调整。
  await handler('set', { ops: [{ op: 'set', path: ['subagentBridge', 'maxConcurrentSubagents'], value: 12 }] })
  assert.deepEqual(received, {
    ops: [{ op: 'set', path: ['subagentBridge', 'maxConcurrentSubagents'], value: 12 }],
    expectedRevision: undefined,
  })
  // 嵌套路径不能被放行，避免绕过白名单写到任意子字段。
  await assert.rejects(
    handler('set', { ops: [{ op: 'set', path: ['subagentBridge', 'maxConcurrentSubagents', 'nested'], value: 1 }] }),
    /禁止修改设置字段/u,
  )
})

test('移动端访问增强的设置路径与模块开关可通过 RPC 写入', async () => {
  let received: unknown
  const handler = createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: 'codingns', revision: 1, value: settingsOf({}) }],
    get: () => settingsOf({}),
    mutate: async (_namespace: string, ops: unknown) => { received = { ops, expectedRevision: undefined } },
  } as never)

  await handler('set', {
    ops: [
      { op: 'set', path: ['modules', 'mobileAccess'], value: true },
      { op: 'set', path: ['mobileAccess', 'hideSidebarOnMobile'], value: true },
      { op: 'set', path: ['mobileAccess', 'mobileViewportMaxPx'], value: 900 },
    ],
  })
  assert.deepEqual(received, {
    ops: [
      { op: 'set', path: ['modules', 'mobileAccess'], value: true },
      { op: 'set', path: ['mobileAccess', 'hideSidebarOnMobile'], value: true },
      { op: 'set', path: ['mobileAccess', 'mobileViewportMaxPx'], value: 900 },
    ],
    expectedRevision: undefined,
  })

  // 手势设置归属移动端访问增强：非回环页面没有本地设置镜像，写入只能走这条 RPC。
  await handler('set', {
    ops: [
      { op: 'set', path: ['mobileAccess', 'sidebarGestures'], value: true },
      { op: 'set', path: ['mobileAccess', 'sidebarGestureMapping'], value: 'swipe-inward' },
      { op: 'set', path: ['mobileAccess', 'sidebarGestureEdge'], value: 'avoid' },
      { op: 'set', path: ['mobileAccess', 'sidebarGestureDistancePercent'], value: 50 },
    ],
  })
  assert.deepEqual(received, {
    ops: [
      { op: 'set', path: ['mobileAccess', 'sidebarGestures'], value: true },
      { op: 'set', path: ['mobileAccess', 'sidebarGestureMapping'], value: 'swipe-inward' },
      { op: 'set', path: ['mobileAccess', 'sidebarGestureEdge'], value: 'avoid' },
      { op: 'set', path: ['mobileAccess', 'sidebarGestureDistancePercent'], value: 50 },
    ],
    expectedRevision: undefined,
  })

  // 旧像素字段继续放行：已安装的 PWA 可能仍在运行缓存里的旧 bundle，
  // 拒绝写入会让用户的设置保存直接报错。
  await handler('set', {
    ops: [{ op: 'set', path: ['mobileAccess', 'sidebarGestureThresholdPx'], value: 80 }],
  })
  assert.deepEqual(received, {
    ops: [{ op: 'set', path: ['mobileAccess', 'sidebarGestureThresholdPx'], value: 80 }],
    expectedRevision: undefined,
  })

  await assert.rejects(
    handler('set', { ops: [{ op: 'set', path: ['workspaceSessionEnhancement', 'sidebarGestures'], value: true }] }),
    /禁止修改设置字段/u,
  )

  await assert.rejects(
    handler('set', { ops: [{ op: 'set', path: ['mobileAccess', 'unknownField'], value: 1 }] }),
    /禁止修改设置字段/u,
  )

  // 局域网入口的 PWA 资产由「移动端访问增强」卡片写入：非回环页面没有本地设置镜像，
  // 这条路径必须放行，否则手机上的 PWA 开关会被直接拒绝。
  const pwa = { enabled: false, serviceWorker: true, installPrompt: false, notifications: 'local' }
  await handler('set', { ops: [{ op: 'set', path: ['lanAccessDsh', 'pwa'], value: pwa }] })
  assert.deepEqual(received, {
    ops: [{ op: 'set', path: ['lanAccessDsh', 'pwa'], value: pwa }],
    expectedRevision: undefined,
  })
  await assert.rejects(
    handler('set', { ops: [{ op: 'set', path: ['lanAccessDsh', 'unknownField'], value: 1 }] }),
    /禁止修改设置字段/u,
  )
})

test('远程设置 RPC 兼容 DSH 0.1.7 的插件 entry id', async () => {
  const current = settingsOf({})
  let namespace: string | undefined
  const handler = createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: 'codingns4dsh', revision: 2, value: current }],
    get: (requestedNamespace: string) => requestedNamespace === 'codingns4dsh' ? current : undefined,
    mutate: async (updatedNamespace: string) => { namespace = updatedNamespace },
  } as never)

  assert.deepEqual(await handler('get', {}), { value: current, revision: 2 })
  await handler('set', { ops: [{ op: 'set', path: ['modules', 'reverseProxy'], value: true }] })
  assert.equal(namespace, 'codingns4dsh')
})

test('远程设置 RPC 按 scoped entry id 回读配置，而不是固定读取旧 namespace', async () => {
  const current = settingsOf({ reverseProxy: true })
  let requestedNamespace: string | undefined
  const handler = createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: '@jingyi0605/codingns4dsh', revision: 9, value: current }],
    get: (namespace: string) => {
      requestedNamespace = namespace
      return namespace === '@jingyi0605/codingns4dsh' ? current : undefined
    },
    mutate: async () => undefined,
  } as never)

  assert.deepEqual(await handler('get', {}), { value: current, revision: 9 })
  assert.equal(requestedNamespace, '@jingyi0605/codingns4dsh')
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
  // 设置卡片文案必须走词典键；label/description 只是词典缺失时的兜底。
  assert.equal(cliAdaptersFeature.descriptor.ui?.labelKey, 'feature.cliAdapters.label')
  assert.equal(cliAdaptersFeature.descriptor.ui?.alwaysEnabled, undefined)
  assert.equal(cliAdaptersFeature.settingsPanel?.name, 'CliAdaptersPanel')
})

test('终端增强作为默认关闭且重启生效的独立设置模块登记', () => {
  assert.equal(terminalEnhancementFeature.descriptor.name, 'terminalEnhancement')
  assert.equal(terminalEnhancementFeature.descriptor.enabledByDefault, false)
  assert.equal(terminalEnhancementFeature.descriptor.activation, 'restart')
  assert.equal(terminalEnhancementFeature.descriptor.ui?.labelKey, 'feature.terminal.label')
  assert.equal(terminalEnhancementFeature.settingsPanel?.name, 'TerminalEnhancementPanel')
})

test('工作区会话增强作为依赖外部 Agent 的实时 Client 模块登记', () => {
  assert.equal(workspaceSessionEnhancementFeature.descriptor.name, 'workspaceSessionEnhancement')
  assert.equal(workspaceSessionEnhancementFeature.descriptor.runtime, 'client')
  assert.equal(workspaceSessionEnhancementFeature.descriptor.enabledByDefault, false)
  assert.deepEqual(workspaceSessionEnhancementFeature.descriptor.dependencies, ['cliAdapters'])
  assert.equal(workspaceSessionEnhancementFeature.descriptor.activation, undefined)
  assert.equal(workspaceSessionEnhancementFeature.descriptor.ui?.labelKey, 'feature.workspaceSession.label')
  assert.equal(workspaceSessionEnhancementFeature.settingsPanel?.name, 'WorkspaceSessionEnhancementPanel')
})

test('移动端访问增强作为默认启用、依赖布局能力的 Client 模块登记', () => {
  assert.equal(mobileAccessFeature.descriptor.name, 'mobileAccess')
  assert.equal(mobileAccessFeature.descriptor.runtime, 'client')
  assert.equal(mobileAccessFeature.descriptor.enabledByDefault, true)
  assert.deepEqual(mobileAccessFeature.descriptor.dependencies, [])
  assert.deepEqual(mobileAccessFeature.descriptor.requires, [
    { capability: 'layout.columns', required: false, fallback: 'disable' },
  ])
  assert.equal(mobileAccessFeature.descriptor.ui?.labelKey, 'feature.mobileAccess.label')
  assert.equal(mobileAccessFeature.settingsPanel?.name, 'MobileAccessPanel')
})

test('工作区调试面板作为可独立启停的 Client 模块登记', () => {
  assert.equal(debugFeature.descriptor.name, 'debug')
  assert.equal(debugFeature.descriptor.runtime, 'client')
  assert.equal(debugFeature.descriptor.enabledByDefault, true)
  assert.equal(debugFeature.descriptor.ui?.labelKey, 'feature.debug.label')
  assert.equal(debugFeature.settingsPanel, undefined)
})

test('注册表拒绝未知的模块生效模式', () => {
  const registry = new FeatureRegistry({})
  assert.throws(() => registry.register({
    descriptor: {
      name: 'brokenActivation',
      version: '1.0.0',
      enabledByDefault: false,
      dependencies: [],
      runtime: 'client',
      activation: 'later' as never,
    },
    start: () => undefined,
  }), /activation/u)
})
