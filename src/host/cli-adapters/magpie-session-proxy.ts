import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'

const MAGPIE_SESSION_HEADER = 'x-magpie-session'
const MAX_SESSION_ID_LENGTH = 128

export interface MagpieSessionProxy {
  /** Loopback URL to hand to the CLI instead of the Magpie gateway URL. */
  readonly baseUrl: string
  close(): Promise<void>
}

export interface MagpieGeminiModelMapping {
  readonly acpModel: string
  readonly gatewayModel: string
}

function mapGeminiPath(path: string, basePath: string, mapping: MagpieGeminiModelMapping): string {
  const modelPath = `${basePath}/v1beta/models/${mapping.acpModel}:`
  if (!path.startsWith(modelPath) || !/^(?:generateContent|streamGenerateContent|countTokens)(?:\?|$)/u.test(path.slice(modelPath.length))) return path
  return `${basePath}/v1beta/models/${mapping.gatewayModel}:${path.slice(modelPath.length)}`
}

/**
 * Antigravity talks to the Magpie gateway through `GOOGLE_GEMINI_BASE_URL` and
 * offers no way to add request headers on that path (settings fields, URL
 * query and path prefixes were all verified to be dropped or rejected). Magpie
 * indexes usage and routes by `X-Magpie-Session`, so this proxy lives for one
 * CLI turn and adds that header to every request it forwards.
 *
 * It stores no credentials: the CLI's own `Authorization`/API key headers pass
 * through untouched, and an explicit session header from the client wins.
 * A per-turn Gemini mapping rewrites only the matching model's API path.
 * Returns null when the target is not a loopback HTTP(S) URL or the session ID
 * cannot be sent as a header. A mapped turn must have a working proxy.
 */
export async function startMagpieSessionProxy(targetUrl: string, sessionId: string, mapping?: MagpieGeminiModelMapping): Promise<MagpieSessionProxy | null> {
  const session = sessionId.trim()
  if (session === '' || session.length > MAX_SESSION_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(session)) return null
  const target = parseLoopbackTarget(targetUrl)
  if (target === null) return null
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  const rawBasePath = target.pathname.replace(/\/+$/u, '')
  // The Gemini SDK appends /v1beta itself. A gateway URL ending in /v1 is the OpenAI API base.
  const basePath = mapping === undefined ? rawBasePath : rawBasePath.replace(/\/v1(?:beta)?$/u, '')

  const server: Server = createServer((req, res) => {
    const headers: IncomingHttpHeaders = { ...req.headers, host: target.host }
    delete headers.connection
    if (headers[MAGPIE_SESSION_HEADER] === undefined) headers[MAGPIE_SESSION_HEADER] = session
    const path = req.url ?? '/'
    const upstream = send({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/gu, ''),
      port: target.port === '' ? undefined : target.port,
      method: req.method,
      // The CLI already includes the base path. Preserve it and the query string.
      path: mapping !== undefined && req.method === 'POST' ? mapGeminiPath(path, basePath, mapping) : path,
      headers,
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
      response.once('error', () => res.destroy())
    })
    upstream.once('error', () => {
      if (res.headersSent) res.destroy()
      else { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Magpie gateway is unreachable"}}') }
    })
    // A CLI that gives up (turn aborted) must not leave the upstream stream running.
    res.once('close', () => { if (!res.writableFinished) upstream.destroy() })
    req.once('error', () => upstream.destroy())
    req.pipe(upstream)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const { port } = server.address() as AddressInfo
  let closing: Promise<void> | null = null
  return {
    baseUrl: `http://127.0.0.1:${port}${basePath}`,
    close: () => closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

function parseLoopbackTarget(value: string): URL | null {
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    || url.hostname === '::1' || url.hostname === '[::1]'
  return loopback ? url : null
}
