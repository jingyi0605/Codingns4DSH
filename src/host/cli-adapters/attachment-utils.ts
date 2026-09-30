import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CodingNsCliAttachment } from '../../shared/contracts/cli-adapter.js'

/** 根据附件声明或扩展名补齐协议需要的 MIME 类型。 */
export function attachmentMimeType(attachment: CodingNsCliAttachment): string {
  const declared = attachment.mimeType?.trim().toLowerCase()
  if (declared) return declared
  const extension = extname(attachment.path).toLowerCase()
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
  }[extension] ?? 'application/octet-stream'
}

/** 给只接受文本 prompt 的 CLI 追加可解析的 @路径引用。 */
export function promptWithAttachmentPaths(prompt: string, attachments: readonly CodingNsCliAttachment[]): string {
  if (attachments.length === 0) return prompt
  const references = attachments.map((attachment) => `附件「${attachment.name ?? basename(attachment.path)}」：@${attachment.path}`)
  return [prompt.trim(), '请读取并处理以下消息附件：', ...references].filter((part) => part !== '').join('\n')
}

/** ACP PromptRequest 的内容块；图片内联，普通文件用 file:// 资源链接。 */
export async function buildAcpPromptBlocks(prompt: string, attachments: readonly CodingNsCliAttachment[]): Promise<readonly Record<string, unknown>[]> {
  const blocks: Record<string, unknown>[] = []
  if (prompt.trim() !== '' || attachments.length === 0) blocks.push({ type: 'text', text: prompt })
  for (const attachment of attachments) {
    const mimeType = attachmentMimeType(attachment)
    if (attachment.kind === 'image') {
      blocks.push({ type: 'image', data: Buffer.from(await readFile(attachment.path)).toString('base64'), mimeType })
      continue
    }
    const size = (await stat(attachment.path)).size
    blocks.push({
      type: 'resource_link',
      uri: pathToFileURL(attachment.path).href,
      name: attachment.name ?? basename(attachment.path),
      mimeType,
      size,
    })
  }
  return blocks
}

/** OpenCode message API 的 file parts；其 API 不接受本地路径，必须传 data URL。 */
export async function buildOpenCodeAttachmentParts(attachments: readonly CodingNsCliAttachment[]): Promise<readonly Record<string, unknown>[]> {
  return Promise.all(attachments.map(async (attachment) => ({
    type: 'file',
    mime: attachmentMimeType(attachment),
    filename: attachment.name ?? basename(attachment.path),
    url: `data:${attachmentMimeType(attachment)};base64,${Buffer.from(await readFile(attachment.path)).toString('base64')}`,
  })))
}

/** Pi RPC 只支持把图片作为 base64 image content；普通文件继续走路径读取。 */
export async function buildPiImages(attachments: readonly CodingNsCliAttachment[]): Promise<readonly Record<string, unknown>[]> {
  return Promise.all(attachments.filter((attachment) => attachment.kind === 'image').map(async (attachment) => ({
    type: 'image',
    data: Buffer.from(await readFile(attachment.path)).toString('base64'),
    mimeType: attachmentMimeType(attachment),
  })))
}

/** Kimi wire 的附件元数据字段，文件内容由 Kimi CLI 按路径读取。 */
export async function buildKimiAttachments(attachments: readonly CodingNsCliAttachment[]): Promise<readonly Record<string, unknown>[]> {
  return Promise.all(attachments.map(async (attachment) => ({
    file_path: attachment.path,
    file_name: attachment.name ?? basename(attachment.path),
    mime_type: attachmentMimeType(attachment),
    file_size: (await stat(attachment.path)).size,
  })))
}
