import type { AssistantAvatarResourcePack } from './assistant-avatar-resources.js'
export { assistantAvatarCacheStatusPath } from './assistant-avatar-resources.js'

/** 地址包含上游提交与精简策略版本；修改资源或策略时必须更新版本，避免浏览器旧缓存。 */
export const WHALE_LIVE2D_RESOURCE_PACK: AssistantAvatarResourcePack = Object.freeze({
  basePath: '/api/codingns/assistant-avatar-assets/whale-185c02bf-v1/',
  upstreamRoot: 'https://raw.githubusercontent.com/A8Chann/dsh-pet-live2d/185c02bfbb3b886e1a236b5c2ec035cc085b9ca2/dsh-live2d-pet/pets/ds-whale-girl/',
  manifest: 'c_0120.model3.json',
  motionGroups: Object.freeze({ idle: 'Idle', thinking: 'Idle', listening: 'Idle', waiting: 'Idle', error: 'SprayWater' }),
  files: Object.freeze([
    { path: 'c_0120.model3.json', contentType: 'application/json', maxBytes: 262144 },
    { path: 'model/c_0120.moc3', contentType: 'application/octet-stream', maxBytes: 4194304 },
    { path: 'model/c_0120.physics3.json', contentType: 'application/json', maxBytes: 1048576 },
    { path: 'model/c_0120.cdi3.json', contentType: 'application/json', maxBytes: 1048576, preload: false as const },
    { path: 'textures/texture_00.png', contentType: 'image/png', maxBytes: 4194304 },
    { path: 'textures/texture_01.png', contentType: 'image/png', maxBytes: 1048576 },
    { path: 'motions/idle.motion3.json', contentType: 'application/json', maxBytes: 1048576 },
    { path: 'motions/spray-water.motion3.json', contentType: 'application/json', maxBytes: 1048576 },
  ].map((file) => Object.freeze(file))),
})

export const ASSISTANT_AVATAR_RESOURCE_PACKS: readonly AssistantAvatarResourcePack[] = Object.freeze([WHALE_LIVE2D_RESOURCE_PACK])
