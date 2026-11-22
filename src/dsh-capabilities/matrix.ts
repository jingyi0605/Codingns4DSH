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
  route('plugin.update.inspect', 'plugin-manager-inspect-021', 'host', '>=0.2.1-rc.2', 'supported', ['dsh-capabilities/host/plugin-update-adapter.ts', 'host/features/plugin-update.ts']),
  route('plugin.update.apply', 'plugin-manager-install-021', 'host', '>=0.2.1-rc.2', 'supported', ['dsh-capabilities/host/plugin-update-adapter.ts', 'host/update/service.ts']),
  route('plugin.host.activation-status', 'plugin-host-version-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/update/service.ts']),
  route('plugin.client.reload-status', 'plugin-client-reload-unavailable-020', 'client', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/client/plugin-reload-adapter.ts', 'client/update-panel.ts']),
  route('session.external-performance', 'session-performance-projection-021', 'host', '>=0.2.1-alpha.3', 'supported', ['dsh-capabilities/host/session-performance-adapter.ts', 'host/cli-adapters/feature.ts']),
  route('session.external-performance', 'session-performance-presentation-021', 'client', '>=0.2.1-alpha.3', 'supported', ['dsh-capabilities/client/session-performance-adapter.ts', 'client/features/cli-adapters.ts']),
  route('session.prompt-assembly', 'session-prompt-assembly-021', 'host', '>=0.2.1-alpha.3', 'supported', ['dsh-capabilities/host/session-prompt-adapter.ts', 'host/features/session-prompt-translation.ts', 'host/cli-adapters/feature.ts']),
  route('session.external-model-selection', 'session-external-model-selection-021', 'host', '>=0.2.1-alpha.3', 'supported', ['dsh-capabilities/host/session-model-selection-adapter.ts', 'host/cli-adapters/feature.ts']),
  route('session.external-compaction', 'session-external-compaction-021', 'host', '>=0.2.1-rc.5', 'supported', ['dsh-capabilities/host/session-compaction-adapter.ts', 'host/cli-adapters/feature.ts']),
  route('session.activation', 'session-activation-020', 'host', '>=0.2.1-alpha.2 <=0.2.1-alpha.2', 'deprecated', ['dsh-capabilities/host/session-activation-adapter.ts', 'host/native-session-bridge.ts'], 'session.activation', '0.2.4-0'),
  route('session.activation', 'session-activation-021', 'host', '>=0.2.1-alpha.3', 'supported', ['dsh-capabilities/host/session-activation-adapter.ts', 'host/native-session-bridge.ts']),
  route('workspace.session-control', 'workspace-session-control-020', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/workspace-session-control-adapter.ts', 'host/workspace-mcp/tools.ts']),
  route('workspace.pending-questions', 'workspace-pending-questions-020', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/workspace-pending-questions-adapter.ts', 'host/workspace-mcp/tools.ts']),
  route('workspace.approval', 'workspace-approval-020', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/workspace-approval-adapter.ts', 'host/workspace-mcp/tools.ts', 'host/native-session-bridge.ts']),
  route('conversation.message-presentation', 'message-presentation-020', 'client', '>=0.2.1-alpha.2 <=0.2.1-alpha.2', 'deprecated', ['dsh-capabilities/client/message-presentation-adapter.ts', 'client/session-translation-chat.ts'], 'conversation.message-presentation', '0.2.4-0'),
  route('conversation.message-presentation', 'message-presentation-021', 'client', '>=0.2.1-alpha.3', 'supported', ['dsh-capabilities/client/message-presentation-adapter.ts', 'client/session-translation-chat.ts']),
  route('connection.peer', 'connection.peer-021', 'host', '>=0.2.1-alpha.3', 'supported', ['dsh-capabilities/host/connection-peer-adapter.ts', 'host/rpc.ts', 'host/modules/peer-host/peer-host-native-dispatch.ts']),
  route('web.browser-entry-url', 'web-browser-entry-connection-022', 'host', '>=0.2.2-alpha.2 <=0.2.2', 'supported', ['host/index.ts']),
  route('web.browser-entry-url', 'web-browser-entry-event-023', 'host', '>=0.2.3-alpha.1', 'supported', ['host/index.ts']),
  route('connection.uplink', 'connection.uplink-021', 'host', '>=0.2.1-alpha.3', 'supported', ['dsh-capabilities/host/native-dispatch-adapter.ts', 'host/modules/peer-host/peer-host-native-dispatch.ts']),
  route('session.title', 'session-title-020', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/session-title-adapter.ts', 'host/features/session-title-optimization.ts']),
  // alpha.2 起会话有可变的「当前目录」；旧版本没有该服务，终端回退到不可变的
  // `session.header.cwd`，因此能力缺失只影响「跟随当前目录」这一项增强。
  route('session.working-directory', 'session-working-directory-021', 'host', '>=0.2.1-alpha.2', 'supported', ['host/terminal/terminal-controller.ts', 'host/index.ts']),
  route('llm.text', 'llm-text-021', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/llm-text-adapter.ts', 'dsh-capabilities/host/session-title-adapter.ts', 'host/features/session-title-optimization.ts', 'host/features/git-management.ts']),
  route('settings.store', 'legacy-settings-scope', 'host', '>=0.1.5-rc.3 <=0.1.6', 'deprecated', ['host/settings.ts', 'host/features/*'], 'settings.store', '0.2.4-0'),
  route('settings.store', 'config-forms', 'host', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'deprecated', ['host/settings.ts', 'client/settings-bridge.ts'], 'settings.store', '0.2.4-0'),
  route('connection.rpc', 'legacy-rpc-handler', 'host', '>=0.1.5-rc.3 <=0.1.6', 'deprecated', ['host/rpc.ts'], 'connection.rpc', '0.2.4-0'),
  route('connection.rpc', 'peer-aware-rpc-handler', 'host', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'deprecated', ['host/rpc.ts'], 'connection.rpc', '0.2.4-0'),
  route('connection.peer', 'peer-scope', 'host', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'deprecated', ['host/rpc.ts'], 'connection.peer', '0.2.4-0'),
  route('ui.icon.plus', 'fixed-plus-icon', 'client', '>=0.1.5-rc.3 <=0.1.6', 'deprecated', ['client/terminal/xterm-view.ts'], 'ui.icon.plus', '0.2.4-0'),
  route('ui.icon.plus', 'regular-plus-icon', 'client', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'deprecated', ['client/terminal/xterm-view.ts'], 'ui.icon.plus', '0.2.4-0'),
  route('ui.icon.chevron', 'fixed-chevron-icon', 'client', '>=0.1.5-rc.3 <=0.1.6', 'deprecated', ['client/terminal/ui.ts'], 'ui.icon.chevron', '0.2.4-0'),
  route('ui.icon.chevron', 'regular-chevron-icon', 'client', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'deprecated', ['client/terminal/ui.ts'], 'ui.icon.chevron', '0.2.4-0'),
  route('locale.runtime', 'locale-runtime', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['client/locale.ts'], 'locale.runtime', '0.2.4-0'),
  route('theme.runtime', 'theme-runtime', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['client/theme.ts'], 'theme.runtime', '0.2.4-0'),
  route('conversation.tool-call', 'conversation-events', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['client/external-tool-stream.ts'], 'conversation.tool-call', '0.2.4-0'),
  route('sidebar.right', 'sidebar-right-tabs', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['client/terminal/ui.ts'], 'sidebar.right', '0.2.4-0'),
  route('sidebar.global-panel', 'sidebar-panellist-main-020', 'client', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/client/global-panel-adapter.ts', 'client/features/magpie-management.ts']),
  route('ui.context-menu', 'ui-context-menu-022', 'client', '>=0.2.2-alpha.3', 'supported', ['dsh-capabilities/client/context-menu-adapter.ts', 'client/features/file-management.ts', 'client/features/workspace-session-enhancement.ts']),
  route('typert.remote', 'remote-result', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['host/terminal/terminal-controller.ts', 'client/terminal/model.ts'], 'typert.remote', '0.2.4-0'),
  route('peer-host.store', 'peer-host-store', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['host/features/peer-host.ts'], 'peer-host.store', '0.2.4-0'),
  route('peer-host.handshake', 'peer-host-handshake', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['host/features/peer-host.ts'], 'peer-host.handshake', '0.2.4-0'),
  route('peer-host.http-proxy', 'peer-host-http-proxy', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['host/features/peer-host.ts'], 'peer-host.http-proxy', '0.2.4-0'),
  route('peer-host.ws-proxy', 'peer-host-ws-proxy', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['host/features/peer-host.ts'], 'peer-host.ws-proxy', '0.2.4-0'),
  route('peer-host.aggregate', 'peer-host-aggregate', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['host/features/peer-host.ts'], 'peer-host.aggregate', '0.2.4-0'),
  route('peer-host.relay-route', 'peer-host-relay-route', 'host', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['host/features/peer-host.ts'], 'peer-host.relay-route', '0.2.4-0'),
  route('peer-host.native-navigation', 'peer-host-native-navigation-legacy', 'client', '>=0.1.5-rc.3 <=0.1.6', 'deprecated', ['client/features/peer-host.ts'], 'peer-host.native-navigation', '0.2.4-0'),
  route('peer-host.native-navigation', 'peer-host-native-navigation-modern', 'client', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'deprecated', ['client/features/peer-host.ts'], 'peer-host.native-navigation', '0.2.4-0'),
  route('peer-host.remote-web-context-fallback', 'peer-host-remote-web-context-fallback', 'client', '>=0.1.5-rc.3 <=0.1.7-rc.2', 'deprecated', ['client/features/peer-host.ts'], 'peer-host.remote-web-context-fallback', '0.2.4-0'),
  // Use structural probes to select 0.2-era adapters; these are not install-time version gates.
  route('settings.store', 'settings-forms-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/settings.ts', 'host/rpc.ts']),
  route('connection.rpc', 'connection-rpc-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/rpc.ts', 'transport/dsh-transport.ts']),
  route('connection.peer', 'connection-peer-admission-020', 'host', '>=0.2.1-alpha.2 <=0.2.1-alpha.2', 'deprecated', ['host/rpc.ts'], 'connection.peer', '0.2.4-0'),
  route('connection.attachment', 'connection-rpc-attachment-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/rpc.ts', 'transport/dsh-transport.ts']),
  route('connection.uplink', 'connection-rpc-uplink-020', 'host', '>=0.2.1-alpha.2 <=0.2.1-alpha.2', 'deprecated', ['host/rpc.ts', 'transport/dsh-transport.ts'], 'connection.uplink', '0.2.4-0'),
  route('typert.remote', 'remote-context-stream-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/terminal/terminal-controller.ts', 'client/terminal/model.ts']),
  route('typert.context', 'typert-context-registry-020', 'host', DSH_COMPATIBILITY, 'supported', ['typert.host.ts', 'host/terminal/terminal-controller.ts']),
  route('typert.stream', 'typert-remote-stream-020', 'host', DSH_COMPATIBILITY, 'supported', ['typert.host.ts', 'typert.remote-client.ts']),
  route('session.format-v4', 'session-format-v4', 'host', DSH_COMPATIBILITY, 'supported', ['host/native-session-bridge.ts', 'host/session-migration-repair.ts']),
  // 启动参数的嵌套/顶层差异由能力边界归一化，业务侧保留稳定调用入口。
  route('subagent.continuable', 'subagent-activation-021', 'host', '>=0.2.1-alpha.2', 'supported', ['dsh-capabilities/host/subagent-activation-adapter.ts', 'host/cli-adapters/native-team-subagent.ts', 'host/cli-adapters/native-subagent-dispatch.ts']),
  route('subagent.continuable', 'subagent-activation-tree-022', 'host', '>=0.2.2-rc.2', 'supported', ['dsh-capabilities/host/subagent-activation-adapter.ts', 'host/cli-adapters/native-team-subagent.ts', 'host/cli-adapters/native-subagent-dispatch.ts']),
  route('agent-team.native', 'agent-team-native-020', 'host', DSH_COMPATIBILITY, 'supported', ['host/cli-adapters/feature.ts', 'host/cli-adapters/native-team-proxy.ts']),
  route('agent-team.external-member', 'agent-team-external-member-021', 'host', '>=0.2.1-alpha.2', 'supported', ['host/cli-adapters/feature.ts', 'host/cli-bridge/team-dispatch.ts']),
  route('agent-team.external-lead', 'agent-team-external-lead-021', 'host', '>=0.2.1-alpha.2', 'supported', ['host/cli-adapters/feature.ts', 'host/cli-bridge/team-dispatch.ts']),
  route('ui.icon.plus', 'regular-plus-icon-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/terminal/xterm-view.ts']),
  route('ui.icon.chevron', 'regular-chevron-icon-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/terminal/ui.ts']),
  route('locale.runtime', 'locale-runtime-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/locale.ts']),
  route('theme.runtime', 'theme-runtime-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/theme.ts']),
  // alpha.2 起界面字号按角色可配（`--dsh-content-font-size`）；旧版本没有该变量，
  // 插件界面的 `fontSize()` 会回落到基准值，行为与今天一致。
  route('theme.font-scale', 'theme-font-scale-021', 'client', '>=0.2.1-alpha.2', 'supported', ['client/font-scale.ts', 'client/index.ts']),
  route('conversation.tool-call', 'conversation-events-020', 'client', DSH_COMPATIBILITY, 'supported', ['client/external-tool-stream.ts']),
  route('conversation.draft-share', 'conversation-draft-share-021', 'client', '>=0.2.1-alpha.1', 'supported', ['client/terminal/ui.ts', 'client/terminal/sharing.ts']),
  route('conversation.interaction-translation', 'interaction-presentation-021', 'client', DSH_COMPATIBILITY, 'supported', ['client/session-translation-interactions.ts']),
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
  route('session.deletion.persistence-location', 'session-deletion-persistence-location-022', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/session-deletion-adapter.ts', 'host/features/session-deletion.ts', 'host/session-deletion/target-locator.ts']),
  route('session.deletion.immediate', 'session-deletion-immediate-022', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/session-deletion-adapter.ts', 'host/session-deletion/service.ts']),
  route('session.deletion.restart-replay', 'session-deletion-restart-replay-022', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/session-deletion-adapter.ts', 'host/session-deletion/service.ts']),
  route('session.deletion.workspace-cleanup', 'session-deletion-workspace-cleanup-022', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/session-deletion-adapter.ts', 'host/session-deletion/cleanup.ts']),
  route('session.deletion.projection-cleanup', 'session-deletion-projection-cleanup-022', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/session-deletion-adapter.ts', 'host/session-deletion/cleanup.ts']),
  route('session.deletion.spill-cleanup', 'session-deletion-spill-cleanup-022', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/session-deletion-adapter.ts', 'host/session-deletion/cleanup.ts']),
  route('session.deletion.search-reconcile', 'session-deletion-search-reconcile-022', 'host', DSH_COMPATIBILITY, 'supported', ['dsh-capabilities/host/session-deletion-adapter.ts', 'host/session-deletion/cleanup.ts']),
  route('session.deletion.ui-refresh', 'session-deletion-ui-refresh-022', 'client', '>=0.2.2-alpha.3', 'supported', ['dsh-capabilities/client/session-deletion-adapter.ts', 'client/session-deletion.ts']),
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
