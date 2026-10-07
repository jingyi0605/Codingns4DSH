/** 目录仅提供安装清单链接；浏览目录不注册角色，也不下载第三方素材。 */
export const ASSISTANT_AVATAR_CATALOG_URL = 'https://github.com/jingyi0605/Codingns4DSH/blob/main/assets/assistant-avatar-catalog.md'

/** 使用说明单独版本化；升级说明后必须重新确认，不能继承旧版同意。 */
export const ASSISTANT_AVATAR_CONSENT_VERSION = '2026-10-07.1'
export const ASSISTANT_AVATAR_CATALOG_PREVIEW_PATH = '/api/codingns/assistant-avatar-catalog-preview'
/** 临时素材只通过随机预览租约读取，不与正式安装目录混用。 */
export const ASSISTANT_AVATAR_TEMPORARY_ASSET_PATH = '/api/codingns/assistant-avatar-temporary-assets'
export interface AssistantAvatarTemporaryPreview {
  readonly lease: string
  readonly model: import('./assistant-avatar.js').AssistantAvatarModel
}
export interface AssistantAvatarConsent {
  readonly version: string
  readonly acceptedAt: number
}
/** 目录只传元数据；完整素材始终由用户另外确认安装。 */
export interface AssistantAvatarCatalogEntry {
  readonly id: string
  readonly number: number
  readonly name: string
  readonly author: string
  readonly description: string
  readonly remarks: string
  readonly repositoryUrl: string
  readonly licenseUrl: string
  readonly license: string
  readonly homepage: string
  readonly format: string
  readonly revision: string
  readonly bytes: number
  readonly files: number
  readonly previewAvailable: boolean
}
export function validAssistantAvatarConsent(value: unknown): value is AssistantAvatarConsent {
  if (value === null || typeof value !== 'object') return false
  const consent = value as Partial<AssistantAvatarConsent>
  return typeof consent.version === 'string' && consent.version.length > 0 && consent.version.length <= 80
    && Number.isSafeInteger(consent.acceptedAt) && consent.acceptedAt! > 0
}
export function hasAssistantAvatarConsent(value: unknown): boolean {
  return validAssistantAvatarConsent(value) && value.version === ASSISTANT_AVATAR_CONSENT_VERSION
}
export function assistantAvatarCatalogPreviewUrl(entry: Pick<AssistantAvatarCatalogEntry, 'id' | 'revision'>): string {
  return `${ASSISTANT_AVATAR_CATALOG_PREVIEW_PATH}?${new URLSearchParams({ id: entry.id, revision: entry.revision })}`
}
