import type { DshCapabilityId, DshCapabilityRouteStatus, DshCapabilityRuntime } from './types.js'

export interface DshCapabilityMatrixRoute {
  readonly capability: DshCapabilityId
  readonly routeId: string
  readonly supportedDsh: string
  readonly runtime: DshCapabilityRuntime
  readonly status: DshCapabilityRouteStatus
  readonly introducedIn: string
  readonly removableAfter?: string
  readonly replacement?: DshCapabilityId
  readonly consumers: readonly string[]
}

/** 能力版本矩阵是运行时路由和版本检查的共同事实源。 */
export const DSH_CAPABILITY_MATRIX: readonly DshCapabilityMatrixRoute[] = [
  route('settings.store', 'legacy-settings-scope', 'host', '>=0.1.5-rc.3 <0.1.7-0', 'supported', ['host/settings.ts', 'host/features/*']),
  route('settings.store', 'config-forms', 'host', '>=0.1.7-rc.2 <0.1.8-0', 'supported', ['host/settings.ts', 'client/settings-bridge.ts']),
  route('connection.rpc', 'legacy-rpc-handler', 'host', '>=0.1.5-rc.3 <0.1.7-0', 'supported', ['host/rpc.ts']),
  route('connection.rpc', 'peer-aware-rpc-handler', 'host', '>=0.1.7-rc.2 <0.1.8-0', 'supported', ['host/rpc.ts']),
  route('connection.peer', 'no-peer-context', 'host', '>=0.1.5-rc.3 <0.1.7-0', 'deprecated', ['host/rpc.ts'], 'connection.peer', '0.1.8-0'),
  route('connection.peer', 'peer-scope', 'host', '>=0.1.7-rc.2 <0.1.8-0', 'supported', ['host/rpc.ts']),
  route('ui.icon.plus', 'fixed-plus-icon', 'client', '>=0.1.5-rc.3 <0.1.7-0', 'supported', ['client/terminal/xterm-view.ts']),
  route('ui.icon.plus', 'regular-plus-icon', 'client', '>=0.1.7-rc.2 <0.1.8-0', 'supported', ['client/terminal/xterm-view.ts']),
  route('ui.icon.chevron', 'fixed-chevron-icon', 'client', '>=0.1.5-rc.3 <0.1.7-0', 'supported', ['client/terminal/ui.ts']),
  route('ui.icon.chevron', 'regular-chevron-icon', 'client', '>=0.1.7-rc.2 <0.1.8-0', 'supported', ['client/terminal/ui.ts']),
  route('locale.runtime', 'locale-runtime', 'client', '>=0.1.5-rc.3 <0.1.8-0', 'supported', ['client/locale.ts']),
  route('theme.runtime', 'theme-runtime', 'client', '>=0.1.5-rc.3 <0.1.8-0', 'supported', ['client/theme.ts']),
  route('conversation.tool-call', 'conversation-events', 'client', '>=0.1.5-rc.3 <0.1.8-0', 'supported', ['client/external-tool-stream.ts']),
  route('sidebar.right', 'sidebar-right-tabs', 'client', '>=0.1.5-rc.3 <0.1.8-0', 'supported', ['client/terminal/ui.ts']),
  route('typert.remote', 'remote-result', 'host', '>=0.1.5-rc.3 <0.1.8-0', 'supported', ['host/terminal/terminal-controller.ts', 'client/terminal/model.ts']),
]

function route(
  capability: DshCapabilityId,
  routeId: string,
  runtime: DshCapabilityRuntime,
  supportedDsh: string,
  status: DshCapabilityRouteStatus,
  consumers: readonly string[],
  replacement?: DshCapabilityId,
  removableAfter?: string,
): DshCapabilityMatrixRoute {
  return {
    capability,
    routeId,
    runtime,
    supportedDsh,
    status,
    introducedIn: supportedDsh.slice(2).split(' ')[0] ?? supportedDsh,
    ...(replacement === undefined ? {} : { replacement }),
    ...(removableAfter === undefined ? {} : { removableAfter }),
    consumers,
  }
}
