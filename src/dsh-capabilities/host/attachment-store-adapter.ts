import type { NativeAttachment } from '../../shared/attachments.js'

/** 原生附件服务的最小兼容面；浏览器始终上传字节，引用只由该服务生成。 */
export interface NativeAttachmentStore {
  admitPromptContent(content: readonly unknown[]): Promise<readonly NativeAttachment[]>
  admitEncodedFile(input: { readonly data: string; readonly name: string }): Promise<NativeAttachment['attachment']>
  readFileStream(ref: NativeAttachment['attachment'], signal?: AbortSignal): AsyncIterable<Uint8Array>
}
export function readNativeAttachmentStore(context: unknown): NativeAttachmentStore | undefined {
  try {
    const service = typeof (context as any)?.get === 'function' ? (context as any).get('attachments') : (context as any)?.attachments
    return ['admitPromptContent', 'admitEncodedFile', 'readFileStream'].every((name) => typeof service?.[name] === 'function') ? service : undefined
  } catch { return undefined }
}
