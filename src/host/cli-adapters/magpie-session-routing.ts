import { AsyncLocalStorage } from 'node:async_hooks'

const MAGPIE_SESSION_HEADER = 'x-magpie-session'
const MAX_SESSION_ID_LENGTH = 128

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

interface MagpieSessionRoutingState {
  readonly storage: AsyncLocalStorage<string>
  readonly originalFetch: typeof fetch
  readonly wrappedFetch: typeof fetch
  references: number
}

let state: MagpieSessionRoutingState | undefined

/**
 * Native DSH requests already carry their session ID in the immutable LLM
 * options. Bind that ID to provider fetches so Magpie can index the request.
 */
export function createMagpieSessionRouting(): {
  wrap<T>(sessionId: string, stream: AsyncIterable<T>): AsyncIterable<T>
  dispose(): void
} {
  const current = state ?? createState()
  state = current
  current.references++
  let disposed = false

  return {
    wrap: (sessionId, stream) => withMagpieSession(current.storage, sessionId, stream),
    dispose: () => {
      if (disposed) return
      disposed = true
      current.references--
      if (current.references !== 0 || state !== current) return
      if (globalThis.fetch === current.wrappedFetch) globalThis.fetch = current.originalFetch
      state = undefined
    },
  }
}

function createState(): MagpieSessionRoutingState {
  const storage = new AsyncLocalStorage<string>()
  const originalFetch = globalThis.fetch
  const wrappedFetch = ((input: FetchInput, init?: FetchInit): ReturnType<typeof fetch> => {
    const sessionId = storage.getStore()
    if (sessionId === undefined || !isLoopbackV1Request(input)) return originalFetch(input, init)
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    if (headers.has(MAGPIE_SESSION_HEADER)) return originalFetch(input, init)
    headers.set(MAGPIE_SESSION_HEADER, sessionId)
    if (input instanceof Request) return originalFetch(new Request(input, { ...init, headers }))
    return originalFetch(input, { ...init, headers })
  }) as typeof fetch
  globalThis.fetch = wrappedFetch
  return { storage, originalFetch, wrappedFetch, references: 0 }
}

async function* withMagpieSession<T>(
  storage: AsyncLocalStorage<string>,
  sessionId: string,
  stream: AsyncIterable<T>,
): AsyncIterable<T> {
  const normalized = normalizeSessionId(sessionId)
  if (normalized === null) {
    yield* stream
    return
  }
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const result = await storage.run(normalized, () => iterator.next())
      if (result.done) return
      yield result.value
    }
  } finally {
    if (typeof iterator.return === 'function') await storage.run(normalized, () => iterator.return!())
  }
}

function isLoopbackV1Request(input: FetchInput): boolean {
  const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : typeof input === 'string' ? input : null
  if (rawUrl === null) return false
  let url: URL
  try { url = new URL(rawUrl) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    || url.hostname === '::1' || url.hostname === '[::1]'
  return loopback && (url.pathname === '/v1' || url.pathname.startsWith('/v1/'))
}

function normalizeSessionId(value: string): string | null {
  const sessionId = value.trim()
  return sessionId !== '' && sessionId.length <= MAX_SESSION_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(sessionId)
    ? sessionId
    : null
}
