import type { TerminalTextSnapshot } from '../../shared/contracts/terminal-share.js'
import { resolveCodingNsTranslator, type CodingNsTranslator } from '../locale.js'

export const TERMINAL_SHARE_MAX_LINES = 200
export const TERMINAL_SHARE_MAX_BYTES = 32 * 1024
export const TERMINAL_LOG_REFERENCE_SOURCE = 'codingns-terminal-log'
const MAX_REFERENCE_CHARACTERS = 256 * 1024
const encoder = new TextEncoder()

/** 只依赖 xterm 的公开缓冲接口，也便于独立验证中文与软换行。 */
export interface TerminalTextReader {
  getSelection(): string
  readonly rows: number
  readonly buffer: { readonly active: {
    readonly type: 'normal' | 'alternate'
    readonly length: number
    readonly viewportY: number
    getLine(index: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
  } }
}

export type TerminalSnapshotSource = Pick<TerminalTextSnapshot, 'terminalId' | 'title' | 'sourceHostId' | 'sourceWorkspaceId' | 'cwd' | 'shell'>

/** 工具栏固定采集最近输出；选区入口只读取用户明确选中的原文。 */
export function captureTerminalSnapshot(reader: TerminalTextReader, source: TerminalSnapshotSource, selection?: string, capturedAt = new Date().toISOString()): TerminalTextSnapshot {
  if (selection !== undefined) return createTerminalSnapshot(source, 'selection', selection, capturedAt)
  const active = reader.buffer.active
  return createTerminalSnapshot(source, active.type === 'alternate' ? 'screen' : 'recent', readBufferLines(reader, 0, active.length), capturedAt)
}

function readBufferLines(reader: TerminalTextReader, start: number, end: number): string {
  const lines: string[] = []
  for (let index = start; index < end; index += 1) {
    const line = reader.buffer.active.getLine(index)
    if (line === undefined) continue
    // 软换行的前一行不能 trimRight：空格可能是日志正文，而不是屏幕补齐。
    const continued = index + 1 < end && reader.buffer.active.getLine(index + 1)?.isWrapped === true
    const text = line.translateToString(!continued)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

/** 最近输出保留尾部；显式选区保留开头，菜单提示截断后的实际分享范围。 */
export function createTerminalSnapshot(source: TerminalSnapshotSource, range: TerminalTextSnapshot['range'], raw: string, capturedAt: string): TerminalTextSnapshot {
  const normalized = raw.replace(/\r\n?/gu, '\n')
  const lines = normalized === '' ? [] : normalized.split('\n')
  const retained = range === 'recent' ? lines.slice(-TERMINAL_SHARE_MAX_LINES) : lines.slice(0, TERMINAL_SHARE_MAX_LINES)
  const candidate = retained.join('\n')
  const text = limitUtf8(candidate, TERMINAL_SHARE_MAX_BYTES, range === 'recent')
  return Object.freeze({ ...source, version: 1, capturedAt, range, text,
    lineCount: text === '' ? 0 : text.split('\n').length,
    originalLineCount: lines.length,
    truncated: retained.length < lines.length || text !== candidate,
  })
}

/** 按 Unicode 码点裁剪，不能拆开中文 UTF-8 字节或 emoji 代理对。 */
function limitUtf8(value: string, maxBytes: number, tail: boolean): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value
  const characters = Array.from(value)
  let bytes = 0
  let count = 0
  const ordered = tail ? [...characters].reverse() : characters
  for (const character of ordered) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > maxBytes) break
    bytes += size
    count += 1
  }
  return (tail ? characters.slice(-count) : characters.slice(0, count)).join('')
}

/** 引用自身携带快照，DSH 保存草稿引用时一并保存正文，不依赖内存 Map。 */
export function encodeTerminalSnapshot(snapshot: TerminalTextSnapshot): string {
  const ref = JSON.stringify(snapshot)
  decodeTerminalSnapshot(ref)
  return ref
}

export function decodeTerminalSnapshot(ref: string): TerminalTextSnapshot {
  if (ref.length > MAX_REFERENCE_CHARACTERS) throw new Error('终端日志引用超过大小限制')
  const value: unknown = JSON.parse(ref)
  if (!isSnapshot(value)) throw new Error('终端日志快照无效，请重新选择日志')
  return Object.freeze(value)
}

function isSnapshot(value: unknown): value is TerminalTextSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const strings = ['terminalId', 'title', 'sourceHostId', 'sourceWorkspaceId', 'cwd', 'shell', 'capturedAt']
  if (!strings.every((key) => typeof item[key] === 'string' && item[key].length <= 4096)) return false
  if (typeof item.text !== 'string' || encoder.encode(item.text).byteLength > TERMINAL_SHARE_MAX_BYTES) return false
  const lineCount = item.text === '' ? 0 : item.text.split('\n').length
  return item.version === 1 && ['selection', 'recent', 'screen'].includes(String(item.range))
    && Number.isFinite(Date.parse(String(item.capturedAt))) && typeof item.truncated === 'boolean'
    && item.lineCount === lineCount && lineCount <= TERMINAL_SHARE_MAX_LINES
    && Number.isSafeInteger(item.originalLineCount) && Number(item.originalLineCount) >= lineCount
}

/** 用足够长的围栏保护日志里的反引号；展开结果始终进入普通用户消息正文。 */
export function formatTerminalSnapshot(snapshot: TerminalTextSnapshot, t: CodingNsTranslator = resolveCodingNsTranslator()): string {
  const range = t(`terminalShare.range.${snapshot.range}`)
  const runs = snapshot.text.match(/`+/gu) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  return [t('terminalShare.snapshot.heading'),
    t('terminalShare.snapshot.terminal', { title: snapshot.title }),
    t('terminalShare.snapshot.host', { host: snapshot.sourceHostId }),
    t('terminalShare.snapshot.workspace', { workspace: snapshot.sourceWorkspaceId }),
    t('terminalShare.snapshot.cwd', { cwd: snapshot.cwd }),
    t('terminalShare.snapshot.shell', { shell: snapshot.shell }),
    t('terminalShare.snapshot.time', { time: snapshot.capturedAt }),
    t('terminalShare.snapshot.range', { range, lines: snapshot.lineCount }),
    t(snapshot.truncated ? 'terminalShare.snapshot.truncated' : 'terminalShare.snapshot.complete'),
    '', `${fence}text`, snapshot.text, fence,
  ].join('\n')
}
