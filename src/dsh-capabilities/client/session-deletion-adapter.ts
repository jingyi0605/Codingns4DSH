export interface DshSessionDeletionUiRefreshAdapter {
  isMainViewSession(sessionId: string): boolean
  clearMainViewIfMatching(sessionId: string): boolean
  refreshSessionList(sessionId: string): void
}

interface NativeClientSessionsLike {
  readonly list?: {
    getSnapshot?(): {
      readonly byId?: Record<string, { readonly id?: string; readonly retainedBy?: Record<string, number> }>
    }
  }
  readonly manager?: {
    refreshList?(): unknown
  }
  handleSessionRemoved?(sessionId: string): void
  refreshList?(): unknown
}

interface NativeUiWorkspaceLike {
  readonly mainReference?: { readonly sessionId?: string }
  readonly selection?: { getSnapshot?(): { readonly sessionId?: string } }
  clearMain?(): void
}

export function supportsSessionDeletionUiRefresh(context: unknown): boolean {
  return readSessionDeletionUiRefresh(context) !== undefined
}

export function readSessionDeletionUiRefresh(context: unknown): DshSessionDeletionUiRefreshAdapter | undefined {
  const sessionsValue = readService(context, 'sessions')
  const uiWorkspaceValue = readService(context, 'uiWorkspace')
  const sessions = isObject(sessionsValue) ? sessionsValue as NativeClientSessionsLike : undefined
  const uiWorkspace = isObject(uiWorkspaceValue) ? uiWorkspaceValue as NativeUiWorkspaceLike : undefined
  const hasSessionRefresh = sessions !== undefined && (
    typeof sessions.handleSessionRemoved === 'function'
    || typeof sessions.refreshList === 'function'
    || typeof sessions.manager?.refreshList === 'function'
    || isObject(sessions.list)
  )
  const hasWorkspaceClear = uiWorkspace !== undefined && typeof uiWorkspace.clearMain === 'function'
  if (!hasSessionRefresh && !hasWorkspaceClear) return undefined
  return createSessionDeletionUiRefreshAdapter(sessions, uiWorkspace)
}

export function createSessionDeletionUiRefreshAdapter(
  sessionsValue: unknown,
  uiWorkspaceValue: unknown,
): DshSessionDeletionUiRefreshAdapter {
  const sessions = isObject(sessionsValue) ? sessionsValue as NativeClientSessionsLike : undefined
  const uiWorkspace = isObject(uiWorkspaceValue) ? uiWorkspaceValue as NativeUiWorkspaceLike : undefined

  const isMainViewSession = (sessionId: string): boolean => {
    if (uiWorkspace?.mainReference !== undefined) {
      return uiWorkspace.mainReference.sessionId === sessionId
    }
    const selectionId = uiWorkspace?.selection?.getSnapshot?.()?.sessionId
    if (typeof selectionId === 'string') return selectionId === sessionId
    const byId = sessions?.list?.getSnapshot?.()?.byId
    if (isObject(byId)) {
      return Object.values(byId).some(
        (row) => isObject(row) && row.id === sessionId && ((row.retainedBy?.mainView ?? 0) > 0),
      )
    }
    return false
  }

  const clearMainViewIfMatching = (sessionId: string): boolean => {
    if (!isMainViewSession(sessionId)) return false
    if (typeof uiWorkspace?.clearMain !== 'function') return false
    uiWorkspace.clearMain()
    return true
  }

  const refreshSessionList = (sessionId: string): void => {
    try {
      sessions?.handleSessionRemoved?.(sessionId)
    } catch {
      // Ignore native list hook failures; refreshList below covers resync.
    }
    try {
      const result = typeof sessions?.refreshList === 'function'
        ? sessions.refreshList()
        : sessions?.manager?.refreshList?.()
      void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Ignore transient refresh errors when offline.
    }
  }

  return {
    isMainViewSession,
    clearMainViewIfMatching,
    refreshSessionList,
  }
}

function readService(context: unknown, name: string): unknown {
  if (!isObject(context)) return undefined
  const getter = Reflect.get(context, 'get')
  if (typeof getter === 'function') {
    try {
      const value = getter.call(context, name)
      if (value !== undefined) return value
    } catch {
      // Ignore Cordis uninjected lookup failure.
    }
  }
  try {
    return Reflect.get(context, name)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
