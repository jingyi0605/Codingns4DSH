export interface NativeAttachmentReference {
  readonly attachmentId: string; readonly name?: string; readonly bytes: number
  readonly mediaType?: string; readonly width?: number; readonly height?: number
}
export interface NativeAttachment { readonly type: 'image' | 'file'; readonly attachment: NativeAttachmentReference }
export const MAX_NATIVE_ATTACHMENTS = 6
export const MAX_NATIVE_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** 持久记录只保留宿主生成的引用，不保存上传编码或可执行路径。 */
export function readNativeAttachments(value: unknown): readonly NativeAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_NATIVE_ATTACHMENTS) throw new Error('原生附件引用无效')
  for (const item of value) {
    const ref = item?.attachment
    if (!['image', 'file'].includes(item?.type) || ref === null || typeof ref !== 'object'
      || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_NATIVE_ATTACHMENT_BYTES
      || ref.name !== undefined && (typeof ref.name !== 'string' || ref.name.length > 200 || /[\\/\x00-\x1f]/u.test(ref.name))
      || item.type === 'image' && (!SUPPORTED_IMAGE_MIME_TYPES.some((type) => type === ref.mediaType)
        || !Number.isSafeInteger(ref.width) || ref.width < 1 || !Number.isSafeInteger(ref.height) || ref.height < 1)) throw new Error('原生附件引用无效')
  }
  return structuredClone(value) as NativeAttachment[]
}
