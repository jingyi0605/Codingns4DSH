/**
 * Live2D 引擎的固定版本与许可契约。
 *
 * 引擎不随插件打包：Host 在用户确认引擎许可后，从固定 registry 地址下载
 * 精确版本并校验摘要，安装到 CodingNS 自有目录；源码开发仍可直接解析
 * 仓库中的开发依赖。升级版本必须同时更新 tarball 地址、摘要与许可说明。
 */
export const ASSISTANT_AVATAR_ENGINE_VERSION = '2.1.1'
let runtimeRevision = 0
const runtimeListeners = new Set<() => void>()
/** Host 与 Client 各自维护代次，安装成功立即解除缺失引擎的短期缓存。 */
export function invalidateAssistantAvatarRuntime(): void {
  runtimeRevision += 1
  for (const listener of runtimeListeners) listener()
}
export function assistantAvatarRuntimeRevision(): number { return runtimeRevision }
/** 已经显示加载失败的形象也需要重新挂载，不能只清除模块缓存。 */
export function subscribeAssistantAvatarRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener)
  return () => { runtimeListeners.delete(listener) }
}
export const ASSISTANT_AVATAR_ENGINE_TARBALL = 'https://registry.npmjs.org/l2d/-/l2d-2.1.1.tgz'
export const ASSISTANT_AVATAR_ENGINE_SHA512 = 'Q9Rp3uDPiZyS4SJZ/RJ+tuR1YQ75gKhGeS2gZNCO6KvydDB6okPQJk+zsKt8KyJ6Y5g0okVMtj3Sisjxr35ptA=='
/** npm tarball 顶层固定为 package/，入口是真正的 ESM 文件而非全局 IIFE。 */
export const ASSISTANT_AVATAR_ENGINE_ENTRY = 'package/dist/index.js'
/** 真实入口约 820 KB；明显偏小说明下载或解压不完整。 */
export const ASSISTANT_AVATAR_ENGINE_MIN_ENTRY_BYTES = 512 * 1024
export const ASSISTANT_AVATAR_ENGINE_MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
/** 引擎许可单独版本化：Cubism SDK 条款与第三方素材许可分别确认。 */
export const ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION = '2026-10-08.1'
export interface AssistantAvatarEngineConsent {
  readonly version: string
  readonly acceptedAt: number
}
/** managed 为 CodingNS 自有目录安装，dependency 为源码开发或用户手工安装。 */
export type AssistantAvatarEngineSource = 'managed' | 'dependency' | 'missing'
export interface AssistantAvatarEngineStatus {
  readonly installed: boolean
  readonly version: string
  readonly source: AssistantAvatarEngineSource
}
export function validAssistantAvatarEngineConsent(value: unknown): value is AssistantAvatarEngineConsent {
  if (value === null || typeof value !== 'object') return false
  const consent = value as Partial<AssistantAvatarEngineConsent>
  return typeof consent.version === 'string' && consent.version.length > 0 && consent.version.length <= 80
    && Number.isSafeInteger(consent.acceptedAt) && consent.acceptedAt! > 0
}
export function hasAssistantAvatarEngineConsent(value: unknown): boolean {
  return validAssistantAvatarEngineConsent(value) && value.version === ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION
}
