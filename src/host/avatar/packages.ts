import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { BUILTIN_ASSISTANT_AVATAR_ADAPTERS } from '../../shared/assistant-avatar-adapters.js'
import type { AssistantAvatarAdapter } from '../../shared/assistant-avatar-adapters.js'
import { copyAssistantAvatarModel, validateAssistantAvatarModel } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { ASSISTANT_AVATAR_ASSET_PATH, ASSISTANT_AVATAR_STATUS_PATH } from '../../shared/assistant-avatar-installation.js'
import type { AssistantAvatarInstallation } from '../../shared/assistant-avatar-installation.js'
import { AssistantAvatarRemote } from './remote.js'
import { discoverAssistantAvatarSource, BUILTIN_ASSISTANT_AVATAR_SOURCE_ADAPTERS } from './sources.js'
import type { AssistantAvatarSourceAdapter } from './sources.js'
import { installAssistantAvatarMaterials, BUILTIN_ASSISTANT_AVATAR_MATERIAL_ADAPTERS } from './materials.js'
import type { AssistantAvatarMaterialAdapter } from './materials.js'
import { AssistantAvatarRegistration } from '../../shared/assistant-avatar-registration.js'

interface PackageRecord {
  readonly version: 1
  readonly id: string
  readonly model: AssistantAvatarModel
  readonly files: readonly { readonly key: string; readonly contentType: string; readonly bytes: number }[]
}
/** 自有素材目录，不复用 DSH 插件安装目录、源码或 Desktop Profile。 */
export function assistantAvatarPackageDirectory(): string {
  return join(process.env.CODINGNS4DSH_STATE_DIR?.trim() || join(homedir(), '.config', 'codingns4dsh'), 'assistant-avatar-packages')
}

/** 原子安装的素材仓库；目录中的有效 record.json 是唯一完成标记。 */
export class AssistantAvatarPackages {
  private readonly generation = randomUUID()
  private readonly records = new Map<string, PackageRecord>()
  private writes: Promise<unknown> = Promise.resolve()
  readonly formats: AssistantAvatarRegistration<AssistantAvatarAdapter>
  readonly sources: AssistantAvatarRegistration<AssistantAvatarSourceAdapter>
  readonly materials: AssistantAvatarRegistration<AssistantAvatarMaterialAdapter>
  constructor(readonly directory = assistantAvatarPackageDirectory(),
    private readonly remote = new AssistantAvatarRemote(),
    formats: readonly AssistantAvatarAdapter[] = BUILTIN_ASSISTANT_AVATAR_ADAPTERS,
    sources: readonly AssistantAvatarSourceAdapter[] = BUILTIN_ASSISTANT_AVATAR_SOURCE_ADAPTERS,
    materials: readonly AssistantAvatarMaterialAdapter[] = BUILTIN_ASSISTANT_AVATAR_MATERIAL_ADAPTERS) {
    this.formats = new AssistantAvatarRegistration(formats)
    this.sources = new AssistantAvatarRegistration(sources)
    this.materials = new AssistantAvatarRegistration(materials)
  }

  discover(source: string, signal?: AbortSignal) { return discoverAssistantAvatarSource(source, this.remote, signal, this.sources.getSnapshot()) }
  async install(source: string, adapterId = 'auto', signal?: AbortSignal): Promise<AssistantAvatarInstallation> {
    signal?.throwIfAborted()
    let model: AssistantAvatarModel
    if (/\.(png|webp|jpe?g|gif)$/iu.test(new URL(source).pathname)) {
      const id = createHash('sha256').update(source).digest('hex').slice(0, 16)
      model = { id: `image-${id}`, name: decodeURIComponent(new URL(source).pathname.split('/').pop() || '形象').slice(0, 80),
        renderer: 'image', source, spriteVersion: 2, package: { adapterId: 'codingns-pack', manifestUrl: source } }
    } else {
      const manifest = await this.remote.json(source, signal)
      return this.installManifest(manifest.value, manifest.url, adapterId, signal)
    }
    return this.installModel(model, signal)
  }
  /** 受控目录复用同一适配器和原子安装流程，不依赖尚未发布的 GitHub 清单 URL。 */
  installManifest(value: unknown, manifestUrl: string, adapterId = 'auto', signal?: AbortSignal): Promise<AssistantAvatarInstallation> {
    signal?.throwIfAborted()
    const adapter = adapterId === 'auto' ? this.formats.getSnapshot().find((item) => item.matches(value)) : this.formats.get(adapterId)
    if (adapter === undefined || !adapter.matches(value)) throw new TypeError('无法识别形象包，或所选适配器未注册')
    const parsed = adapter.parse(value, { manifestUrl })
    const model = copyAssistantAvatarModel({ ...parsed, package: { ...parsed.package, adapterId: adapter.id, manifestUrl } })
    return this.installModel(model, signal)
  }
  private async installModel(model: AssistantAvatarModel, signal?: AbortSignal): Promise<AssistantAvatarInstallation> {
    validateAssistantAvatarModel(model)
    const installed = await installAssistantAvatarMaterials(model, this.remote, signal, this.materials.getSnapshot())
    return this.commit(installed, signal)
  }
  /** 临时预览采用时复制已验证完整素材，不再请求上游，也不搬走正在绘制的文件。 */
  async copyFrom(source: AssistantAvatarPackages, id: string, signal?: AbortSignal): Promise<AssistantAvatarInstallation> {
    signal?.throwIfAborted()
    const record = await source.record(id)
    if (record === undefined) throw new TypeError('临时形象素材已清理，请重新预览')
    const materials = await Promise.all(record.files.map(async (file) => {
      const bytes = await readFile(join(source.directory, id, file.key))
      if (bytes.byteLength !== file.bytes) throw new TypeError('临时形象素材不完整')
      return { key: file.key, contentType: file.contentType, bytes }
    }))
    return this.commit({ id, model: record.model, materials }, signal)
  }
  private commit(installed: Awaited<ReturnType<typeof installAssistantAvatarMaterials>>, signal?: AbortSignal): Promise<AssistantAvatarInstallation> {
    // 只有素材完整且未取消才写入；与删除串行，避免旧安装结果复活已卸载记录。
    return this.mutate(async () => {
      signal?.throwIfAborted()
      const previous = await this.record(installed.id)
      if (previous !== undefined) return summary(previous, false)
      await mkdir(this.directory, { recursive: true })
      const staging = join(this.directory, `.install-${randomUUID()}`)
      await mkdir(staging)
      try {
        for (const material of installed.materials) {
          signal?.throwIfAborted()
          await writeFile(join(staging, material.key), material.bytes, { flag: 'wx' })
        }
        const record: PackageRecord = { version: 1, id: installed.id, model: installed.model,
          files: installed.materials.map(({ key, contentType, bytes }) => ({ key, contentType, bytes: bytes.byteLength })) }
        await writeFile(join(staging, 'record.json'), JSON.stringify(record), { flag: 'wx' })
        signal?.throwIfAborted()
        await rename(staging, join(this.directory, record.id))
        this.records.set(record.id, record)
        return summary(record, true)
      } finally { await rm(staging, { recursive: true, force: true }) }
    })
  }
  async list(): Promise<readonly AssistantAvatarInstallation[]> {
    let names: string[]
    try { names = await readdir(this.directory) } catch (error) { if (missing(error)) return []; throw error }
    const records = await Promise.all(names.filter(validPackId).map((name) => this.record(name)))
    return records.filter((value) => value !== undefined).map((record) => summary(record, false))
  }
  remove(id: string): Promise<void> {
    if (!validPackId(id)) throw new TypeError('形象安装版本无效')
    return this.mutate(async () => {
      await rm(join(this.directory, id), { recursive: true, force: true })
      this.records.delete(id)
    })
  }
  readonly handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (![ASSISTANT_AVATAR_ASSET_PATH, ASSISTANT_AVATAR_STATUS_PATH].includes(url.pathname)) return new Response(null, { status: 404 })
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    const id = url.searchParams.get('pack') ?? ''
    const record = await this.record(id)
    if (record === undefined) return new Response(null, { status: 404 })
    if (url.pathname === ASSISTANT_AVATAR_STATUS_PATH) {
      const present = await Promise.all(record.files.map(async (file) => {
        try { const info = await stat(join(this.directory, id, file.key)); return info.isFile() && info.size === file.bytes } catch { return false }
      }))
      return Response.json({ version: 1, generation: this.generation, pack: id, total: record.files.length,
        cached: present.filter(Boolean).length, pending: 0, downloads: 0 }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const file = record.files.find((entry) => entry.key === url.searchParams.get('file'))
    if (file === undefined) return new Response(null, { status: 404 })
    try {
      const bytes = await readFile(join(this.directory, id, file.key))
      if (bytes.byteLength !== file.bytes) throw new Error('avatar_local_resource_changed')
      return new Response(bytes, { headers: { 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff', 'X-CodingNS-Avatar-Cache': 'disk' } })
    } catch { return Response.json({ error: 'avatar_local_resource_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
  }
  private async record(id: string): Promise<PackageRecord | undefined> {
    if (!validPackId(id)) return undefined
    const cached = this.records.get(id)
    if (cached !== undefined) return cached
    try {
      const bytes = await readFile(join(this.directory, id, 'record.json'))
      if (bytes.byteLength > 256 * 1024) return undefined
      const record = JSON.parse(bytes.toString('utf8')) as PackageRecord
      if (record.version !== 1 || record.id !== id || record.model?.package?.installationId !== id || !Array.isArray(record.files)
        || record.files.length === 0 || record.files.length > 256 || record.files.some((file) => !/^[a-f0-9]{64}\.[a-z0-9.]+$/u.test(file.key)
          || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 32 * 1024 * 1024
          || !['application/json', 'application/octet-stream', 'image/png', 'image/webp', 'image/jpeg', 'image/gif', 'audio/wav', 'audio/mpeg', 'audio/ogg'].includes(file.contentType))) return undefined
      validateAssistantAvatarModel(record.model)
      this.records.set(id, record)
      return record
    } catch (error) { if (missing(error) || error instanceof SyntaxError || error instanceof TypeError) return undefined; throw error }
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const task = this.writes.then(action)
    this.writes = task.catch(() => undefined)
    return task
  }
}
function validPackId(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value) }
function missing(error: unknown): boolean { return (error as { code?: string })?.code === 'ENOENT' }
function summary(record: PackageRecord, created: boolean): AssistantAvatarInstallation {
  return { id: record.id, model: copyAssistantAvatarModel(record.model), created, files: record.files.length, bytes: record.files.reduce((total, file) => total + file.bytes, 0) }
}
