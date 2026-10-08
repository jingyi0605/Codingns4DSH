import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { PROVIDER_ICON_FILES, PROVIDER_ICON_PATH } from '../shared/provider-icon-resources.js'

/** 固定白名单：注册时不读磁盘，首次显示时读取，并合并同一图片的并发请求。 */
export function createProviderIconHandler(readImage: (filename: string) => Promise<Uint8Array<ArrayBuffer>> = readInstalledIcon): (request: Request) => Promise<Response> {
  const files = new Map(Object.values(PROVIDER_ICON_FILES).map((filename) => [PROVIDER_ICON_PATH + filename, filename]))
  const images = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
  return async (request) => {
    const filename = files.get(new URL(request.url).pathname)
    if (filename === undefined) return new Response(null, { status: 404 })
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    try {
      let image = images.get(filename)
      if (image === undefined) {
        image = Promise.resolve().then(() => readImage(filename))
        images.set(filename, image)
        void image.catch(() => { if (images.get(filename) === image) images.delete(filename) })
      }
      const body = await image
      return new Response(request.method === 'HEAD' ? null : body, { headers: {
        'Content-Type': filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        'Content-Length': String(body.byteLength),
        // URL 带版本号；同版本开发仍可重新校验，不永久缓存旧内容。
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      } })
    } catch { return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
  }
}

export function registerProviderIconRoutes(registry: HostConnectionFetch): () => Promise<void> {
  const handler = createProviderIconHandler()
  const disposers: Array<() => Promise<void>> = []
  const dispose = async (): Promise<void> => {
    const results = await Promise.allSettled(disposers.splice(0).reverse().map((release) => Promise.resolve().then(release)))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  try {
    for (const filename of new Set(Object.values(PROVIDER_ICON_FILES))) {
      disposers.push(registry.register({ path: PROVIDER_ICON_PATH + filename, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: handler }))
    }
  } catch (error) { void dispose().catch(() => undefined); throw error }
  return dispose
}

async function readInstalledIcon(filename: string): Promise<Uint8Array<ArrayBuffer>> {
  const root = dirname(createRequire(import.meta.url).resolve('@jingyi0605/codingns4dsh/package.json'))
  return new Uint8Array(await readFile(join(root, 'assets', 'provider-icons', filename)))
}
