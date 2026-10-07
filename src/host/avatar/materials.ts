import { createHash } from 'node:crypto'
import type { AssistantAvatarAsset, AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { copyAssistantAvatarModel, validateAssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { assistantAvatarInstalledSource } from '../../shared/assistant-avatar-installation.js'
import { resolveAssistantAvatarSource } from '../../shared/assistant-avatar-adapters.js'
import { AssistantAvatarRemote } from './remote.js'

export interface AssistantAvatarMaterial { readonly key: string; readonly contentType: string; readonly bytes: Uint8Array }
export interface AssistantAvatarMaterialContext {
  readonly signal?: AbortSignal
  file(source: string, kind: 'image' | 'binary' | 'json' | 'sound' | 'motion'): Promise<string>
  model(source: string): Promise<string>
}
/** 渲染格式拥有自己的依赖解释器；安装器不识别角色、文件目录或插件名称。 */
export interface AssistantAvatarMaterialAdapter {
  readonly id: string
  supports(renderer: string): boolean
  install(asset: AssistantAvatarAsset, context: AssistantAvatarMaterialContext): Promise<AssistantAvatarAsset>
}
const image: AssistantAvatarMaterialAdapter = {
  id: 'image', supports: (renderer) => renderer === 'image' || renderer === 'spritesheet',
  async install(asset, context) {
    const source = await context.file(asset.source, 'image')
    const entries = await Promise.all(Object.entries(asset.stateSources ?? {}).map(async ([state, url]) => [state, await context.file(url, 'image')]))
    return { ...asset, source, ...(asset.stateSources === undefined ? {} : { stateSources: Object.fromEntries(entries) }) }
  },
}
const live2d: AssistantAvatarMaterialAdapter = {
  id: 'live2d', supports: (renderer) => renderer === 'live2d',
  async install(asset, context) { return { ...asset, source: await context.model(asset.source) } },
}
export const BUILTIN_ASSISTANT_AVATAR_MATERIAL_ADAPTERS: readonly AssistantAvatarMaterialAdapter[] = [image, live2d]
const marker = 'PACK_VERSION'
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** 依赖完整下载并重写为本地引用；模型、动作、贴图本体不做裁剪。 */
export async function installAssistantAvatarMaterials(model: AssistantAvatarModel, remote: AssistantAvatarRemote, signal?: AbortSignal,
  adapters: readonly AssistantAvatarMaterialAdapter[] = BUILTIN_ASSISTANT_AVATAR_MATERIAL_ADAPTERS): Promise<{ id: string; model: AssistantAvatarModel; materials: readonly AssistantAvatarMaterial[] }> {
  validateAssistantAvatarModel(model)
  const lifetime = new AbortController()
  const cancellation = signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal])
  const pending = new Map<string, Promise<string>>()
  const materials: AssistantAvatarMaterial[] = []
  let size = 0
  let active = 0
  const waiters: (() => void)[] = []
  const read = async (source: string, maxBytes: number) => {
    if (active >= 4) await new Promise<void>((resolve) => waiters.push(resolve))
    else active++
    try { cancellation.throwIfAborted(); return await remote.read(source, maxBytes, cancellation) }
    finally { const next = waiters.shift(); if (next === undefined) active--; else next() }
  }
  const register = (source: string, contentType: string, bytes: Uint8Array): string => {
    size += bytes.byteLength
    if (size > 256 * 1024 * 1024) throw new TypeError('单个形象包超过 256 MiB')
    const suffix = new URL(source).pathname.match(/(\.model3?\.json|\.[a-z0-9]+)$/iu)?.[1]?.toLowerCase() ?? '.bin'
    const key = `${digest(source)}${suffix}`
    materials.push({ key, contentType, bytes })
    return assistantAvatarInstalledSource(marker, key)
  }
  const once = (source: string, action: () => Promise<string>): Promise<string> => {
    const existing = pending.get(source)
    if (existing !== undefined) return existing
    if (pending.size >= 256) throw new TypeError('单个形象包最多包含 256 个资源')
    const task = action(); pending.set(source, task); return task
  }
  const context: AssistantAvatarMaterialContext = {
    signal: cancellation,
    file(source, kind) {
      const contentType = resourceType(source, kind)
      return once(source, async () => {
        const result = await read(source, kind === 'json' ? 2 * 1024 * 1024 : 32 * 1024 * 1024)
        // 对资源 JSON 做语法验证，避免把错误网页作为缓存成功保存。
        if (kind === 'json') JSON.parse(new TextDecoder().decode(result.bytes))
        if (kind === 'image' && !imageSignature(result.bytes)) throw new TypeError('图片资源内容无效')
        return register(source, contentType, result.bytes)
      })
    },
    model(source) {
      resourceType(source, 'json')
      return once(source, async () => {
        const result = await read(source, 2 * 1024 * 1024)
        const value: unknown = JSON.parse(new TextDecoder().decode(result.bytes))
        const rewritten = await rewriteAssistantAvatarModel(value, result.url, context)
        // l2d 通过字符串拼接目录，因此依赖引用须是同目录的相对入口，而非绝对 URL。
        const bytes = new TextEncoder().encode(JSON.stringify(rewritten))
        return register(source, 'application/json', bytes)
      })
    },
  }
  const install = async (asset: AssistantAvatarAsset): Promise<AssistantAvatarAsset> => {
    const adapter = adapters.find((item) => item.supports(asset.renderer))
    if (adapter === undefined) throw new TypeError(`此渲染器尚无本地素材安装适配器：${asset.renderer}`)
    return adapter.install(asset, context)
  }
  try {
    // 顺序收集展示位置，共用去重表，不重复下载同一个模型或贴图。
    const base = await install(model)
    const surfaces = model.surfaces === undefined ? undefined : Object.fromEntries(await Promise.all(
      Object.entries(model.surfaces).map(async ([surface, asset]) => [surface, await install(asset)])))
    await Promise.all(pending.values())
    cancellation.throwIfAborted()
    const result = { id: model.id, name: model.name, ...base, package: model.package, ...(surfaces === undefined ? {} : { surfaces }) }
    const id = digest(JSON.stringify([result, materials.map((file) => [file.key, digest(file.bytes)]).sort(([a], [b]) => a!.localeCompare(b!))]))
    const local = JSON.parse(JSON.stringify(result).replaceAll(`pack=${marker}`, `pack=${id}`)) as AssistantAvatarModel
    const completed = materials.map((file) => file.contentType !== 'application/json' ? file : { ...file,
      bytes: new TextEncoder().encode(new TextDecoder().decode(file.bytes).replaceAll(`pack=${marker}`, `pack=${id}`)) })
    return { id, model: copyAssistantAvatarModel({ ...local, package: { ...local.package, adapterId: local.package?.adapterId ?? 'codingns-pack', installationId: id } }), materials: completed }
  } catch (error) {
    // 一项失败后取消其余并发下载，再等待它们退出，避免孤立请求跨越安装生命周期。
    lifetime.abort()
    await Promise.allSettled(pending.values())
    throw error
  }
}

/** Cubism 2/3 的所有文件引用统一走安装上下文，其余布局、参数和扩展数据原样保留。 */
export async function rewriteAssistantAvatarModel(value: unknown, source: string, context: AssistantAvatarMaterialContext): Promise<unknown> {
  if (!record(value)) throw new TypeError('Live2D 模型清单无效')
  const cubism3 = value.FileReferences !== undefined
  if (cubism3 && (value.Version !== 3 || !record(value.FileReferences))) throw new TypeError('Live2D 模型版本无效')
  const refs = { ...(cubism3 ? value.FileReferences as Record<string, unknown> : value) }
  const field = async (input: unknown, kind: 'image' | 'binary' | 'json' | 'sound' | 'motion'): Promise<string> => {
    const local = await context.file(resolveAssistantAvatarSource(input, source), kind)
    return local.slice(local.lastIndexOf('/') + 1)
  }
  const mocKey = cubism3 ? 'Moc' : 'model'
  const textureKey = cubism3 ? 'Textures' : 'textures'
  const textures = refs[textureKey]
  if (!Array.isArray(textures) || textures.length === 0 || textures.length > 32) throw new TypeError('Live2D 模型贴图无效')
  refs[mocKey] = await field(refs[mocKey], 'binary')
  refs[textureKey] = await Promise.all(textures.map((url) => field(url, 'image')))
  for (const key of cubism3 ? ['Physics', 'Pose', 'UserData', 'DisplayInfo'] : ['physics', 'pose']) {
    if (refs[key] !== undefined && refs[key] !== '') refs[key] = await field(refs[key], 'json')
  }
  const rewriteEntries = async (entries: unknown): Promise<unknown[]> => {
    if (!Array.isArray(entries) || entries.length > 256) throw new TypeError('Live2D 动作或表情列表无效')
    return Promise.all(entries.map(async (entry: unknown) => {
      if (!record(entry)) throw new TypeError('Live2D 动作或表情无效')
      const key = cubism3 ? 'File' : 'file'
      const result = { ...entry, [key]: await field(entry[key], cubism3 || new URL(resolveAssistantAvatarSource(entry[key], source)).pathname.endsWith('.json') ? 'json' : 'motion') }
      const sound = cubism3 ? 'Sound' : 'sound'
      if (entry[sound] !== undefined && entry[sound] !== '') result[sound] = await field(entry[sound], 'sound')
      return result
    }))
  }
  const expressions = cubism3 ? 'Expressions' : 'expressions'
  if (refs[expressions] !== undefined) refs[expressions] = await rewriteEntries(refs[expressions])
  const motionsKey = cubism3 ? 'Motions' : 'motions'
  if (refs[motionsKey] !== undefined) {
    if (!record(refs[motionsKey])) throw new TypeError('Live2D 动作映射无效')
    refs[motionsKey] = Object.fromEntries(await Promise.all(Object.entries(refs[motionsKey]).map(async ([group, entries]) => [group, await rewriteEntries(entries)])))
  }
  return cubism3 ? { ...value, FileReferences: refs } : refs
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function resourceType(source: string, kind: 'image' | 'binary' | 'json' | 'sound' | 'motion'): string {
  const ext = new URL(source).pathname.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = kind === 'image' ? { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }
    : kind === 'json' ? { json: 'application/json' } : kind === 'binary' ? { moc: 'application/octet-stream', moc3: 'application/octet-stream' }
      : kind === 'motion' ? { mtn: 'application/octet-stream' } : { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg' }
  const type = ext === undefined ? undefined : types[ext]
  if (type === undefined) throw new TypeError('形象资源类型不受支持，请提供 JSON、模型、图片或音频文件地址')
  return type
}
function imageSignature(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 12))
  return (bytes[0] === 137 && head.slice(1, 4) === 'PNG') || head.startsWith('GIF8')
    || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
}
