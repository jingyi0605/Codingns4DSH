import { rmSync } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CodingNsAgentEvent, CodingNsCliAttachment, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif', '.svg': 'image/svg+xml',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.pdf': 'application/pdf',
}

const EXTENSION_BY_IMAGE_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/bmp': '.bmp', 'image/tiff': '.tiff', 'image/x-icon': '.ico',
  'image/avif': '.avif', 'image/heic': '.heic', 'image/heif': '.heif', 'image/svg+xml': '.svg',
}

/** 图片内容是格式的最终依据，不能把显示文件名当成实际磁盘后缀。 */
function imageMimeFromBytes(bytes: Uint8Array): string | undefined {
  const header = Buffer.from(bytes.subarray(0, 512))
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
  if (/^GIF8[79]a/u.test(header.toString('ascii', 0, 6))) return 'image/gif'
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (header.toString('ascii', 0, 2) === 'BM') return 'image/bmp'
  if (header.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || header.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return 'image/tiff'
  if (header.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) return 'image/x-icon'
  if (header.toString('ascii', 4, 8) === 'ftyp') {
    const brand = header.toString('ascii', 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic'
    if (['heif', 'mif1', 'msf1'].includes(brand)) return 'image/heif'
  }
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/iu.test(header.toString('utf8').replace(/^\uFEFF/u, '').trimStart())) return 'image/svg+xml'
  return undefined
}

/** 优先识别图片内容，其次使用声明、原始文件名和实际路径补齐 MIME 类型。 */
export function attachmentMimeType(attachment: CodingNsCliAttachment, bytes?: Uint8Array): string {
  const detected = attachment.kind === 'image' && bytes !== undefined ? imageMimeFromBytes(bytes) : undefined
  if (detected !== undefined) return detected
  const declared = attachment.mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (declared && declared !== 'application/octet-stream') return declared === 'image/jpg' ? 'image/jpeg' : declared
  return MIME_BY_EXTENSION[extname(attachment.name ?? '').toLowerCase()]
    ?? MIME_BY_EXTENSION[extname(attachment.path).toLowerCase()]
    ?? 'application/octet-stream'
}

/** 原生图片协议与路径副本共用一次内容识别，未知图片格式必须明确报错。 */
async function readAttachment(attachment: CodingNsCliAttachment): Promise<{ readonly bytes: Buffer; readonly mimeType: string }> {
  const bytes = await readFile(attachment.path)
  const mimeType = attachmentMimeType(attachment, bytes)
  if (attachment.kind === 'image' && !mimeType.startsWith('image/')) {
    throw new Error(`无法识别图片附件「${attachment.name ?? basename(attachment.path)}」的格式`)
  }
  return { bytes, mimeType }
}

/** 保留可识别的原名；显示名称缺后缀或与内容不符时补齐，绝不用于拼接磁盘路径。 */
function imageAttachmentName(attachment: CodingNsCliAttachment, mimeType: string): string {
  const name = attachment.name ?? basename(attachment.path)
  const extension = extname(name)
  const expected = EXTENSION_BY_IMAGE_MIME[mimeType]
  if (expected === undefined || MIME_BY_EXTENSION[extension.toLowerCase()] === mimeType) return name
  return `${name.slice(0, name.length - extension.length)}${expected}`
}

export interface PreparedAttachmentInput {
  readonly input: CodingNsCliTurnInput
  /** 清理归属于整个 Provider 回合；分段续跑期间不能提前删除图片。 */
  readonly cleanup: () => void
}

/** 给文本 CLI 准备真实存在且后缀正确的图片副本，不改写 DSH 附件存储和消息历史。 */
export async function prepareAttachmentPaths(input: CodingNsCliTurnInput): Promise<PreparedAttachmentInput> {
  if (!input.attachments?.some((attachment) => attachment.kind === 'image')) return { input, cleanup: () => {} }
  let directory: string | undefined
  const cleanup = (): void => { if (directory !== undefined) rmSync(directory, { recursive: true, force: true }) }
  const attachments: CodingNsCliAttachment[] = []
  try {
    for (const [index, attachment] of input.attachments.entries()) {
      if (attachment.kind !== 'image') { attachments.push(attachment); continue }
      const { bytes, mimeType } = await readAttachment(attachment)
      const extension = EXTENSION_BY_IMAGE_MIME[mimeType]
      if (extension === undefined) throw new Error(`无法为图片附件「${attachment.name ?? basename(attachment.path)}」准备可读取路径：${mimeType}`)
      let path = attachment.path
      if (MIME_BY_EXTENSION[extname(path).toLowerCase()] !== mimeType) {
        directory ??= await mkdtemp(join(tmpdir(), 'codingns-agent-images-'))
        path = join(directory, `attachment-${index}${extension}`)
        await writeFile(path, bytes, { mode: 0o600 })
      }
      attachments.push({ ...attachment, path, name: imageAttachmentName(attachment, mimeType), mimeType })
    }
    return { input: { ...input, attachments }, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

/** 通用流式驱动持有副本至迭代器结束，正常完成、异常、取消和关闭流均清理。 */
export async function* withAttachmentPaths(
  input: CodingNsCliTurnInput,
  execute: (prepared: CodingNsCliTurnInput) => AsyncIterable<CodingNsAgentEvent>,
): AsyncGenerator<CodingNsAgentEvent> {
  const prepared = await prepareAttachmentPaths(input)
  try { yield* execute(prepared.input) } finally { prepared.cleanup() }
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
    if (attachment.kind === 'image') {
      const { bytes, mimeType } = await readAttachment(attachment)
      blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType })
      continue
    }
    const size = (await stat(attachment.path)).size
    blocks.push({
      type: 'resource_link',
      uri: pathToFileURL(attachment.path).href,
      name: attachment.name ?? basename(attachment.path),
      mimeType: attachmentMimeType(attachment),
      size,
    })
  }
  return blocks
}

/** OpenCode message API 的 file parts；其 API 不接受本地路径，必须传 data URL。 */
export async function buildOpenCodeAttachmentParts(attachments: readonly CodingNsCliAttachment[]): Promise<readonly Record<string, unknown>[]> {
  return Promise.all(attachments.map(async (attachment) => {
    const { bytes, mimeType } = await readAttachment(attachment)
    return {
      type: 'file', mime: mimeType,
      filename: attachment.kind === 'image' ? imageAttachmentName(attachment, mimeType) : attachment.name ?? basename(attachment.path),
      url: `data:${mimeType};base64,${bytes.toString('base64')}`,
    }
  }))
}

/** Pi RPC 只支持把图片作为 base64 image content；普通文件继续走路径读取。 */
export async function buildPiImages(attachments: readonly CodingNsCliAttachment[]): Promise<readonly Record<string, unknown>[]> {
  return Promise.all(attachments.filter((attachment) => attachment.kind === 'image').map(async (attachment) => {
    const { bytes, mimeType } = await readAttachment(attachment)
    return { type: 'image', data: bytes.toString('base64'), mimeType }
  }))
}

/** Kimi wire 只接受 user_input；图片必须放进原生 image_url 内容块，不能另造 attachments 字段。 */
export async function buildKimiUserInput(prompt: string, attachments: readonly CodingNsCliAttachment[]): Promise<string | readonly Record<string, unknown>[]> {
  if (!attachments.some((attachment) => attachment.kind === 'image')) return promptWithAttachmentPaths(prompt, attachments)
  const text = promptWithAttachmentPaths(prompt, attachments.filter((attachment) => attachment.kind === 'file'))
  const images = await Promise.all(attachments.filter((attachment) => attachment.kind === 'image').map(async (attachment) => {
    const { bytes, mimeType } = await readAttachment(attachment)
    return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${bytes.toString('base64')}` } }
  }))
  return [...(text.trim() === '' ? [] : [{ type: 'text', text }]), ...images]
}

/** Claude stdin 原生支持图片内容块，包括 GIF/WebP；普通文件保留工具可读取路径。 */
export async function buildClaudeUserContent(prompt: string, attachments: readonly CodingNsCliAttachment[]): Promise<readonly Record<string, unknown>[]> {
  const text = promptWithAttachmentPaths(prompt, attachments.filter((attachment) => attachment.kind === 'file'))
  const images = await Promise.all(attachments.filter((attachment) => attachment.kind === 'image').map(async (attachment) => {
    const { bytes, mimeType } = await readAttachment(attachment)
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: bytes.toString('base64') } }
  }))
  return [...(text.trim() === '' && images.length > 0 ? [] : [{ type: 'text', text }]), ...images]
}
