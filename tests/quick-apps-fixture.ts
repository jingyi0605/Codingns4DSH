import { mkdtemp, mkdir, cp, copyFile, writeFile, rm, realpath } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuickAppRegistry } from '../src/host/modules/quick-apps/registry.js'
import { QuickAppService } from '../src/host/modules/quick-apps/service.js'
import type { QuickApp } from '../src/shared/contracts/quick-apps.js'
import type { QuickAppOriginProvider } from '../src/dsh-capabilities/host/quick-app-origin-adapter.js'

export const definition = { id: '', title: 'Fixture', hostId: 'local', workspaceId: 'workspace-a', documentRoot: 'site', entryPath: 'site/index.html', kind: 'html' as const, spaFallback: true, mounts: [], order: 0 }

/** Test-only transport: the harness supplies cookies. This does not verify browser credential delivery. */
export async function quickAppFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'quick-app-test-')))
  await cp(new URL('./fixtures/quick-app/', import.meta.url), join(root, 'site'), { recursive: true })
  await mkdir(join(root, 'data'))
  await mkdir(join(root, 'site', 'folder'))
  await writeFile(join(root, 'site', 'folder', 'index.html'), '<p>directory</p>')
  await writeFile(join(root, 'site', '空 格.txt'), 'unicode\n')
  await writeFile(join(root, 'data', 'member.json'), '{"value":1}')
  await writeFile(join(root, 'site', 'assets', 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
  await copyFile(new URL('../node_modules/@deepseek-ai/dsh-client-ui-theme/lib/styles/montserrat-regular.woff2', import.meta.url), join(root, 'site', 'assets', 'font.woff2'))
  let saved: QuickApp[] = []
  const registry = new QuickAppRegistry({ read: () => saved, write: async apps => { saved = structuredClone([...apps]) } }, id => id === 'workspace-a' ? root : null)
  const connections: { origin: string; port: number; cookie: string; closed: boolean }[] = []
  let uiOrigin = 'http://dsh.localhost:9000'
  const provider: QuickAppOriginProvider = { open: async handler => {
    const server = createServer(handler)
    server.requestTimeout = 30_000
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const connection = { origin: `http://app${connections.length + 1}.localhost:${port}`, port, cookie: '', closed: false }
    connections.push(connection)
    return { origin: connection.origin, ownerHostId: 'local', uiOrigin, remote: false, cookieName: 'quickapp',
      activate: async (credential, path) => { connection.cookie = `quickapp=${credential}`; return { url: `${connection.origin}${path}` } },
      dispose: async () => { if (connection.closed) return; connection.closed = true; server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
    }
  } }
  const service = new QuickAppService(registry, provider)
  const app = await registry.upsert(definition, 0)
  const launch = async () => service.launch(app.id, 'browser-owner') as Promise<{ launchId: string; url: string; origin: string }>
  const http = (index: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; cookie?: string } = {}) => new Promise<{ status: number; headers: Record<string, unknown>; bytes: Buffer; text: string; json(): any }>((resolve, reject) => {
    const connection = connections[index]!
    const req = request({ hostname: '127.0.0.1', port: connection.port, path, method: options.method ?? 'GET', headers: { host: new URL(connection.origin).host, cookie: options.cookie ?? connection.cookie, ...options.headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode!, headers: res.headers, bytes, text: bytes.toString(), json: () => JSON.parse(bytes.toString()) }) })
      res.on('error', reject)
    })
    req.setTimeout(10_000, () => req.destroy(new Error('Fixture HTTP timeout')))
    req.on('error', reject)
    req.end(options.body)
  })
  const dispose = async () => { await service.dispose(); await rm(root, { recursive: true, force: true }) }
  return { root, registry, service, app, launch, http, connections, dispose, saved: () => saved, setUiOrigin: (value: string) => { uiOrigin = value } }
}
