import { useSyncExternalStore } from 'react'
import type { MagpieContextSession } from '../shared/contracts/magpie-management.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCodingNsRpcResult } from './rpc-call.js'

export type MagpieContextState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly value: MagpieContextSession }
  | { readonly status: 'native' | 'error' }

const POLL_INTERVAL_MS = 3_000
const IDLE_STATE = { status: 'idle' } as const
const NATIVE_STATE = { status: 'native' } as const
const stores = new WeakMap<CodingNsRpcClient, Map<string, MagpieContextStore>>()
const EMPTY_STORE = {
  subscribe: () => () => undefined,
  getSnapshot: (): MagpieContextState => NATIVE_STATE,
  getServerSnapshot: (): MagpieContextState => NATIVE_STATE,
}

export class MagpieContextStore {
  private readonly listeners = new Set<() => void>()
  private state: MagpieContextState = IDLE_STATE
  private request: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private polling = false

  constructor(private readonly rpc: CodingNsRpcClient, private readonly sessionId: string) {}

  getSnapshot = (): MagpieContextState => this.state
  getServerSnapshot = (): MagpieContextState => IDLE_STATE

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) void this.load(false)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stopPolling()
    }
  }

  setPolling(enabled: boolean): void {
    this.polling = enabled
    if (!enabled) {
      this.stopPolling()
      return
    }
    this.schedulePoll()
  }

  refresh(): Promise<void> {
    return this.load(true)
  }

  private async load(force: boolean): Promise<void> {
    if (this.request !== undefined) return this.request
    if (!force && this.state.status === 'ready') return
    // Keep a good snapshot mounted while a poll is in flight. Only the first
    // read needs a loading state; replacing ready with loading makes the
    // native ContextMeter disappear on every refresh.
    if (this.state.status !== 'ready') this.setState({ status: 'loading' })
    const request = callCodingNsRpcResult(this.rpc, 'magpie/context', { sessionId: this.sessionId })
      .then((result) => {
        if (!result.ok) {
          if (this.state.status !== 'ready') this.setState({ status: 'error' })
          return
        }
        const value = readMagpieContextSession(result.value)
        this.setState(value === null ? NATIVE_STATE : { status: 'ready', value })
      })
      .catch(() => { if (this.state.status !== 'ready') this.setState({ status: 'error' }) })
      .finally(() => {
        if (this.request === request) this.request = undefined
        this.schedulePoll()
      })
    this.request = request
    return request
  }

  private schedulePoll(): void {
    if (!this.polling || this.listeners.size === 0 || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.load(true)
    }, POLL_INTERVAL_MS)
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private setState(next: MagpieContextState): void {
    if (sameState(this.state, next)) return
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}

export function getMagpieContextStore(rpc: CodingNsRpcClient, sessionId: string): MagpieContextStore {
  const normalized = sessionId.trim()
  let bySession = stores.get(rpc)
  if (bySession === undefined) {
    bySession = new Map()
    stores.set(rpc, bySession)
  }
  let store = bySession.get(normalized)
  if (store === undefined) {
    store = new MagpieContextStore(rpc, normalized)
    bySession.set(normalized, store)
  }
  return store
}

export function useMagpieContext(rpc: CodingNsRpcClient | undefined, sessionId: string | undefined): MagpieContextState {
  const store = rpc === undefined || sessionId === undefined || sessionId.trim() === ''
    ? EMPTY_STORE
    : getMagpieContextStore(rpc, sessionId)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}

function readMagpieContextSession(value: unknown): MagpieContextSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return typeof record.agent === 'string'
    && typeof record.key === 'string'
    && typeof record.model === 'string'
    && Number.isSafeInteger(record.usedTokens)
    && Number.isSafeInteger(record.contextWindow)
    && Array.isArray(record.parts)
    ? value as MagpieContextSession
    : null
}

function sameState(left: MagpieContextState, right: MagpieContextState): boolean {
  if (left.status !== right.status) return false
  return left.status === 'ready' && right.status === 'ready' ? sameContextSession(left.value, right.value) : true
}

function sameContextSession(left: MagpieContextSession, right: MagpieContextSession): boolean {
  if (left.agent !== right.agent || left.key !== right.key || left.title !== right.title
    || left.model !== right.model || left.requests !== right.requests || left.turns !== right.turns
    || left.usedTokens !== right.usedTokens || left.contextWindow !== right.contextWindow
    || left.cacheTokens !== right.cacheTokens || left.cacheRate !== right.cacheRate
    || left.compacts !== right.compacts || left.latestId !== right.latestId
    || left.parts.length !== right.parts.length || left.points.length !== right.points.length) return false
  for (let index = 0; index < left.parts.length; index += 1) {
    const a = left.parts[index]!
    const b = right.parts[index]!
    if (a.kind !== b.kind || a.tokens !== b.tokens || a.items.length !== b.items.length) return false
    for (let itemIndex = 0; itemIndex < a.items.length; itemIndex += 1) {
      const item = a.items[itemIndex]!
      const other = b.items[itemIndex]!
      if (item.name !== other.name || item.tag !== other.tag || item.count !== other.count || item.tokens !== other.tokens) return false
    }
  }
  for (let index = 0; index < left.points.length; index += 1) {
    const point = left.points[index]!
    const other = right.points[index]!
    if (point.id !== other.id || point.time !== other.time || point.tokens !== other.tokens
      || point.window !== other.window || point.cacheTokens !== other.cacheTokens) return false
  }
  return true
}
