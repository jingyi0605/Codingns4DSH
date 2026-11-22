import { SessionDeletionError } from '../../shared/contracts/session-deletion.js'

interface TrackedPersistence {
  open?: (...args: unknown[]) => unknown
  create?: (...args: unknown[]) => unknown
}

interface HandleLike {
  close?: (...args: unknown[]) => unknown
  [Symbol.asyncDispose]?: (...args: unknown[]) => unknown
}

export interface SessionAdmissionReservation {
  release(): void
}

export class SessionAdmissionGuard {
  private readonly reservedIds = new Set<string>()
  private readonly inFlightCounts = new Map<string, number>()
  private readonly drainWaiters = new Map<string, Set<() => void>>()
  private readonly activeWriters = new Map<string, Set<object>>()
  private readonly lifetime = new AbortController()
  private installed = false
  private target: TrackedPersistence | undefined
  private originalOpen: ((...args: unknown[]) => unknown) | undefined
  private originalCreate: ((...args: unknown[]) => unknown) | undefined
  private wrappedOpen: ((...args: unknown[]) => unknown) | undefined
  private wrappedCreate: ((...args: unknown[]) => unknown) | undefined

  install(persistence: unknown): () => void {
    if (this.installed || !isObject(persistence)) return () => undefined
    const target = persistence as TrackedPersistence
    if (typeof target.open !== 'function' || typeof target.create !== 'function') return () => undefined
    const origOpen = target.open
    const origCreate = target.create
    const guard = this

    const wrappedOpen = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      if (guard.lifetime.signal.aborted) return origOpen.apply(this, args)
      const id = typeof args[0] === 'string' ? args[0] : ''
      const access = args[1] === 'write' ? 'write' : 'read'
      const signal = extractSignal(args[2])
      signal?.throwIfAborted()
      if (id !== '' && guard.reservedIds.has(id)) {
        throw new SessionDeletionError('SESSION_DELETION_BUSY', `Session "${id}" is currently being deleted`)
      }
      if (id !== '') guard.incrementInFlight(id)
      try {
        const handle = await origOpen.apply(this, args)
        if (id !== '' && access === 'write' && isObject(handle)) {
          guard.trackWriteHandle(id, handle)
        }
        return handle
      } finally {
        if (id !== '') guard.decrementInFlight(id)
      }
    }

    const wrappedCreate = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      if (guard.lifetime.signal.aborted) return origCreate.apply(this, args)
      const header = isObject(args[0]) ? args[0] : undefined
      const options = isObject(args[1]) ? args[1] : undefined
      const id = typeof header?.id === 'string' ? header.id : ''
      const parentId = typeof header?.parentSession === 'string' ? header.parentSession : ''
      const parentSourceId = isObject(options?.parentSource) && typeof options.parentSource.sessionId === 'string'
        ? options.parentSource.sessionId
        : ''
      const signal = extractSignal(options)
      signal?.throwIfAborted()

      const trackedIds = uniqueNonEmpty([id, parentId, parentSourceId])
      for (const tracked of trackedIds) {
        if (guard.reservedIds.has(tracked)) {
          throw new SessionDeletionError('SESSION_DELETION_BUSY', `Session "${tracked}" is currently being deleted`)
        }
      }
      for (const tracked of trackedIds) guard.incrementInFlight(tracked)
      try {
        const handle = await origCreate.apply(this, args)
        if (id !== '' && isObject(handle)) {
          guard.trackWriteHandle(id, handle)
        }
        return handle
      } finally {
        for (const tracked of trackedIds) guard.decrementInFlight(tracked)
      }
    }

    try {
      target.open = wrappedOpen
      target.create = wrappedCreate
      this.installed = true
      this.target = target
      this.originalOpen = origOpen
      this.originalCreate = origCreate
      this.wrappedOpen = wrappedOpen
      this.wrappedCreate = wrappedCreate
    } catch {
      return () => undefined
    }

    return () => this.uninstall()
  }

  uninstall(): void {
    if (!this.installed) return
    this.installed = false
    this.lifetime.abort()
    if (this.target !== undefined) {
      try {
        if (this.target.open === this.wrappedOpen && this.originalOpen !== undefined) {
          this.target.open = this.originalOpen
        }
      } catch {
        // Ignore frozen target during teardown.
      }
      try {
        if (this.target.create === this.wrappedCreate && this.originalCreate !== undefined) {
          this.target.create = this.originalCreate
        }
      } catch {
        // Ignore frozen target during teardown.
      }
    }
    this.target = undefined
    this.originalOpen = undefined
    this.originalCreate = undefined
    this.wrappedOpen = undefined
    this.wrappedCreate = undefined
  }

  get isInstalled(): boolean {
    return this.installed
  }

  hasActiveWriter(sessionId: string): boolean {
    return (this.activeWriters.get(sessionId)?.size ?? 0) > 0
  }

  hasInFlightAdmission(sessionId: string): boolean {
    return (this.inFlightCounts.get(sessionId) ?? 0) > 0
  }

  isReserved(sessionId: string): boolean {
    return this.reservedIds.has(sessionId)
  }

  async acquireReservation(sessionId: string, timeoutMs = 3_000): Promise<SessionAdmissionReservation> {
    if (!this.installed) {
      throw new SessionDeletionError(
        'SESSION_DELETION_EXCLUSION_UNAVAILABLE',
        'Session persistence admission guard is not installed',
      )
    }
    if (this.reservedIds.has(sessionId)) {
      throw new SessionDeletionError('SESSION_DELETION_BUSY', `Session "${sessionId}" already has an active deletion reservation`)
    }
    this.reservedIds.add(sessionId)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.reservedIds.delete(sessionId)
    }
    try {
      await this.waitForInFlightDrain(sessionId, timeoutMs)
      if (this.hasActiveWriter(sessionId)) {
        throw new SessionDeletionError(
          'SESSION_DELETION_ACTIVE_WRITER',
          `Session "${sessionId}" still has an active write handle`,
        )
      }
      return { release }
    } catch (error) {
      release()
      throw error
    }
  }

  private incrementInFlight(sessionId: string): void {
    this.inFlightCounts.set(sessionId, (this.inFlightCounts.get(sessionId) ?? 0) + 1)
  }

  private decrementInFlight(sessionId: string): void {
    const next = (this.inFlightCounts.get(sessionId) ?? 0) - 1
    if (next <= 0) {
      this.inFlightCounts.delete(sessionId)
      const waiters = this.drainWaiters.get(sessionId)
      if (waiters !== undefined) {
        this.drainWaiters.delete(sessionId)
        for (const notify of waiters) notify()
      }
    } else {
      this.inFlightCounts.set(sessionId, next)
    }
  }

  private waitForInFlightDrain(sessionId: string, timeoutMs: number): Promise<void> {
    if ((this.inFlightCounts.get(sessionId) ?? 0) === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const waiters = this.drainWaiters.get(sessionId) ?? new Set<() => void>()
      const onDrain = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(onDrain)
        if (waiters.size === 0) this.drainWaiters.delete(sessionId)
        resolve()
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        waiters.delete(onDrain)
        if (waiters.size === 0) this.drainWaiters.delete(sessionId)
        reject(new SessionDeletionError(
          'SESSION_DELETION_BUSY',
          `Timed out waiting for in-flight operations on session "${sessionId}" to drain`,
        ))
      }, Math.max(1, timeoutMs))
      waiters.add(onDrain)
      this.drainWaiters.set(sessionId, waiters)
    })
  }

  private trackWriteHandle(sessionId: string, handle: object): void {
    const handles = this.activeWriters.get(sessionId) ?? new Set<object>()
    handles.add(handle)
    this.activeWriters.set(sessionId, handles)
    const typed = handle as HandleLike
    const originalClose = typeof typed.close === 'function' ? typed.close : undefined
    const remove = (): void => {
      const set = this.activeWriters.get(sessionId)
      if (set === undefined) return
      set.delete(handle)
      if (set.size === 0) this.activeWriters.delete(sessionId)
    }
    if (originalClose !== undefined) {
      try {
        typed.close = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
          const result = await originalClose.apply(this, args)
          remove()
          return result
        }
      } catch {
        // Frozen handle cannot be wrapped; keep tracking conservative until teardown.
      }
    }
    const asyncDispose = typed[Symbol.asyncDispose]
    if (typeof asyncDispose === 'function') {
      try {
        typed[Symbol.asyncDispose] = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
          const result = await asyncDispose.apply(this, args)
          remove()
          return result
        }
      } catch {
        // Ignore frozen handle.
      }
    }
  }
}

function extractSignal(value: unknown): AbortSignal | undefined {
  if (!isObject(value)) return undefined
  const signal = value.signal
  return signal instanceof AbortSignal ? signal : undefined
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const result: string[] = []
  for (const value of values) {
    if (value !== '' && !result.includes(value)) result.push(value)
  }
  return result
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
