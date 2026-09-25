import { DshCapabilityRegistry } from './registry.js'
import type { DshCapabilityRoute, DshCapabilityRuntime } from './types.js'

/**
 * 注册 CodingNS 当前实际消费的 DSH 服务能力。
 *
 * 探测只检查结构，不读取版本字符串；版本范围由 Registry 统一处理，避免
 * 业务模块在运行时继续堆叠 if (version >= ...)。
 */
export function createDshCapabilityRegistry(
  dshVersion: string,
  runtime: DshCapabilityRuntime,
  context: unknown,
): DshCapabilityRegistry {
  const registry = new DshCapabilityRegistry(dshVersion, runtime)
  const value = context as Record<string, unknown>
  const rangeLegacy = '>=0.1.5-rc.3 <0.1.7-0'
  const rangeModern = '>=0.1.7-rc.2 <0.1.8-0'
  const add = <T>(route: DshCapabilityRoute<T>): void => registry.register(route)

  if (runtime === 'host') {
    add({ id: 'settings-scope', capability: 'settings.store', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => typeof (ctx as { settings?: { register?: unknown } }).settings?.register === 'function', create: (ctx) => (ctx as { settings: unknown }).settings })
    add({ id: 'config-settings', capability: 'settings.store', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => typeof (ctx as { settings?: { describe?: unknown; mutate?: unknown } }).settings?.describe === 'function' && typeof (ctx as { settings?: { mutate?: unknown } }).settings?.mutate === 'function', create: (ctx) => (ctx as { settings: unknown }).settings })
    add({ id: 'connection-rpc', capability: 'connection.rpc', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { connection?: unknown }).connection !== undefined, create: (ctx) => (ctx as { connection: unknown }).connection })
    add({ id: 'connection-rpc-peer-aware', capability: 'connection.rpc', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => (ctx as { connection?: unknown }).connection !== undefined, create: (ctx) => (ctx as { connection: unknown }).connection })
    add({ id: 'connection-peer', capability: 'connection.peer', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => (ctx as { connection?: { peer?: unknown } }).connection?.peer !== undefined, create: (ctx) => (ctx as { connection: { peer: unknown } }).connection.peer })
    add({ id: 'remote-result', capability: 'typert.remote', supportedDsh: '>=0.1.5-rc.3 <0.1.8-0', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { remote?: unknown }).remote !== undefined, create: (ctx) => (ctx as { remote: unknown }).remote })
  } else {
    add({ id: 'settings-scope', capability: 'settings.store', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => typeof (ctx as { settingsScope?: { bind?: unknown } }).settingsScope?.bind === 'function', create: (ctx) => (ctx as { settingsScope: unknown }).settingsScope })
    add({ id: 'config-form', capability: 'settings.store', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => typeof (ctx as { configForms?: { get?: unknown } }).configForms?.get === 'function', create: (ctx) => (ctx as { configForms: unknown }).configForms })
    add({ id: 'icon-primitives', capability: 'ui.icon.plus', supportedDsh: '>=0.1.5-rc.3 <0.1.8-0', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: () => value.primitives !== undefined, create: () => value.primitives })
    add({ id: 'locale-runtime', capability: 'locale.runtime', supportedDsh: '>=0.1.5-rc.3 <0.1.8-0', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { locale?: unknown }).locale !== undefined, create: (ctx) => (ctx as { locale: unknown }).locale })
    add({ id: 'theme-runtime', capability: 'theme.runtime', supportedDsh: '>=0.1.5-rc.3 <0.1.8-0', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { theme?: unknown }).theme !== undefined, create: (ctx) => (ctx as { theme: unknown }).theme })
    add({ id: 'conversation-events', capability: 'conversation.tool-call', supportedDsh: '>=0.1.5-rc.3 <0.1.8-0', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { uiConversation?: unknown }).uiConversation !== undefined, create: (ctx) => (ctx as { uiConversation: unknown }).uiConversation })
    add({ id: 'sidebar-right', capability: 'sidebar.right', supportedDsh: '>=0.1.5-rc.3 <0.1.8-0', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { sidebarRight?: unknown }).sidebarRight !== undefined, create: (ctx) => (ctx as { sidebarRight: unknown }).sidebarRight })
    add({ id: 'remote-result', capability: 'typert.remote', supportedDsh: '>=0.1.5-rc.3 <0.1.8-0', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { remote?: unknown }).remote !== undefined, create: (ctx) => (ctx as { remote: unknown }).remote })
  }
  return registry
}
