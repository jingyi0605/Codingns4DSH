import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CodingNsAgentImageArtifact } from '../../shared/contracts/cli-adapter.js'

export interface AntigravityToolDetailRequest {
  readonly providerSessionId: string
  readonly stepIndex?: number
  readonly callId?: string
  readonly toolName: string
  readonly parameters?: Record<string, unknown>
}

export interface AntigravityToolDetail {
  readonly parameters: Record<string, unknown>
  readonly output?: string
  readonly error?: string
  readonly images?: readonly CodingNsAgentImageArtifact[]
}

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * AGY 1.5.9 的 stream-json 只发路径/摘要，原生 SQLite 才保存实际调用参数及结果。
 * 只按本轮协议给出的 conversation + step_index 定位 tool step；不扫描其他会话，
 * 不打开工具参数中的路径，不回写数据库。格式未知、锁定或缺失时保留 wire 信息。
 */
export function readAntigravityToolDetail(
  request: AntigravityToolDetailRequest,
  conversationsRoot = join(homedir(), '.gemini', 'antigravity-cli', 'conversations'),
): AntigravityToolDetail | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(request.providerSessionId)
    || (request.stepIndex === undefined ? !request.callId : !Number.isSafeInteger(request.stepIndex) || request.stepIndex < 0)) return null
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(join(conversationsRoot, `${request.providerSessionId}.db`), { readOnly: true })
    const row = request.stepIndex !== undefined
      ? db.prepare('SELECT step_payload FROM steps WHERE idx = ? AND step_type = 132 AND length(step_payload) <= ?').get(request.stepIndex, MAX_PAYLOAD_BYTES)
      : db.prepare('SELECT step_payload FROM steps WHERE step_type = 132 AND instr(metadata, ?) > 0 AND length(step_payload) <= ? ORDER BY idx DESC LIMIT 1').get(Buffer.from(request.callId!), MAX_PAYLOAD_BYTES)
    if (!(row?.step_payload instanceof Uint8Array)) return null
    return decodeToolDetail(row.step_payload, request)
  } catch {
    // 此补充来源不能中断正在运行的 Provider，也不能将原始数据库内容写入日志。
    return null
  } finally {
    db?.close()
  }
}

function decodeToolDetail(bytes: Uint8Array, request: AntigravityToolDetailRequest): AntigravityToolDetail | null {
  // 实测 exa.cortex step: metadata=5, metadata.tool_call=4;
  // tool_execution=140, tool_execution.result=2, result.text=1, result.images=4。
  const step = fields(bytes)
  const call = fields(first(fields(first(step, 5)), 4))
  if (request.callId !== undefined && text(call, 1) !== request.callId) return null
  if (text(call, 2) !== request.toolName) return null
  const value: unknown = JSON.parse(text(call, 3) ?? 'null')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const parameters = value as Record<string, unknown>
  // 同一索引与名称还须匹配 wire 已提供的文件路径，防止读取不相干的旧步骤。
  if (typeof request.parameters?.Path === 'string' && parameters.Path !== request.parameters.Path) return null
  const result = fields(first(fields(first(step, 140)), 2))
  const output = text(result, 1)
  // 失败步骤的错误位于 step.error(31)，不是 tool_execution.result。
  const failure = fields(first(step, 31))
  const error = text(failure, 2) || text(failure, 3)
  const images: CodingNsAgentImageArtifact[] = []
  for (const bytes of result.get(4) ?? []) {
    const image = fields(bytes)
    const mediaType = text(image, 1)
    const data = image.get(2)?.[0]
    if (mediaType === undefined || !IMAGE_TYPES.has(mediaType) || data === undefined || data.length === 0) continue
    images.push({ type: 'image-artifact', data: Buffer.from(data).toString('base64'), mediaType: mediaType as NonNullable<CodingNsAgentImageArtifact['mediaType']> })
  }
  return {
    parameters,
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    ...(images.length === 0 ? {} : { images }),
  }
}

/** 只读取已确认的 length-delimited 字段；未知 protobuf 字段跳过，不猜测内容类型。 */
function fields(bytes: Uint8Array): Map<number, Uint8Array[]> {
  const result = new Map<number, Uint8Array[]>()
  let offset = 0
  const varint = (): number => {
    let value = 0
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = bytes[offset++]
      if (byte === undefined) throw new Error('Truncated Antigravity protobuf')
      value += (byte & 127) * 2 ** shift
      if (byte < 128) return value
    }
    throw new Error('Invalid Antigravity protobuf varint')
  }
  while (offset < bytes.length) {
    const tag = varint()
    const index = Math.floor(tag / 8)
    if (!Number.isSafeInteger(tag) || index === 0) throw new Error('Invalid Antigravity protobuf tag')
    switch (tag % 8) {
      case 0: varint(); break
      case 1: offset += 8; break
      case 5: offset += 4; break
      case 2: {
        const length = varint()
        if (!Number.isSafeInteger(length) || length > bytes.length - offset) throw new Error('Truncated Antigravity protobuf field')
        const values = result.get(index) ?? []
        values.push(bytes.subarray(offset, offset + length))
        result.set(index, values)
        offset += length
        break
      }
      default: throw new Error('Unsupported Antigravity protobuf wire type')
    }
    if (offset > bytes.length) throw new Error('Truncated Antigravity protobuf field')
  }
  return result
}

function first(value: Map<number, Uint8Array[]>, index: number): Uint8Array {
  return value.get(index)?.[0] ?? new Uint8Array()
}

function text(value: Map<number, Uint8Array[]>, index: number): string | undefined {
  const bytes = value.get(index)?.[0]
  return bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
