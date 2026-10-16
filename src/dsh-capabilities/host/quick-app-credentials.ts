import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { QUICK_APP_LIMITS } from '../../shared/contracts/quick-apps.js'
import { quickAppBootstrapEn, quickAppBootstrapZh } from '../../shared/quick-apps-bootstrap-locale.js'

const bootstrapPath = '/__quickapp/bootstrap'
const exchangePath = '/__quickapp/exchange'
const readyPath = '/__quickapp/ready'
const hash = (value: string) => createHash('sha256').update(value).digest()

/** Shared credential landing page; application files are never rewritten. */
export function quickAppCredentials(origin: string, uiOrigin: string, cookieName: string) {
  let active = true
  let activation: { digest: Buffer; credential: string; entryPath: string; expires: number } | undefined
  let credentialDigest: Buffer | undefined
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const path = request.url
      if (path !== bootstrapPath && path !== exchangePath && path !== readyPath) return false
      if (!active) { endQuickAppResponse(response, 410); return true }
      if (path === bootstrapPath && request.method === 'GET') {
        if (!activation || activation.expires <= Date.now()) { activation = undefined; endQuickAppResponse(response, 410); return true }
        const nonce = randomBytes(18).toString('base64url')
        const copy = /^zh(?:\b|-)/iu.test(request.headers['accept-language'] ?? '') ? quickAppBootstrapZh : quickAppBootstrapEn
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors ${uiOrigin}; base-uri 'none'; form-action 'none'`)
        response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p id="status">${copy['quickApps.opening']}</p><script nonce="${nonce}">(async()=>{const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);try{const r=await fetch('${exchangePath}',{method:'POST',headers:{'Content-Type':'text/plain'},body:ticket,credentials:'include'});if(!r.ok)throw 0;const next=await r.text();const ready=await fetch('${readyPath}',{credentials:'include'});if(!ready.ok)throw 0;location.replace(next)}catch{document.querySelector('#status').textContent=${JSON.stringify(copy['quickApps.bootstrapFailed'])}}})()</script>`)
        return true
      }
      if (path === exchangePath) {
        if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'text/plain'
          || !activation || activation.expires <= Date.now()) { endQuickAppResponse(response, 403); return true }
        const ticket = await readTicket(request)
        if (!ticket || !active || !activation || !timingSafeEqual(activation.digest, hash(ticket))) { endQuickAppResponse(response, 403); return true }
        const grant = activation; activation = undefined
        credentialDigest = hash(grant.credential)
        response.setHeader('Set-Cookie', `${cookieName}=${grant.credential}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${QUICK_APP_LIMITS.lifetimeMs / 1000}`)
        response.setHeader('Content-Type', 'text/plain; charset=utf-8')
        response.end(grant.entryPath)
        return true
      }
      if (path === readyPath) {
        const cookies = request.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`)) ?? []
        const supplied = cookies.length === 1 ? cookies[0]!.slice(cookieName.length + 1) : ''
        endQuickAppResponse(response, request.method === 'GET' && credentialDigest && timingSafeEqual(credentialDigest, hash(supplied)) ? 204 : 401)
        return true
      }
      endQuickAppResponse(response, 405)
      return true
    },
    async activate(credential: string, entryPath: string): Promise<{ url: string }> {
      if (!active || activation || credentialDigest || !/^\/(?!\/)/u.test(entryPath) || /[\r\n#?]/u.test(entryPath)) throw new Error('Invalid app activation.')
      const ticket = randomBytes(32).toString('base64url')
      activation = { digest: hash(ticket), credential, entryPath, expires: Date.now() + 60_000 }
      return { url: `${origin}${bootstrapPath}#${ticket}` }
    },
    dispose() { active = false; activation = undefined; credentialDigest = undefined },
  }
}

export function endQuickAppResponse(response: ServerResponse, status: number): void {
  if (response.headersSent) { response.destroy(); return }
  response.setHeader('Cache-Control', 'no-store')
  response.writeHead(status); response.end()
}

async function readTicket(request: IncomingMessage): Promise<string | undefined> {
  if (Number(request.headers['content-length'] ?? 0) > 128) { request.resume(); return undefined }
  let body = ''
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    body += String(chunk)
    if (body.length > 128) { request.resume(); return undefined }
  }
  return /^[A-Za-z0-9_-]{43}$/u.test(body) ? body : undefined
}
