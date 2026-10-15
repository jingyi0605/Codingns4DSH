import { useMemo, useSyncExternalStore } from 'react'
import type { SessionTranslationOutputKind, SessionTranslationRecord } from '../shared/contracts/session-translation.js'
import type { CodingNsClientServices } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'

interface RetryState {
  readonly record?: SessionTranslationRecord
  readonly pending: boolean
}
interface RetryEntry {
  state: RetryState
  readonly listeners: Set<() => void>
  controller?: AbortController
}
const stores = new WeakMap<object, Map<string, RetryEntry>>()

/** Share a display result between the reply, collapsed reasoning, and its popup. */
export function useOutputTranslation(props: {
  readonly services: CodingNsClientServices
  readonly sessionId?: string | undefined
  readonly messageId: string
  readonly outputKind?: SessionTranslationOutputKind | undefined
  readonly record?: SessionTranslationRecord | undefined
}) {
  const owner = props.services.rpc ?? props.services
  const key = JSON.stringify([props.sessionId, props.messageId, props.outputKind, props.record?.original, props.record?.targetLanguage])
  const entry = useMemo(() => {
    let store = stores.get(owner)
    if (store === undefined) { store = new Map(); stores.set(owner, store) }
    let value = store.get(key)
    if (value === undefined) {
      value = { state: { pending: false }, listeners: new Set() }
      store.set(key, value)
      for (const [oldKey, old] of store) {
        if (store.size <= 256) break
        if (oldKey !== key && !old.state.pending && old.listeners.size === 0) store.delete(oldKey)
      }
    }
    return value
  }, [owner, key])
  const subscription = useMemo(() => ({
    subscribe(listener: () => void) { entry.listeners.add(listener); return () => { entry.listeners.delete(listener) } },
    snapshot: () => entry.state,
  }), [entry])
  const state = useSyncExternalStore(subscription.subscribe, subscription.snapshot, subscription.snapshot)
  const publish = (next: RetryState): void => { entry.state = next; for (const listener of entry.listeners) listener() }
  const record = state.record ?? props.record
  const retry = props.sessionId === undefined || props.outputKind === undefined || record?.failed !== true ? undefined : async (): Promise<void> => {
    if (entry.state.pending) return
    const controller = new AbortController()
    entry.controller = controller
    publish({ record, pending: true })
    try {
      const result = await callCliRpc<SessionTranslationRecord>(props.services.rpc, 'translation/retry-output', {
        sessionId: props.sessionId, original: record.original, outputKind: props.outputKind,
      }, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]))
      if (!controller.signal.aborted) publish({ record: result, pending: false })
    } catch {
      if (!controller.signal.aborted) publish({ record, pending: false })
    } finally { if (entry.controller === controller) delete entry.controller }
  }
  return { record, pending: state.pending, retry }
}

export function clearOutputTranslationRetries(services: CodingNsClientServices): void {
  const owner = services.rpc ?? services
  const store = stores.get(owner)
  for (const entry of store?.values() ?? []) entry.controller?.abort()
  stores.delete(owner)
}
