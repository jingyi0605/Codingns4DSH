import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer as createTcpServer } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { createHash, X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { quickAppFixture } from './quick-apps-fixture.js'
import { configuredQuickAppHttpsProvider } from '../src/dsh-capabilities/host/quick-app-https-provider.js'
import { QuickAppService } from '../src/host/modules/quick-apps/service.js'

export async function freeLocalPort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** Disposable TLS trust and DNS mappings only; no system certificates/profiles are changed. */
export async function quickAppHttpsFixture() {
  const f = await quickAppFixture()
  try {
    const port = await freeLocalPort()
    const uiPort = await freeLocalPort()
    const uiOrigin = `https://ui.dsh.test:${uiPort}`
    const openssl = join(f.root, 'openssl.cnf')
    const certFile = join(f.root, 'cert.pem'); const keyFile = join(f.root, 'key.pem')
    await writeFile(openssl, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Quick Apps disposable fixture\n[ext]\nsubjectAltName=DNS:*.apps.quick-app.test,DNS:ui.dsh.test\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n')
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', openssl, '-keyout', keyFile, '-out', certFile], { timeout: 15_000 })
    const config = { appDomain: 'apps.quick-app.test', uiOrigins: [uiOrigin], listenHost: '127.0.0.1', listenPort: port, publicPort: port, certFile, keyFile }
    const configPath = join(f.root, 'https-config.json')
    await writeFile(configPath, JSON.stringify(config))
    const provider = (await configuredQuickAppHttpsProvider(configPath))!
    const cert = await readFile(certFile, 'utf8'); const key = await readFile(keyFile, 'utf8')
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    const service = new QuickAppService(f.registry, provider)
    const http = (origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string; servername?: string } = {}) => new Promise<{ status: number; headers: any; text: string; bytes: Buffer; json(): any }>((resolve, reject) => {
      const url = new URL(origin)
      const req = request({ hostname: '127.0.0.1', port, servername: options.servername ?? url.hostname, ca: cert, path, agent: false,
        method: options.method ?? 'GET', headers: { host: url.host, ...options.headers } }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk)); response.on('error', reject)
        response.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode!, headers: response.headers, text: bytes.toString(), bytes, json: () => JSON.parse(bytes.toString()) }) })
      })
      req.on('error', reject); req.setTimeout(5_000, () => req.destroy(new Error('TLS fixture timed out'))); req.end(options.body)
    })
    const launch = () => service.launch(f.app.id, 'owner', undefined, uiOrigin) as Promise<{ kind: string; url: string; origin: string; launchId: string }>
    const exchange = async (launch: { url: string; origin: string }) => http(launch.origin, '/__quickapp/exchange', { method: 'POST', headers: { origin: launch.origin, 'content-type': 'text/plain' }, body: new URL(launch.url).hash.slice(1) })
    return { ...f, config, provider, service, port, uiPort, uiOrigin, cert, key, spki, http, launch, exchange,
      dispose: async () => { await service.dispose(); await provider.dispose(); await f.dispose() } }
  } catch (error) { await f.dispose(); throw error }
}
