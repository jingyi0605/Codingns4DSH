import { QUICK_APP_STORAGE_LIMITS, QUICK_APP_STORAGE_PROTOCOL } from './quick-app-browser-storage.js'
import { quickAppNetworkInstall, quickAppNetworkSource } from './quick-app-network-bootstrap.js'

/** Self-contained because the Host serializes this function into an opaque sandbox document. */
export function quickAppStorageRuntime(token: string, protocol: string, limits: { bytes: number; keys: number; pending: number; timeoutMs: number }): void {
  type Area = 'local' | 'session'
  type Entries = [string, string][]
  type Operation = 'getItem' | 'setItem' | 'removeItem' | 'clear' | 'keys' | 'flush'
  type Request = { id: number; area: Area; operation: Operation; key?: string; value?: string }
  type Pending = { request: Request; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  const source = fetch(location.href, { headers: { Accept: 'text/html' } }).then(response => {
    if (!response.ok) throw new Error('The application HTML could not be loaded.')
    return response.text()
  })
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const connect = new Promise<MessageEvent>((resolve, reject) => {
    const send = () => parent.postMessage({ type: protocol, token, documentId }, '*')
    const receive = (event: MessageEvent) => {
      if (event.source !== parent || event.data?.type !== protocol || event.data.token !== token || event.data.documentId !== documentId || event.ports.length !== 1) return
      clearInterval(retry); clearTimeout(timeout); removeEventListener('message', receive); resolve(event)
    }
    const retry = setInterval(send, 100)
    const timeout = setTimeout(() => {
      clearInterval(retry); removeEventListener('message', receive)
      reject(new Error('Open this application through the updated Quick Apps viewer to use browser storage.'))
    }, limits.timeoutMs)
    addEventListener('message', receive); send()
  })
  void Promise.all([source, connect]).then(([html, event]) => {
    const port = event.ports[0]!
    const pending = new Map<number, Pending>()
    const baseline: Record<Area, Map<string, string>> = { local: new Map(event.data.snapshot.local ?? []), session: new Map(event.data.snapshot.session ?? []) }
    const mirror: Record<Area, Map<string, string>> = { local: new Map(baseline.local), session: new Map(baseline.session) }
    const errors: Partial<Record<Area, Error>> = {}
    const writeErrors: Partial<Record<Area, Error>> = {}
    for (const area of ['local', 'session'] as const) if (event.data.errors[area]) {
      errors[area] = new DOMException(event.data.errors[area].message, event.data.errors[area].name)
    }
    let sequence = 0
    let closed = false
    const mutation = (operation: Operation) => ['setItem', 'removeItem', 'clear'].includes(operation)
    const apply = (map: Map<string, string>, request: Request) => {
      if (request.operation === 'setItem') map.set(request.key!, request.value!)
      else if (request.operation === 'removeItem') map.delete(request.key!)
      else if (request.operation === 'clear') map.clear()
    }
    const reconcile = (area: Area) => {
      mirror[area] = new Map(baseline[area])
      for (const { request } of pending.values()) if (request.area === area) apply(mirror[area], request)
    }
    const report = (error: Error, area: Area) => {
      dispatchEvent(new CustomEvent('appstorageerror', { detail: { area, name: error.name, message: error.message } }))
    }
    const finish = (id: number, value: unknown, entries?: Entries, error?: Error) => {
      const item = pending.get(id)
      if (!item) return
      clearTimeout(item.timer); pending.delete(id)
      const area = item.request.area
      if (entries) { baseline[area] = new Map(entries); delete errors[area] }
      if (error && mutation(item.request.operation)) writeErrors[area] = error
      reconcile(area)
      if (error) item.reject(error); else item.resolve(value)
    }
    port.onmessage = message => {
      const reply = message.data
      if (reply?.type === 'closed') {
        closed = true
        for (const id of [...pending.keys()]) finish(id, undefined, undefined, new DOMException(reply.error.message, reply.error.name))
        port.close(); return
      }
      if (!reply || !Number.isSafeInteger(reply.id)) return
      const error = reply.error ? new DOMException(reply.error.message, reply.error.name) : undefined
      finish(reply.id, reply.value, reply.entries, error)
    }
    const string = (value: unknown): string => {
      if (typeof value === 'symbol') throw new TypeError('Storage keys and values cannot be symbols.')
      return String(value)
    }
    const request = (area: Area, operation: Operation, key?: string, value?: string): Promise<unknown> => {
      if (closed) throw new DOMException('The application storage channel was closed.', 'SecurityError')
      if (pending.size >= limits.pending) throw new DOMException('Too many pending storage operations.', 'QuotaExceededError')
      const item: Request = { id: ++sequence, area, operation, ...(key !== undefined ? { key } : {}), ...(value !== undefined ? { value } : {}) }
      if (mutation(operation)) {
        const next = new Map(mirror[area]); apply(next, item)
        if (next.size > limits.keys || JSON.stringify([...next]).length * 2 > limits.bytes) throw new DOMException('Application storage quota exceeded.', 'QuotaExceededError')
      }
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(item.id, undefined, undefined, new DOMException('Application storage acknowledgement timed out.', 'TimeoutError')), limits.timeoutMs)
        pending.set(item.id, { request: item, resolve, reject, timer })
        try { port.postMessage(item) } catch (error) { finish(item.id, undefined, undefined, error as Error) }
      })
      reconcile(area)
      return result
    }
    const asyncArea = (area: Area) => Object.freeze({
      async getItem(key: unknown) { return await request(area, 'getItem', string(key)) as string | null },
      async setItem(key: unknown, value: unknown) { await request(area, 'setItem', string(key), string(value)) },
      async removeItem(key: unknown) { await request(area, 'removeItem', string(key)) },
      async clear() { await request(area, 'clear') },
      async keys() { return await request(area, 'keys') as string[] },
      async flush() {
        await request(area, 'flush')
        const error = writeErrors[area]; delete writeErrors[area]
        if (error) throw error
      },
    })
    const facade = (area: Area) => {
      const available = () => { if (errors[area]) throw errors[area] }
      const write = (operation: Operation, key?: string, value?: string) => {
        available()
        void request(area, operation, key, value).catch(error => report(error as Error, area))
      }
      const methods = {
        get length() { available(); return mirror[area].size },
        key(index: number) { available(); return [...mirror[area].keys()][Number(index) >>> 0] ?? null },
        getItem(key: unknown) { available(); return mirror[area].get(string(key)) ?? null },
        setItem(key: unknown, value: unknown) { write('setItem', string(key), string(value)) },
        removeItem(key: unknown) { write('removeItem', string(key)) },
        clear() { write('clear') },
      }
      return new Proxy(Object.create(methods) as Storage, {
        get(target, key, receiver) { return Reflect.has(target, key) ? Reflect.get(target, key, receiver) : typeof key === 'string' ? methods.getItem(key) ?? undefined : undefined },
        set(_target, key, value) { methods.setItem(key, value); return true },
        deleteProperty(_target, key) { methods.removeItem(key); return true },
        ownKeys() { available(); return [...mirror[area].keys()] },
        has(target, key) { available(); return Reflect.has(target, key) || typeof key === 'string' && mirror[area].has(key) },
        getOwnPropertyDescriptor(_target, key) { available(); return typeof key === 'string' && mirror[area].has(key) ? { configurable: true, enumerable: true, writable: true, value: mirror[area].get(key) } : undefined },
        defineProperty(_target, key, descriptor) { if (!('value' in descriptor) || descriptor.get || descriptor.set) return false; methods.setItem(key, descriptor.value); return true },
        preventExtensions() { return false },
      })
    }
    Object.defineProperties(window, {
      appStorage: { value: Object.freeze({ ...asyncArea('local'), session: asyncArea('session') }) },
      localStorage: { value: facade('local') },
      sessionStorage: { value: facade('session') },
    })
    // Parse at the original URL, after hydration, so ordinary resource URLs and script order survive.
    // MessagePort listeners remain attached when document.open clears Window/Document listeners.
    quickAppNetworkInstall()
    document.open(); document.write(html); document.close()
  }).catch(error => {
    const message = document.createElement('p')
    message.setAttribute('role', 'alert'); message.textContent = error instanceof Error ? error.message : 'Application storage initialization failed.'
    document.body.replaceChildren(message)
  })
}

export function quickAppStorageBootstrap(token: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(token)) throw new Error('Invalid storage launch token.')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quick App</title></head><body><script>${quickAppNetworkSource()}
(${quickAppStorageRuntime.toString()})(${JSON.stringify(token)},${JSON.stringify(QUICK_APP_STORAGE_PROTOCOL)},${JSON.stringify(QUICK_APP_STORAGE_LIMITS)});</script></body></html>`
}
