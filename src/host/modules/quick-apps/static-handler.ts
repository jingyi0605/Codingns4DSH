import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { QuickAppOriginLease } from '../../../dsh-capabilities/host/quick-app-origin-adapter.js'
import { QUICK_APP_LIMITS } from '../../../shared/contracts/quick-apps.js'
import type { QuickAppLaunch, QuickAppLaunches } from './launches.js'
import { QuickAppFileApi, tooLarge } from './file-api.js'
import { appPath, decodeResourceTarget, publicPath, resolveAppPath, withinScope } from './paths.js'
import { deny, QuickAppError } from './errors.js'

const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm', pdf: 'application/pdf', mp3: 'audio/mpeg', mp4: 'video/mp4', csv: 'text/csv; charset=utf-8' }
export function quickAppMime(path: string): string { return TYPES[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream' }

export function createQuickAppHttpHandler(launches: QuickAppLaunches, files: QuickAppFileApi, launch: QuickAppLaunch, lease: QuickAppOriginLease): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let active = 0
  return async (req, res) => {
    const proxy = lease.isolation === 'sandbox-proxy'
    const appOrigin = proxy ? 'null' : lease.origin
    const abort = new AbortController()
    const onClose = () => abort.abort()
    req.once('aborted', onClose)
    res.once('close', onClose)
    const signal = AbortSignal.any([abort.signal, launch.abort.signal, AbortSignal.timeout(30_000)])
    let counted = false
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', lease.isolation === 'lan-port' ? 'same-origin' : 'no-referrer')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', `${proxy ? 'sandbox allow-scripts allow-forms allow-downloads; ' : ''}frame-ancestors ${lease.uiOrigin}; worker-src 'none'; object-src 'none'`)
      if (req.headers.host !== new URL(lease.origin).host) deny('Wrong app Host header.')
      const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${lease.cookieName}=`))
      if (cookies.length !== 1) throw new QuickAppError(401, 'QUICK_APP_UNAUTHENTICATED', 'App authentication required.')
      launches.authorize(launch, cookies[0]!.slice(lease.cookieName.length + 1))
      await launches.validateWorkspace(launch)
      if (proxy) {
        res.setHeader('Access-Control-Allow-Origin', 'null')
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-Match, If-None-Match')
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
      }
      if (active >= QUICK_APP_LIMITS.requests) throw new QuickAppError(429, 'QUICK_APP_LIMIT', 'Too many concurrent requests.')
      active++; counted = true
      const target = decodeResourceTarget(req.url ?? '/')
      if (target.path === '__quickapp' || target.path.startsWith('__quickapp/')) {
        if (req.headers.origin !== undefined && req.headers.origin !== appOrigin) deny('Cross-origin file requests are denied.')
        if (!proxy && req.headers['sec-fetch-site'] === 'cross-site') deny()
        const query = new URLSearchParams(target.query)
        if ([...query.keys()].some(key => key !== 'path') || query.getAll('path').length !== 1) deny('Only one workspace-relative path is accepted.')
        const path = appPath(query.get('path'))
        let result: unknown
        if (target.path === '__quickapp/list' && req.method === 'GET') result = await files.list(launch, path)
        else if (target.path !== '__quickapp/files') throw new QuickAppError(404, 'QUICK_APP_NOT_FOUND', 'Unknown file API route.')
        else if (req.method === 'GET') result = await files.read(launch, path)
        else if (req.method === 'PUT' || req.method === 'DELETE') {
          if (req.headers.origin !== appOrigin) deny('Mutations require the app Origin.')
          const content = req.method === 'PUT' ? await readBody(req, signal) : ''
          result = await files.mutate(launch, req.method, path, content, oneHeader(req.headers['if-match']), oneHeader(req.headers['if-none-match']), signal)
        } else throw new QuickAppError(405, 'QUICK_APP_METHOD', 'Unsupported file API method.')
        launches.authorize(launch)
        json(res, 200, result)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new QuickAppError(405, 'QUICK_APP_METHOD', 'Static resources support GET and HEAD.')
      if (req.headers['sec-fetch-dest'] === 'serviceworker' || req.headers['service-worker']) deny('Service workers are not supported.')
      const app = launch.app
      const mount = app.mounts.find(item => withinScope(item.urlPrefix.slice(1), target.path))
      const scope = mount?.workspacePath ?? app.documentRoot
      const suffix = mount ? target.path.slice(mount.urlPrefix.length).replace(/^\//u, '') : target.path
      let resource = [scope, suffix].filter(Boolean).join('/')
      if (!publicPath(resource)) deny()
      let absolute: string
      try {
        absolute = await resolveAppPath(launch.workspaceRoot, resource)
        if ((await stat(absolute)).isDirectory()) {
          if (!target.trailingSlash) {
            res.writeHead(308, { Location: `${lease.basePath ?? '/'}${target.path.split('/').map(encodeURIComponent).join('/')}/${target.query}` }); res.end(); return
          }
          resource = [resource, 'index.html'].filter(Boolean).join('/')
          absolute = await resolveAppPath(launch.workspaceRoot, resource)
        }
      } catch (error) {
        const navigation = req.headers['sec-fetch-mode'] === 'navigate' && ['document', 'iframe'].includes(String(req.headers['sec-fetch-dest'])) && String(req.headers.accept ?? '').includes('text/html')
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !app.spaFallback || !navigation || extname(target.path) !== '' || mount) throw error
        absolute = await resolveAppPath(launch.workspaceRoot, app.entryPath)
      }
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        if (!info.isFile()) deny()
        if (info.size > QUICK_APP_LIMITS.staticBytes) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'Static resources are limited to 64 MiB.')
        launches.authorize(launch)
        res.writeHead(200, { 'Content-Type': quickAppMime(absolute), 'Content-Length': info.size })
        if (req.method === 'HEAD' || info.size === 0) { res.end(); return }
        await pipeline(file.createReadStream({ autoClose: false, start: 0, end: info.size - 1, highWaterMark: 64 * 1024 }), res, { signal })
      } finally { await file.close() }
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return }
      if (!req.complete) res.setHeader('Connection', 'close')
      const failure = error instanceof QuickAppError ? error : (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? new QuickAppError(404, 'QUICK_APP_NOT_FOUND', 'Resource not found.')
        : new QuickAppError(500, 'QUICK_APP_FAILED', 'The request could not be completed.')
      json(res, failure.status, { error: { code: failure.code, message: failure.message } }, req.method === 'HEAD')
    } finally { if (counted) active--; req.off('aborted', onClose); res.off('close', onClose) }
  }
}

function oneHeader(value: string | string[] | undefined): string | undefined { if (Array.isArray(value)) deny(); return value }
function json(res: ServerResponse, status: number, value: unknown, head = false): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(head ? undefined : body)
}
export async function readBody(req: IncomingMessage, signal: AbortSignal): Promise<string> {
  if (!/^text\/plain(?:;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '')) throw new QuickAppError(415, 'QUICK_APP_CONTENT_TYPE', 'Send UTF-8 text/plain content.')
  if (Number(req.headers['content-length']) > QUICK_APP_LIMITS.textBytes) tooLarge()
  const chunks: Buffer[] = []; let length = 0
  const cancel = () => req.destroy()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted()
      length += chunk.length
      if (length > QUICK_APP_LIMITS.textBytes) tooLarge()
      chunks.push(Buffer.from(chunk))
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { throw new QuickAppError(400, 'QUICK_APP_ENCODING', 'Send valid UTF-8 text.') }
  } finally { signal.removeEventListener('abort', cancel) }
}
