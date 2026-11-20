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
