/** 可复用的资源包描述，不包含任何角色素材来源或目录。 */
export interface AssistantAvatarResourcePack {
  readonly basePath: string
  readonly upstreamRoot: string
  readonly manifest: string
  readonly motionGroups: Readonly<Record<string, string>>
  readonly files: readonly { readonly path: string; readonly contentType: string; readonly maxBytes: number; readonly preload?: false }[]
}
export interface AssistantAvatarCacheStatus {
  readonly version: 1
  readonly generation: string
  readonly pack: string
  readonly cached: number
  readonly pending: number
  readonly total: number
  readonly downloads: number
}
export function assistantAvatarCacheStatusPath(pack: AssistantAvatarResourcePack): string { return `${pack.basePath}cache-status.json` }
/** 默认没有第三方资源包，保留旧内部调用的目录形状。 */
export const ASSISTANT_AVATAR_RESOURCE_PACKS: readonly AssistantAvatarResourcePack[] = Object.freeze([])
