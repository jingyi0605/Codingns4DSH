import type { SessionTranslationFailure } from '../../shared/contracts/session-translation.js'

/** Only known transient failures qualify for an automatic retry. */
export function translationFailure(error: unknown, signal?: AbortSignal): SessionTranslationFailure {
  const cause = signal?.aborted ? signal.reason : error
  const value = cause as { name?: string; message?: string; code?: string; status?: number; statusCode?: number; cause?: { code?: string } } | undefined
  const message = [value?.name, value?.message ?? String(cause), value?.code, value?.cause?.code].join(' ')
  const status = value?.status ?? value?.statusCode
  if (/timeout|timed out|ETIMEDOUT/iu.test(message)) return { code: 'timeout', retryable: true }
  if (signal?.aborted || value?.name === 'AbortError') return { code: 'cancelled', retryable: false }
  if (status === 429 || /\b429\b|rate.?limit/iu.test(message)) return { code: 'rate-limit', retryable: true }
  if (status !== undefined && status >= 500 && status < 600 || /\b50[0234]\b|service unavailable|overloaded/iu.test(message)) return { code: 'unavailable', retryable: true }
  if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EPIPE|fetch failed|network|connection (?:lost|closed|reset)/iu.test(message)) return { code: 'network', retryable: true }
  if (/unusable translation|translation.*placeholders/iu.test(message)) return { code: 'invalid-response', retryable: false }
  if (status === 400 || status === 401 || status === 403 || status === 404 || /\b40[0134]\b|unauthori[sz]ed|invalid api key|model not found|unsupported/iu.test(message)) return { code: 'configuration', retryable: false }
  return { code: 'provider', retryable: false }
}

/** Providers may ignore cancellation while resolving metadata or streaming. */
export async function withTranslationAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([operation(), aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

export function translationDeadline(milliseconds: number, parent: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Translation deadline exceeded', 'TimeoutError')), milliseconds)
  return { signal: AbortSignal.any([parent, controller.signal]), dispose: () => clearTimeout(timer) }
}

export async function translationDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await withTranslationAbort(() => new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) }), signal)
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Start work on the next free slot; a slow field cannot block an idle slot. */
export function createTranslationQueue(concurrency: number) {
  let active = 0
  const pending: (() => void)[] = []
  const drain = (): void => { while (active < concurrency && pending.length > 0) pending.shift()!() }
  return {
    concurrency,
    run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
      return new Promise((resolve, reject) => {
        const cancel = (): void => {
          const index = pending.indexOf(start)
          if (index >= 0) pending.splice(index, 1)
          reject(signal.reason)
        }
        const start = (): void => {
          signal.removeEventListener('abort', cancel)
          active++
          void withTranslationAbort(operation, signal).then(resolve, reject).finally(() => { active--; drain() })
        }
        if (signal.aborted) { reject(signal.reason); return }
        signal.addEventListener('abort', cancel, { once: true })
        pending.push(start)
        drain()
      })
    },
  }
}
