import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { QuickAppProxyProvider } from '../src/dsh-capabilities/host/quick-app-proxy-provider.js'
import { QuickAppService } from '../src/host/modules/quick-apps/service.js'
import { createNodeLanAccessDshRuntime, LanAccessDshProxy } from '../src/host/lan-access-dsh.js'
import { quickAppFixture } from './quick-apps-fixture.js'

export async function quickAppProxyFixture() {
  const f = await quickAppFixture()
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  let ui = '<p id="privileged">DSH fixture</p>'
  const seen: { path: string; cookie?: string; authorization?: string }[] = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url!, cookie: req.headers.cookie, authorization: req.headers.authorization })
    const pathname = new URL(req.url!, 'http://host.invalid').pathname
    const route = [...routes].find(([prefix]) => pathname === prefix || pathname.startsWith(prefix + '/'))?.[1]
    if (route) { void route(req, res).catch(() => res.destroy()); return }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.setHeader('Set-Cookie', 'dsh_fixture=privileged-cookie; HttpOnly; Path=/'); res.end(ui); return }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const native = { getOrigin: () => `http://127.0.0.1:${port}`, register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
    if (route.path.endsWith('/')) throw new Error('DSH prefix routes must not have a trailing slash.')
    routes.set(route.path, route.handler); return async () => { routes.delete(route.path) }
  } }
  const provider = new QuickAppProxyProvider(native)
  const service = new QuickAppService(f.registry, provider)
  await f.registry.upsert({ ...f.app, fileAccess: 'workspace' }, f.app.revision)
  const proxy = new LanAccessDshProxy(createNodeLanAccessDshRuntime(port))
  const snapshot = await proxy.start({ listenHost: '127.0.0.1', listenPort: 0, dshPort: port })
  const origin = `http://127.0.0.1:${snapshot.actualListenPort}`
  return { ...f, provider, service, native, proxy, routes, seen, origin, hostOrigin: `http://127.0.0.1:${port}`,
    launch: (uiOrigin = origin) => service.launch(f.app.id, 'browser-owner', undefined, uiOrigin) as Promise<any>,
    setUi: (value: string) => { ui = value },
    dispose: async () => { await service.dispose(); await proxy.close(); await provider.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.dispose() },
  }
}
