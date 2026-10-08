import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { DesktopAssistantFrame } from '../../shared/desktop-assistant.js'

export interface DesktopAssistantPage { readonly url: string; close(): Promise<void> }
/** 独立回环服务只提供形象，不把完整 DSH 页面或认证会话交给伴随窗口。 */
export async function openDesktopAssistantPage(options: {
  readonly frame: () => DesktopAssistantFrame | undefined
  readonly assets: (request: Request) => Promise<Response>
  readonly readBundle?: () => Promise<string>
}): Promise<DesktopAssistantPage> {
  const token = randomBytes(32).toString('hex')
  const cookie = `codingns_companion_${randomBytes(8).toString('hex')}=${token}`
  let origin = ''
  const readBundle = options.readBundle ?? (() => readFile(new URL('../../client/desktop-assistant.js', import.meta.url), 'utf8'))
  // 启动前核对分发文件，缺失时不留下空白原生窗口。
  const bundle = await readBundle()
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.host !== new URL(origin).host || request.method !== 'GET') { response.writeHead(403).end(); return }
      const url = new URL(request.url ?? '/', origin)
      if (request.headers.origin && request.headers.origin !== origin) { response.writeHead(403).end(); return }
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'no-referrer')
      if (url.pathname === '/' && url.searchParams.get('token') === token) {
        response.writeHead(302, { 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' }).end(); return
      }
      if (!request.headers.cookie?.split(';').some((part) => part.trim() === cookie)) { response.writeHead(403).end(); return }
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        // l2d 2.1.1 用内联 script 安装其固定 Cubism 运行时；不开放外部脚本或 eval。
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' https: http: data: blob:; connect-src 'self' https: http:; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'")
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>助理</title><style>html,body,#root{margin:0;background:transparent;overflow:hidden;width:100%;height:100%;font-family:system-ui}button{font:inherit}</style><div id="root"></div><script src="/renderer.js"></script></html>'); return
      }
      if (url.pathname === '/renderer.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(bundle); return }
      if (url.pathname === '/state') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(options.frame() ?? null)); return }
      const asset = await options.assets(new Request(url))
      response.statusCode = asset.status
      for (const [name, value] of asset.headers) response.setHeader(name, value)
      response.end(Buffer.from(await asset.arrayBuffer()))
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') { await close(server); throw new Error('悬浮页面监听失败') }
  origin = `http://127.0.0.1:${address.port}`
  return { url: `${origin}/?token=${token}`, close: () => close(server) }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
}
