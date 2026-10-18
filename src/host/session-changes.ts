import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve } from 'node:path'
import type { SessionChangedFiles } from '../shared/contracts/file-management.js'
import type { CodingNsHostServices } from './features/types.js'

const PATH_KEYS = new Set([
  'path', 'paths', 'filePath', 'file_path', 'target_file', 'srcPath', 'src_path',
  'dstPath', 'dst_path', 'oldPath', 'old_path', 'newPath', 'new_path',
  'sourcePath', 'source_path', 'targetPath', 'target_path',
  'source', 'destination', 'from', 'to',
])

const MUTATING_TOOL_NAMES = new Set([
  'write', 'write_file', 'file_write', 'create', 'create_file', 'new_file',
  'edit', 'edit_file', 'file_edit', 'search_replace', 'str_replace', 'string_replace',
  'apply_patch', 'apply_patch_file', 'patch',
  'delete', 'delete_file', 'file_delete', 'remove', 'remove_file',
  'rename', 'rename_file', 'file_rename', 'move', 'move_file', 'file_move',
  'copy', 'copy_file', 'file_copy', 'mkdir', 'make_directory', 'create_directory',
])

interface ToolCallRecord {
  name: string
  input?: unknown
}

/** 优先从 DSH 原生 Session 事件读取，原生事件不可用时回退到 JSONL。 */
export async function readSessionChangedFiles(
  services: CodingNsHostServices,
  sessionId: string,
  workspaceRoot: string,
): Promise<SessionChangedFiles> {
  let session = services.nativeSessions?.get(sessionId)
  if (session === undefined && services.nativeSessions?.listRemote !== undefined) {
    try {
      const candidates = await services.nativeSessions.listRemote()
      session = candidates.find((candidate) => sessionIdentity(candidate) === sessionId)
    } catch {
      // 原生列表接口不可用时继续走 JSONL 降级。
    }
  }
  const root = resolve(workspaceRoot)
  const nativeEvents = snapshotEvents(session)
  const nativePaths = extractToolPaths(nativeEvents, root)
  if (nativePaths.size > 0) return { paths: [...nativePaths].sort() }

  const jsonlPath = findJsonlReference(session)
  if (jsonlPath === undefined) return { paths: [] }
  try {
    const content = await readFile(jsonlPath, 'utf8')
    const events = content.split(/\r?\n/u).flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        return [parsed]
      } catch {
        return []
      }
    })
    return { paths: [...extractToolPaths(events, root)].sort() }
  } catch {
    // JSONL 是降级数据源；文件不存在或不可读时保持可解释的空结果。
    return { paths: [] }
  }
}

function snapshotEvents(value: unknown): readonly unknown[] {
  if (!isRecord(value)) return []
  if (typeof value.snapshotEvents === 'function') {
    try {
      const events: unknown = value.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {
      // 单个会话损坏时继续尝试其内嵌事件数组。
    }
  }
  return Array.isArray(value.events) ? value.events : []
}

function extractToolPaths(events: readonly unknown[], workspaceRoot: string): Set<string> {
  const paths = new Set<string>()
  const calls = new Map<string, ToolCallRecord>()
  const callsWithoutId: ToolCallRecord[] = []
  for (const candidate of events) {
    const event = isRecord(candidate) ? candidate : undefined
    if (event === undefined) continue
    const data = isRecord(event.data) ? event.data : event
    if (event.type === 'assistant/message') {
      registerAssistantToolCalls(data, calls, callsWithoutId)
      continue
    }
    if (event.type === 'tool/call') {
      registerToolCall(data, calls, callsWithoutId)
      continue
    }
    if (event.type !== 'tool/result') continue

    const message = isRecord(data.message) ? data.message : undefined
    const callId = toolCallId(data) ?? toolCallId(message)
    const call = callId === undefined
      ? callsWithoutId.shift()
      : calls.get(callId)
    if (!isSuccessfulToolResult(data, message)) continue

    // DSH 原生 edit/write 结果会把真实变更放在 meta.diffs。Diff 本身已经
    // 是“成功写入”的事实，即使历史里缺少对应的 tool/call 也可以安全使用。
    collectResultDiffPaths(data, message, workspaceRoot, paths)
    collectNestedMutationPaths(call?.input, workspaceRoot, paths)
    collectNestedMutationPaths(data, workspaceRoot, paths)

    const toolName = call?.name ?? toolNameFrom(data, message)
    if (toolName !== undefined && isMutatingTool(toolName)) {
      collectInputPaths(call?.input, workspaceRoot, paths)
    }
  }
  return paths
}

function registerAssistantToolCalls(
  data: Record<string, unknown>,
  calls: Map<string, ToolCallRecord>,
  callsWithoutId: ToolCallRecord[],
): void {
  const message = isRecord(data.message) ? data.message : undefined
  const content = message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool-call') continue
    registerToolCall(block, calls, callsWithoutId)
  }
}

function registerToolCall(
  value: Record<string, unknown>,
  calls: Map<string, ToolCallRecord>,
  callsWithoutId: ToolCallRecord[],
): void {
  const name = toolNameFrom(value)
  if (name === undefined) return
  const input = value.arguments ?? value.input ?? value.params ?? value.parameters
  const callId = toolCallId(value)
  if (callId === undefined) {
    callsWithoutId.push({ name, ...(input === undefined ? {} : { input }) })
    return
  }
  const previous = calls.get(callId)
  calls.set(callId, {
    name,
    ...(input === undefined ? previous?.input === undefined ? {} : { input: previous.input } : { input }),
  })
}

function toolCallId(value: Record<string, unknown> | undefined): string | undefined {
  if (value === undefined) return undefined
  for (const key of ['callId', 'callID', 'toolCallId', 'tool_call_id', 'id']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  const source = isRecord(value.source) ? value.source : undefined
  const sourceId = source?.callId
  return typeof sourceId === 'string' && sourceId.trim() !== '' ? sourceId.trim() : undefined
}

function toolNameFrom(...values: readonly (Record<string, unknown> | undefined)[]): string | undefined {
  for (const value of values) {
    if (value === undefined) continue
    for (const key of ['name', 'tool', 'toolName', 'tool_name']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
  }
  return undefined
}

function isSuccessfulToolResult(data: Record<string, unknown>, message: Record<string, unknown> | undefined): boolean {
  if (data.isError === true || message?.isError === true) return false
  if (hasError(data.error) || hasError(message?.error)) return false
  for (const value of [data.status, message?.status]) {
    if (typeof value !== 'string') continue
    const status = value.trim().toLowerCase()
    if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'aborted'].includes(status)) return false
  }
  return true
}

function hasError(value: unknown): boolean {
  if (value === undefined || value === null) return false
  return typeof value !== 'string' || value.trim() !== ''
}

function isMutatingTool(value: string): boolean {
  // Older Grok projections persisted display titles as tool names. Recover
  // their arguments without treating the title itself as evidence of a path.
  const normalized = value.trim()
    .replace(/^(Edit|Write) `[^`]+`$/u, '$1')
    .replace(/([a-z])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/gu, '_')
  return MUTATING_TOOL_NAMES.has(normalized)
}

function collectResultDiffPaths(
  data: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  workspaceRoot: string,
  paths: Set<string>,
): void {
  for (const value of [data.meta, data.metadata, message?.meta, message?.metadata]) {
    collectDiffPaths(value, workspaceRoot, paths)
  }
}

function collectDiffPaths(value: unknown, workspaceRoot: string, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDiffPaths(item, workspaceRoot, paths)
    return
  }
  if (!isRecord(value)) return
  const diffs = value.diffs
  if (Array.isArray(diffs)) {
    for (const diff of diffs) collectDiffEntryPaths(diff, workspaceRoot, paths)
  }
}

function collectDiffEntryPaths(value: unknown, workspaceRoot: string, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDiffEntryPaths(item, workspaceRoot, paths)
    return
  }
  if (!isRecord(value)) return
  for (const key of ['path', 'oldPath', 'old_path', 'newPath', 'new_path']) {
    const candidate = value[key]
    if (typeof candidate === 'string') addPath(candidate, workspaceRoot, paths)
  }
}

function collectNestedMutationPaths(value: unknown, workspaceRoot: string, paths: Set<string>): void {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return
    try { collectNestedMutationPaths(JSON.parse(trimmed) as unknown, workspaceRoot, paths) } catch {
      // 工具参数不是 JSON 时没有可安全判断的嵌套调用。
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNestedMutationPaths(item, workspaceRoot, paths)
    return
  }
  if (!isRecord(value)) return
  for (const key of ['toolCalls', 'tool_calls']) {
    const nested = value[key]
    if (!Array.isArray(nested)) continue
    for (const item of nested) {
      if (!isRecord(item)) continue
      const name = toolNameFrom(item)
      if (name === undefined || !isMutatingTool(name) || !isSuccessfulNestedTool(item)) continue
      collectInputPaths(item.input ?? item.arguments ?? item.params, workspaceRoot, paths)
      collectResultDiffPaths(item, undefined, workspaceRoot, paths)
    }
  }
}

function isSuccessfulNestedTool(value: Record<string, unknown>): boolean {
  if (value.isError === true || hasError(value.error)) return false
  const status = typeof value.status === 'string' ? value.status.trim().toLowerCase() : ''
  return !['failed', 'failure', 'error', 'cancelled', 'canceled', 'aborted'].includes(status)
}

function collectInputPaths(value: unknown, workspaceRoot: string, paths: Set<string>): void {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) {
      for (const item of value) collectInputPaths(item, workspaceRoot, paths)
      return
    }
    if (isRecord(value)) {
      for (const [key, nested] of Object.entries(value)) {
        if (PATH_KEYS.has(key)) collectPathValues(nested, workspaceRoot, paths)
        else collectInputPaths(nested, workspaceRoot, paths)
      }
    }
    return
  }
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    for (const line of trimmed.split(/\r?\n/u)) {
      const match = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/u.exec(line)
        ?? /^\*\*\* Move to:\s+(.+)$/u.exec(line)
      if (match?.[1] !== undefined) addPath(match[1], workspaceRoot, paths)
    }
    return
  }
  try { collectInputPaths(JSON.parse(trimmed) as unknown, workspaceRoot, paths) } catch {
    // 工具参数不是 JSON 时只使用 apply_patch 文本格式。
  }
}

function collectPathValues(value: unknown, workspaceRoot: string, paths: Set<string>): void {
  if (typeof value === 'string') {
    addPath(value, workspaceRoot, paths)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, workspaceRoot, paths)
    return
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) collectPathValues(nested, workspaceRoot, paths)
  }
}

function addPath(value: string, workspaceRoot: string, paths: Set<string>): void {
  const trimmed = value.trim().replace(/^['"]+|['"]+$/gu, '')
  if (trimmed === '' || trimmed === '.' || trimmed === './') return
  const candidate = isAbsolute(trimmed) ? normalize(trimmed) : resolve(workspaceRoot, trimmed)
  const relativePath = relative(workspaceRoot, candidate).replaceAll('\\', '/')
  if (relativePath === '' || relativePath.startsWith('../') || isAbsolute(relativePath)) return
  paths.add(relativePath.replace(/^\.\//u, ''))
}

function findJsonlReference(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !isRecord(value)) return undefined
  for (const key of ['rawStoreRef', 'jsonlPath', 'sessionPath', 'filePath']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && /\.jsonl(?:\.zstd)?$/u.test(candidate.trim())) return candidate.trim()
  }
  for (const nested of Object.values(value)) {
    const result = findJsonlReference(nested, depth + 1)
    if (result !== undefined) return result
  }
  return undefined
}

function sessionIdentity(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of ['sessionId', 'id']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  const header = value.header
  return isRecord(header) && typeof header.id === 'string' ? header.id.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
