import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, X509Certificate } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { request as tlsRequest } from 'node:https'
import type { Server } from 'node:net'
import { WebSocketServer } from 'ws'
import { quickAppFixture } from './quick-apps-fixture.js'
import { freeLocalPort } from './quick-apps-https-fixture.js'
import { configuredQuickAppTransport } from '../src/dsh-capabilities/host/quick-app-transport.js'
import { QuickAppService } from '../src/host/modules/quick-apps/service.js'
import { LanAccessDshProxy, createNodeLanAccessDshRuntime } from '../src/host/lan-access-dsh.js'

export async function closeFixtureServer(server: Server): Promise<void> {
  if ('closeAllConnections' in server) (server as any).closeAllConnections()
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
}

/** All sockets bind loopback. Public names/IPs exist only in fixture Host/TLS fields. */
export async function quickAppLanFixture(publicHost = 'lan.dsh.test', portCount = 12) {
  const f = await quickAppFixture()
  let transport: Awaited<ReturnType<typeof configuredQuickAppTransport>> | undefined
  let proxy: LanAccessDshProxy | undefined
  let service: QuickAppService | undefined
  const requests: { url: string; origin?: string; cookie?: string }[] = []
  let uiBody = '<p>DSH fixture</p>'
  const upstream = createServer((req, res) => {
    requests.push({ url: req.url!, origin: req.headers.origin, cookie: req.headers.cookie })
    if (req.url === '/authenticate') { res.writeHead(303, { 'Set-Cookie': 'dsh_fixture=general-secret; HttpOnly; Path=/', Location: '/' }); res.end(); return }
    if (!req.headers.cookie?.includes('dsh_fixture=general-secret')) { res.writeHead(401); res.end(); return }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.setHeader('Set-Cookie', 'dsh_browser=fixture-browser-secret; HttpOnly; Secure; Path=/'); res.end(uiBody); return }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ privileged: true }))
  })
  const websocket = new WebSocketServer({ server: upstream })
  websocket.on('connection', (socket, req) => {
    requests.push({ url: req.url!, origin: req.headers.origin, cookie: req.headers.cookie })
    socket.on('message', message => socket.send(message.toString()))
  })
  const dispose = async () => { await service?.dispose(); await proxy?.close(); await transport?.dispose(); for (const socket of websocket.clients) socket.terminate(); websocket.close(); await closeFixtureServer(upstream); await f.dispose() }
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const dshPort = (upstream.address() as { port: number }).port
    const uiPort = await freeLocalPort()
    // Select a bounded high range. Busy ports are skipped by the production allocator.
    const first = Math.min(await freeLocalPort(), 65000 - portCount)
    const uiOrigin = `https://${publicHost}:${uiPort}`
    const certFile = join(f.root, 'lan-cert.pem'); const keyFile = join(f.root, 'lan-key.pem')
    const certConfig = join(f.root, 'lan-openssl.cnf')
    await writeFile(certConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Disposable LAN fixture\n[ext]\nsubjectAltName=DNS:lan.dsh.test,IP:10.20.30.40,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n')
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', certConfig, '-keyout', keyFile, '-out', certFile], { timeout: 15_000 })
    const cert = await readFile(certFile, 'utf8'); const key = await readFile(keyFile, 'utf8')
    const config = { transport: 'lan-ports' as const, publicHost, uiOrigins: [uiOrigin], ports: [first, first + portCount - 1] as const, stateDirectory: join(f.root, 'port-history'), certFile, keyFile }
    const configPath = join(f.root, 'lan-config.json'); await writeFile(configPath, JSON.stringify(config))
    transport = await configuredQuickAppTransport(configPath)
    if (!transport.lan) throw new Error('LAN fixture configuration failed')
    const runtime = createNodeLanAccessDshRuntime(dshPort)
    proxy = new LanAccessDshProxy(runtime, `http://127.0.0.1:${dshPort}/authenticate`, undefined, transport.lan)
    const start = () => proxy!.start({ listenHost: '127.0.0.1', listenPort: 0, dshPort })
    const snapshot = await start()
    service = new QuickAppService(f.registry, transport.origins)
    await f.registry.upsert({ ...f.app, fileAccess: 'workspace' }, f.app.revision)
    const http = (origin: string, path: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: string; plain?: boolean; port?: number } = {}) => new Promise<{ status: number; headers: any; text: string; bytes: Buffer; json(): any }>((resolve, reject) => {
      const url = new URL(origin)
      const req = (options.plain ? request : tlsRequest)({ hostname: '127.0.0.1', port: options.port ?? Number(url.port), agent: false,
        ...(options.plain ? {} : { ca: cert, servername: url.hostname === 'lan.dsh.test' ? url.hostname : '' }),
        path, method: options.method ?? 'GET', headers: Object.fromEntries(Object.entries({ host: url.host, 'sec-fetch-site': 'same-origin', ...options.headers }).filter(([, value]) => value !== undefined)) }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
        res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode!, headers: res.headers, text: bytes.toString(), bytes, json: () => JSON.parse(bytes.toString()) }) })
      })
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('LAN fixture timed out'))); req.end(options.body)
    })
    const launch = () => service!.launch(f.app.id, 'fixture-owner', undefined, uiOrigin) as Promise<{ origin: string; url: string; launchId: string; isolation: string }>
    const exchange = (launch: { origin: string; url: string }) => http(launch.origin, '/__quickapp/exchange', { method: 'POST', headers: { origin: launch.origin, 'content-type': 'text/plain' }, body: new URL(launch.url).hash.slice(1) })
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    return { ...f, config, configPath, cert, key, spki, transport, provider: transport.origins, proxy, service, http, launch, exchange, uiOrigin, uiPort, proxyPort: snapshot.actualListenPort!,
      requests, dshPort, start, setUiBody: (body: string) => { uiBody = body }, dispose }
  } catch (error) { await dispose(); throw error }
}
