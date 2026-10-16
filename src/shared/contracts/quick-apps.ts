/** Persisted references and user-selected access policy. Launch credentials never enter settings. */
export interface QuickApp {
  readonly id: string
  readonly title: string
  readonly hostId: string
  readonly workspaceId: string
  readonly entryPath: string
  readonly documentRoot: string
  readonly kind: 'html' | 'text'
  /** Explicit workspace trust; omitted on legacy shortcuts until the user saves them. */
  readonly fileAccess?: 'workspace'
  readonly spaFallback: boolean
  readonly mounts: readonly QuickAppMount[]
  readonly revision: number
  readonly order: number
}

export interface QuickAppMount {
  readonly urlPrefix: string
  readonly workspacePath: string
  readonly read: true
}

export interface QuickAppDirectory {
  readonly path: string
  readonly entries: readonly { readonly name: string; readonly path: string; readonly kind: 'file' | 'directory' }[]
  readonly truncated: boolean
}

export interface QuickAppPermissions {
  readonly read: readonly string[]
  readonly write: readonly string[]
  readonly delete: readonly string[]
}

/** A document snapshot, bound to a Host-owned launch rather than a conversation. */
export interface QuickAppDocument {
  readonly path: string
  readonly content: string
  readonly version: string
  readonly canWrite: boolean
}

/** Host-to-Host resource relay. The owning launch supplies all filesystem identity. */
export interface QuickAppProxyRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}
export interface QuickAppProxyResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly bodyBase64: string
}

export type QuickAppAvailability = 'available' | 'missing-file' | 'missing-workspace' | 'disconnected-host' | 'unsupported-runtime' | 'unsupported-connection'
export const QUICK_APP_RUNTIME_REASONS = ['not-configured', 'config-invalid', 'lan-stopped', 'ui-not-allowed', 'ports-exhausted', 'ports-busy'] as const
export type QuickAppRuntimeReason = typeof QUICK_APP_RUNTIME_REASONS[number]
export const quickAppTransportErrorCode = (reason: QuickAppRuntimeReason): string => `QUICK_APP_TRANSPORT_${reason.toUpperCase().replaceAll('-', '_')}`
export const QUICK_APP_LIMITS = Object.freeze({ textBytes: 4 * 1024 * 1024, staticBytes: 64 * 1024 * 1024, requests: 8, launches: 32, originHistory: 1024, shortcuts: 200, lifetimeMs: 30 * 60 * 1000 })
