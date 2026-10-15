interface ConnectionPeers {
  readonly operator?: unknown
  readonly browserPeer?: unknown
  admit?(request: { readonly headers: unknown }): { readonly peer: unknown } | { readonly rejection: number }
  requestRejection?(request: { readonly headers: unknown }): number | undefined
}

/** Only Connection may derive identity from credentials. Never read it from an RPC payload. */
export function admitCodingNsPeer(connection: unknown, headers: unknown): { peer: unknown } | { rejection: number } {
  const service = connection as ConnectionPeers
  const admission = typeof service.admit === 'function'
    ? service.admit({ headers })
    : (() => {
      const rejection = service.requestRejection?.({ headers })
      return rejection === undefined ? { peer: service.operator } : { rejection }
    })()
  if ('rejection' in admission) return admission
  // Plugin settings and external agent controls have always been owner-only.
  return isCodingNsOwnerPeer(connection, admission.peer) ? admission : { rejection: 403 }
}

export function isCodingNsOwnerPeer(connection: unknown, peer: unknown): boolean {
  const service = connection as ConnectionPeers | undefined
  const candidate = peer as { principal?: { kind?: string }; signal?: AbortSignal; authenticated?: boolean; authorized?: boolean; scope?: { kind?: string }; kind?: string } | undefined
  if (candidate?.signal?.aborted || candidate?.authenticated === false || candidate?.authorized === false || candidate?.scope?.kind === 'session' || candidate?.kind === 'session') return false
  if (service?.browserPeer !== undefined) return candidate?.principal?.kind === 'owner'
  return service?.operator === undefined || peer === service.operator
}

/** Internal host calls borrow the host-owned peer; callers retain ownership of supplied peers. */
export function nativeDispatchPeer(connection: unknown, caller?: unknown): unknown {
  const service = connection as ConnectionPeers | undefined
  const peer = caller ?? service?.browserPeer ?? service?.operator
  if (service?.browserPeer !== undefined && peer === undefined) throw new Error('DSH requires a live peer')
  const signal = (peer as { signal?: AbortSignal } | undefined)?.signal
  signal?.throwIfAborted()
  return peer
}
