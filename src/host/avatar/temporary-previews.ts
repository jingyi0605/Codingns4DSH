import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSISTANT_AVATAR_ASSET_PATH } from '../../shared/assistant-avatar-installation.js'
import type { AssistantAvatarInstallation } from '../../shared/assistant-avatar-installation.js'
import { ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH } from '../../shared/assistant-avatar-catalog.js'
import type { AssistantAvatarTemporaryPreview } from '../../shared/assistant-avatar-catalog.js'
import type { AssistantAvatarCatalog } from './catalog.js'
import { AssistantAvatarPackages } from './packages.js'

interface PreviewLease {
  readonly id: string
  readonly revision: string
  readonly requestConsent: boolean
  readonly controller: AbortController
  readonly directory: Promise<string>
  readonly ready: Promise<AssistantAvatarInstallation>
  packages?: AssistantAvatarPackages
  expiresAt: number
}

/** 一次预览一个独立临时目录；正常释放立即清理，页面失联以心跳超时兜底。 */
export class AssistantAvatarTemporaryPreviews {
  private readonly leases = new Map<string, PreviewLease>()
  private readonly released = new Map<string, number>()
  private readonly cleaning = new Map<string, Promise<void>>()
  private stopped = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly catalog: AssistantAvatarCatalog,
    private readonly createPackages: (directory: string) => AssistantAvatarPackages = (directory) => new AssistantAvatarPackages(directory),
    private readonly root = tmpdir(), private readonly now = Date.now, private readonly ttl = 180_000) {
    this.timer = setInterval(() => { void this.reap().catch((error) => console.warn('[CodingNS] Temporary avatar cleanup failed', error)) }, 30_000)
    this.timer.unref()
  }

  async create(lease: string, id: string, revision: string, signal?: AbortSignal, requestConsent = false): Promise<AssistantAvatarTemporaryPreview> {
    validateLease(lease); signal?.throwIfAborted(); await this.reap()
    if (this.stopped || this.released.has(lease)) throw new TypeError('临时形象预览已取消')
    if (this.leases.has(lease) || this.leases.size >= 4) throw new TypeError('临时形象预览正在使用，请关闭其他预览后重试')
    const controller = new AbortController()
    const cancellation = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const directory = mkdtemp(join(this.root, 'codingns-avatar-preview-'))
    const entry: PreviewLease = { id, revision, requestConsent, controller, directory, expiresAt: this.now() + this.ttl,
      ready: directory.then((path) => {
        cancellation.throwIfAborted()
        entry.packages = this.createPackages(path)
        return this.catalog.install(id, revision, entry.packages, cancellation)
      }) }
    this.leases.set(lease, entry)
    try {
      const installed = await entry.ready
      cancellation.throwIfAborted()
      if (this.leases.get(lease) !== entry) throw new TypeError('临时形象预览已取消')
      const model = JSON.parse(JSON.stringify(installed.model).replaceAll(`${ASSISTANT_AVATAR_ASSET_PATH}?`, `${ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH}?lease=${lease}&`))
      return { lease, model: { ...model, id: `preview-${lease}` } }
    } catch (error) { await this.release(lease); throw error }
  }

  /** 请求内的协议只覆盖该预览，释放或超时后不能继续读取素材。 */
  hasRequestConsent(lease: string): boolean {
    const entry = this.leases.get(lease)
    return entry?.requestConsent === true && entry.expiresAt > this.now()
  }

  touch(lease: string): void {
    validateLease(lease)
    const entry = this.leases.get(lease)
    if (entry === undefined || entry.expiresAt <= this.now()) throw new TypeError('临时形象预览已过期，请重新预览')
    entry.expiresAt = this.now() + this.ttl
  }
  async install(lease: string, id: string, revision: string, packages: AssistantAvatarPackages, signal?: AbortSignal) {
    this.touch(lease)
    const entry = this.leases.get(lease)!
    if (entry.id !== id || entry.revision !== revision) throw new TypeError('临时预览与所选形象不一致')
    const installed = await entry.ready
    signal?.throwIfAborted()
    if (entry.packages === undefined || this.leases.get(lease) !== entry) throw new TypeError('临时形象预览已取消')
    return packages.copyFrom(entry.packages, installed.id, signal)
  }
  readonly handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname !== ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH) return new Response(null, { status: 404 })
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    const lease = url.searchParams.get('lease') ?? ''
    const entry = this.leases.get(lease)
    if (entry?.packages === undefined || entry.expiresAt <= this.now()) return new Response(null, { status: 404 })
    const installed = await entry.ready
    if (url.searchParams.get('pack') !== installed.id || this.leases.get(lease) !== entry) return new Response(null, { status: 404 })
    url.pathname = ASSISTANT_AVATAR_ASSET_PATH
    const response = await entry.packages.handle(new Request(url, { signal: request.signal }))
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store'); headers.set('X-CodingNS-Avatar-Cache', 'temporary')
    // Live2D 清单使用同目录相对引用，所有依赖都必须携带同一个临时租约。
    const body = headers.get('Content-Type') === 'application/json'
      ? (await response.text()).replaceAll('assistant-avatar-assets?', `assistant-avatar-temporary-assets?lease=${lease}&`)
      : await response.arrayBuffer()
    return new Response(body, { status: response.status, headers })
  }

  release(lease: string): Promise<void> {
    validateLease(lease)
    // 保留短期取消标记，阻止取消请求先到、创建请求迟到时重新生成临时目录。
    this.released.set(lease, this.now() + this.ttl)
    const entry = this.leases.get(lease)
    if (entry === undefined) return this.cleaning.get(lease) ?? Promise.resolve()
    this.leases.delete(lease); entry.controller.abort()
    const cleanup = (async () => {
      await entry.ready.catch(() => undefined)
      const directory = await entry.directory.catch(() => undefined)
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    })()
    this.cleaning.set(lease, cleanup)
    void cleanup.finally(() => this.cleaning.delete(lease)).catch(() => undefined)
    return cleanup
  }
  async reap(): Promise<void> {
    const now = this.now()
    for (const [lease, expires] of this.released) if (expires <= now) this.released.delete(lease)
    await Promise.all([...this.leases].filter(([, entry]) => entry.expiresAt <= now).map(([lease]) => this.release(lease)))
  }
  async dispose(): Promise<void> {
    this.stopped = true; clearInterval(this.timer)
    await Promise.all([...this.leases.keys()].map((lease) => this.release(lease)))
    await Promise.all(this.cleaning.values())
    this.released.clear()
  }
}
function validateLease(value: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)) throw new TypeError('临时形象预览标识无效')
}
