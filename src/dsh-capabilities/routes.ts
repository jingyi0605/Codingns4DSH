import { DshCapabilityRegistry } from './registry.js'
import { DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL } from '../bootstrap/dsh-peer-host-preboot-shim.js'
import { DSH_COMPATIBILITY } from '../shared/contracts/version.js'
import type { DshCapabilityRoute, DshCapabilityRuntime } from './types.js'
import { createTerminalSharingBridge, supportsTerminalSharing } from './client/terminal-sharing-adapter.js'

/**
 * 注册 Codingns4DSH 当前实际消费的 DSH 服务能力。
 *
 * 探测只检查结构，不读取版本字符串；版本范围由 Registry 统一处理，避免
 * 业务模块在运行时继续堆叠 if (version >= ...)。
 */
export function createDshCapabilityRegistry(
  dshVersion: string,
  runtime: DshCapabilityRuntime,
  context: unknown,
  facts: DshCapabilityRuntimeFacts = {},
): DshCapabilityRegistry {
  const registry = new DshCapabilityRegistry(dshVersion, runtime)
  const rangeLegacy = '>=0.1.5-rc.3 <=0.1.6'
  const rangeModern = '>=0.1.7-rc.2 <=0.1.7-rc.2'
  const range020 = DSH_COMPATIBILITY
  const add = <T>(route: DshCapabilityRoute<T>): void => registry.register(route)

  if (runtime === 'host') {
    // rc.2 已具备同一套根 Agent 与工具隔离接口；路由 ID 保持兼容，范围跟随插件支持声明。
    add({ id: 'assistant-agent-021', capability: 'assistant.agent', supportedDsh: range020, runtime, priority: 10, status: 'supported', introducedIn: '0.2.0-rc.2',
      detect: (ctx) => hasMethods(read(ctx, 'agents'), ['create']) && hasMethods(read(ctx, 'tools'), ['register', 'restrict', 'guard', 'presentAs']) && hasMethods(read(ctx, 'systemPrompt'), ['section', 'suppressRuntimeContext']) && typeof read(ctx, 'on') === 'function',
      create: (ctx) => read(ctx, 'agents') })
    add({ id: 'settings-scope', capability: 'settings.store', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => typeof (ctx as { settings?: { register?: unknown } }).settings?.register === 'function', create: (ctx) => (ctx as { settings: unknown }).settings })
    add({ id: 'config-settings', capability: 'settings.store', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => typeof (ctx as { settings?: { describe?: unknown; mutate?: unknown } }).settings?.describe === 'function' && typeof (ctx as { settings?: { mutate?: unknown } }).settings?.mutate === 'function', create: (ctx) => (ctx as { settings: unknown }).settings })
    add({ id: 'connection-rpc', capability: 'connection.rpc', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { connection?: unknown }).connection !== undefined, create: (ctx) => (ctx as { connection: unknown }).connection })
    add({ id: 'connection-rpc-peer-aware', capability: 'connection.rpc', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => (ctx as { connection?: unknown }).connection !== undefined, create: (ctx) => (ctx as { connection: unknown }).connection })
    add({ id: 'connection-peer', capability: 'connection.peer', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => (ctx as { connection?: { peer?: unknown } }).connection?.peer !== undefined, create: (ctx) => (ctx as { connection: { peer: unknown } }).connection.peer })
    add({ id: 'remote-result', capability: 'typert.remote', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { remote?: unknown }).remote !== undefined, create: (ctx) => (ctx as { remote: unknown }).remote })
    addDsh020HostRoutes(add, range020)
    addPeerHostHostRoutes(add)
  } else {
    add({ id: 'settings-scope', capability: 'settings.store', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => typeof (ctx as { settingsScope?: { bind?: unknown } }).settingsScope?.bind === 'function', create: (ctx) => (ctx as { settingsScope: unknown }).settingsScope })
    add({ id: 'config-form', capability: 'settings.store', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => typeof (ctx as { configForms?: { get?: unknown } }).configForms?.get === 'function', create: (ctx) => (ctx as { configForms: unknown }).configForms })
    add({ id: 'icon-primitives', capability: 'ui.icon.plus', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: () => facts.primitives !== undefined, create: () => facts.primitives })
    add({ id: 'locale-runtime', capability: 'locale.runtime', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { locale?: unknown }).locale !== undefined, create: (ctx) => (ctx as { locale: unknown }).locale })
    add({ id: 'theme-runtime', capability: 'theme.runtime', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { theme?: unknown }).theme !== undefined, create: (ctx) => (ctx as { theme: unknown }).theme })
    add({ id: 'conversation-events', capability: 'conversation.tool-call', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { uiConversation?: unknown }).uiConversation !== undefined, create: (ctx) => (ctx as { uiConversation: unknown }).uiConversation })
    add({ id: 'sidebar-right', capability: 'sidebar.right', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { sidebarRight?: unknown }).sidebarRight !== undefined, create: (ctx) => (ctx as { sidebarRight: unknown }).sidebarRight })
    add({ id: 'remote-result', capability: 'typert.remote', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { remote?: unknown }).remote !== undefined, create: (ctx) => (ctx as { remote: unknown }).remote })
    addDsh020ClientRoutes(add, range020, facts)
    addPeerHostClientRoutes(add)
  }
  return registry
}

type CapabilityRouteAdder = <T>(route: DshCapabilityRoute<T>) => void

/**
 * 无法从 Context 探测、只能由运行时入口提供的结构事实。
 * 图标导出属于客户端 bundle 的静态导入，由 client/index.ts 在装配时提供。
 */
export interface DshCapabilityRuntimeFacts {
  readonly primitives?: unknown
}

/** DSH 0.2 Host 结构化能力。检测基于服务形状，不把版本判断散落到业务模块。 */
function addDsh020HostRoutes(add: CapabilityRouteAdder, supportedDsh: string): void {
  add({
    id: 'session-title-020', capability: 'session.title', supportedDsh, runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.2',
    detect: (ctx) => hasMethods(read(ctx, 'sessionTitle'), ['get']) && hasMethods(read(ctx, 'sessions'), ['get']) && typeof read(ctx, 'on') === 'function',
    create: (ctx) => ({ titles: read(ctx, 'sessionTitle'), sessions: read(ctx, 'sessions') }),
  })
  add({
    id: 'session-working-directory-021', capability: 'session.working-directory', supportedDsh: '>=0.2.1-alpha.2', runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.1-alpha.2',
    // 只探测 `get`：`ensure()` 会按需恢复目录并在必要时写 `working-directory/change`
    // 事件，终端读当前目录不能有这种副作用。
    detect: (ctx) => hasMethods(read(ctx, 'workingDirectory'), ['get']),
    create: (ctx) => read(ctx, 'workingDirectory'),
  })
  add({
    id: 'llm-text-021', capability: 'llm.text', supportedDsh, runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.2',
    detect: (ctx) => hasMethods(read(ctx, 'llm'), ['stream', 'listProviders', 'listModels']),
    create: (ctx) => read(ctx, 'llm'),
  })
  add({
    id: 'settings-forms-020', capability: 'settings.store', supportedDsh, runtime: 'host', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: (ctx) => hasMethods(read(ctx, 'settings'), ['describe', 'mutate', 'configure']),
    create: (ctx) => read(ctx, 'settings'),
  })
  add({
    id: 'connection-rpc-020', capability: 'connection.rpc', supportedDsh, runtime: 'host', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: (ctx) => hasMethods(read(ctx, 'connection.rpc'), ['handle', 'intercept']) && hasMethods(read(ctx, 'connection.fetch'), ['register']),
    create: (ctx) => read(ctx, 'connection'),
  })
  add({
    id: 'connection-peer-admission-020', capability: 'connection.peer', supportedDsh, runtime: 'host', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: (ctx) => hasMethods(read(ctx, 'connection'), ['admit', 'requestRejection']) && read(ctx, 'connection.operator') !== undefined,
    create: (ctx) => read(ctx, 'connection'),
  })
  add({
    id: 'connection-rpc-attachment-020', capability: 'connection.attachment', supportedDsh, runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: (ctx) => hasMethods(read(ctx, 'connection.rpc'), ['handle']) && hasMethods(read(ctx, 'connection.fetch'), ['register']),
    create: (ctx) => read(ctx, 'connection'),
  })
  add({
    id: 'connection-rpc-uplink-020', capability: 'connection.uplink', supportedDsh, runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: (ctx) => hasMethods(read(ctx, 'connection.rpc'), ['handle']) && read(ctx, 'connection.operator') !== undefined,
    create: (ctx) => read(ctx, 'connection'),
  })
  add({
    id: 'remote-context-stream-020', capability: 'typert.remote', supportedDsh, runtime: 'host', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // 0.2 Host 用 `ctx.typert` 注册表承载 Remote 服务（TypertRemoteService）；
    // `ctx.remote` 属于浏览器装配，不会出现在 Host 组合里。
    detect: (ctx) => read(ctx, 'typert.remotes') !== undefined && read(ctx, 'typert.local') !== undefined,
    create: (ctx) => read(ctx, 'typert'),
  })
  add({
    id: 'typert-context-registry-020', capability: 'typert.context', supportedDsh, runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: (ctx) => hasMethods(read(ctx, 'typert.contexts'), ['getHost', 'getClient']),
    create: (ctx) => read(ctx, 'typert.contexts'),
  })
  add({
    id: 'typert-remote-stream-020', capability: 'typert.stream', supportedDsh, runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // 流式端点由 Remote 注册表承载（descriptor.mode === 'stream'）。
    detect: (ctx) => hasMethods(read(ctx, 'typert.remotes'), ['register', 'list']),
    create: (ctx) => read(ctx, 'typert.remotes'),
  })
  add({
    id: 'session-format-v4', capability: 'session.format-v4', supportedDsh, runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // generation 由 SessionStore 中每个会话头部的 version 决定；这里只确认 0.2
    // 的 Store 形状，具体 generation 仍由 native-session-bridge 按会话读取。
    detect: (ctx) => hasMethods(read(ctx, 'sessions'), ['get', 'list']),
    create: (ctx) => read(ctx, 'sessions'),
  })
  add({
    id: 'subagent-activation-021', capability: 'subagent.continuable', supportedDsh: '>=0.2.1-alpha.2', runtime: 'host', priority: 30,
    status: 'supported', introducedIn: '0.2.1-alpha.2',
    // alpha.2 起 DSH 用托管 Activation 取代可续启动：`startContinuable` 已从
    // SubagentRuntime 移除，改为 `startActivation` 且 `delivery` 为必填参数。
    // 两条路由共用 `subagent.continuable` 能力，Registry 按版本范围与优先级择优，
    // 业务侧只认能力是否 ready，不需要在运行期写版本判断。
    detect: (ctx) => hasMethods(read(ctx, 'subagents'), ['startActivation', 'sendMessage']),
    create: (ctx) => read(ctx, 'subagents'),
  })
  add({
    id: 'subagent-continuable-020', capability: 'subagent.continuable', supportedDsh: '>=0.2.0-rc.1 <=0.2.1-alpha.1', runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // rc.1 到 alpha.1 的可续子代理是 SubagentRuntime 的公开操作 startContinuable/sendMessage。
    detect: (ctx) => hasMethods(read(ctx, 'subagents'), ['startContinuable', 'sendMessage']),
    create: (ctx) => read(ctx, 'subagents'),
  })
  add({
    id: 'agent-team-native-020', capability: 'agent-team.native', supportedDsh, runtime: 'host', priority: 10,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // 原生 Team 代理同时需要 TeamService 的成员/派生操作与 Agent 注册表。
    detect: (ctx) => hasMethods(read(ctx, 'agentTeams'), ['listMembers', 'spawnTeammate']) && read(ctx, 'agents') !== undefined,
    create: (ctx) => read(ctx, 'agentTeams'),
  })
  add({
    id: 'index-inject-rows-020', capability: 'web.index-inject', supportedDsh, runtime: 'host', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // 启动页注入 = 事件总线 + WebServer 端口；行类型是否支持由渲染方决定。
    detect: (ctx) => typeof read(ctx, 'on') === 'function' && read(ctx, 'webServer') !== undefined,
    create: (ctx) => ({ events: read(ctx, 'on'), webServer: read(ctx, 'webServer') }),
  })
  add({
    id: 'index-tap-020', capability: 'web.index-tap', supportedDsh, runtime: 'host', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // raw HTML 变换是逃生口：只有确认存在 tapIndex 才允许注册。
    detect: (ctx) => typeof read(ctx, 'webServer.tapIndex') === 'function',
    create: (ctx) => read(ctx, 'webServer'),
  })
}

/** DSH 0.2 Client 结构化能力；图标和 UI 服务允许由新旧导出共同提供。 */
function addDsh020ClientRoutes(add: CapabilityRouteAdder, supportedDsh: string, facts: DshCapabilityRuntimeFacts): void {
  add({
    // rc.2 只有纯文本镜像且在组件挂载后才导入草稿，不能保证跨会话插入安全。
    // alpha.1 与 alpha.2 的 `scope`/`input.for`/`openSession` 探测点与草稿 API
    // （captureInsertion、insertReference、persistDraft）逐项一致，因此共用同一路由。
    id: 'conversation-draft-share-021', capability: 'conversation.draft-share', supportedDsh: '>=0.2.1-alpha.1 <=0.2.1-alpha.2', runtime: 'client', priority: 30,
    status: 'supported', introducedIn: '0.2.1-alpha.1',
    detect: supportsTerminalSharing,
    create: createTerminalSharingBridge,
  })
  add({
    id: 'config-forms-020', capability: 'settings.store', supportedDsh, runtime: 'client', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: (ctx) => hasMethods(read(ctx, 'settings'), ['describe', 'update']) || hasMethods(read(ctx, 'configForms'), ['get']),
    create: (ctx) => read(ctx, 'settings') ?? read(ctx, 'configForms'),
  })
  add({
    id: 'regular-plus-icon-020', capability: 'ui.icon.plus', supportedDsh, runtime: 'client', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: () => hasAny(facts.primitives, ['IconPlusOutlineRegular', 'IconPlusOutlineMedium']),
    create: () => facts.primitives,
  })
  add({
    id: 'regular-chevron-icon-020', capability: 'ui.icon.chevron', supportedDsh, runtime: 'client', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    detect: () => hasAny(facts.primitives, ['IconChevronDownOutlineRegular', 'IconChevronDownOutlineMedium']),
    create: () => facts.primitives,
  })
  add({ id: 'locale-runtime-020', capability: 'locale.runtime', supportedDsh, runtime: 'client', priority: 30, status: 'supported', introducedIn: '0.2.0-rc.1', detect: (ctx) => read(ctx, 'locale') !== undefined, create: (ctx) => read(ctx, 'locale') })
  add({ id: 'theme-runtime-020', capability: 'theme.runtime', supportedDsh, runtime: 'client', priority: 30, status: 'supported', introducedIn: '0.2.0-rc.1', detect: (ctx) => read(ctx, 'theme') !== undefined, create: (ctx) => read(ctx, 'theme') })
  add({
    id: 'theme-font-scale-021', capability: 'theme.font-scale', supportedDsh: '>=0.2.1-alpha.2', runtime: 'client', priority: 10,
    status: 'supported', introducedIn: '0.2.1-alpha.2',
    // alpha.2 起 `ITheme` 暴露按角色的 `fontSizes`；旧版本只有单值 `fontSize`，
    // 探测失败即整块跳过，插件界面的 `fontSize()` 回落到基准像素。
    detect: (ctx) => typeof read(ctx, 'theme.fontSizes') === 'object',
    create: (ctx) => read(ctx, 'theme'),
  })
  add({ id: 'conversation-events-020', capability: 'conversation.tool-call', supportedDsh, runtime: 'client', priority: 30, status: 'supported', introducedIn: '0.2.0-rc.1', detect: (ctx) => read(ctx, 'uiConversation') !== undefined, create: (ctx) => read(ctx, 'uiConversation') })
  add({ id: 'sidebar-right-dock-020', capability: 'sidebar.right', supportedDsh, runtime: 'client', priority: 30, status: 'supported', introducedIn: '0.2.0-rc.1', detect: (ctx) => read(ctx, 'sidebarRight') !== undefined || read(ctx, 'sidebarRightTabs') !== undefined, create: (ctx) => read(ctx, 'sidebarRight') ?? read(ctx, 'sidebarRightTabs') })
  add({ id: 'remote-context-stream-020-client', capability: 'typert.remote', supportedDsh, runtime: 'client', priority: 30, status: 'supported', introducedIn: '0.2.0-rc.1', detect: (ctx) => hasMethods(read(ctx, 'remote'), ['$mount']), create: (ctx) => read(ctx, 'remote') })
  add({ id: 'typert-context-registry-020-client', capability: 'typert.context', supportedDsh, runtime: 'client', priority: 10, status: 'supported', introducedIn: '0.2.0-rc.1', detect: (ctx) => hasMethods(read(ctx, 'typert.contexts'), ['getHost', 'getClient']), create: (ctx) => read(ctx, 'typert.contexts') })
  add({ id: 'typert-remote-stream-020-client', capability: 'typert.stream', supportedDsh, runtime: 'client', priority: 10, status: 'supported', introducedIn: '0.2.0-rc.1', detect: (ctx) => hasMethods(read(ctx, 'remote'), ['$mount', '$stream']), create: (ctx) => read(ctx, 'remote') })
  add({ id: 'client-web-boot-graph-020', capability: 'client.boot-graph', supportedDsh, runtime: 'client', priority: 10, status: 'supported', introducedIn: '0.2.0-rc.1', detect: (ctx) => read(ctx, 'modules.version') === 'client', create: (ctx) => read(ctx, 'modules') })
  add({
    id: 'layout-columns-020', capability: 'layout.columns', supportedDsh, runtime: 'client', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // 手势只通过布局服务开合左栏；缺 toggleSidebar 时整块禁用。
    detect: (ctx) => typeof read(ctx, 'layout.toggleSidebar') === 'function',
    create: (ctx) => read(ctx, 'layout'),
  })
  add({
    id: 'sidebar-right-expand-020', capability: 'sidebar.right.expand', supportedDsh, runtime: 'client', priority: 30,
    status: 'supported', introducedIn: '0.2.0-rc.1',
    // 右栏开合比“停靠”更窄：必须同时能读状态与切换，否则手势无法保持同步。
    detect: (ctx) => hasMethods(read(ctx, 'sidebarRight'), ['isExpanded', 'toggleExpanded']),
    create: (ctx) => read(ctx, 'sidebarRight'),
  })
}

/**
 * 读取探测上下文里的服务或结构事实。
 *
 * Cordis 的 Context 只在调用方 fiber 的 inject 链（或祖先 fiber 提供的服务）里
 * 解析属性；直接读未注入的服务会抛 `cannot get property "x" without inject`，
 * 把 `a || b` 形式的探测短路成失败。因此这里统一先走 `ctx.get(...)`（Cordis 提供
 * 的免 inject 读取），再回退到普通属性读取，让探测只依据服务形状，不受消费方
 * inject 列表影响。
 */
function read(context: unknown, path: string): unknown {
  const [head, ...rest] = path.split('.')
  if (head === undefined) return undefined
  let value = readKey(context, head)
  for (const key of rest) {
    value = readProperty(value, key)
  }
  return value
}

/** 读取上下文上的服务（优先 `ctx.get`）或直接挂在上下文上的事实对象。 */
function readKey(context: unknown, key: string): unknown {
  if (typeof context !== 'object' || context === null) return undefined
  const getter = readProperty(context, 'get')
  if (typeof getter === 'function') {
    try {
      const value = (getter as (name: string) => unknown).call(context, key)
      if (value !== undefined) return value
    } catch {
      // Cordis 读取失败按缺失处理，继续尝试普通属性。
    }
  }
  return readProperty(context, key)
}

/** 读取对象属性；Cordis 代理对未注入的服务会抛错，统一按缺失处理。 */
function readProperty(target: unknown, key: string): unknown {
  if (typeof target !== 'object' || target === null) return undefined
  try {
    return Reflect.get(target, key)
  } catch {
    return undefined
  }
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && methods.every((method) => typeof Reflect.get(value, method) === 'function')
}

function hasAny(value: unknown, keys: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && keys.some((key) => Reflect.get(value, key) !== undefined)
}

/** PeerHost Host 能力只接受显式注入的适配器，避免把普通 DSH 服务误报为已实现。 */
function addPeerHostHostRoutes(add: CapabilityRouteAdder): void {
  addPeerHostRoute(add, 'peer-host.store', 'peer-host-store', 'peerHostStore')
  addPeerHostRoute(add, 'peer-host.handshake', 'peer-host-handshake', 'peerHostHandshake')
  addPeerHostRoute(add, 'peer-host.http-proxy', 'peer-host-http-proxy', 'peerHostHttpProxy')
  addPeerHostRoute(add, 'peer-host.ws-proxy', 'peer-host-ws-proxy', 'peerHostWsProxy')
  addPeerHostRoute(add, 'peer-host.aggregate', 'peer-host-aggregate', 'peerHostAggregate')
  addPeerHostRoute(add, 'peer-host.aggregated-transport', 'peer-host-aggregated-transport', 'peerHostAggregatedTransport')
  addPeerHostRoute(add, 'peer-host.target-capabilities', 'peer-host-target-capabilities', 'peerHostTargetCapabilities')
  addPeerHostRoute(add, 'peer-host.local-plugin-baseline', 'peer-host-local-plugin-baseline', 'peerHostLocalPluginBaseline')
  addPeerHostRoute(add, 'peer-host.relay-route', 'peer-host-relay-route', 'peerHostRelayRoute')
  addPeerHostRoute(add, 'peer-host.store', 'peer-host-store-020', 'peerHostStore', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.handshake', 'peer-host-handshake-020', 'peerHostHandshake', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.http-proxy', 'peer-host-http-proxy-020', 'peerHostHttpProxy', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.ws-proxy', 'peer-host-ws-proxy-020', 'peerHostWsProxy', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.aggregate', 'peer-host-aggregate-020', 'peerHostAggregate', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.aggregated-transport', 'peer-host-aggregated-transport-020', 'peerHostAggregatedTransport', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.target-capabilities', 'peer-host-target-capabilities-020', 'peerHostTargetCapabilities', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.local-plugin-baseline', 'peer-host-local-plugin-baseline-020', 'peerHostLocalPluginBaseline', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.relay-route', 'peer-host-relay-route-020', 'peerHostRelayRoute', DSH_COMPATIBILITY, 'supported', 30)
}

/**
 * PeerHost Client 导航能力由独立 adapter 注入；未注入时由 Feature 诊断降级。
 *
 * `peer-host.client-preboot-transport` 表示"页面在 DSH Connection 之前已可被聚合
 * Transport 包装"。它不再等待官方 Provider 适配器，而是由插件自带的启动页 shim
 * 提供：Web 与 Desktop 都注入同一个 shim，Desktop 用访问器接管运行时赋值。探测
 * 只读 shim 状态，`external`（Transport 形状未知）时判为不可用，由 Feature 按
 * "能力缺失只影响该模块"停用 PeerHost，而不是提示用户刷新。
 */
function addPeerHostClientRoutes(add: CapabilityRouteAdder): void {
  addPeerHostRoute(add, 'peer-host.native-navigation', 'peer-host-native-navigation-legacy', 'peerHostNativeNavigation', '>=0.1.5-rc.3 <=0.1.6', 'deprecated')
  addPeerHostRoute(add, 'peer-host.native-navigation', 'peer-host-native-navigation-modern', 'peerHostNativeNavigation', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'supported', 20)
  addPeerHostRoute(add, 'peer-host.remote-web-context-fallback', 'peer-host-remote-web-context-fallback', 'peerHostRemoteWebContextFallback')
  addPeerHostRoute(add, 'peer-host.native-navigation', 'peer-host-native-navigation-020', 'peerHostNativeNavigation', DSH_COMPATIBILITY, 'supported', 30)
  addPeerHostRoute(add, 'peer-host.remote-web-context-fallback', 'peer-host-remote-web-context-fallback-020', 'peerHostRemoteWebContextFallback', DSH_COMPATIBILITY, 'supported', 30)
  add({
    id: 'peer-host-client-preboot-transport-020',
    capability: 'peer-host.client-preboot-transport',
    supportedDsh: DSH_COMPATIBILITY,
    runtime: 'client',
    priority: 40,
    status: 'supported',
    introducedIn: '0.2.0-rc.2',
    detect: () => isPeerHostPrebootShimWrappable(),
    create: () => readPeerHostPrebootShim(),
  })
}

/**
 * shim 已安装且不是"结构不支持"时，页面 Transport 可被聚合层包装。
 *
 * 探测只读启动页已经写入的全局状态：`not-installed`（脚本未注入）与 `external`
 * （Transport 形状未知）都判为不可用，让 Feature 按"能力缺失只影响该模块"停用
 * PeerHost，而不是提示用户刷新。
 */
function isPeerHostPrebootShimWrappable(): boolean {
  const state = readPeerHostPrebootShimState()
  return state !== 'not-installed' && state !== 'external'
}

function readPeerHostPrebootShimState(): string {
  const shim = readPeerHostPrebootShim()
  if (shim === undefined) return 'not-installed'
  try {
    return typeof shim.getState === 'function' ? String(shim.getState()) : 'installed'
  } catch {
    return 'not-installed'
  }
}

function readPeerHostPrebootShim(): { getState?: () => string; getMode?: () => string } | undefined {
  try {
    return (globalThis as Record<string, unknown>)[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL] as { getState?: () => string } | undefined
  } catch {
    return undefined
  }
}

function addPeerHostRoute(
  add: CapabilityRouteAdder,
  capability: DshCapabilityRoute<unknown>['capability'],
  id: string,
  field: string,
  supportedDsh = '>=0.1.5-rc.3 <=0.1.7-rc.2',
  status: DshCapabilityRoute<unknown>['status'] = 'supported',
  priority = 10,
): void {
  add({
    id,
    capability,
    supportedDsh,
    runtime: capability === 'peer-host.native-navigation' || capability === 'peer-host.remote-web-context-fallback' || capability === 'peer-host.client-preboot-transport' ? 'client' : 'host',
    priority,
    status,
    introducedIn: '0.1.5-rc.3',
    detect: (context) => readPeerHostAdapter(context, field) !== undefined,
    create: (context) => readPeerHostAdapter(context, field),
  })
}

function readPeerHostAdapter(context: unknown, field: string): unknown {
  if (Array.isArray(context)) return undefined
  return readKey(context, field)
}
