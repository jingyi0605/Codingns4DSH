import { ASSISTANT_IMAGE_MEDIA_TYPES, readAssistantAttachmentUploads, readAssistantAttachments,
  type AssistantAttachmentUpload, type AssistantAttachment } from '../../shared/assistant-attachments.js'
import type { AssistantManagementTool } from '../../host/features/assistant-management-tools.js'

/** 原生附件服务的最小兼容面；浏览器始终上传字节，引用只由该服务生成。 */
export interface AssistantAttachmentStore {
  admitPromptContent(content: readonly unknown[]): Promise<readonly AssistantAttachment[]>
  admitEncodedFile(input: { readonly data: string; readonly name: string }): Promise<AssistantAttachment['attachment']>
  readFileStream(ref: AssistantAttachment['attachment'], signal?: AbortSignal): AsyncIterable<Uint8Array>
}
export function readAssistantAttachmentStore(context: unknown): AssistantAttachmentStore | undefined {
  try {
    const service = typeof (context as any)?.get === 'function' ? (context as any).get('attachments') : (context as any)?.attachments
    return ['admitPromptContent', 'admitEncodedFile', 'readFileStream'].every((name) => typeof service?.[name] === 'function') ? service : undefined
  } catch { return undefined }
}
export async function admitAssistantAttachments(store: AssistantAttachmentStore | undefined, uploads: readonly AssistantAttachmentUpload[]): Promise<readonly AssistantAttachment[]> {
  const inputs = readAssistantAttachmentUploads(uploads)
  if (inputs.length === 0) return []
  if (store === undefined) throw new Error('当前 Host 的 DSH 附件服务不可用')
  // 图片作为一批交给 DSH 解码、验证和归一化；失败不会开始 Agent 问答。
  const images = await store.admitPromptContent(inputs.filter((item) => ASSISTANT_IMAGE_MEDIA_TYPES.some((type) => type === item.mediaType))
    .map((item) => ({ type: 'image', ...item })))
  let imageIndex = 0
  const result: AssistantAttachment[] = []
  for (const input of inputs) {
    if (ASSISTANT_IMAGE_MEDIA_TYPES.some((type) => type === input.mediaType)) result.push(images[imageIndex++]!)
    else result.push({ type: 'file', attachment: await store.admitEncodedFile({ data: input.data, name: input.name }) })
  }
  return readAssistantAttachments(result)
}

/** 文件工具只能读取本助理已经收到的附件，不能读取用户随意给出的 Host 路径。 */
export function createAssistantAttachmentTool(store: AssistantAttachmentStore, allowed: ReadonlyMap<string, AssistantAttachment>): AssistantManagementTool {
  return {
    name: 'assistant_read_attachment', description: '读取用户发送给本助理的文本附件。仅接受附件标识，不接受文件路径；二进制文档请用户提供文本或图片版本。',
    parameters: { type: 'object', properties: { attachmentId: { type: 'string', description: '用户附件的 attachmentId' } }, required: ['attachmentId'], additionalProperties: false },
    output: { schema: {}, render: () => [] },
    async execute(input: any, { signal }) {
      const item = allowed.get(input?.attachmentId)
      if (item?.type !== 'file') throw new Error('附件不在本助理的可读范围内')
      const chunks: Uint8Array[] = []; let length = 0; const maximum = 128 * 1024
      for await (const chunk of store.readFileStream(item.attachment, signal)) {
        signal.throwIfAborted()
        chunks.push(chunk.subarray(0, maximum - length)); length += Math.min(chunk.length, maximum - length)
        if (length >= maximum) break
      }
      signal.throwIfAborted()
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: item.attachment.bytes > length })
        if (text.includes('\0')) throw new Error('binary')
        return { name: item.attachment.name, text, truncated: item.attachment.bytes > length }
      } catch { throw new Error('该附件不是 UTF-8 文本，请提供文本或图片版本') }
    },
  }
}
