import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AntigravityContextDetails } from '../../shared/contracts/cli-adapter.js'

export function readAntigravitySessionDb<Result>(
  providerSessionId: string,
  conversationsRoot: string | undefined,
  read: (db: DatabaseSync) => Result,
): Result | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(providerSessionId)) return null
  const root = conversationsRoot ?? join(homedir(), '.gemini', 'antigravity-cli', 'conversations')
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(join(root, `${providerSessionId}.db`), { readOnly: true })
    return read(db)
  } catch {
    return null
  } finally {
    db?.close()
  }
}

const breakdownKeys = new Map<number, keyof AntigravityContextDetails['breakdown']>([
  [1, 'systemTokens'],
  [2, 'toolsTokens'],
  [4, 'toolsTokens'],
  [7, 'messageTokens'],
])

export function readAntigravityContextDetails(providerSessionId: string, conversationsRoot?: string): AntigravityContextDetails | null {
  return readAntigravitySessionDb(providerSessionId, conversationsRoot, db => {
    const row = db.prepare('SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM gen_metadata ORDER BY idx DESC LIMIT 1')
      .get(32 * 1024 * 1024)
    if (!(row?.data instanceof Uint8Array)) return null
    const context = [1, 9, 10].reduce((fields, index) => readAntigravityFields(firstAntigravityMessage(fields, index)), readAntigravityFields(row.data))
    const threshold = context.varints.get(4)
    const compactionThreshold = threshold !== undefined && Number.isSafeInteger(threshold) && threshold > 0 ? threshold : null
    const breakdown: AntigravityContextDetails['breakdown'] = {}
    const tokenBreakdown = readAntigravityFields(firstAntigravityMessage(context, 3))
    for (const groupBytes of tokenBreakdown.messages.get(1) ?? []) {
      const group = readAntigravityFields(groupBytes)
      const key = breakdownKeys.get(group.varints.get(2) ?? 0)
      const tokens = group.varints.get(4)
      if (key === undefined || tokens === undefined || !Number.isSafeInteger(tokens)) continue
      const total = (breakdown[key] ?? 0) + tokens
      if (Number.isSafeInteger(total)) breakdown[key] = total
    }
    return { compactionThreshold, breakdown }
  })
}

/** AGY 会话库里一次已完成模型调用（planner response）的实测数据。 */
export interface AntigravityRequestSample {
  readonly stepIndex: number
  readonly startedAt: number
  readonly completedAt: number
  readonly outputTokens: number
  /** 该次调用看到的上下文：未缓存输入 + 缓存读取。 */
  readonly contextTokens: number
}

export interface AntigravityRequestSamples {
  readonly samples: readonly AntigravityRequestSample[]
  /** 库里最后一个 planner response 的序号（含未完成），用作下一次读取的基线。 */
  readonly lastStepIndex: number
}

const PLANNER_RESPONSE_STEP_TYPE = 15

/**
 * ACP 通道不会像 stream-json 那样回传每次模型调用的耗时，只能读 AGY 自己的会话库。
 * 实测 planner response 的 metadata：1=开始时间，7=完成时间（秒+纳秒），
 * 9.2=输入 token，9.3=输出 token（含思考），9.5=缓存读取，与 transcript.jsonl 逐项吻合。
 * 只返回序号大于 afterStepIndex 且已有完成时间、输出大于 0 的调用；afterStepIndex 为 'latest'
 * 时返回当前最后一个序号作为基线，samples 只含最近一次已完成的调用。格式不符或库被锁时返回 null。
 */
export function readAntigravityRequestSamples(
  providerSessionId: string,
  afterStepIndex: number | 'latest',
  conversationsRoot?: string,
): AntigravityRequestSamples | null {
  return readAntigravitySessionDb(providerSessionId, conversationsRoot, db => {
    if (afterStepIndex === 'latest') {
      // 基线：只回最近一次已完成的调用，供续聊的回合一开始就显示上一次的上下文占用。
      const rows = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = ? AND metadata IS NOT NULL AND length(metadata) <= ? ORDER BY idx DESC LIMIT 8')
        .all(PLANNER_RESPONSE_STEP_TYPE, 1024 * 1024) as { idx: number; metadata: unknown }[]
      const latest = parseRequestSamples([...rows].reverse()).at(-1)
      return { samples: latest === undefined ? [] : [latest], lastStepIndex: rows[0]?.idx ?? -1 }
    }
    const rows = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = ? AND idx > ? AND metadata IS NOT NULL AND length(metadata) <= ? ORDER BY idx')
      .all(PLANNER_RESPONSE_STEP_TYPE, afterStepIndex, 1024 * 1024) as { idx: number; metadata: unknown }[]
    return { samples: parseRequestSamples(rows), lastStepIndex: rows.reduce((last, row) => Math.max(last, row.idx), afterStepIndex) }
  })
}

function parseRequestSamples(rows: readonly { idx: number; metadata: unknown }[]): AntigravityRequestSample[] {
  const samples: AntigravityRequestSample[] = []
  for (const row of rows) {
    if (!(row.metadata instanceof Uint8Array)) continue
    try {
      const metadata = readAntigravityFields(row.metadata)
      const startedAt = readAntigravityTimestamp(metadata, 1)
      const completedAt = readAntigravityTimestamp(metadata, 7)
      const usage = readAntigravityFields(firstAntigravityMessage(metadata, 9))
      const outputTokens = usage.varints.get(3)
      if (startedAt === undefined || completedAt === undefined || completedAt <= startedAt
        || outputTokens === undefined || outputTokens <= 0) continue
      samples.push({
        stepIndex: row.idx, startedAt, completedAt, outputTokens,
        contextTokens: (usage.varints.get(2) ?? 0) + (usage.varints.get(5) ?? 0),
      })
    } catch { /* 单条记录格式未知时跳过，不影响其余调用 */ }
  }
  return samples
}

/** protobuf Timestamp（1=秒，2=纳秒）转毫秒。 */
function readAntigravityTimestamp(fields: AntigravityFields, index: number): number | undefined {
  const timestamp = readAntigravityFields(firstAntigravityMessage(fields, index))
  const seconds = timestamp.varints.get(1)
  if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds <= 0) return undefined
  return seconds * 1000 + Math.floor((timestamp.varints.get(2) ?? 0) / 1e6)
}

interface AntigravityFields {
  readonly messages: Map<number, Uint8Array[]>
  readonly varints: Map<number, number>
}

export function firstAntigravityMessage(fields: AntigravityFields, index: number): Uint8Array {
  return fields.messages.get(index)?.[0] ?? new Uint8Array()
}

export function readAntigravityFields(bytes: Uint8Array): AntigravityFields {
  const messages = new Map<number, Uint8Array[]>()
  const varints = new Map<number, number>()
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
      case 0: varints.set(index, varint()); break
      case 1: offset += 8; break
      case 5: offset += 4; break
      case 2: {
        const length = varint()
        if (!Number.isSafeInteger(length) || length > bytes.length - offset) throw new Error('Truncated Antigravity protobuf field')
        const values = messages.get(index) ?? []
        values.push(bytes.subarray(offset, offset + length))
        messages.set(index, values)
        offset += length
        break
      }
      default: throw new Error('Unsupported Antigravity protobuf wire type')
    }
    if (offset > bytes.length) throw new Error('Truncated Antigravity protobuf field')
  }
  return { messages, varints }
}
