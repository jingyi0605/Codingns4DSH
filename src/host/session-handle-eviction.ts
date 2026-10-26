import type { SessionHandleEvictionSettings } from '../shared/contracts/config.js'

type UnknownObject = Record<PropertyKey, unknown>
type Timer = ReturnType<typeof setTimeout>

export interface SessionHandleEvictionLogger {
  debug(message: string, fields: Record<string, unknown>): void
  warn?(message: string, fields: Record<string, unknown>): void
}

export interface SessionHandleEvictionOptions {
  readonly settings: SessionHandleEvictionSettings
  readonly now?: () => number
  readonly logger?: SessionHandleEvictionLogger
}

export interface SessionHandleEvictionDiagnostics {
  readonly openHandles: number
  readonly maxOpenHandles: number
  readonly evictedTotal: number
}

export interface SessionHandleEvictionController {
  getDiagnostics(): SessionHandleEvictionDiagnostics
  sweep(): Promise<void>
  dispose(): Promise<void>
}

interface TrackedHandle {
  readonly target: UnknownObject
  readonly id: string
  readonly access: string
  readonly originalClose?: (...args: unknown[]) => unknown
  readonly proxy: UnknownObject
  lastUsedAt: number
  activeCalls: number
  activeIterators: number
  activeSubscriptions: number
  evicting: boolean
  closed: boolean
  closePromise?: Promise<void>
}

interface PersistenceService extends UnknownObject {
  open?: (...args: unknown[]) => unknown
  flushAll?: (...args: unknown[]) => unknown
}

const TRACKED_METHODS = new Set(['append', 'flush', 'next', 'read', 'write'])
const ITERATOR_KEYS = new Set<PropertyKey>([Symbol.asyncIterator, Symbol.iterator])
const SUBSCRIPTION_METHODS = new Set(['addListener', 'listen', 'observe', 'on', 'subscribe', 'watch'])
const SUBSCRIBER_FIELDS = ['activeIterators', 'activeSubscribers', 'listeners', 'observers', 'subscribers', 'subscriptions'] as const

/**
 * Install a process-local safety net around the DSH persistence service.
 *
 * The upstream JSONL implementation owns the actual close semantics. This adapter
 * only evicts idle read handles. Write handles remain owned by DSH until their
 * caller closes them: backend-routed session events bypass this proxy, and closing
 * a writer removes its live persistence route even when its buffer is empty.
 * The handle cap is therefore best-effort when DSH owns more writers than the cap.
 */
export function installSessionHandleEviction(
  value: unknown,
  options: SessionHandleEvictionOptions,
): SessionHandleEvictionController | undefined {
  if (!options.settings.enabled || !isObject(value)) return undefined
  const persistence = value as PersistenceService
  if (typeof persistence.open !== 'function') return undefined

  const now = options.now ?? Date.now
  const logger = options.logger
  const idleTtlMs = normalizePositiveInteger(options.settings.idleTtlMs, 600_000)
  const maxOpenHandles = normalizePositiveInteger(options.settings.maxOpenHandles, 32)
  const records = new Map<UnknownObject, TrackedHandle>()
  const traceCounts = new Map<string, number>()
  const originalOpen = persistence.open
  const originalFlushAll = persistence.flushAll
  let timer: Timer | undefined
  let sweepPromise: Promise<void> | undefined
  let flushAllDepth = 0
  let evictedTotal = 0
  let disposed = false

  const getDiagnostics = (): SessionHandleEvictionDiagnostics => ({
    openHandles: records.size,
    maxOpenHandles,
    evictedTotal,
  })

  const log = (message: string, fields: Record<string, unknown>): void => {
    try { logger?.debug(message, fields) } catch { /* diagnostics must not break persistence */ }
  }

  const warn = (message: string, fields: Record<string, unknown>): void => {
    try { logger?.warn?.(message, fields) } catch { /* diagnostics must not break persistence */ }
  }

  const touch = (record: TrackedHandle): void => {
    record.lastUsedAt = now()
    try { Reflect.set(record.target, 'lastUsedAt', record.lastUsedAt) } catch { /* frozen handles still use the side table */ }
  }

  const callWithActivity = <T>(record: TrackedHandle, method: (...args: unknown[]) => T, args: unknown[]): T | Promise<Awaited<T>> => {
    touch(record)
    record.activeCalls += 1
    let result: T
    try {
      result = Reflect.apply(method, record.target, args)
    } catch (error) {
      record.activeCalls -= 1
      throw error
    }
    if (!isPromiseLike(result)) {
      record.activeCalls -= 1
      return result
    }
    return Promise.resolve(result).finally(() => { record.activeCalls -= 1 }) as Promise<Awaited<T>>
  }

  const releaseSubscription = (record: TrackedHandle): void => {
    record.activeSubscriptions = Math.max(0, record.activeSubscriptions - 1)
  }

  const wrapSubscriptionResult = (record: TrackedHandle, result: unknown): unknown => {
    if (typeof result === 'function') {
      record.activeSubscriptions += 1
      let released = false
      return (...args: unknown[]): unknown => {
        if (!released) { released = true; releaseSubscription(record) }
        return Reflect.apply(result, record.target, args)
      }
    }
    if (!isObject(result)) return result
    const unsubscribe = typeof Reflect.get(result, 'unsubscribe', result) === 'function'
      ? Reflect.get(result, 'unsubscribe', result) as (...args: unknown[]) => unknown
      : typeof Reflect.get(result, 'dispose', result) === 'function'
        ? Reflect.get(result, 'dispose', result) as (...args: unknown[]) => unknown
        : undefined
    if (unsubscribe === undefined) {
      record.activeSubscriptions += 1
      return result
    }
    record.activeSubscriptions += 1
    let released = false
    const wrapped = new Proxy(result, {
      get(target, property, receiver) {
        if (property !== 'unsubscribe' && property !== 'dispose') return Reflect.get(target, property, receiver)
        return (...args: unknown[]): unknown => {
          if (!released) { released = true; releaseSubscription(record) }
          return Reflect.apply(unsubscribe, target, args)
        }
      },
    })
    return wrapped
  }

  const wrapIterator = (record: TrackedHandle, iterator: unknown): unknown => {
    if (!isObject(iterator)) return iterator
    record.activeIterators += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      record.activeIterators = Math.max(0, record.activeIterators - 1)
    }
    const invoke = (methodName: 'next' | 'return' | 'throw', args: unknown[]): unknown => {
      const method = Reflect.get(iterator, methodName, iterator)
      if (typeof method !== 'function') {
        if (methodName !== 'next') release()
        return methodName === 'return' ? { done: true, value: undefined } : undefined
      }
      const result = callWithActivity(record, method as (...values: unknown[]) => unknown, args)
      if (!isPromiseLike(result)) {
        if (methodName !== 'next' || isIteratorDone(result)) release()
        return result
      }
      return Promise.resolve(result).then((value) => {
        if (methodName !== 'next' || isIteratorDone(value)) release()
        return value
      })
    }
    return {
      next: (...args: unknown[]) => invoke('next', args),
      return: (...args: unknown[]) => invoke('return', args),
      throw: (...args: unknown[]) => invoke('throw', args),
      [Symbol.asyncIterator]() { return this },
      [Symbol.iterator]() { return this },
    }
  }

  const closeRecord = (record: TrackedHandle, reason?: 'cap' | 'ttl'): Promise<void> => {
    if (record.closePromise !== undefined) return record.closePromise
    const close = record.originalClose
    if (close === undefined) return Promise.reject(new Error(`Session handle ${record.id} has no close method`))
    record.evicting = reason !== undefined
    if (reason !== undefined) {
      evictedTotal += 1
      const idleMs = Math.max(0, now() - record.lastUsedAt)
      log('session handle evicted', { id: record.id, reason, idleMs, openCount: records.size })
    }
    let result: unknown
    try {
      result = Reflect.apply(close, record.target, [])
    } catch (error) {
      record.evicting = false
      return Promise.reject(error)
    }
    const promise = Promise.resolve(result).then(() => {
      record.closed = true
      records.delete(record.target)
    }).catch((error: unknown) => {
      record.evicting = false
      warn('session handle close failed', { id: record.id, error: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => {
      if (!record.closed) record.evicting = false
      scheduleSweep()
    })
    record.closePromise = promise
    return promise
  }

  const isSafeToEvict = (record: TrackedHandle): boolean => {
    if (record.access !== 'read') return false
    if (flushAllDepth > 0 || record.evicting || record.closed) return false
    if (record.activeCalls > 0 || record.activeIterators > 0 || record.activeSubscriptions > 0) return false
    if (readProperty(record.target, 'closing') !== undefined) return false
    return !hasExternalActivity(record.target)
  }

  const runSweep = async (): Promise<void> => {
    if (disposed || records.size === 0) return
    const current = now()
    log('session handle eviction diagnostics', { ...getDiagnostics() })
    if (flushAllDepth > 0) return
    const ordered = [...records.values()].sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    const selected = new Set<TrackedHandle>()
    const reasons = new Map<TrackedHandle, 'cap' | 'ttl'>()
    for (const record of ordered) {
      if (current - record.lastUsedAt >= idleTtlMs && isSafeToEvict(record)) {
        selected.add(record)
        reasons.set(record, 'ttl')
      }
    }
    let remaining = records.size - selected.size - maxOpenHandles
    if (remaining > 0) {
      for (const record of ordered) {
        if (remaining <= 0) break
        if (selected.has(record) || !isSafeToEvict(record)) continue
        selected.add(record)
        reasons.set(record, 'cap')
        remaining -= 1
      }
    }
    await Promise.all([...selected].map(async (record) => {
      try { await closeRecord(record, reasons.get(record)) } catch { /* retrying later is safer than losing a live handle */ }
    }))
  }

  const requestSweep = (): Promise<void> => {
    if (sweepPromise !== undefined) return sweepPromise
    sweepPromise = runSweep().finally(() => { sweepPromise = undefined; scheduleSweep() })
    return sweepPromise
  }

  function scheduleSweep(): void {
    if (disposed || records.size === 0 || timer !== undefined) return
    const readers = [...records.values()].filter((record) => record.access === 'read')
    if (readers.length === 0) return
    const oldest = Math.min(...readers.map((record) => record.lastUsedAt))
    const delay = records.size > maxOpenHandles
      ? 1
      : Math.max(1, Math.min(idleTtlMs, idleTtlMs - Math.max(0, now() - oldest)))
    timer = setTimeout(() => {
      timer = undefined
      void requestSweep().catch((error: unknown) => warn('session handle sweep failed', { error: error instanceof Error ? error.message : String(error) }))
    }, delay)
    const unref = (timer as Timer & { unref?: () => void }).unref
    unref?.call(timer)
  }

  const adopt = (value: unknown, accessHint: unknown): unknown => {
    if (!isObject(value)) return value
    const existing = records.get(value)
    if (existing !== undefined) { touch(existing); return existing.proxy }
    const target = value as UnknownObject
    const originalClose = readClose(target)
    const record = {} as TrackedHandle
    const proxy = new Proxy(target, {
      get(current, property, receiver) {
        if (property === 'close' || property === Symbol.asyncDispose) {
          return () => closeRecord(record)
        }
        const method = Reflect.get(current, property, receiver)
        if (typeof method !== 'function') return method
        if (ITERATOR_KEYS.has(property)) return (...args: unknown[]) => wrapIterator(record, Reflect.apply(method, current, args))
        if (!TRACKED_METHODS.has(String(property)) && !SUBSCRIPTION_METHODS.has(String(property))) return (...args: unknown[]) => Reflect.apply(method, current, args)
        return (...args: unknown[]) => {
          const result = callWithActivity(record, method as (...values: unknown[]) => unknown, args)
          return SUBSCRIPTION_METHODS.has(String(property)) ? wrapSubscriptionResult(record, result) : result
        }
      },
    }) as unknown as UnknownObject
    const access = typeof readProperty(target, 'access') === 'string'
      ? readProperty(target, 'access') as string
      : typeof accessHint === 'string' ? accessHint : 'read'
    Object.assign(record, {
      target,
      id: String(readProperty(target, 'id') ?? accessHint ?? 'unknown'),
      access,
      originalClose,
      proxy,
      lastUsedAt: now(),
      activeCalls: 0,
      activeIterators: 0,
      activeSubscriptions: 0,
      evicting: false,
      closed: false,
    })
    records.set(target, record)
    touch(record)
    traceAdoption(traceCounts)
    scheduleSweep()
    return proxy
  }

  const wrappedOpen = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const opened = await Reflect.apply(originalOpen, this, args)
    return adopt(opened, args[1])
  }
  try {
    persistence.open = wrappedOpen
    if (typeof originalFlushAll === 'function') {
      persistence.flushAll = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
        flushAllDepth += 1
        try { return await Reflect.apply(originalFlushAll, this, args) } finally { flushAllDepth = Math.max(0, flushAllDepth - 1); scheduleSweep() }
      }
    }
  } catch {
    persistence.open = originalOpen
    return undefined
  }

  log('session handle eviction enabled', { idleTtlMs, ...getDiagnostics() })
  return {
    getDiagnostics,
    sweep: requestSweep,
    async dispose() {
      disposed = true
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (persistence.open === wrappedOpen) persistence.open = originalOpen
      if (originalFlushAll !== undefined && persistence.flushAll !== originalFlushAll) persistence.flushAll = originalFlushAll
      await sweepPromise
    },
  }
}

function traceAdoption(traceCounts: Map<string, number>): void {
  if (typeof process === 'undefined' || process.env.DSH_TRACE_SESSION_HANDLES !== '1') return
  const stack = (new Error().stack ?? '').split('\n').slice(3, 7).join(' | ')
  const key = stack.replace(/:\d+:\d+/g, '')
  traceCounts.set(key, (traceCounts.get(key) ?? 0) + 1)
  if (traceCounts.size % 20 === 0) {
    console.error('[handle-trace]', JSON.stringify([...traceCounts.entries()].sort((left, right) => right[1] - left[1])))
  }
}

function readClose(target: UnknownObject): ((...args: unknown[]) => unknown) | undefined {
  const close = readProperty(target, 'close')
  if (typeof close === 'function') return close as (...args: unknown[]) => unknown
  const dispose = readProperty(target, Symbol.asyncDispose)
  return typeof dispose === 'function' ? dispose as (...args: unknown[]) => unknown : undefined
}

function hasExternalActivity(target: UnknownObject): boolean {
  for (const field of SUBSCRIBER_FIELDS) {
    const value = readProperty(target, field)
    if (typeof value === 'number' && value > 0) return true
    if (Array.isArray(value) && value.length > 0) return true
    if (value instanceof Set && value.size > 0) return true
    if (value instanceof Map && value.size > 0) return true
  }
  const hasSubscribers = readProperty(target, 'hasSubscribers')
  if (hasSubscribers === true) return true
  if (typeof hasSubscribers === 'function') {
    try { if (Reflect.apply(hasSubscribers, target, [])) return true } catch { return true }
  }
  return false
}

function readProperty(target: UnknownObject, property: PropertyKey): unknown {
  try { return Reflect.get(target, property, target) } catch { return undefined }
}

function isObject(value: unknown): value is UnknownObject {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof Reflect.get(value, 'then', value) === 'function'
}

function isIteratorDone(value: unknown): boolean {
  return isObject(value) && Reflect.get(value, 'done', value) === true
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback
}
