import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ASSISTANT_AVATAR_RUNTIME_PATH, BUILTIN_ASSISTANT_AVATAR_SOURCES } from '../../shared/assistant-avatar.js'
import { createAssistantAvatarBasicHandler } from './assistant-avatar-basics.js'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsHostServices } from './types.js'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { ASSISTANT_AVATAR_RESOURCE_PACKS, assistantAvatarCacheStatusPath } from '../../shared/assistant-avatar-legacy-resources.js'
import { getAssistantAvatarPreset } from '../../shared/assistant-avatar-legacy.js'
import { createAssistantAvatarAssetHandler } from './assistant-avatar-legacy-assets.js'
import { AssistantAvatarPackages } from '../avatar/packages.js'
import { ASSISTANT_AVATAR_ASSET_PATH, ASSISTANT_AVATAR_STATUS_PATH } from '../../shared/assistant-avatar-installation.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { getAssistantAvatarPackages } from '../avatar/registry.js'
import { AssistantAvatarCatalog } from '../avatar/catalog.js'
import { assistantAvatarEngineInstalled, installAssistantAvatarEngine, readAssistantAvatarEngine } from '../avatar/engine.js'
import { ASSISTANT_AVATAR_ENGINE_VERSION, hasAssistantAvatarEngineConsent, invalidateAssistantAvatarRuntime, assistantAvatarRuntimeRevision } from '../../shared/assistant-avatar-engine.js'
import type { AssistantAvatarEngineStatus } from '../../shared/assistant-avatar-engine.js'
import { ASSISTANT_AVATAR_CATALOG_PREVIEW_PATH, ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH, hasAssistantAvatarConsent } from '../../shared/assistant-avatar-catalog.js'
import { AssistantAvatarTemporaryPreviews } from '../avatar/temporary-previews.js'

/** 原生 Fetch 路由逐项登记固定路径，停用后全部注销；不开放通用资源代理。 */
export function registerAssistantAvatarRoutes(registry: HostConnectionFetch, handler: (request: Request) => Promise<Response>, legacy = false): () => Promise<void> {
  const paths = [ASSISTANT_AVATAR_RUNTIME_PATH, ASSISTANT_AVATAR_ASSET_PATH, ASSISTANT_AVATAR_STATUS_PATH,
    ASSISTANT_AVATAR_CATALOG_PREVIEW_PATH, ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH,
    ...Object.values(BUILTIN_ASSISTANT_AVATAR_SOURCES),
    ...(legacy ? ASSISTANT_AVATAR_RESOURCE_PACKS.flatMap((pack) => [assistantAvatarCacheStatusPath(pack), ...pack.files.map((file) => pack.basePath + file.path)]) : [])]
  const disposers: (() => Promise<void>)[] = []
  const dispose = async (): Promise<void> => {
    const results = await Promise.allSettled(disposers.splice(0).reverse().map((release) => Promise.resolve().then(release)))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  try {
    for (const path of paths) disposers.push(registry.register({ path, methods: ['GET'], requestBody: 'buffered', fetch: handler }))
  } catch (error) { void dispose().catch(() => undefined); throw error }
  return dispose
}

export function createAssistantAvatarRouteHandler(packages = new AssistantAvatarPackages(), legacy = false,
  preview?: (request: Request) => Promise<Response>, temporary?: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  const runtime = createAssistantAvatarRuntimeHandler()
  const basics = createAssistantAvatarBasicHandler()
  const assets = createAssistantAvatarAssetHandler()
  return (request) => {
    const path = new URL(request.url).pathname
    if (path === ASSISTANT_AVATAR_RUNTIME_PATH) return runtime(request)
    if (path === ASSISTANT_AVATAR_CATALOG_PREVIEW_PATH) return preview?.(request) ?? Promise.resolve(new Response(null, { status: 403 }))
    if (path === ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH) return temporary?.(request) ?? Promise.resolve(new Response(null, { status: 403 }))
    if (Object.values(BUILTIN_ASSISTANT_AVATAR_SOURCES).includes(path)) return basics(request)
    return path === ASSISTANT_AVATAR_ASSET_PATH || path === ASSISTANT_AVATAR_STATUS_PATH ? packages.handle(request)
      : legacy ? assets(request) : Promise.resolve(new Response(null, { status: 404 }))
  }
}

/** 只返回固定依赖文件，不提供任意路径读取或外部脚本代理。 */
export function createAssistantAvatarRuntimeHandler(readRuntime: () => Promise<string> = readInstalledRuntime): (request: Request) => Promise<Response> {
  let source: Promise<string> | undefined
  let retryAt = 0
  let revision = assistantAvatarRuntimeRevision()
  return async (request) => {
    if (new URL(request.url).pathname !== ASSISTANT_AVATAR_RUNTIME_PATH) return new Response(null, { status: 404 })
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    if (revision !== assistantAvatarRuntimeRevision()) {
      revision = assistantAvatarRuntimeRevision(); source = undefined; retryAt = 0
    }
    if (Date.now() < retryAt) return Response.json({ error: 'avatar_runtime_unavailable' }, { status: 503, headers: { 'Retry-After': '30', 'Cache-Control': 'no-store' } })
    const requestRevision = revision
    let pending: Promise<string> | undefined
    try {
      pending = source ??= readRuntime()
      return new Response(await pending, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } })
    } catch {
      if (source === pending && revision === requestRevision) {
        source = undefined
        retryAt = Date.now() + 30_000
      }
      return Response.json({ error: 'avatar_runtime_unavailable' }, { status: 503, headers: { 'Retry-After': '30', 'Cache-Control': 'no-store' } })
    }
  }
}

async function readInstalledRuntime(): Promise<string> {
  // 用户确认引擎许可后由 Host 安装到自有目录，优先使用该完整副本。
  const managed = await readAssistantAvatarEngine()
  if (managed !== undefined) return managed
  const require = createRequire(import.meta.url)
  // 源码开发依赖或目标 Host 的独立安装提供引擎；此处只解析已有依赖，不安装或下载代码。
  const root = dirname(require.resolve('l2d/package.json'))
  // index.min.js 是全局 IIFE，不能通过 import 获得 init；使用真正的 ESM 文件。
  return readFile(join(root, 'dist', 'index.js'), 'utf8')
}

/** 自有目录优先，其次源码开发或用户手工安装的依赖；两者都没有才算缺失。 */
export async function readAssistantAvatarEngineStatus(): Promise<AssistantAvatarEngineStatus> {
  if (await assistantAvatarEngineInstalled()) return { installed: true, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: 'managed' }
  try {
    const require = createRequire(import.meta.url)
    const root = dirname(require.resolve('l2d/package.json'))
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    const source = await readFile(join(root, 'dist', 'index.js'), 'utf8')
    if (source.length > 0) return { installed: true,
      version: typeof manifest.version === 'string' ? manifest.version : ASSISTANT_AVATAR_ENGINE_VERSION, source: 'dependency' }
  } catch { /* 缺失、接口异常或损坏的依赖都按未安装处理。 */ }
  return { installed: false, version: ASSISTANT_AVATAR_ENGINE_VERSION, source: 'missing' }
}

export function createAssistantAvatarRuntimeFeature(options: { readonly packages?: AssistantAvatarPackages; readonly catalog?: AssistantAvatarCatalog; readonly temporary?: AssistantAvatarTemporaryPreviews } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: { name: 'assistantAvatarRuntime', version: '0.1.0', enabledByDefault: true, dependencies: [], runtime: 'host' },
    start(context) {
      const packages = options.packages ?? getAssistantAvatarPackages(context.services)
      const catalog = options.catalog ?? new AssistantAvatarCatalog()
      const temporary = options.temporary ?? new AssistantAvatarTemporaryPreviews(catalog)
      const requireConsent = (requested?: unknown): void => {
        // 草稿中的明确同意只授权本次请求；旧客户端继续使用已保存的协议记录。
        const consent = requested === undefined ? context.services.settings?.get().assistant.appearance?.thirdPartyConsent : requested
        if (!hasAssistantAvatarConsent(consent)) {
          throw new CodingNsRpcError('CODINGNS_AVATAR_CONSENT_REQUIRED', '请先同意第三方形象使用说明')
        }
      }
      const requireEngineConsent = (requested?: unknown): void => {
        // 请求中的明确同意只授权本次安装；未携带时兼容旧客户端已保存的许可。
        const consent = requested === undefined ? context.services.settings?.get().assistant.appearance?.engineConsent : requested
        if (!hasAssistantAvatarEngineConsent(consent)) {
          throw new CodingNsRpcError('CODINGNS_AVATAR_ENGINE_CONSENT_REQUIRED', '请先确认 Live2D 引擎许可')
        }
      }
      const lifetime = new AbortController()
      context.resources.add(() => lifetime.abort())
      context.resources.add(() => temporary.dispose())
      if (context.services.rpc !== undefined) context.resources.add(context.services.rpc.register('avatar', async (action, payload, rpcContext) => {
        const input = payload as { source?: unknown; adapterId?: unknown; id?: unknown; revision?: unknown; licenseAccepted?: unknown; lease?: unknown; engineConsent?: unknown; thirdPartyConsent?: unknown }
        const requestedSignal = (rpcContext as { signal?: AbortSignal } | undefined)?.signal
        const signal = requestedSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, requestedSignal])
        if (action === 'list') return packages.list()
        // 只读探测：未安装时客户端据此决定是否弹出引擎许可确认。
        if (action === 'engineStatus') return readAssistantAvatarEngineStatus()
        if (action === 'catalog') { requireConsent(input?.thirdPartyConsent); return catalog.list() }
        // 撤销协议或连接变为只读后，清理接口仍必须可用。
        if (action === 'releasePreview' && typeof input?.lease === 'string') return temporary.release(input.lease)
        if (action === 'keepPreview' && typeof input?.lease === 'string') { requireConsent(input.thirdPartyConsent); return temporary.touch(input.lease) }
        // 与原设置写入边界一致，远端只读连接不能借安装接口写入磁盘。
        if (context.services.settingsProvider?.writable === false) throw new CodingNsRpcError('CODINGNS_SETTINGS_READONLY', '当前形象设置为只读')
        // 引擎下载写入 CodingNS 自有目录，不修改 DSH Profile 或插件依赖树。
        if (action === 'installEngine') {
          requireEngineConsent(input?.engineConsent)
          await installAssistantAvatarEngine({ signal })
          invalidateAssistantAvatarRuntime()
          return readAssistantAvatarEngineStatus()
        }
        if (action === 'previewCatalog') {
          requireConsent(input?.thirdPartyConsent)
          if (typeof input?.id !== 'string' || typeof input.revision !== 'string' || typeof input.lease !== 'string') throw new TypeError('临时形象预览参数无效')
          const preview = await temporary.create(input.lease, input.id, input.revision, signal, hasAssistantAvatarConsent(input.thirdPartyConsent))
          try { requireConsent(input.thirdPartyConsent); signal.throwIfAborted(); return preview }
          catch (error) { await temporary.release(input.lease); throw error }
        }
        if (action === 'installCatalog') {
          requireConsent(input?.thirdPartyConsent)
          if (input?.licenseAccepted !== true || typeof input.id !== 'string' || typeof input.revision !== 'string') throw new TypeError('请确认所选形象的许可及应用')
          if (input.lease !== undefined && typeof input.lease !== 'string') throw new TypeError('临时形象预览标识无效')
          const installed = input.lease === undefined ? await catalog.install(input.id, input.revision, packages, signal)
            : await temporary.install(input.lease, input.id, input.revision, packages, signal)
          try { requireConsent(input.thirdPartyConsent); signal.throwIfAborted(); return installed }
          catch (error) {
            if (installed.created && !context.services.settings?.get().assistant.appearance?.models.some((model) => model.package?.installationId === installed.id)) await packages.remove(installed.id)
            throw error
          }
        }
        if (action === 'remove' && typeof input?.id === 'string') {
          if (context.services.settings?.get().assistant.appearance?.models.some((model) => model.package?.installationId === input.id)) throw new TypeError('形象素材仍被已登记角色使用，请先移除对应角色')
          return packages.remove(input.id)
        }
        if (typeof input?.source !== 'string' || input.source.length > 4096) throw new TypeError('形象安装地址无效')
        if (action === 'discover') return packages.discover(input.source, signal)
        if (action === 'install') return packages.install(input.source, typeof input.adapterId === 'string' ? input.adapterId : 'auto', signal)
        throw new TypeError('未知形象管理操作')
      }))
      const register = context.services.registerAssistantAvatarRuntimeRoute
      const appearance = context.services.settings?.get().assistant.appearance
      const legacy = appearance !== undefined && ((getAssistantAvatarPreset(appearance.selectedId) !== undefined && !appearance.models.some((model) => model.id === appearance.selectedId))
        || appearance.models.some((model) => ASSISTANT_AVATAR_RESOURCE_PACKS.some((pack) => model.source.startsWith(pack.basePath))))
      const preview = async (request: Request): Promise<Response> => {
        try {
          requireConsent()
          const response = await catalog.preview(request)
          requireConsent()
          return response
        } catch (error) {
          const status = error instanceof CodingNsRpcError ? 403 : error instanceof TypeError ? 404 : 503
          return Response.json({ error: 'avatar_catalog_preview_unavailable' }, { status, headers: { 'Cache-Control': 'no-store' } })
        }
      }
      const temporaryAssets = async (request: Request): Promise<Response> => {
        // 草稿预览的同意绑定在租约上，不要求为浏览素材提前写入正式配置。
        const requirePreviewConsent = (): void => {
          if (!temporary.hasRequestConsent(new URL(request.url).searchParams.get('lease') ?? '')) requireConsent()
        }
        try { requirePreviewConsent(); const response = await temporary.handle(request); requirePreviewConsent(); return response }
        catch (error) { return Response.json({ error: 'avatar_temporary_preview_unavailable' }, {
          status: error instanceof CodingNsRpcError ? 403 : 503, headers: { 'Cache-Control': 'no-store' },
        }) }
      }
      if (register !== undefined) context.resources.add(register(createAssistantAvatarRouteHandler(packages, legacy, preview, temporaryAssets), legacy))
    },
  }
}
