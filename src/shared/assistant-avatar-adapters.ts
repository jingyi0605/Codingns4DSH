import { copyAssistantAvatarModel, isAssistantAvatarSource, validateAssistantAvatarModel } from './assistant-avatar.js'
import type { AssistantAvatarAsset, AssistantAvatarManifest, AssistantAvatarModel, AssistantAvatarPackageInfo, AssistantAvatarState } from './assistant-avatar.js'

export interface AssistantAvatarAdapterContext { readonly manifestUrl: string }
/** 适配器解释 JSON 数据，不负责下载脚本、会话或渲染实例。 */
export interface AssistantAvatarAdapter {
  readonly id: string
  readonly labelKey?: string
  readonly name?: string
  matches(manifest: unknown): boolean
  parse(manifest: unknown, context: AssistantAvatarAdapterContext): AssistantAvatarModel
}

/** 相对路径以清单实际响应 URL 为基准，重定向后不再使用旧目录。 */
export function resolveAssistantAvatarSource(source: unknown, manifestUrl: string): string {
  if (typeof source !== 'string' || source.trim().length === 0 || source.trim().startsWith('//') || /[\\\u0000-\u001f]/u.test(source)) throw new TypeError('形象包资源地址无效')
  if (!isAssistantAvatarSource(manifestUrl)) throw new TypeError('形象包清单地址无效')
  const resolved = new URL(source, manifestUrl).href
  if (!isAssistantAvatarSource(resolved)) throw new TypeError('形象包资源地址无效')
  return resolved
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('形象包清单必须是 JSON 对象')
  return value as Record<string, unknown>
}
function looksLike(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && key in value
}
function asset(value: unknown, url: string): AssistantAvatarAsset {
  const input = record(value)
  return { renderer: input.renderer as string, source: resolveAssistantAvatarSource(input.source, url),
    spriteVersion: (input.spriteVersion ?? 2) as 1 | 2,
    ...(input.stateSources === undefined ? {} : { stateSources: Object.fromEntries(Object.entries(record(input.stateSources)).map(([state, source]) => [state, resolveAssistantAvatarSource(source, url)])) }),
    ...(input.motionGroups === undefined ? {} : { motionGroups: record(input.motionGroups) as NonNullable<AssistantAvatarAsset['motionGroups']> }),
    ...(input.reactionSources === undefined ? {} : { reactionSources: Object.fromEntries(Object.entries(record(input.reactionSources)).map(([reaction, source]) => [reaction, resolveAssistantAvatarSource(source, url)])) }),
    ...(input.reactionMotionGroups === undefined ? {} : { reactionMotionGroups: record(input.reactionMotionGroups) as NonNullable<AssistantAvatarAsset['reactionMotionGroups']> }),
    ...(input.reactionExpressions === undefined ? {} : { reactionExpressions: record(input.reactionExpressions) as NonNullable<AssistantAvatarAsset['reactionExpressions']> }),
    ...(input.live2d === undefined ? {} : { live2d: record(input.live2d) as NonNullable<AssistantAvatarAsset['live2d']> }),
  }
}
function build(input: Record<string, unknown>, base: AssistantAvatarAsset, context: AssistantAvatarAdapterContext, adapterId: string,
  surfaces?: AssistantAvatarModel['surfaces']): AssistantAvatarModel {
  const info: AssistantAvatarPackageInfo = { adapterId, manifestUrl: context.manifestUrl,
    ...(input.author === undefined ? {} : { author: input.author as string }),
    ...(input.license === undefined ? {} : { license: input.license as string }),
    ...(input.homepage === undefined ? {} : { homepage: resolveAssistantAvatarSource(input.homepage, context.manifestUrl) }),
  }
  const model = { id: input.id as string, name: (input.name ?? input.displayName) as string, ...base, package: info,
    ...(surfaces === undefined ? {} : { surfaces }) }
  validateAssistantAvatarModel(model)
  return copyAssistantAvatarModel(model)
}

const native: AssistantAvatarAdapter = {
  id: 'codingns-pack', labelKey: 'avatar.adapter.native',
  matches: (value) => looksLike(value, 'avatarManifestVersion'),
  parse(value, context) {
    const input = record(value)
    if (input.avatarManifestVersion !== 1) throw new TypeError('不支持的 CodingNS 形象包版本')
    const surfaces = input.surfaces === undefined ? undefined : Object.fromEntries(Object.entries(record(input.surfaces)).map(([surface, source]) => [surface, asset(source, context.manifestUrl)]))
    return build(input, asset(input.asset, context.manifestUrl), context, this.id, surfaces)
  },
}
const codex: AssistantAvatarAdapter = {
  id: 'codex-pet', labelKey: 'avatar.adapter.codex',
  matches: (value) => looksLike(value, 'spritesheetPath'),
  parse(value, context) {
    const input = record(value)
    return build(input, { renderer: 'spritesheet', source: resolveAssistantAvatarSource(input.spritesheetPath, context.manifestUrl),
      spriteVersion: input.spriteVersionNumber as 1 | 2 }, context, this.id)
  },
}
const dsh: AssistantAvatarAdapter = {
  id: 'dsh-live2d-pet', labelKey: 'avatar.adapter.dsh',
  matches: (value) => looksLike(value, 'petManifestVersion'),
  parse(value, context) {
    const input = record(value)
    if (input.petManifestVersion !== 2 || input.renderer !== 'live2d') throw new TypeError('不支持的 DSH 形象包格式')
    const live2d = record(input.live2d)
    const translate = live2d.translate === undefined ? undefined : record(live2d.translate)
    // DSH 的 failed/asking 与 CodingNS 的 error/waiting 在适配边界转换。
    const motions = live2d.motions === undefined ? {} : record(live2d.motions)
    const states: Record<AssistantAvatarState, readonly string[]> = {
      idle: ['idle'], thinking: ['thinking', 'tool'], speaking: ['speaking'],
      listening: ['listening', 'waiting'], waiting: ['waiting', 'asking', 'queued'], error: ['error', 'failed'],
    }
    const motionGroups = Object.fromEntries(Object.entries(states).flatMap(([state, aliases]) => {
      const group = aliases.map((key) => motions[key]).find((item) => item !== undefined)
      return group === undefined ? [] : [[state, group]]
    }))
    return build(input, { renderer: 'live2d', source: resolveAssistantAvatarSource(live2d.model, context.manifestUrl), spriteVersion: 2,
      ...(Object.keys(motionGroups).length === 0 ? {} : { motionGroups }),
      ...(live2d.scale === undefined && translate === undefined ? {} : { live2d: {
        ...(live2d.scale === undefined ? {} : { scale: live2d.scale as number }),
        ...(translate === undefined ? {} : { position: [translate.x, translate.y] as [number, number] }),
      } }),
    }, context, this.id)
  },
}
const cubism: AssistantAvatarAdapter = {
  id: 'cubism-model', labelKey: 'avatar.adapter.cubism',
  matches: (value) => looksLike(value, 'FileReferences') || looksLike(value, 'model'),
  parse(value, context) {
    const input = record(value)
    const refs = input.FileReferences === undefined ? input : record(input.FileReferences)
    const textures = refs.Textures ?? refs.textures
    if ((input.FileReferences !== undefined && input.Version !== 3) || !Array.isArray(textures) || textures.length === 0) throw new TypeError('Live2D 模型清单不完整')
    resolveAssistantAvatarSource(refs.Moc ?? refs.model, context.manifestUrl)
    for (const texture of textures) resolveAssistantAvatarSource(texture, context.manifestUrl)
    // 模型没有角色 ID，使用来源的稳定指纹，重复导入不会生成无限副本。
    let hash = 2166136261
    for (const character of context.manifestUrl) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
    const filename = new URL(context.manifestUrl).pathname.split('/').pop() ?? 'Live2D'
    return build({ id: `live2d-${(hash >>> 0).toString(36)}`, name: decodeURIComponent(filename).replace(/\.model3?\.json$/iu, '').slice(0, 80) || 'Live2D' },
      { renderer: 'live2d', source: context.manifestUrl, spriteVersion: 2 }, context, this.id)
  },
}

export const BUILTIN_ASSISTANT_AVATAR_ADAPTERS: readonly AssistantAvatarAdapter[] = [native, codex, dsh, cubism]

/** 导出原生清单时不重复嵌入导入器元数据，素材地址已统一为可访问地址。 */
export function assistantAvatarManifest(model: AssistantAvatarModel): AssistantAvatarManifest {
  validateAssistantAvatarModel(model)
  if (model.renderer === 'builtin') throw new TypeError('内置形象不需要导出素材包')
  const { id, name, package: info, surfaces, ...base } = copyAssistantAvatarModel(model)
  return { avatarManifestVersion: 1, id, name, asset: base, ...(surfaces === undefined ? {} : { surfaces }),
    ...(info?.author === undefined ? {} : { author: info.author }), ...(info?.license === undefined ? {} : { license: info.license }),
    ...(info?.homepage === undefined ? {} : { homepage: info.homepage }) }
}
