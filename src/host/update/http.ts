import { updateError } from '../../shared/contracts/plugin-update.js'

export type UpdateFetch = typeof globalThis.fetch

/** Fixed public origins and no redirects keep metadata independent of profile credentials. */
export async function readUpdateJson(url: string, request: UpdateFetch, signal: AbortSignal, limit = 8 * 1024 * 1024): Promise<unknown | null> {
  const parsed = new URL(url)
  if (!['https://registry.npmjs.org', 'https://api.github.com'].includes(parsed.origin) || parsed.username || parsed.password) {
    throw updateError('UPDATE_INVALID_SOURCE')
  }
  const response = await request(url, {
    signal, redirect: 'error', credentials: 'omit',
    headers: { Accept: 'application/json', 'User-Agent': 'Codingns4DSH-update-check' },
  })
  if (response.status === 404) { await response.body?.cancel(); return null }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw updateError(response.status === 429 || response.status === 403 ? 'UPDATE_RATE_LIMITED' : 'UPDATE_METADATA_UNAVAILABLE')
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel()
    throw updateError('UPDATE_RESPONSE_TOO_LARGE')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let body = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw updateError('UPDATE_RESPONSE_TOO_LARGE')
      body += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(body + decoder.decode()) as unknown
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function sha(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{40}$/iu.test(value) ? value.toLowerCase() : null
}

export function date(value: unknown): string | null {
  return typeof value === 'string' && value.length < 64 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}
