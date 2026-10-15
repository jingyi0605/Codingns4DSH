export interface SessionActivationController {
  create?(request: { readonly sessionId?: string; readonly cwd?: string }): Promise<{ readonly sessionId: string }>
  resolveAgent?(sessionId: string): Promise<{ readonly agent?: unknown; readonly error?: unknown }>
}

/** Resume before creation; successful activation must preserve the caller's exact identity. */
export function createSessionActivator(store: { get(id: string): unknown } | undefined, controller: SessionActivationController | undefined) {
  const pending = new Map<string, Promise<string | null>>()
  async function activate(sessionId: string, cwd?: string): Promise<string | null> {
    if (store?.get(sessionId) !== undefined) return sessionId
    if (typeof controller?.resolveAgent === 'function') {
      const resolved = await controller.resolveAgent(sessionId)
      if (resolved.error !== undefined) {
        if ((resolved.error as { code?: unknown })?.code !== 'session/not-found') throw resolved.error
      } else {
        if (resolved.agent !== undefined) return sessionId
        return null
      }
    }
    if (controller?.create === undefined) return null
    const created = await controller.create({ sessionId, ...(cwd ? { cwd } : {}) })
    if (created.sessionId !== sessionId) throw Object.assign(new Error('DSH allocated a different session; native projection was refused'), { code: 'CODINGNS_SESSION_ID_MISMATCH' })
    return sessionId
  }
  return (sessionId: string, cwd?: string): Promise<string | null> => {
    if (sessionId.trim() === '') return Promise.resolve(null)
    let operation = pending.get(sessionId)
    if (operation === undefined) {
      operation = activate(sessionId, cwd).finally(() => pending.delete(sessionId))
      pending.set(sessionId, operation)
    }
    return operation
  }
}
