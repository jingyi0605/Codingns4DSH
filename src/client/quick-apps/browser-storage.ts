import { QUICK_APP_STORAGE_LIMITS, QUICK_APP_STORAGE_PROTOCOL, isQuickAppStorageRequest, validateQuickAppStorageEntries,
  type QuickAppStorageArea, type QuickAppStorageEntries, type QuickAppStorageRequest } from '../../shared/quick-app-browser-storage.js'

export function storageFailure(error: unknown): { name: string; message: string } {
  return { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : 'Application storage failed.' }
}

/** Only this object chooses the namespace; requests cannot provide storage keys or identities. */
export function createQuickAppBrowserStore(scope: string, resolve: (area: QuickAppStorageArea) => Storage) {
  const key = scope
  if (!key.startsWith('codingns.quickApps.storage.v1:') || key.length > 8192) throw new DOMException('Invalid application storage scope.', 'SecurityError')
  const read = (area: QuickAppStorageArea): QuickAppStorageEntries => {
    const text = resolve(area).getItem(key)
    if (text !== null && text.length * 2 > QUICK_APP_STORAGE_LIMITS.bytes) throw new DOMException('Application storage quota exceeded.', 'QuotaExceededError')
    let entries: unknown
    try { entries = text === null ? [] : JSON.parse(text) } catch { throw new DOMException('Application storage is not valid JSON.', 'DataError') }
    validateQuickAppStorageEntries(entries)
    return entries
  }
  return { read, execute(request: unknown) {
    if (!isQuickAppStorageRequest(request)) throw new DOMException('Invalid application storage request.', 'SecurityError')
    const store = resolve(request.area)
    // Clearing a damaged namespace must not require parsing the damaged value first.
    const entries = new Map(request.operation === 'clear' ? [] : read(request.area))
    let value: unknown = null
    switch (request.operation) {
      case 'getItem': value = entries.get(request.key!) ?? null; break
      case 'setItem': entries.set(request.key!, request.value!); break
      case 'removeItem': entries.delete(request.key!); break
      case 'keys': value = [...entries.keys()]; break
    }
    const snapshot = [...entries]
    validateQuickAppStorageEntries(snapshot)
    if (request.operation === 'clear') store.removeItem(key)
    else if (request.operation === 'setItem' || request.operation === 'removeItem') store.setItem(key, JSON.stringify(snapshot))
    return { id: request.id, value, entries: snapshot }
  } }
}

/** Exact window + launch token authenticate the initial transfer; Origin:null alone never does. */
export function attachQuickAppStorageBroker(options: {
  owner: Window; frame(): HTMLIFrameElement | null; token: string; scope: string; expiresAt: number; onError(error: Error): void
}): () => void {
  const { owner, token, expiresAt, onError } = options
  const store = createQuickAppBrowserStore(options.scope, area => area === 'local' ? owner.localStorage : owner.sessionStorage)
  let active = true
  let port: MessagePort | undefined
  let documentId: string | undefined
  const shutdown = () => {
    port?.postMessage({ type: 'closed', error: { name: 'SecurityError', message: 'The application storage channel was closed.' } })
    port?.close(); port = undefined
  }
  const connect = (event: MessageEvent) => {
    const frameWindow = options.frame()?.contentWindow
    const data = event.data
    if (!active || Date.now() >= expiresAt || !frameWindow || event.source !== frameWindow || event.origin !== 'null'
      || !data || data.type !== QUICK_APP_STORAGE_PROTOCOL || data.token !== token || typeof data.documentId !== 'string'
      || !/^[a-f0-9]{32}$/u.test(data.documentId) || documentId === data.documentId) return
    shutdown(); documentId = data.documentId
    const channel = new MessageChannel()
    port = channel.port1
    const current = port
    const snapshot: Partial<Record<QuickAppStorageArea, QuickAppStorageEntries>> = {}
    const errors: Partial<Record<QuickAppStorageArea, ReturnType<typeof storageFailure>>> = {}
    for (const area of ['local', 'session'] as const) {
      try { snapshot[area] = store.read(area) }
      catch (error) { errors[area] = storageFailure(error); onError(new Error(errors[area]!.message)) }
    }
    current.onmessage = message => {
      if (current !== port) return
      if (!active || Date.now() >= expiresAt) { shutdown(); return }
      try { current.postMessage(store.execute(message.data)) }
      catch (error) {
        const failure = storageFailure(error)
        const id = (message.data as Partial<QuickAppStorageRequest> | null)?.id
        current.postMessage({ id, error: failure })
        onError(new Error(failure.message))
        if (!isQuickAppStorageRequest(message.data)) shutdown()
      }
    }
    frameWindow.postMessage({ type: QUICK_APP_STORAGE_PROTOCOL, token, documentId, snapshot, errors }, '*', [channel.port2])
  }
  owner.addEventListener('message', connect)
  const expiry = setTimeout(() => { active = false; shutdown(); owner.removeEventListener('message', connect) }, Math.max(0, Math.min(expiresAt - Date.now(), 2_147_483_647)))
  return () => { active = false; clearTimeout(expiry); owner.removeEventListener('message', connect); shutdown() }
}
