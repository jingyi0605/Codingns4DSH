import { ASSISTANT_ATTACHMENT_MAX_FILES, ASSISTANT_ATTACHMENT_MAX_BYTES, ASSISTANT_ATTACHMENT_MAX_TOTAL_BYTES,
  ASSISTANT_IMAGE_MEDIA_TYPES, type AssistantAttachmentUpload } from '../../shared/assistant-attachments.js'
import { ASSISTANT_CLEAR_COMMANDS } from '../../shared/assistant-commands.js'

/** 只匹配完整指令，避免把路径、带参数文本或普通问题误当成破坏性操作。 */
export function readAssistantComposerCommand(text: string): 'clear' | undefined {
  return ASSISTANT_CLEAR_COMMANDS.includes(text.trim().toLowerCase()) ? 'clear' : undefined
}
export function isAssistantClearCommandSuggestion(text: string): boolean {
  const prefix = text.trim().toLowerCase()
  return prefix.startsWith('/') && ASSISTANT_CLEAR_COMMANDS.some((command) => command.startsWith(prefix))
}

/** 先归零再测量，删除内容也能缩回单行；超过视口上限后仅内部滚动。 */
export function resizeAssistantComposerTextarea(input: HTMLTextAreaElement): void {
  const style = input.ownerDocument.defaultView?.getComputedStyle(input)
  const minimum = Number.parseFloat(style?.minHeight ?? '') || 38
  const maximum = Number.parseFloat(style?.maxHeight ?? '') || 120
  input.style.height = '0px'
  const height = input.scrollHeight
  input.style.height = `${Math.min(maximum, Math.max(minimum, height))}px`
  input.style.overflowY = height > maximum ? 'auto' : 'hidden'
}

export function validateAssistantFiles(files: readonly File[]): void {
  if (files.length > ASSISTANT_ATTACHMENT_MAX_FILES) throw new Error('awb.attachments.countError')
  if (files.some((file) => file.size > ASSISTANT_ATTACHMENT_MAX_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > ASSISTANT_ATTACHMENT_MAX_TOTAL_BYTES) throw new Error('awb.attachments.sizeError')
  if (files.some((file) => file.type.startsWith('image/') && !ASSISTANT_IMAGE_MEDIA_TYPES.some((type) => type === file.type))) throw new Error('awb.attachments.typeError')
}
/** 附件在点击发送时才编码；选择、删除或取消草稿不会在 Host 留下文件。 */
export async function encodeAssistantFiles(files: readonly File[]): Promise<readonly AssistantAttachmentUpload[]> {
  validateAssistantFiles(files)
  return await Promise.all(files.map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    return { name: file.name, mediaType: file.type, data: btoa(binary) }
  }))
}
