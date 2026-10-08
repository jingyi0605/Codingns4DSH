import { copyFile, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// v4 文件也可能是由旧版插件直接写入的裸 tool/call；DSH 0.1.7
// 会在恢复时直接拒绝它，因此必须在 open 边界前一并修复。
const LEGACY_FILE = /^session\.v[34]\.(jsonl|jsonl\.zstd)$/u
const REFERENCE_KEYS = new Set([
  'sourceEventSeq',
  'sourceEventSeqs',
  'headerSeq',
  'throughSeq',
  'messageSeqs',
  'shadowedSeqs',
  'startSeq',
  'endSeq',
])

export interface LegacySessionRepairOptions {
  readonly root: string
  /** 指定时仅定位该会话，不递归遍历其他会话目录。省略供显式离线全量修复使用。 */
  readonly sessionId?: string
  readonly signal?: AbortSignal
  readonly logger?: (message: string, error?: unknown) => void
}

export interface LegacySessionRepairReport {
  readonly scanned: number
  readonly repaired: number
  readonly skipped: number
  readonly failed: number
}

interface SessionEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly [key: string]: unknown
}

interface ParsedLog {
  readonly header: Record<string, unknown>
  readonly events: readonly SessionEvent[]
  readonly compression: 'none' | 'zstd'
}

/**
 * 在官方 v3->v4 迁移前修复外部 Agent 写入的裸 tool/call。
 * 每个文件独立处理，单文件失败不会影响其他历史会话。
 */
export async function repairLegacySessionLogs(options: LegacySessionRepairOptions): Promise<LegacySessionRepairReport> {
  const files = options.sessionId === undefined
    ? await findLegacyLogs(options.root, options.signal)
    : await findSessionLogs(options.root, options.sessionId, options.signal)
  let repaired = 0
  let skipped = 0
  let failed = 0
  for (const path of files) {
    throwIfAborted(options.signal)
    try {
      const result = await repairLegacySessionLog(path, options.signal)
      if (result) repaired += 1
      else skipped += 1
    } catch (error) {
      failed += 1
      options.logger?.(`历史会话修复失败：${path}`, error)
    }
  }
  return { scanned: files.length, repaired, skipped, failed }
}

/** 同一会话只检查一次，并发打开共用修复；失败和不存在的会话允许下次重试。 */
export function createLegacySessionRepair(options: Omit<LegacySessionRepairOptions, 'sessionId'>): (sessionId: string) => Promise<LegacySessionRepairReport> {
  const pending = new Map<string, Promise<LegacySessionRepairReport>>()
  // 只缓存成功结果，且限定数量，避免长期运行的 Host 随会话数量无限增长。
  const completed = new Map<string, LegacySessionRepairReport>()
  return (sessionId) => {
    const cached = completed.get(sessionId)
    if (cached !== undefined) return Promise.resolve(cached)
    const running = pending.get(sessionId)
    if (running !== undefined) return running
    const repair = repairLegacySessionLogs({ ...options, sessionId }).then((report) => {
      if (report.failed === 0 && report.scanned > 0) {
        completed.set(sessionId, report)
        if (completed.size > 2000) completed.delete(completed.keys().next().value!)
      }
      return report
    }).finally(() => { pending.delete(sessionId) })
    pending.set(sessionId, repair)
    return repair
  }
}

/**
 * DSH JSONL 布局为 root/项目目录/编码后的会话 ID/session.vN.jsonl[.zstd]。
 * 只列项目目录并探测目标会话，开一个会话不再解压全部历史日志。
 */
async function findSessionLogs(root: string, sessionId: string, signal?: AbortSignal): Promise<string[]> {
  if (sessionId.length === 0) return []
  throwIfAborted(signal)
  let projects
  try { projects = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  const result: string[] = []
  const segment = encodeSessionSegment(sessionId)
  for (const project of projects) {
    throwIfAborted(signal)
    if (!project.isDirectory()) continue
    const directory = join(root, project.name, segment)
    try {
      // 与全量扫描一致，不跟随会话目录的符号链接。
      if (!(await lstat(directory)).isDirectory()) continue
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && LEGACY_FILE.test(entry.name)) result.push(join(directory, entry.name))
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
  return result
}

/** 对齐 DSH session-persistence-jsonl 的 encodeSegment（按 UTF-16 编码，不能使用 URI 编码）。 */
function encodeSessionSegment(id: string): string {
  if (id === '.' || id === '..') return '~002E'.repeat(id.length)
  return id.replace(/[^A-Za-z0-9._-]/g, (unit) => `~${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}

/** 修复一个 v3/v4 日志；返回 true 表示已发布修复文件。 */
export async function repairLegacySessionLog(path: string, signal?: AbortSignal): Promise<boolean> {
  const source = await readFileBytes(path)
  throwIfAborted(signal)
  const parsed = decodeLog(path, source)
  // 0.2 使用 V4；未知的更高 generation 必须交给官方迁移器，插件不能重排
  // 它的 event envelope，否则 repair 会把新 projection 引用改写成旧语义。
  const generation = sessionHeaderVersion(parsed.header)
  if (generation !== undefined && generation > 4) return false
  const repaired = repairEvents(parsed.events, isV4Log(path, parsed.header))
  if (repaired === null) return false
  throwIfAborted(signal)
  await publishRepair(path, parsed.header, repaired, parsed.compression, source, signal)
  return true
}

async function findLegacyLogs(root: string, signal?: AbortSignal): Promise<string[]> {
  const result: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    throwIfAborted(signal)
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile() && LEGACY_FILE.test(entry.name)) result.push(path)
    }
  }
  return result
}

async function readFileBytes(path: string): Promise<Buffer> {
  const readBinary = readFile as unknown as (target: string) => Promise<Buffer>
  return readBinary(path)
}

function decodeLog(path: string, bytes: Buffer): ParsedLog {
  const compression = path.endsWith('.zstd') ? 'zstd' : 'none'
  const text = compression === 'zstd' ? decodeZstd(bytes) : bytes.toString('utf8')
  const rows = text.split('\n').filter((line) => line.trim() !== '').map((line, index) => {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value)) throw new Error(`历史会话第 ${String(index + 1)} 行不是对象`)
    return value
  })
  const header = rows.shift()
  if (header === undefined || header.type !== 'session') throw new Error('历史会话缺少 session 头')
  const events = rows.map((row, index) => {
    if (typeof row.seq !== 'number' || row.seq !== index) throw new Error(`历史会话 seq 不连续：期望 ${String(index)}，得到 ${String(row.seq)}`)
    if (typeof row.type !== 'string') throw new Error(`历史会话事件 ${String(index)} 缺少 type`)
    return row as SessionEvent
  })
  return { header, events, compression }
}

function decodeZstd(bytes: Buffer): string {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    const next = bytes.indexOf(ZSTD_MAGIC, offset + 1)
    const frame = bytes.subarray(offset, next === -1 ? bytes.length : next)
    chunks.push(zstdDecompressSync(frame))
    offset = next === -1 ? bytes.length : next
  }
  return Buffer.concat(chunks).toString('utf8')
}

function repairEvents(events: readonly SessionEvent[], canonicalizeV4Results = false): SessionEvent[] | null {
  const mapping: number[] = []
  const insertBefore = new Map<number, { callId: string; name: string; arguments: string; turn: number; step: number }>()
  const pending = new Set<string>()
  const normalizedAssistantMessages = new Map<number, SessionEvent>()
  let canonicalized = false
  for (const event of events) {
    const oldSeq = event.seq!
    if (event.type === 'assistant/message') registerDeclaredCalls(event, pending)
    if (event.type === 'tool/call') {
      const call = toolCallData(event)
      if (call !== null && !pending.has(call.callId)) {
        insertBefore.set(oldSeq, call)
        pending.add(call.callId)
      }
      if (call !== null) pending.add(call.callId)
    }
    if (event.type === 'tool/result') {
      const callId = toolResultCallId(event)
      if (callId !== null) pending.delete(callId)
    }
  }
  const declaredExternalCalls = new Set<string>()
  for (const event of events) {
    if (event.type === 'step/start' || event.type === 'turn/start') declaredExternalCalls.clear()
    const normalized = canonicalizeExternalAssistantMessage(event, declaredExternalCalls)
    if (normalized !== event) {
      normalizedAssistantMessages.set(event.seq!, normalized)
      canonicalized = true
    }
    if (event.type === 'step/end' || event.type === 'turn/end') declaredExternalCalls.clear()
  }
  if (insertBefore.size === 0 && !canonicalizeV4Results && !canonicalized) return null
  if (canonicalizeV4Results) {
    for (const event of events) {
      if (canonicalizeV4ToolResult(event) !== event) {
        canonicalized = true
        break
      }
    }
  }
  if (insertBefore.size === 0 && !canonicalized) return null

  let nextSeq = 0
  for (const event of events) {
    const oldSeq = event.seq!
    if (insertBefore.has(oldSeq)) nextSeq += 1
    mapping[oldSeq] = nextSeq
    nextSeq += 1
  }

  const output: SessionEvent[] = []
  for (const event of events) {
    const oldSeq = event.seq!
    const call = insertBefore.get(oldSeq)
    if (call !== undefined) output.push(createDeclaration(event, call, mapping[oldSeq]! - 1))
    const deduplicated = normalizedAssistantMessages.get(oldSeq) ?? event
    const normalized = canonicalizeV4Results ? canonicalizeV4ToolResult(deduplicated) : deduplicated
    output.push(remapEvent(normalized, mapping[oldSeq]!, mapping))
  }
  return output
}

function isV4Log(path: string, header: Record<string, unknown>): boolean {
  return header.version === 4 || /\.v4\.jsonl(?:\.zstd)?$/u.test(path)
}

function sessionHeaderVersion(header: Record<string, unknown>): number | undefined {
  const direct = header.version
  if (typeof direct === 'number' && Number.isSafeInteger(direct) && direct >= 0) return direct
  const data = header.data
  if (isRecord(data) && typeof data.version === 'number' && Number.isSafeInteger(data.version) && data.version >= 0) return data.version
  return undefined
}

/** 将插件旧版在 V4 文件中留下的 V3 tool-result wrapper 提升为 tool-role 消息。 */
function canonicalizeV4ToolResult(event: SessionEvent): SessionEvent {
  if (event.type !== 'tool/result') return event
  const data = isRecord(event.data) ? event.data : undefined
  const message = data && isRecord(data.message) ? data.message : undefined
  if (message?.role !== 'user') return event
  const source = isRecord(message.source) ? message.source : undefined
  const callId = source?.kind === 'tool' && typeof source.callId === 'string' ? source.callId : undefined
  const content = message.content
  if (callId === undefined || !Array.isArray(content) || content.length !== 1) return event
  const wrapper = content[0]
  if (!isRecord(wrapper) || wrapper.type !== 'tool-result' || wrapper.toolCallId !== callId || !Array.isArray(wrapper.content)) return event
  if (wrapper.isError !== undefined && typeof wrapper.isError !== 'boolean') return event
  const { content: _legacyContent, ...rest } = message
  const normalizedMessage = {
    ...rest,
    role: 'tool',
    toolCallId: callId,
    content: wrapper.content,
    ...(wrapper.isError === undefined ? {} : { isError: wrapper.isError }),
  }
  return { ...event, data: { ...data, message: normalizedMessage } }
}

/** 删除外部适配器累积消息中的历史 tool-call，保留当前消息新增的声明。 */
function canonicalizeExternalAssistantMessage(event: SessionEvent, declared: Set<string>): SessionEvent {
  if (event.type !== 'assistant/message') return event
  const data = isRecord(event.data) ? event.data : undefined
  const message = data && isRecord(data.message) ? data.message : undefined
  if (!message || !Array.isArray(message.content) || !Array.isArray(data?.stream) || data.stream.length !== 0) return event
  let changed = false
  const content = message.content.filter((block) => {
    if (!isRecord(block) || block.type !== 'tool-call' || typeof block.id !== 'string') return true
    if (declared.has(block.id)) {
      changed = true
      return false
    }
    declared.add(block.id)
    return true
  })
  return changed ? { ...event, data: { ...data, message: { ...message, content } } } : event
}

function registerDeclaredCalls(event: SessionEvent, pending: Set<string>): void {
  const data = isRecord(event.data) ? event.data : undefined
  const message = data && isRecord(data.message) ? data.message : undefined
  const content = message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool-call' || typeof block.id !== 'string') continue
    pending.add(block.id)
  }
}

function toolCallData(event: SessionEvent): { callId: string; name: string; arguments: string; turn: number; step: number } | null {
  const data = isRecord(event.data) ? event.data : undefined
  if (!data || typeof data.callId !== 'string' || typeof data.name !== 'string' || typeof data.arguments !== 'string') return null
  if (!Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) return null
  return { callId: data.callId, name: data.name, arguments: data.arguments, turn: data.turn, step: data.step }
}

function toolResultCallId(event: SessionEvent): string | null {
  const data = isRecord(event.data) ? event.data : undefined
  const message = data && isRecord(data.message) ? data.message : undefined
  if (typeof message?.toolCallId === 'string') return message.toolCallId
  const content = message?.content
  if (!Array.isArray(content) || content.length !== 1) return null
  const wrapper = content[0]
  return isRecord(wrapper) && wrapper.type === 'tool-result' && typeof wrapper.toolCallId === 'string'
    ? wrapper.toolCallId
    : null
}

function createDeclaration(event: SessionEvent, call: { callId: string; name: string; arguments: string; turn: number; step: number }, seq: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    ...(typeof event.time === 'number' ? { time: event.time } : {}),
    data: {
      turn: call.turn,
      step: call.step,
      message: {
        id: `external-tool-${call.callId}-${call.turn}-${call.step}`,
        role: 'assistant',
        content: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: call.arguments }],
        source: { kind: 'model', provider: 'codingns-external', model: 'external-agent' },
      },
      stream: [],
    },
    surfaceOp: 'append',
  }
}

function remapEvent(event: SessionEvent, seq: number, mapping: readonly number[]): SessionEvent {
  if (seq === event.seq) return event
  const data = remapReferences(event.data, mapping)
  const surfaceOp = remapReferences(event.surfaceOp, mapping)
  const sourceEventSeqs = event.sourceEventSeqs === undefined ? undefined : event.sourceEventSeqs.map((value) => mapReference(value, mapping))
  return {
    ...event,
    seq,
    ...(data === event.data ? {} : { data }),
    ...(surfaceOp === event.surfaceOp ? {} : { surfaceOp }),
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

function remapReferences(value: unknown, mapping: readonly number[], key?: string, range = false, targetSeq = false): unknown {
  if (typeof value === 'number' && key !== undefined && (REFERENCE_KEYS.has(key) || range && (key === 'start' || key === 'end') || targetSeq && key === 'seq')) return mapReference(value, mapping)
  if (Array.isArray(value)) return value.map((item) => remapReferences(item, mapping, key, range, targetSeq))
  if (!isRecord(value)) return value
  let changed = false
  const copy: Record<string, unknown> = {}
  for (const [childKey, child] of Object.entries(value)) {
    const mapped = remapReferences(child, mapping, childKey, key === 'shadowedRange', key === 'targets' || targetSeq)
    copy[childKey] = mapped
    changed ||= mapped !== child
  }
  return changed ? copy : value
}

function mapReference(value: number, mapping: readonly number[]): number {
  const mapped = mapping[value]
  if (mapped === undefined) throw new Error(`历史会话引用了不存在的 seq：${String(value)}`)
  return mapped
}

async function publishRepair(
  path: string,
  header: Record<string, unknown>,
  events: readonly SessionEvent[],
  compression: 'none' | 'zstd',
  original: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'codingns-session-repair-'))
  const tempPath = join(tempDir, basename(path))
  const backupPath = `${path}.codingns-repair-backup`
  try {
    const body = [header, ...events].map((value) => `${JSON.stringify(value)}\n`).join('')
    const encoded = compression === 'zstd'
      ? Buffer.concat([zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)), zstdCompressSync(Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join('')))])
      : Buffer.from(body)
    const writeBinary = writeFile as unknown as (target: string, data: Uint8Array, options: { flag: string; mode: number }) => Promise<void>
    await writeBinary(tempPath, encoded, { flag: 'wx', mode: 0o600 })
    throwIfAborted(signal)
    if (!(await sameBytes(path, original))) throw new Error('历史会话在修复期间发生变化')
    try {
      await copyFile(path, backupPath, 1)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    await replaceFile(tempPath, path, `${path}.codingns-repair-displaced-${basename(tempDir)}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/** POSIX rename 可以直接替换；Windows 在目标存在时先暂存旧文件再发布。 */
async function replaceFile(tempPath: string, targetPath: string, displacedPath: string): Promise<void> {
  try {
    await rename(tempPath, targetPath)
    return
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error
  }
  await rename(targetPath, displacedPath)
  try {
    await rename(tempPath, targetPath)
  } catch (error) {
    try { await rename(displacedPath, targetPath) } catch {}
    throw error
  }
  await rm(displacedPath, { force: true })
}

async function sameBytes(path: string, expected: Buffer): Promise<boolean> {
  try {
    const current = await readFileBytes(path)
    return current.equals(expected)
  } catch {
    return false
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('历史会话修复已取消')
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}
