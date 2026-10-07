import { randomUUID } from 'node:crypto'
import { ASSISTANT_AVATAR_RESOURCE_PACKS, assistantAvatarCacheStatusPath } from '../../shared/assistant-avatar-legacy-resources.js'
import type { AssistantAvatarCacheStatus, AssistantAvatarResourcePack } from '../../shared/assistant-avatar-resources.js'

/** 清单只保留助理实际消费的动作；不改模型、贴图、物理和布局数据。 */
export function prepareAssistantAvatarManifest(value: unknown, pack: AssistantAvatarResourcePack): string {
  if (!isRecord(value) || value.Version !== 3 || !isRecord(value.FileReferences)) throw new TypeError('预设模型清单无效')
  const refs = value.FileReferences
  const motions = isRecord(refs.Motions) ? refs.Motions : {}
  const groups = new Set(Object.values(pack.motionGroups))
  const allowed = new Set(pack.files.map((file) => file.path))
  const selected = Object.fromEntries(Object.entries(motions).filter(([group]) => groups.has(group)))
  if (!Array.isArray(refs.Textures) || refs.Textures.length === 0 || Object.keys(selected).length !== groups.size) throw new TypeError('预设模型资源不完整')
  if (typeof refs.Moc !== 'string' || !allowed.has(refs.Moc)
    || refs.Textures.some((file) => typeof file !== 'string' || !allowed.has(file))) throw new TypeError('预设引用了未登记的资源')
  const files: unknown[] = [refs.Moc, ...refs.Textures, refs.Physics, refs.Pose, refs.UserData, refs.DisplayInfo]
  for (const entries of Object.values(selected)) {
    if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('预设动作组无效')
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.File !== 'string' || !allowed.has(entry.File)) throw new TypeError('预设动作无效')
      files.push(entry.File)
    }
  }
  if (files.some((file) => file !== undefined && file !== '' && (typeof file !== 'string' || !allowed.has(file)))) throw new TypeError('预设引用了未登记的资源')
  return JSON.stringify({ ...value, FileReferences: { ...refs, Expressions: [], Motions: selected } })
}

/**
 * 固定白名单、按需下载、并发去重和有界内存缓存。
 * 每个路径与最大体积均由源码固定，不能通过 query 或文件名代理任意 URL。
 */
function createAssetStore(fetchRemote: typeof fetch) {
  const generation = randomUUID()
  const cache = new Map<string, { task: Promise<Uint8Array>; ready: boolean }>()
  const downloads = new Map<string, number>()
  const read = (path: string): Promise<Uint8Array> => {
    const previous = cache.get(path)
    if (previous !== undefined) return previous.task
    const { pack, file } = entries.get(path)!
    if (file.preload !== false) downloads.set(pack.basePath, (downloads.get(pack.basePath) ?? 0) + 1)
    const task = (async () => {
      const response = await fetchRemote(pack.upstreamRoot + file.path, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`avatar_asset_http_${response.status}`) }
      if (Number(response.headers.get('content-length')) > file.maxBytes) { await response.body?.cancel(); throw new Error('avatar_asset_too_large') }
      const bytes = await readBounded(response, file.maxBytes)
      if (file.path !== pack.manifest) return bytes
      const source = prepareAssistantAvatarManifest(JSON.parse(new TextDecoder().decode(bytes)), pack)
      // 先返回精简清单，依赖同时在 Host 下载；引擎随后分阶段读取时命中同一请求或缓存。
      for (const dependency of pack.files) {
        if (dependency.path !== pack.manifest && dependency.preload !== false) void read(pack.basePath + dependency.path).catch(() => undefined)
      }
      return new TextEncoder().encode(source)
    })()
    const entry = { task, ready: false }
    cache.set(path, entry)
    void task.then(() => { entry.ready = true }, () => { if (cache.get(path) === entry) cache.delete(path) })
    return task
  }
  const status = (pack: AssistantAvatarResourcePack): AssistantAvatarCacheStatus => {
    const files = pack.files.filter((file) => file.preload !== false)
    const states = files.map((file) => cache.get(pack.basePath + file.path))
    return { version: 1, generation, pack: pack.basePath, total: files.length,
      cached: states.filter((entry) => entry?.ready).length, pending: states.filter((entry) => entry !== undefined && !entry.ready).length,
      downloads: downloads.get(pack.basePath) ?? 0 }
  }
  return { read, status, lookup: (path: string) => cache.get(path) }
}

const entries = new Map(ASSISTANT_AVATAR_RESOURCE_PACKS.flatMap((pack) => pack.files.map((file) => [pack.basePath + file.path, { pack, file }] as const)))
const statusPacks = new Map(ASSISTANT_AVATAR_RESOURCE_PACKS.map((pack) => [assistantAvatarCacheStatusPath(pack), pack]))
// 路由停用再登记只更换 Handler，不丢成功素材；仍由固定白名单限制体积，不写磁盘。
const sharedStore = createAssetStore((...args) => fetch(...args))

/** 注入下载器的测试独立缓存；生产入口复用同一模块生命周期内的素材。 */
export function createAssistantAvatarAssetHandler(fetchRemote?: typeof fetch): (request: Request) => Promise<Response> {
  const store = fetchRemote === undefined ? sharedStore : createAssetStore(fetchRemote)
  return async (request) => {
    const path = new URL(request.url).pathname
    const entry = entries.get(path)
    const pack = statusPacks.get(path)
    if (entry === undefined && pack === undefined) return new Response(null, { status: 404 })
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    // 诊断读取永远不会获取素材；不能用浏览器缓存返回的旧快照冒充实时状态。
    if (pack !== undefined) return Response.json(store.status(pack), { headers: { 'Cache-Control': 'no-store' } })
    const previous = store.lookup(path)
    const cacheState = previous === undefined ? 'miss' : previous.ready ? 'hit' : 'shared'
    try {
      const bytes = await store.read(path)
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': entry!.file.contentType,
        'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'X-CodingNS-Avatar-Cache': cacheState } })
    } catch { return Response.json({ error: 'avatar_asset_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
  }
}

/** 流式限额读取，不让上游异常响应突破固定缓存预算。 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('avatar_asset_empty')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new Error('avatar_asset_too_large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  if (size === 0) throw new Error('avatar_asset_empty')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
