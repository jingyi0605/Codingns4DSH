import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { QUICK_APP_LIMITS } from '../../../shared/contracts/quick-apps.js'
import { quickAppAddressBlocked, quickAppAllowMatches, quickAppAllowMatchesName, quickAppFakeIpAddress } from '../../../shared/quick-app-network-allow.js'
import { QuickAppError } from './errors.js'

/** Host egress skips the browser's CORS and private-network checks, so non-public targets need an app allow entry. */

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const REQUEST_HEADERS = new Set(['authorization', 'content-type', 'accept', 'accept-language'])
const RAW_LIMIT = 96 * 1024 * 1024
const BODY_LIMIT = 64 * 1024 * 1024
const EGRESS_TIMEOUT = 180_000

export interface QuickAppEgressHop {
  readonly protocol: 'http:' | 'https:'
  readonly hostname: string
  readonly hostHeader: string
  readonly address: string
  readonly family: 4 | 6
  readonly port: number
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer
}
export interface QuickAppEgressResponse { readonly status: number; readonly contentType: string; readonly body: Buffer }
interface HopResponse extends QuickAppEgressResponse { readonly location?: string }
export interface QuickAppEgressDeps {
  lookup?(hostname: string): Promise<readonly { address: string; family: number }[]>
  deliver?(hop: QuickAppEgressHop, signal: AbortSignal): Promise<HopResponse>
  allow?: readonly string[]
}

export function quickAppEgressAddressBlocked(address: string): boolean {
  const normalized = normalizeAddress(address)
  return normalized === null || quickAppAddressBlocked(normalized.address, normalized.family)
}

export async function proxyQuickAppEgress(raw: string, signal: AbortSignal, deps: QuickAppEgressDeps = {}): Promise<QuickAppEgressResponse> {
  const request = parseEgressRequest(raw)
  const resolve = deps.lookup ?? defaultLookup
  const deliver = deps.deliver ?? deliverQuickAppEgress
  const allow = deps.allow ?? []
  let method = request.method
  let body = request.body
  let headers = request.headers
  let current = request.url
  for (let hop = 0; hop <= 5; hop++) {
    const pinned = await resolvePublic(current, resolve, allow)
    const response = await deliver(hopRequest(current, method, headers, body, pinned), signal)
    if (response.status < 300 || response.status >= 400 || request.redirect === 'manual') return { status: response.status, contentType: response.contentType, body: response.body }
    if (request.redirect === 'error') throw failed(502, 'The network request was redirected.')
    if (hop === 5 || !response.location) throw failed(502, 'The network request was redirected too many times.')
    const next = new URL(response.location, current)
    if (next.host !== current.host) headers = headers.filter(([name]) => name !== 'authorization')
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET'; body = Buffer.alloc(0); headers = headers.filter(([name]) => name !== 'content-type')
    }
    current = next
  }
  throw failed(502, 'The network request was redirected too many times.')
}

export async function deliverQuickAppEgress(hop: QuickAppEgressHop, signal: AbortSignal): Promise<HopResponse> {
  const library = hop.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof QuickAppError ? error : failed(signal.aborted ? 504 : 502, signal.aborted ? 'The network request timed out.' : 'The network request could not be completed.'))
    const req = library({ host: hop.address, servername: hop.protocol === 'https:' ? hop.hostname : undefined, port: hop.port, method: hop.method, path: hop.path, headers: hop.headers, timeout: EGRESS_TIMEOUT, signal, family: hop.family, agent: false }, res => {
      const chunks: Buffer[] = []; let size = 0; let failedLimit = false
      res.on('data', chunk => {
        size += chunk.length
        if (size > QUICK_APP_LIMITS.staticBytes) { failedLimit = true; res.destroy(); reject(new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'The network response limit is 64 MiB.')) }
        else chunks.push(chunk)
      })
      res.on('error', fail)
      res.on('end', () => {
        if (failedLimit) return
        resolve({ status: statusOf(res), contentType: contentTypeOf(res.headers['content-type']), body: Buffer.concat(chunks), ...(typeof res.headers.location === 'string' ? { location: res.headers.location } : {}) })
      })
    })
    req.setHeader('Host', hop.hostHeader)
    req.on('error', fail)
    req.on('timeout', () => req.destroy(failed(504, 'The network request timed out.')))
    req.end(hop.body.byteLength ? hop.body : undefined)
  })
}

export async function readEgressBody(req: IncomingMessage, signal: AbortSignal): Promise<string> {
  if (!/^text\/plain(?:;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '')) throw new QuickAppError(415, 'QUICK_APP_CONTENT_TYPE', 'Send UTF-8 text/plain content.')
  if (Number(req.headers['content-length']) > RAW_LIMIT) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'The network request limit is 64 MiB.')
  const chunks: Buffer[] = []; let length = 0
  const cancel = () => req.destroy()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted(); length += chunk.length
      if (length > RAW_LIMIT) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'The network request limit is 64 MiB.')
      chunks.push(Buffer.from(chunk))
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { throw new QuickAppError(400, 'QUICK_APP_ENCODING', 'Send valid UTF-8 text.') }
  } finally { signal.removeEventListener('abort', cancel) }
}

function parseEgressRequest(raw: string): { method: string; url: URL; headers: [string, string][]; body: Buffer; redirect?: string } {
  if (Buffer.byteLength(raw) > RAW_LIMIT) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'The network request limit is 64 MiB.')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request is invalid.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request is invalid.')
  const record = value as Record<string, unknown>
  const method = typeof record.method === 'string' ? record.method.toUpperCase() : 'GET'
  if (!METHODS.has(method)) throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request method is not supported.')
  if (typeof record.url !== 'string' || record.url.length > 8192) throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request URL is invalid.')
  let url: URL
  try { url = new URL(record.url) } catch { throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request URL is invalid.') }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request URL is invalid.')
  const headers = normalizeHeaders(record.headers)
  const body = decodeBody(record.body)
  const redirect = record.redirect === undefined ? undefined : record.redirect === 'follow' || record.redirect === 'manual' || record.redirect === 'error' ? record.redirect : undefined
  if (record.redirect !== undefined && redirect === undefined) throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request is invalid.')
  return { method, url, headers, body, ...(redirect ? { redirect } : {}) }
}

function normalizeHeaders(value: unknown): [string, string][] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32) throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request is invalid.')
  return value.map(item => {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request is invalid.')
    const name = item[0].toLowerCase()
    if (!REQUEST_HEADERS.has(name) || item[1].length > 8192 || /[\r\n\0]/u.test(item[1])) throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request is invalid.')
    return [name, item[1]] as [string, string]
  })
}

function decodeBody(value: unknown): Buffer {
  if (value === undefined) return Buffer.alloc(0)
  if (typeof value !== 'string' || value.length > RAW_LIMIT || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new QuickAppError(400, 'QUICK_APP_EGRESS_REQUEST', 'The network request is invalid.')
  const body = Buffer.from(value, 'base64')
  if (body.byteLength > BODY_LIMIT) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'The network request limit is 64 MiB.')
  return body
}

async function resolvePublic(url: URL, resolve: NonNullable<QuickAppEgressDeps['lookup']>, allow: readonly string[]): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (!hostname || hostname.length > 253 || /^\d+$/u.test(hostname)) throw denied()
  const special = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
  const named = quickAppAllowMatchesName(allow, hostname)
  const literal = isIP(hostname)
  const records = literal ? [{ address: hostname, family: literal }] : await resolve(hostname).catch(() => { throw failed(502, 'The server address could not be resolved.') })
  if (!records.length) throw failed(502, 'The server address could not be resolved.')
  const usable: { address: string; family: 4 | 6 }[] = []
  const fakeIp: { address: string; family: 4 | 6 }[] = []
  for (const record of records) {
    const normalized = normalizeAddress(record.address)
    if (!normalized) continue
    const blocked = quickAppAddressBlocked(normalized.address, normalized.family)
    const allowed = named || quickAppAllowMatches(allow, hostname, normalized.address, normalized.family)
    if (special) {
      if (allowed) usable.push(normalized)
      continue
    }
    if (!blocked || allowed) { usable.push(normalized); continue }
    // A hostname that only resolves inside the benchmarking range is the system proxy's fake-ip table.
    if (!literal && quickAppFakeIpAddress(normalized.address, normalized.family)) { fakeIp.push(normalized); continue }
    throw denied()
  }
  const pinned = usable.length ? usable : fakeIp
  if (!pinned.length) throw denied()
  return pinned[0]!
}

function hopRequest(url: URL, method: string, headers: readonly [string, string][], body: Buffer, pinned: { address: string; family: 4 | 6 }): QuickAppEgressHop {
  const outbound = Object.fromEntries(headers.filter(([name]) => method === 'GET' || method === 'HEAD' ? name !== 'content-type' : true))
  return {
    protocol: url.protocol === 'https:' ? 'https:' : 'http:', hostname: url.hostname, hostHeader: url.host, address: pinned.address, family: pinned.family,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80, method, path: `${url.pathname}${url.search}`, headers: outbound, body: method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : body,
  }
}

function normalizeAddress(address: string): { address: string; family: 4 | 6 } | null {
  const zone = address.split('%')[0] ?? address
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(zone)
  if (dotted && isIP(dotted[1]!) === 4) return { address: dotted[1]!, family: 4 }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(zone)
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16); const low = Number.parseInt(hex[2]!, 16)
    return { address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, family: 4 }
  }
  const family = isIP(zone)
  if (family === 4 || family === 6) return { address: zone, family }
  return null
}

async function defaultLookup(hostname: string): Promise<readonly { address: string; family: number }[]> {
  return lookup(hostname, { all: true, verbatim: true })
}

function statusOf(res: IncomingMessage): number { return res.statusCode && res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502 }
function contentTypeOf(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return 'application/octet-stream'
  const type = raw.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type)) return 'application/octet-stream'
  const charset = /charset\s*=\s*"?([a-z0-9._-]+)"?/iu.exec(raw)
  return charset ? `${type}; charset=${charset[1]!.toLowerCase()}` : type
}
function denied(): QuickAppError { return new QuickAppError(403, 'QUICK_APP_EGRESS_DENIED', 'Quick Apps can call public websites only.') }
function failed(status: number, message: string): QuickAppError { return new QuickAppError(status, 'QUICK_APP_EGRESS_FAILED', message) }
