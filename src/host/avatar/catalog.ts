import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { BUILTIN_ASSISTANT_AVATAR_ADAPTERS } from '../../shared/assistant-avatar-adapters.js'
import { ASSISTANT_AVATAR_CATALOG_PREVIEW_PATH } from '../../shared/assistant-avatar-catalog.js'
import type { AssistantAvatarCatalogEntry } from '../../shared/assistant-avatar-catalog.js'
import { AssistantAvatarRemote, remoteUrl } from './remote.js'
import type { AssistantAvatarPackages } from './packages.js'

interface CatalogRecord {
  readonly entry: AssistantAvatarCatalogEntry
  readonly manifest: unknown
  readonly manifestUrl: string
  readonly previewUrl?: string
}
type ReadCatalogFile = (path: string) => Promise<string>
const previewLimit = 1024 * 1024

/** 随包只保存索引和安装清单；选中记录后才请求预览，安装确认后才请求素材。 */
export class AssistantAvatarCatalog {
  private records: Promise<readonly CatalogRecord[]> | undefined
  private readonly previews = new Map<string, { bytes: Uint8Array; contentType: string }>()
  constructor(private readonly read: ReadCatalogFile = readCatalogFile, private readonly remote = new AssistantAvatarRemote()) {}

  async list(): Promise<readonly AssistantAvatarCatalogEntry[]> { return (await this.load()).map(({ entry }) => entry) }

  async install(id: string, revision: string, packages: AssistantAvatarPackages, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const record = await this.find(id, revision)
    return packages.installManifest(record.manifest, record.manifestUrl, 'codingns-pack', signal)
  }

  /** 固定白名单路径，不接受浏览器传入外部 URL；也不返回整张动作图集作为预览。 */
  async preview(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== ASSISTANT_AVATAR_CATALOG_PREVIEW_PATH) return new Response(null, { status: 404 })
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    const record = await this.find(url.searchParams.get('id') ?? '', url.searchParams.get('revision') ?? '')
    if (record.previewUrl === undefined) return new Response(null, { status: 404 })
    const key = `${record.entry.id}:${record.entry.revision}`
    let preview = this.previews.get(key)
    if (preview === undefined) {
      const { bytes } = await this.remote.read(record.previewUrl, previewLimit, request.signal)
      const contentType = previewContentType(bytes)
      request.signal.throwIfAborted()
      preview = { bytes, contentType }
      // 上限八张小图，既避免反复切换下载，也不长期积累整个目录的图片。
      if (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!)
      this.previews.set(key, preview)
    }
    return new Response(new Uint8Array(preview.bytes), { headers: { 'Content-Type': preview.contentType,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  }

  private async find(id: string, revision: string): Promise<CatalogRecord> {
    const record = (await this.load()).find(({ entry }) => entry.id === id && entry.revision === revision)
    if (record === undefined) throw new TypeError('形象目录记录已变更，请重新选择')
    return record
  }
  private load(): Promise<readonly CatalogRecord[]> {
    this.records ??= this.readRecords().catch((error) => { this.records = undefined; throw error })
    return this.records
  }
  private async readRecords(): Promise<readonly CatalogRecord[]> {
    const value = parseJson(await this.read('avatar-packages/catalog.json')) as { catalogVersion?: unknown; packages?: unknown }
    if (value?.catalogVersion !== 1 || !Array.isArray(value.packages) || value.packages.length > 100) throw new TypeError('形象目录格式无效')
    const ids = new Set<string>()
    const native = BUILTIN_ASSISTANT_AVATAR_ADAPTERS.find((adapter) => adapter.id === 'codingns-pack')!
    return Promise.all(value.packages.map(async (item: Record<string, unknown>, index): Promise<CatalogRecord> => {
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(item.id)
        || ids.has(item.id) || item.number !== index + 1 || typeof item.revision !== 'string' || !/^[a-f0-9]{40}$/u.test(item.revision)) throw new TypeError('形象目录身份无效')
      ids.add(item.id)
      const manifest = parseJson(await this.read(`avatar-packages/manifests/${item.id}.avatar.json`))
      const manifestUrl = publicUrl(item.installManifestUrl)
      const model = native.parse(manifest, { manifestUrl })
      const name = label(item.name, 80)
      const author = label(item.author, 500)
      if (model.id !== `catalog-${item.id}` || model.name !== name || model.package?.author !== author || !model.package.license || !model.package.homepage) throw new TypeError('形象清单与目录不一致')
      const repositoryUrl = publicUrl(item.repositoryUrl)
      const repository = new URL(repositoryUrl)
      const pinnedSource = `https://raw.githubusercontent.com${repository.pathname}/${item.revision}/`
      if (repository.origin !== 'https://github.com' || !model.source.startsWith(pinnedSource)) throw new TypeError('形象素材未固定到目录版本')
      const stats = item.verification as { files?: number; bytes?: number } | undefined
      if (!Number.isSafeInteger(stats?.files) || stats!.files! < 1 || !Number.isSafeInteger(stats?.bytes) || stats!.bytes! < 1) throw new TypeError('形象目录大小无效')
      const previewUrl = item.previewUrl === undefined ? undefined : publicUrl(item.previewUrl)
      return { manifest, manifestUrl, ...(previewUrl === undefined ? {} : { previewUrl }), entry: Object.freeze({
        id: item.id, number: index + 1, name, author, description: label(item.description, 1000), remarks: label(item.remarks, 2000),
        repositoryUrl, licenseUrl: publicUrl(item.licenseUrl), license: model.package.license, homepage: model.package.homepage,
        format: label(item.format, 80), revision: item.revision, bytes: stats!.bytes!, files: stats!.files!, previewAvailable: previewUrl !== undefined,
      }) }
    }))
  }
}
async function readCatalogFile(path: string): Promise<string> {
  const root = dirname(createRequire(import.meta.url).resolve('@jingyi0605/codingns4dsh/package.json'))
  return readFile(join(root, path), 'utf8')
}
function parseJson(text: string): unknown {
  if (text.length > 256 * 1024) throw new TypeError('形象目录清单过大')
  return JSON.parse(text) as unknown
}
function label(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError('形象目录文字无效')
  return value
}
function publicUrl(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('形象目录地址无效')
  return remoteUrl(value).href
}
function previewContentType(bytes: Uint8Array): string {
  const signature = Buffer.from(bytes.subarray(0, 12))
  if (signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (signature.subarray(0, 4).toString() === 'RIFF' && signature.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  if (signature[0] === 255 && signature[1] === 216 && signature[2] === 255) return 'image/jpeg'
  throw new TypeError('形象预览必须为 PNG、WebP 或 JPEG 图片')
}
