import type { DshCapabilityId, DshCapabilityRouteStatus, DshCapabilityRuntime } from './types.js'
import { DSH_COMPATIBILITY } from '../shared/contracts/version.js'

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
  route('llm.text', 'llm-text-021', 'host', '>=0.2.1-alpha.1 <=0.2.1-alpha.1', 'supported', ['dsh-capabilities/host/assistant-llm-adapter.ts', 'host/features/assistant-text-chat.ts']),
  route('assistant.agent', 'assistant-agent-021', 'host', '>=0.2.1-alpha.1 <=0.2.1-alpha.1', 'supported', ['dsh-capabilities/host/assistant-agent-adapter.ts', 'host/features/global-voice-rpc.ts']),
  route('settings.store', 'legacy-settings-scope', 'host', '>=0.1.5-rc.3 <=0.1.6', 'supported', ['host/settings.ts', 'host/features/*']),
  route('settings.store', 'config-forms', 'host', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'supported', ['host/settings.ts', 'client/settings-bridge.ts']),
  route('connection.rpc', 'legacy-rpc-handler', 'host', '>=0.1.5-rc.3 <=0.1.6', 'supported', ['host/rpc.ts']),
  route('connection.rpc', 'peer-aware-rpc-handler', 'host', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'supported', ['host/rpc.ts']),
  route('connection.peer', 'peer-scope', 'host', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'supported', ['host/rpc.ts']),
  route('ui.icon.plus', 'fixed-plus-icon', 'client', '>=0.1.5-rc.3 <=0.1.6', 'supported', ['client/terminal/xterm-view.ts']),
  route('ui.icon.plus', 'regular-plus-icon', 'client', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'supported', ['client/terminal/xterm-view.ts']),
  route('ui.icon.chevron', 'fixed-chevron-icon', 'client', '>=0.1.5-rc.3 <=0.1.6', 'supported', ['client/terminal/ui.ts']),
  route('ui.icon.chevron', 'regular-chevron-icon', 'client', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'supported', ['client/terminal/ui.ts']),
  route('locale.runtime', 'locale-runtime', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['client/locale.ts']),
  route('theme.runtime', 'theme-runtime', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['client/theme.ts']),
  route('conversation.tool-call', 'conversation-events', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['client/external-tool-stream.ts']),
  route('sidebar.right', 'sidebar-right-tabs', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['client/terminal/ui.ts']),
  route('typert.remote', 'remote-result', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['host/terminal/terminal-controller.ts', 'client/terminal/model.ts']),
  route('peer-host.store', 'peer-host-store', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['host/features/peer-host.ts']),
  route('peer-host.handshake', 'peer-host-handshake', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['host/features/peer-host.ts']),
  route('peer-host.http-proxy', 'peer-host-http-proxy', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['host/features/peer-host.ts']),
  route('peer-host.ws-proxy', 'peer-host-ws-proxy', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['host/features/peer-host.ts']),
  route('peer-host.aggregate', 'peer-host-aggregate', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['host/features/peer-host.ts']),
  route('peer-host.relay-route', 'peer-host-relay-route', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['host/features/peer-host.ts']),
  route('peer-host.native-navigation', 'peer-host-native-navigation-legacy', 'client', '>=0.1.5-rc.3 <=0.1.6', 'deprecated', ['client/features/peer-host.ts']),
  route('peer-host.native-navigation', 'peer-host-native-navigation-modern', 'client', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'supported', ['client/features/peer-host.ts']),
  route('peer-host.remote-web-context-fallback', 'peer-host-remote-web-context-fallback', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'supported', ['client/features/peer-host.ts']),
  // DSH 0.2.0 的 Client ABI 只对当前锁定的 rc.2 做正式承诺，不能用无上界范围掩盖漂移。
  route('settings.store', 'settings-forms-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/settings.ts', 'host/rpc.ts']),
  route('connection.rpc', 'connection-rpc-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/rpc.ts', 'transport/dsh-transport.ts']),
  route('connection.peer', 'connection-peer-admission-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/rpc.ts']),
  route('connection.attachment', 'connection-rpc-attachment-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/rpc.ts', 'transport/dsh-transport.ts']),
  route('connection.uplink', 'connection-rpc-uplink-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/rpc.ts', 'transport/dsh-transport.ts']),
  route('typert.remote', 'remote-context-stream-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/terminal/terminal-controller.ts', 'client/terminal/model.ts']),
  route('typert.context', 'typert-context-registry-020', 'host', DSH_COMPATIBILITY, 'supported', ['typert.host.ts', 'host/terminal/terminal-controller.ts']),
  route('typert.stream', 'typert-remote-stream-020', 'host', DSH_COMPATIBILITY, 'supported', ['typert.host.ts', 'typert.remote-client.ts']),
  route('session.format-v4', 'session-format-v4', 'host', DSH_COMPATIBILITY, 'supported', ['host/native-session-bridge.ts', 'host/session-migration-repair.ts']),
  route('subagent.continuable', 'subagent-continuable-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/cli-adapters/session-store.ts', 'host/cli-adapters/feature.ts']),
  route('agent-team.native', 'agent-team-native-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/cli-adapters/feature.ts', 'host/cli-adapters/native-team-proxy.ts']),
  route('ui.icon.plus', 'regular-plus-icon-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/terminal/xterm-view.ts']),
  route('ui.icon.chevron', 'regular-chevron-icon-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/terminal/ui.ts']),
  route('locale.runtime', 'locale-runtime-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/locale.ts']),
  route('theme.runtime', 'theme-runtime-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/theme.ts']),
  route('conversation.tool-call', 'conversation-events-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/external-tool-stream.ts']),
  route('conversation.draft-share', 'conversation-draft-share-021', 'client', '>=0.2.1-alpha.1 <=0.2.1-alpha.1', 'supported', ['client/terminal/ui.ts', 'client/terminal/sharing.ts']),
  route('sidebar.right', 'sidebar-right-dock-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/terminal/ui.ts']),
  route('typert.remote', 'remote-context-stream-020-client', 'client', DSH_COMPATIBILITY, 'supported', ['client/terminal/model.ts']),
  route('typert.context', 'typert-context-registry-020-client', 'client', DSH_COMPATIBILITY, 'supported', ['typert.remote-client.ts', 'client/terminal/model.ts']),
  route('typert.stream', 'typert-remote-stream-020-client', 'client', DSH_COMPATIBILITY, 'supported', ['typert.remote-client.ts', 'client/terminal/model.ts']),
  route('client.boot-graph', 'client-web-boot-graph-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/index.ts', 'package.json']),
  route('peer-host.native-navigation', 'peer-host-native-navigation-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/features/peer-host.ts']),
  route('peer-host.remote-web-context-fallback', 'peer-host-remote-web-context-fallback-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/features/peer-host.ts']),
  route('peer-host.store', 'peer-host-store-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/features/peer-host.ts']),
  route('peer-host.handshake', 'peer-host-handshake-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/features/peer-host.ts']),
  route('peer-host.http-proxy', 'peer-host-http-proxy-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/features/peer-host.ts']),
  route('peer-host.ws-proxy', 'peer-host-ws-proxy-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/features/peer-host.ts']),
  route('peer-host.aggregate', 'peer-host-aggregate-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/features/peer-host.ts']),
  route('peer-host.aggregated-transport', 'peer-host-aggregated-transport-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/modules/peer-host/aggregated-host-transport.ts']),
  // 页面级 preboot shim 由插件自己的启动页脚本注入，Web 与 Desktop 共用同一份实现；
  // Desktop 用带 setter 的访问器接管运行时赋值，因此 0.2.0-rc.1 起即可用。
  route('peer-host.client-preboot-transport', 'peer-host-client-preboot-transport-020', 'client', DSH_COMPATIBILITY, 'supported', ['bootstrap/index.ts', 'host/index-injection.ts', 'client/features/peer-host.ts']),
  route('peer-host.target-capabilities', 'peer-host-target-capabilities-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/modules/peer-host/aggregated-host-transport.ts']),
  route('peer-host.local-plugin-baseline', 'peer-host-local-plugin-baseline-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/modules/peer-host/aggregated-host-transport.ts']),
  route('peer-host.relay-route', 'peer-host-relay-route-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/features/peer-host.ts']),
  // 移动端 PWA 与手势相关能力只在 0.2.0-rc.1 上验证过：结构化 `html` 行、`tapIndex`
  // 与布局服务在更早版本没有运行时实现，由 Registry 判为 unavailable 并给出诊断，
  // 业务侧据此整块跳过（不写入行、不注册手势）。
  route('web.index-inject', 'index-inject-rows-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/index-injection.ts', 'host/index.ts']),
  route('web.index-tap', 'index-tap-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/index.ts', 'host/modules/pwa/pwa-viewport.ts']),
  route('layout.columns', 'layout-columns-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/mobile-sidebar-gestures.ts', 'client/features/workspace-session-enhancement.ts', 'client/mobile-sidebar-rail-dom.ts', 'client/features/mobile-access.ts']),
  route('sidebar.right.expand', 'sidebar-right-expand-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/mobile-sidebar-gestures.ts', 'client/features/workspace-session-enhancement.ts']),
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
