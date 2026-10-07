/** 上传只携带字节，不能由浏览器指定 Host 文件路径或已有附件引用。 */
export interface AssistantAttachmentUpload { readonly name: string; readonly mediaType: string; readonly data: string }
export interface AssistantAttachmentReference {
  readonly attachmentId: string; readonly name?: string; readonly bytes: number
  readonly mediaType?: string; readonly width?: number; readonly height?: number
}
export interface AssistantAttachment { readonly type: 'image' | 'file'; readonly attachment: AssistantAttachmentReference }
export const ASSISTANT_ATTACHMENT_MAX_FILES = 6
export const ASSISTANT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const ASSISTANT_ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024
export const ASSISTANT_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** 在解码和写入前限制 JSON 上传的体积，所有真实图片校验仍交给 DSH。 */
export function readAssistantAttachmentUploads(value: unknown): readonly AssistantAttachmentUpload[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ASSISTANT_ATTACHMENT_MAX_FILES) throw new Error('助理附件数量无效，最多 6 个')
  let total = 0
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200
      || /[\\/\x00-\x1f]/u.test(item.name) || typeof item.mediaType !== 'string' || item.mediaType.length > 120
      || typeof item.data !== 'string' || item.data.length > Math.ceil(ASSISTANT_ATTACHMENT_MAX_BYTES / 3) * 4) throw new Error('助理附件无效或超过 10 MiB')
    if (item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(item.data)) throw new Error('助理附件编码无效')
    const bytes = item.data.length / 4 * 3 - (item.data.endsWith('==') ? 2 : item.data.endsWith('=') ? 1 : 0)
    if (bytes > ASSISTANT_ATTACHMENT_MAX_BYTES || (total += bytes) > ASSISTANT_ATTACHMENT_MAX_TOTAL_BYTES) throw new Error('助理附件总大小超过 20 MiB')
    if (item.mediaType.startsWith('image/') && !ASSISTANT_IMAGE_MEDIA_TYPES.some((type) => type === item.mediaType)) throw new Error('图片仅支持 PNG、JPEG、WebP 和 GIF')
    return { name: item.name.trim(), mediaType: item.mediaType, data: item.data }
  })
}

/** 持久记录只保留宿主生成的引用，不保存上传编码或可执行路径。 */
export function readAssistantAttachments(value: unknown): readonly AssistantAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ASSISTANT_ATTACHMENT_MAX_FILES) throw new Error('助理附件引用无效')
  for (const item of value) {
    const ref = item?.attachment
    if (!['image', 'file'].includes(item?.type) || ref === null || typeof ref !== 'object'
      || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > ASSISTANT_ATTACHMENT_MAX_BYTES
      || ref.name !== undefined && (typeof ref.name !== 'string' || ref.name.length > 200 || /[\\/\x00-\x1f]/u.test(ref.name))
      || item.type === 'image' && (!ASSISTANT_IMAGE_MEDIA_TYPES.some((type) => type === ref.mediaType)
        || !Number.isSafeInteger(ref.width) || ref.width < 1 || !Number.isSafeInteger(ref.height) || ref.height < 1)) throw new Error('助理附件引用无效')
  }
  return structuredClone(value) as AssistantAttachment[]
}
