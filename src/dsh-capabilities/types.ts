/** DSH 宿主能力的稳定标识。业务模块只依赖这些标识，不直接依赖 DSH 版本。 */
export type DshCapabilityId =
  | 'settings.store'
  | 'llm.text'
  | 'assistant.agent'
  | 'connection.rpc'
  | 'connection.peer'
  | 'connection.attachment'
  | 'connection.uplink'
  | 'ui.icon.plus'
  | 'ui.icon.chevron'
  | 'locale.runtime'
  | 'theme.runtime'
  | 'conversation.tool-call'
  | 'conversation.draft-share'
  | 'sidebar.right'
  | 'typert.remote'
  | 'typert.context'
  | 'typert.stream'
  | 'session.format-v4'
  | 'subagent.continuable'
  | 'agent-team.native'
  | 'client.boot-graph'
  | 'web.index-inject'
  | 'web.index-tap'
  | 'layout.columns'
  | 'sidebar.right.expand'
  | 'peer-host.store'
  | 'peer-host.handshake'
  | 'peer-host.http-proxy'
  | 'peer-host.ws-proxy'
  | 'peer-host.aggregate'
  | 'peer-host.aggregated-transport'
  | 'peer-host.client-preboot-transport'
  | 'peer-host.target-capabilities'
  | 'peer-host.local-plugin-baseline'
  | 'peer-host.relay-route'
  | 'peer-host.native-navigation'
  | 'peer-host.remote-web-context-fallback'

export type DshCapabilityRuntime = 'host' | 'client'
export type DshCapabilityRouteStatus = 'supported' | 'deprecated'
export type DshCapabilityResolutionStatus = 'ready' | 'degraded' | 'unavailable'

export interface DshCapabilityDiagnostic {
  readonly code: string
  readonly capability: DshCapabilityId
  readonly routeId?: string
  readonly dshVersion: string
  readonly message: string
  readonly replacement?: DshCapabilityId
  readonly featureNames?: readonly string[]
}

export interface DshCapabilityRoute<T> {
  readonly id: string
  readonly capability: DshCapabilityId
  readonly supportedDsh: string
  readonly runtime: DshCapabilityRuntime
  readonly priority: number
  readonly detect: (context: unknown) => boolean
  readonly create: (context: unknown) => T
  readonly status: DshCapabilityRouteStatus
  readonly introducedIn: string
  readonly removableAfter?: string
  readonly replacement?: DshCapabilityId
}

export interface DshCapabilityResolution<T = unknown> {
  readonly capability: DshCapabilityId
  readonly routeId?: string
  readonly dshVersion: string
  readonly status: DshCapabilityResolutionStatus
  readonly value?: T
  readonly reason?: string
  readonly replacement?: DshCapabilityId
}

export interface DshCapabilityProfile {
  readonly dshVersion: string
  readonly runtime: DshCapabilityRuntime
  readonly capabilities: ReadonlyMap<DshCapabilityId, DshCapabilityResolution>
  readonly diagnostics: readonly DshCapabilityDiagnostic[]
  readonly frozenAt: number
}

export interface FeatureCapabilityRequirement {
  readonly capability: DshCapabilityId
  readonly required: boolean
  readonly fallback?: 'disable' | 'degrade' | 'error'
}

export function createCapabilityProfile(
  dshVersion: string,
  runtime: DshCapabilityRuntime,
  capabilities: ReadonlyMap<DshCapabilityId, DshCapabilityResolution>,
  diagnostics: readonly DshCapabilityDiagnostic[],
): DshCapabilityProfile {
  return Object.freeze({
    dshVersion,
    runtime,
    capabilities: freezeMap(capabilities),
    diagnostics: Object.freeze([...diagnostics]),
    frozenAt: Date.now(),
  })
}

/** Map 的只读视图，避免 Object.freeze(Map) 仍可通过 set() 修改。 */
function freezeMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map(source)
  const view = new Proxy(map, {
    get(target, property, receiver) {
      if (property === 'set' || property === 'delete' || property === 'clear') return undefined
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return Object.freeze(view) as unknown as ReadonlyMap<K, V>
}
