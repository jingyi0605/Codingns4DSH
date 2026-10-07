import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { BUILTIN_ASSISTANT_AVATAR_SOURCES } from '../../shared/assistant-avatar.js'

/** 只读取随插件提供的两张生图素材，不接受任意文件路径或下载地址。 */
export function createAssistantAvatarBasicHandler(readImage: (filename: string) => Promise<Uint8Array<ArrayBuffer>> = readBasicImage): (request: Request) => Promise<Response> {
  const paths = new Set(Object.values(BUILTIN_ASSISTANT_AVATAR_SOURCES))
  const images = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
  return async (request) => {
    const path = new URL(request.url).pathname
    if (!paths.has(path)) return new Response(null, { status: 404 })
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    try {
      let image = images.get(path)
      if (image === undefined) { image = readImage(basename(path)); images.set(path, image) }
      return new Response(await image, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } })
    } catch {
      images.delete(path)
      return Response.json({ error: 'avatar_basic_unavailable' }, { status: 503 })
    }
  }
}

async function readBasicImage(filename: string): Promise<Uint8Array<ArrayBuffer>> {
  // 包自引用兼容源码和打包目录，读取发生在首次请求时，不进行预下载。
  const root = dirname(createRequire(import.meta.url).resolve('@jingyi0605/codingns4dsh/package.json'))
  return new Uint8Array(await readFile(join(root, 'assets', 'assistant-basics', filename)))
}
