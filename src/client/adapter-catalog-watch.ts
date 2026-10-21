import type { CodingNsCliAdapterDescriptor } from '../shared/contracts/cli-adapter.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'

const loads = new WeakMap<CodingNsRpcClient, Map<string, Promise<readonly CodingNsCliAdapterDescriptor[]>>>()
export type AdapterCatalogChange =
  | { readonly kind: 'adapter' }
  | { readonly kind: 'models'; readonly adapterId: string }

const listeners = new WeakMap<CodingNsRpcClient, Set<(change: AdapterCatalogChange) => void>>()

/** 手动检测完成后，让已挂载的选择器和模型目录一起更新。 */
export function notifyAdapterCatalogChanged(rpc: CodingNsRpcClient): void {
  publishCatalogChange(rpc, { kind: 'adapter' })
}

/** Model enrichment must not trigger a fresh adapter-installation scan. */
export function notifyModelCatalogChanged(rpc: CodingNsRpcClient, adapterId: string): void {
  publishCatalogChange(rpc, { kind: 'models', adapterId })
}

function publishCatalogChange(rpc: CodingNsRpcClient, change: AdapterCatalogChange): void {
  for (const listener of listeners.get(rpc) ?? []) listener(change)
}

export function subscribeAdapterCatalogChanged(rpc: CodingNsRpcClient, listener: (change: AdapterCatalogChange) => void): () => void {
  let entries = listeners.get(rpc)
  if (entries === undefined) { entries = new Set(); listeners.set(rpc, entries) }
  entries.add(listener)
  return () => { entries.delete(listener) }
}

/** Poll only while installation detection or an explicitly requested release check is pending. */
export function watchAdapterCatalog(
  rpc: CodingNsRpcClient,
  sessionId: string | undefined,
  onValue: (value: readonly CodingNsCliAdapterDescriptor[]) => void,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  let active = true
  let busy = false
  let dirty = false
  let started = Date.now()
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = async (): Promise<void> => {
    if (!active) return
    if (busy) { dirty = true; return }
    clearTimeout(timer)
    busy = true
    try {
      let requests = loads.get(rpc)
      if (requests === undefined) { requests = new Map(); loads.set(rpc, requests) }
      const key = sessionId ?? ''
      let request = requests.get(key)
      if (request === undefined) {
        request = callCliRpc<readonly CodingNsCliAdapterDescriptor[]>(rpc, 'catalog', sessionId === undefined ? {} : { sessionId }, AbortSignal.timeout(10_000))
          .finally(() => { if (requests.get(key) === request) requests.delete(key) })
        requests.set(key, request)
      }
      const value = await request
      if (!active) return
      failures = 0
      onValue(value)
      if (value.some((entry) => entry.detectionState === 'pending' || entry.detectionState === 'running' || entry.update?.state === 'checking') && Date.now() - started < 120_000) {
        timer = setTimeout(() => { void refresh() }, 1_000)
      }
    } catch (error) {
      if (active) {
        failures += 1
        if (failures === 1) onError(error)
        if (Date.now() - started < 120_000) timer = setTimeout(() => { void refresh() }, Math.min(1_000 * 2 ** failures, 15_000))
      }
    }
    finally {
      busy = false
      if (dirty && active) { dirty = false; void refresh() }
    }
  }
  const remove = subscribeAdapterCatalogChanged(rpc, (change) => {
    if (change.kind !== 'adapter') return
    started = Date.now()
    void refresh()
  })
  void refresh()
  return () => { active = false; clearTimeout(timer); remove() }
}
