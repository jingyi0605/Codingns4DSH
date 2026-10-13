import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { CodingNsAgentImageArtifact } from '../shared/contracts/cli-adapter.js'

/** 单个外部 Agent 图片产物的读取上限；最终仍由 DSH attachments 再做一次校验。 */
export const CODINGNS_IMAGE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024

export interface CodingNsImageArtifactBytes {
  readonly data: Uint8Array
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly name?: string
}

/** 从 Provider 事件中提取本地图片路径；远程 URL、data URL 和普通文本都会被忽略。 */
export function imageArtifactPathsFromValue(value: unknown, key = '', depth = 0): readonly string[] {
  if (depth > 6) return []
  if (typeof value === 'string') {
    const paths: string[] = []
    const markdown = /!\[[^\]]*\]\(\s*[<]?([^)>\s]+)[>]?(?:\s+[^)]*)?\)/gu
    for (const match of value.matchAll(markdown)) {
      const candidate = match[1]
      if (candidate !== undefined && isLocalImagePath(candidate)) paths.push(candidate)
    }
    if (paths.length === 0 && (key === '' || isImagePathKey(key)) && isLocalImagePath(value)) paths.push(value)
    return dedupeImagePaths(paths)
  }
  if (Array.isArray(value)) return dedupeImagePaths(value.flatMap((item) => imageArtifactPathsFromValue(item, key, depth + 1)))
  if (!isRecord(value)) return []
  return dedupeImagePaths(Object.entries(value).flatMap(([childKey, childValue]) => imageArtifactPathsFromValue(childValue, childKey, depth + 1)))
}

/** 从 Provider 正文移除已单独投影为 image block 的 Markdown 图片，避免留下坏图标。 */
export function stripImageMarkdown(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text
  const allowed = new Set(paths)
  return text.replace(/!\[[^\]]*\]\(\s*[<]?([^)>\s]+)[>]?(?:\s+[^)]*)?\)/gu, (full, rawPath: string) => allowed.has(rawPath) ? '' : full)
}

/**
 * 读取 Provider 产物时只接受普通图片文件。
 *
 * Provider 返回的路径是不可信输入：不能因为它来自本机 CLI 就直接把任意文件
 * 交给浏览器。这里先限制绝对普通文件、大小和图片 magic，再交给 DSH 的附件
 * 服务生成持久化引用。
 */
export async function readCodingNsImageArtifact(artifact: CodingNsAgentImageArtifact): Promise<CodingNsImageArtifactBytes> {
  const inline = artifact.data === undefined ? undefined : decodeInlineImage(artifact.data)
  const filePath = artifact.path?.trim()
  if (inline === undefined && (filePath === undefined || !isAbsolute(filePath) || filePath.includes('\u0000'))) {
    throw new Error('外部 Agent 图片产物路径或内联数据无效')
  }
  let data: Buffer
  if (inline !== undefined) {
    data = inline.data
  } else {
    const info = await stat(filePath!)
    if (!info.isFile()) throw new Error('外部 Agent 图片产物不是普通文件')
    if (info.size > CODINGNS_IMAGE_ARTIFACT_MAX_BYTES) throw new Error('外部 Agent 图片产物超过 64 MiB')
    data = await readFile(filePath!)
  }
  if (data.byteLength > CODINGNS_IMAGE_ARTIFACT_MAX_BYTES) throw new Error('外部 Agent 图片产物超过 64 MiB')
  const mediaType = detectImageMediaType(data)
  if (mediaType === undefined) throw new Error('外部 Agent 图片产物格式不受支持')
  if (inline?.mediaType !== undefined && inline.mediaType !== mediaType) {
    throw new Error('外部 Agent 图片产物 MIME 类型与文件内容不一致')
  }
  if (artifact.mediaType !== undefined && artifact.mediaType !== mediaType) {
    throw new Error('外部 Agent 图片产物 MIME 类型与文件内容不一致')
  }
  const rawName = artifact.name ?? (filePath === undefined ? undefined : basename(filePath))
  const name = rawName === undefined ? undefined : safeImageName(rawName)
  return { data, mediaType, ...(name === undefined ? {} : { name }) }
}

function decodeInlineImage(value: string): { readonly data: Buffer; readonly mediaType?: string } | undefined {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/u.exec(value.trim())
  const encoded = match?.[2] ?? value.trim()
  if (encoded === '' || encoded.length > Math.ceil(CODINGNS_IMAGE_ARTIFACT_MAX_BYTES / 3) * 4
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return undefined
  const data = Buffer.from(encoded, 'base64')
  if (data.length === 0 || data.length > CODINGNS_IMAGE_ARTIFACT_MAX_BYTES) return undefined
  return { data, ...(match?.[1] === undefined ? {} : { mediaType: match[1].toLowerCase() }) }
}

function isLocalImagePath(value: string): boolean {
  const candidate = value.trim()
  return candidate !== ''
    && !candidate.includes('\u0000')
    && !/[\r\n]/u.test(candidate)
    && (candidate.includes('/') || candidate.includes('\\') || !/\s/u.test(candidate))
    && !/^(?:data:|https?:|file:|blob:)/iu.test(candidate)
    && mediaTypeFromPath(candidate) !== undefined
}

function isImagePathKey(key: string): boolean {
  return /(?:image|artifact|output|file)[_-]?(?:path|file|url)?$/iu.test(key)
}

function dedupeImagePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].slice(0, 8)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function detectImageMediaType(data: Uint8Array): CodingNsImageArtifactBytes['mediaType'] | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && new TextDecoder().decode(data.subarray(0, 6)) === 'GIF87a') return 'image/gif'
  if (data.length >= 6 && new TextDecoder().decode(data.subarray(0, 6)) === 'GIF89a') return 'image/gif'
  if (data.length >= 12
    && new TextDecoder().decode(data.subarray(0, 4)) === 'RIFF'
    && new TextDecoder().decode(data.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

function mediaTypeFromPath(filePath: string): CodingNsImageArtifactBytes['mediaType'] | undefined {
  switch (extname(filePath).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}

function safeImageName(value: string): string | undefined {
  const name = basename(value.replaceAll('\\', '/')).normalize('NFC')
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/gu, '_')
    .replace(/^[. ]+|[. ]+$/gu, '')
  return name === '' ? undefined : name.slice(0, 180)
}
