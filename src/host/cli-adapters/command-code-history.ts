import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { knownCommandCodeContextWindow } from './model-catalog.js'

const COMMAND_CODE_MAX_TITLE_LENGTH = 48
const COMMAND_CODE_HISTORY_CACHE_MAX_ENTRIES = 64
const COMMAND_CODE_HISTORY_CACHE_MAX_BYTES = 32 * 1024 * 1024
const COMMAND_CODE_HISTORY_FALLBACK_INTERVAL_MS = 5_000

/** Command Code 原生 transcript 的历史读取方向。 */
export type CommandCodeHistoryDirection = 'forward' | 'backward'

export interface CommandCodeHistoryToolCall {
  readonly callId: string
  readonly name: string
  readonly input: string
  readonly output: string | null
  readonly error: string | null
  readonly status: 'running' | 'completed' | 'failed'
}

export interface CommandCodeHistoryMessage {
  readonly messageId: string
  readonly providerSessionId: string
  readonly role: 'user' | 'assistant' | 'tool' | 'system'
  readonly kind: 'text' | 'thinking' | 'tool_call' | 'tool_result'
  readonly content: string
  readonly toolCall: CommandCodeHistoryToolCall | null
  readonly timestamp: string
  readonly sequence: number
  readonly rawRef: string
}

export interface CommandCodeHistoryPage {
  readonly messages: readonly CommandCodeHistoryMessage[]
  readonly cursor: string | null
  readonly nextCursor: string | null
  readonly total: number
}

export interface CommandCodeHistoryDelta extends CommandCodeHistoryPage {
  readonly mode: 'unchanged' | 'seed' | 'append' | 'reset_required'
  readonly bytesRead: number
  readonly recordsParsed: number
}

export interface CommandCodeSessionSummary {
  readonly provider: 'command-code'
  readonly providerSessionId: string
  readonly title: string
  readonly workspacePath: string
  readonly rawStoreRef: string
  readonly isArchived: boolean
  readonly lastMessageAt: string | null
  readonly messageCount: number
  readonly sourceMtimeMs: number
  readonly sourceSizeBytes: number
}

export interface CommandCodeSessionDiscovery {
  readonly sessions: readonly CommandCodeSessionSummary[]
  readonly isComplete: boolean
  readonly invalidLineCount: number
  readonly incompleteTailCount: number
}

export interface CommandCodeContextUsage {
  readonly provider: 'command-code'
  readonly promptTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly contextWindow: number | null
  readonly usageRatio: number | null
  readonly modelId: string | null
  readonly capturedAt: string | null
}

export interface CommandCodeSessionStats {
  readonly provider: 'command-code'
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly turns: number
  readonly steps: number
  readonly capturedAt: string | null
}

export interface CommandCodeForkResult {
  readonly session: CommandCodeSessionSummary
  readonly inheritedPrefixMessageCount: number
  readonly forkSourceType: 'session' | 'message'
  readonly providerSourceMessageId: string | null
}

export interface CommandCodeStartSessionResult {
  readonly session: CommandCodeSessionSummary
  readonly initialCursor: string | null
}

export interface CommandCodeResumeSessionResult {
  readonly provider: 'command-code'
  readonly providerSessionId: string
  readonly resumedAt: string
  readonly rawStoreRef: string
}

export interface CommandCodeSendMessageResult {
  readonly acceptedAt: string
  readonly message: CommandCodeHistoryMessage
}

export interface CommandCodeHistorySubscription {
  close(): void
}

interface CachedHistory {
  readonly identity: string
  readonly filePath: string
  readonly providerSessionId: string
  readonly size: number
  readonly mtimeMs: number
  readonly messages: readonly CommandCodeHistoryMessage[]
  readonly recordCount: number
}

export interface CommandCodeHistoryOptions {
  readonly readStatus?: (workspacePath: string) => Promise<Record<string, unknown> | null>
}

interface ParsedTranscript {
  readonly records: Record<string, unknown>[]
  readonly invalidLineCount: number
  readonly incompleteTailCount: number
  readonly lineNumbers: ReadonlyMap<Record<string, unknown>, number>
}

/**
 * Command Code 原生 JSONL 的只读历史层。
 *
 * 运行层负责启动 CLI；本类只操作 Provider canonical transcript，避免把 DSH
 * 会话索引误当成 Provider 历史。方法名与父仓库 Provider Adapter 保持一致，
 * 供 Host RPC 或后续原生历史投影按需接入。
 */
export class CommandCodeHistory {
  private readonly homeDirectory: string
  private readonly readStatus: ((workspacePath: string) => Promise<Record<string, unknown> | null>) | undefined
  private readonly cache = new Map<string, CachedHistory>()
  private cacheBytes = 0

  constructor(homeDirectory = join(homedir(), '.commandcode'), options: CommandCodeHistoryOptions = {}) {
    this.homeDirectory = homeDirectory
    this.readStatus = options.readStatus
  }

  async detectSessions(workspacePath: string): Promise<readonly CommandCodeSessionSummary[]> {
    return (await this.detectSessionsDetailed(workspacePath)).sessions
  }

  async detectSessionsDetailed(workspacePath: string): Promise<CommandCodeSessionDiscovery> {
    const target = normalizeWorkspace(workspacePath)
    const projectsRoot = join(this.homeDirectory, 'projects')
    const sessions: CommandCodeSessionSummary[] = []
    let invalidLineCount = 0
    let incompleteTailCount = 0
    for (const path of walkJsonlFiles(projectsRoot)) {
      const parsed = readTranscript(path)
      invalidLineCount += parsed.invalidLineCount
      incompleteTailCount += parsed.incompleteTailCount
      const session = parsed.records.find((record) => record.type === 'session') ?? parsed.records[0]
      const cwd = text(session?.cwd)
      if (cwd === '' || normalizeWorkspace(cwd) !== target) continue
      const providerSessionId = text(session?.id ?? session?.sessionId) || basename(path, '.jsonl')
      const messages = this.parseMessages(path, providerSessionId, parsed.records, parsed.lineNumbers)
      const stats = statSafe(path)
      if (stats === null) continue
      sessions.push({
        provider: 'command-code',
        providerSessionId,
        title: transcriptTitle(parsed.records, messages, path),
        workspacePath,
        rawStoreRef: path,
        isArchived: readArchived(path),
        lastMessageAt: messages.at(-1)?.timestamp ?? (text(parsed.records.at(-1)?.timestamp) || null),
        messageCount: messages.length,
        sourceMtimeMs: stats.mtimeMs,
        sourceSizeBytes: stats.size,
      })
    }
    sessions.sort((left, right) => (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? ''))
    return { sessions, isComplete: invalidLineCount === 0 && incompleteTailCount === 0, invalidLineCount, incompleteTailCount }
  }

  async startSession(workspacePath: string, options: { readonly initialPrompt?: string } = {}): Promise<CommandCodeStartSessionResult> {
    const providerSessionId = randomUUID()
    const directory = join(this.homeDirectory, 'projects', workspaceSlug(workspacePath))
    const filePath = join(directory, `${providerSessionId}.jsonl`)
    mkdirSync(directory, { recursive: true })
    const timestamp = new Date().toISOString()
    const initialPrompt = options.initialPrompt?.trim() ?? ''
    const lines: Record<string, unknown>[] = [{ type: 'session', version: 3, id: providerSessionId, timestamp, cwd: workspacePath }]
    if (initialPrompt !== '') lines.push({ type: 'message', id: randomUUID(), parentId: null, timestamp, sessionId: providerSessionId, message: { role: 'user', content: [{ type: 'text', text: initialPrompt }], meta: { source: 'user', createdAt: Date.parse(timestamp) } } })
    writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    const stats = statSafe(filePath)!
    const messages = this.getMessages(filePath, providerSessionId)
    return { session: { provider: 'command-code', providerSessionId, title: normalizeTitle(initialPrompt) || 'New Command Code session', workspacePath, rawStoreRef: filePath, isArchived: false, lastMessageAt: timestamp, messageCount: messages.length, sourceMtimeMs: stats.mtimeMs, sourceSizeBytes: stats.size }, initialCursor: encodeCursor(messages.length) }
  }

  async resumeSession(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeResumeSessionResult> {
    const filePath = this.requireSessionFilePath(providerSessionId, rawStoreRef)
    return { provider: 'command-code', providerSessionId, resumedAt: new Date().toISOString(), rawStoreRef: filePath }
  }

  async sendMessage(providerSessionId: string, rawStoreRef: string, content: string): Promise<CommandCodeSendMessageResult> {
    const filePath = this.requireSessionFilePath(providerSessionId, rawStoreRef)
    const acceptedAt = new Date().toISOString()
    const textContent = content
    if (textContent.trim() === '') throw new Error('content 不能为空')
    const recordId = randomUUID()
    appendFileSync(filePath, `${JSON.stringify({ type: 'message', id: recordId, parentId: null, timestamp: acceptedAt, sessionId: providerSessionId, message: { role: 'user', content: [{ type: 'text', text: textContent }], meta: { source: 'user', createdAt: Date.parse(acceptedAt) } } })}\n`, 'utf8')
    this.deleteCached(filePath)
    const message = this.getMessages(filePath, providerSessionId).at(-1)
    if (message === undefined) throw new Error('PROVIDER_HISTORY_WRITE_FAILED')
    return { acceptedAt, message }
  }

  async readSessionHistory(providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, direction: CommandCodeHistoryDirection = 'forward'): Promise<CommandCodeHistoryPage> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef)
    if (filePath === null) return { messages: [], cursor, nextCursor: null, total: 0 }
    const messages = this.getMessages(filePath, providerSessionId)
    return sliceHistory(messages, cursor, limit, direction)
  }

  async readSessionHistoryDelta(providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, direction: CommandCodeHistoryDirection = 'forward'): Promise<CommandCodeHistoryDelta> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef)
    if (filePath === null) return { messages: [], cursor, nextCursor: null, total: 0, mode: 'reset_required', bytesRead: 0, recordsParsed: 0 }
    const previous = this.cache.get(filePath)
    const stats = statSafe(filePath)
    if (stats === null) return { messages: [], cursor, nextCursor: null, total: 0, mode: 'reset_required', bytesRead: 0, recordsParsed: 0 }
    const messages = this.getMessages(filePath, providerSessionId)
    const current = this.cache.get(filePath)!
    const mode = previous === undefined
      ? 'seed'
      : previous.identity !== current.identity || stats.size < previous.size
        ? 'reset_required'
        : stats.size === previous.size ? 'unchanged' : 'append'
    const page = sliceHistory(messages, cursor, limit, direction)
    return { ...page, mode, bytesRead: mode === 'unchanged' ? 0 : Math.max(0, stats.size - (previous?.size ?? 0)), recordsParsed: mode === 'unchanged' ? 0 : Math.max(0, current.recordCount - (previous?.recordCount ?? 0)) }
  }

  subscribeSession(providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, onEvent: (event: { readonly messages: readonly CommandCodeHistoryMessage[]; readonly cursor: string | null }) => Promise<void> | void): CommandCodeHistorySubscription {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef)
    if (filePath === null) return { close() {} }
    let closed = false
    let currentCursor = cursor
    let watcher: FSWatcher | undefined
    const fallbackTimer = setInterval(() => { ensureWatcher(); void refresh() }, COMMAND_CODE_HISTORY_FALLBACK_INTERVAL_MS)
    fallbackTimer.unref?.()
    let running = false
    const refresh = async (): Promise<void> => {
      if (closed || running) return
      running = true
      try {
        const delta = await this.readSessionHistoryDelta(providerSessionId, filePath, currentCursor, limit)
        if (!closed && delta.mode !== 'unchanged' && delta.messages.length > 0) {
          currentCursor = delta.cursor
          await onEvent({ messages: delta.messages, cursor: delta.cursor })
        }
      } finally { running = false }
    }
    const ensureWatcher = (): void => {
      if (closed || watcher !== undefined || !existsSync(filePath)) return
      try {
        watcher = watch(filePath, (eventType) => {
          if (eventType === 'rename') {
            watcher?.close()
            watcher = undefined
          }
          void refresh()
        })
      } catch { watcher = undefined }
    }
    ensureWatcher()
    return {
      close: () => {
        if (closed) return
        closed = true
        watcher?.close()
        watcher = undefined
        clearInterval(fallbackTimer)
      },
    }
  }

  async readSessionTitle(providerSessionId: string, rawStoreRef: string): Promise<string> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef)
    if (filePath === null) return ''
    const parsed = readTranscript(filePath)
    return transcriptTitle(parsed.records, this.getMessages(filePath, providerSessionId), filePath)
  }

  async renameSessionTitle(providerSessionId: string, rawStoreRef: string, title: string): Promise<string> {
    const filePath = this.requireSessionFilePath(providerSessionId, rawStoreRef)
    const normalized = title.trim().replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').slice(0, COMMAND_CODE_MAX_TITLE_LENGTH)
    appendFileSync(filePath, `${JSON.stringify({ type: 'title', sessionId: providerSessionId, title: normalized })}\n`, 'utf8')
    this.deleteCached(filePath)
    return normalized
  }

  async updateSessionArchiveState(providerSessionId: string, rawStoreRef: string, isArchived: boolean): Promise<{ readonly rawStoreRef: string; readonly isArchived: boolean }> {
    const filePath = this.requireSessionFilePath(providerSessionId, rawStoreRef)
    const metadataPath = join(dirname(filePath), '.meta.json')
    let metadata: Record<string, unknown> = {}
    try { metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown> } catch { /* 缺少或损坏的 meta 视为默认空对象 */ }
    metadata.archived = isArchived
    mkdirSync(dirname(metadataPath), { recursive: true })
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8')
    return { rawStoreRef: filePath, isArchived }
  }

  async deleteSession(providerSessionId: string, rawStoreRef: string): Promise<void> {
    const filePath = this.requireSessionFilePath(providerSessionId, rawStoreRef)
    rmSync(filePath, { force: true })
    this.deleteCached(filePath)
  }

  async readContextUsage(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeContextUsage | null> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef)
    if (filePath === null) return null
    const parsed = readTranscript(filePath)
    const usage = parsed.records.map((record, index) => readUsage(record, index)).filter((value): value is CommandCodeUsage => value !== null).at(-1)
    if (usage === undefined) return null
    const session = parsed.records.find((record) => record.type === 'session')
    const modelId = usage.model || text(session?.model) || null
    const status = this.readStatus === undefined
      ? null
      : await this.readStatus(text(session?.cwd) || dirname(filePath)).catch(() => null)
    const statusModel = text(status?.model).trim().toLowerCase()
    const statusWindow = readNumber(status?.contextWindow ?? status?.context_window)
    const runtimeWindow = statusWindow > 0 && modelId !== null && statusModel === modelId.trim().toLowerCase()
      ? statusWindow
      : null
    const contextWindow = usage.contextWindow ?? runtimeWindow ?? knownCommandCodeContextWindow(modelId === null ? undefined : modelId) ?? null
    return {
      provider: 'command-code',
      promptTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      contextWindow,
      usageRatio: contextWindow === null || contextWindow <= 0 ? null : Math.min(1, Math.max(0, usage.inputTokens / contextWindow)),
      modelId,
      capturedAt: usage.timestamp || null,
    }
  }

  async readSessionStats(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeSessionStats | null> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef)
    if (filePath === null) return null
    const records = readTranscript(filePath).records
    const byMessageId = new Map<string, CommandCodeUsage>()
    for (const usage of records.map((record, index) => readUsage(record, index)).filter((value): value is CommandCodeUsage => value !== null)) {
      byMessageId.set(usage.messageId, usage)
    }
    const usages = [...byMessageId.values()]
    if (usages.length === 0) return null
    const inputTokens = usages.reduce((sum, value) => sum + value.inputTokens, 0)
    const outputTokens = usages.reduce((sum, value) => sum + value.outputTokens, 0)
    return {
      provider: 'command-code',
      inputTokens,
      outputTokens,
      cacheReadTokens: usages.reduce((sum, value) => sum + value.cacheReadTokens, 0),
      cacheWriteTokens: usages.reduce((sum, value) => sum + value.cacheWriteTokens, 0),
      totalTokens: inputTokens + outputTokens,
      turns: countTurns(records),
      steps: usages.length,
      capturedAt: usages.at(-1)?.timestamp || null,
    }
  }

  async forkSession(providerSessionId: string, workspacePath: string, options: { readonly rawStoreRef: string; readonly sourceType: 'session' | 'message'; readonly sourceMessageId?: string | null }): Promise<CommandCodeForkResult> {
    const sourcePath = this.requireSessionFilePath(providerSessionId, options.rawStoreRef)
    const sourceMessages = this.getMessages(sourcePath, providerSessionId).filter((message) => (message.role === 'user' || message.role === 'assistant') && message.kind === 'text' && message.content.trim() !== '')
    const sourceIndex = options.sourceType === 'message' && options.sourceMessageId
      ? sourceMessages.findIndex((message) => message.messageId === options.sourceMessageId)
      : -1
    const inherited = sourceIndex >= 0 ? sourceMessages.slice(0, sourceIndex + 1) : sourceMessages
    const forkedId = randomUUID()
    const directory = join(this.homeDirectory, 'projects', workspaceSlug(workspacePath))
    const targetPath = join(directory, `${forkedId}.jsonl`)
    mkdirSync(directory, { recursive: true })
    const timestamp = new Date().toISOString()
    const lines = [{ type: 'session', version: 3, id: forkedId, timestamp, cwd: workspacePath }, ...inherited.map((message) => ({ type: 'message', id: randomUUID(), parentId: null, timestamp: message.timestamp, message: { role: message.role, content: [{ type: 'text', text: message.content }] } }))]
    writeFileSync(targetPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    const stats = statSafe(targetPath)!
    const session: CommandCodeSessionSummary = {
      provider: 'command-code', providerSessionId: forkedId, title: transcriptTitle([], inherited, targetPath), workspacePath,
      rawStoreRef: targetPath, isArchived: false, lastMessageAt: inherited.at(-1)?.timestamp ?? timestamp,
      messageCount: inherited.length, sourceMtimeMs: stats.mtimeMs, sourceSizeBytes: stats.size,
    }
    return { session, inheritedPrefixMessageCount: inherited.length, forkSourceType: options.sourceType, providerSourceMessageId: options.sourceMessageId ?? null }
  }

  private getMessages(filePath: string, providerSessionId: string): readonly CommandCodeHistoryMessage[] {
    const stats = statSafe(filePath)
    if (stats === null) return []
    const identity = `${stats.dev}:${stats.ino}`
    const cached = this.cache.get(filePath)
    if (cached?.identity === identity && cached.providerSessionId === providerSessionId && cached.size === stats.size) return cached.messages
    const parsed = readTranscript(filePath)
    const messages = this.parseMessages(filePath, providerSessionId, parsed.records, parsed.lineNumbers)
    this.setCached(filePath, { filePath, providerSessionId, identity, size: stats.size, mtimeMs: stats.mtimeMs, messages, recordCount: parsed.records.length })
    return messages
  }

  private setCached(filePath: string, value: CachedHistory): void {
    const previous = this.cache.get(filePath)
    if (previous !== undefined) this.cacheBytes -= previous.size
    this.cache.set(filePath, value)
    this.cacheBytes += value.size
    while (this.cache.size > COMMAND_CODE_HISTORY_CACHE_MAX_ENTRIES || this.cacheBytes > COMMAND_CODE_HISTORY_CACHE_MAX_BYTES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.deleteCached(oldest)
    }
  }

  private deleteCached(filePath: string): void {
    const cached = this.cache.get(filePath)
    if (cached === undefined) return
    this.cache.delete(filePath)
    this.cacheBytes = Math.max(0, this.cacheBytes - cached.size)
  }

  private parseMessages(filePath: string, providerSessionId: string, records: readonly Record<string, unknown>[], lineNumbers?: ReadonlyMap<Record<string, unknown>, number>): readonly CommandCodeHistoryMessage[] {
    const result: CommandCodeHistoryMessage[] = []
    const positions = new Map<string, number>()
    records.forEach((record, recordIndex) => {
      if (record.type !== 'message') return
      const message = asRecord(record.message)
      const role = normalizeRole(message?.role)
      const content = Array.isArray(message?.content) ? message.content : [message?.content]
      content.forEach((part, partIndex) => {
        const block = asRecord(part)
        if (block === null) return
        const type = text(block.type).toLowerCase()
        const callId = text(block.id ?? block.tool_use_id ?? block.toolCallId ?? block.callId)
        const messageId = `${text(record.id) || text(message?.id) || recordIndex}:${partIndex}:${type}:${callId}`
        const rawRef = `${filePath}#${lineNumbers?.get(record) ?? recordIndex + 1}:${partIndex}`
        const timestamp = text(record.timestamp) || new Date().toISOString()
        const push = (entry: Omit<CommandCodeHistoryMessage, 'messageId' | 'providerSessionId' | 'timestamp' | 'sequence' | 'rawRef'>): void => {
          const normalized = { ...entry, messageId, providerSessionId, timestamp, sequence: 0, rawRef }
          const existing = positions.get(messageId)
          if (existing === undefined) {
            positions.set(messageId, result.length)
            result.push(normalized)
          } else {
            result[existing] = normalized
          }
        }
        if (type === 'thinking' || type === 'reasoning') {
          push({ role: 'assistant', kind: 'thinking', content: text(block.thinking ?? block.text ?? block.content), toolCall: null })
        } else if (type === 'text' || type === 'output_text' || type === 'markdown') {
          push({ role, kind: 'text', content: text(block.text ?? block.content), toolCall: null })
        } else if (type === 'tool_use' || type === 'tool_call' || type === 'function_call') {
          const fn = asRecord(block.function)
          const name = text(block.name ?? block.tool ?? fn?.name) || 'tool'
          push({ role: 'assistant', kind: 'tool_call', content: '', toolCall: { callId: callId || messageId, name, input: stringify(block.input ?? fn?.arguments ?? {}), output: null, error: null, status: 'running' } })
        } else if (type === 'tool_result' || type === 'tool_return' || type === 'function_result') {
          const error = block.error !== undefined || block.is_error === true
          const output = extractTextBlocks(block.content ?? block.output ?? block.result)
          push({ role: 'tool', kind: 'tool_result', content: output, toolCall: { callId: callId || messageId, name: text(block.name) || 'tool', input: '', output: error ? null : output, error: error ? output : null, status: error ? 'failed' : 'completed' } })
        } else if (role === 'user' || role === 'assistant' || role === 'system') {
          const value = extractTextBlocks(part)
          if (value.trim() !== '') push({ role, kind: 'text', content: value, toolCall: null })
        }
      })
    })
    return result.map((message, index) => ({ ...message, sequence: index + 1 }))
  }

  private resolveSessionFilePath(providerSessionId: string, rawStoreRef: string): string | null {
    const candidate = rawStoreRef.trim()
    if (isSafeTranscriptPath(candidate, this.homeDirectory) && existsSync(candidate)) {
      const filenameId = basename(candidate, '.jsonl')
      const first = readTranscript(candidate).records.find((record) => record.type === 'session')
      const recordedId = text(first?.id ?? first?.sessionId).trim()
      if (filenameId === providerSessionId || recordedId === providerSessionId) return candidate
    }
    return this.findSessionFile(providerSessionId)
  }

  private requireSessionFilePath(providerSessionId: string, rawStoreRef: string): string {
    const path = this.resolveSessionFilePath(providerSessionId, rawStoreRef)
    if (path === null) throw new Error('PROVIDER_SESSION_NOT_FOUND')
    return path
  }

  private findSessionFile(providerSessionId: string): string | null {
    const root = resolve(join(this.homeDirectory, 'projects'))
    for (const filePath of walkJsonlFiles(root)) {
      if (basename(filePath, '.jsonl') === providerSessionId) return filePath
      const first = readTranscript(filePath).records.find((record) => record.type === 'session')
      if (text(first?.id ?? first?.sessionId).trim() === providerSessionId) return filePath
    }
    return null
  }
}

interface CommandCodeUsage {
  readonly messageId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly contextWindow?: number
  readonly model: string
  readonly timestamp: string
}

function readUsage(record: Record<string, unknown>, recordIndex = 0): CommandCodeUsage | null {
  const usage = asRecord(record.usage) ?? asRecord(asRecord(record.event)?.usage) ?? asRecord(asRecord(record.result)?.usage)
  if (usage === null) return null
  const number = (...keys: string[]): number => {
    for (const key of keys) {
      const value = usage[key]
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
    }
    return 0
  }
  const inputTokens = number('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const outputTokens = number('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  if (inputTokens === 0 && outputTokens === 0 && number('totalTokens', 'total_tokens') === 0) return null
  const contextWindow = number('contextWindow', 'context_window') || readNumber(record.contextWindow ?? record.context_window)
  return {
    messageId: text(record.id ?? asRecord(record.message)?.id ?? asRecord(record.meta)?.messageId) || `record:${recordIndex}`,
    inputTokens,
    outputTokens,
    cacheReadTokens: number('cacheReadTokens', 'cache_read_tokens', 'cachedInputTokens'),
    cacheWriteTokens: number('cacheWriteTokens', 'cache_write_tokens'),
    ...(contextWindow > 0 ? { contextWindow } : {}),
    model: text(usage.model ?? record.model),
    timestamp: text(record.timestamp ?? asRecord(record.event)?.timestamp),
  }
}

function readNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** 工具结果也会以 user 角色写回，但它不代表新的真实用户轮次。 */
function countTurns(records: readonly Record<string, unknown>[]): number {
  return records.reduce((count, record) => {
    if (record.type !== 'message') return count
    const message = asRecord(record.message)
    if (text(message?.role).trim().toLowerCase() !== 'user') return count
    const parts = Array.isArray(message?.content) ? message.content : []
    if (parts.length === 0) return count
    const isToolResult = parts.some((part) => {
      const type = text(asRecord(part)?.type).trim().toLowerCase()
      return type === 'tool_result' || type === 'tool_return' || type === 'function_result'
    })
    return isToolResult ? count : count + 1
  }, 0)
}

function sliceHistory(messages: readonly CommandCodeHistoryMessage[], cursor: string | null, limit: number, direction: CommandCodeHistoryDirection): CommandCodeHistoryPage {
  const size = Math.max(1, Math.min(100, Math.floor(limit) || 50))
  const offset = cursor === null
    ? (direction === 'backward' ? messages.length : 0)
    : decodeCursor(cursor)
  if (direction === 'backward') {
    const start = Math.max(0, offset - size)
    return { messages: messages.slice(start, offset), cursor: encodeCursor(offset), nextCursor: start > 0 ? encodeCursor(start) : null, total: messages.length }
  }
  const end = Math.min(messages.length, offset + size)
  return { messages: messages.slice(offset, end), cursor: encodeCursor(end), nextCursor: end < messages.length ? encodeCursor(end) : null, total: messages.length }
}

function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ index: Math.max(0, Math.trunc(index)) }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { index?: unknown }
    const index = Number(value.index)
    if (!Number.isFinite(index) || index < 0) throw new Error('CURSOR_INVALID')
    return Math.trunc(index)
  } catch {
    // 兼容旧版本曾经暴露的十进制游标，已存在的分页链接不应突然失效。
    const legacy = Number.parseInt(cursor, 10)
    if (Number.isFinite(legacy) && legacy >= 0) return legacy
    throw new Error('CURSOR_INVALID')
  }
}

function readTranscript(path: string): ParsedTranscript {
  let content = ''
  try { content = readFileSync(path, 'utf8') } catch { return { records: [], invalidLineCount: 1, incompleteTailCount: 0, lineNumbers: new Map() } }
  const lines = content.split(/\r?\n/u)
  const completeFinalLine = /\r?\n$/u.test(content)
  const records: Record<string, unknown>[] = []
  const lineNumbers = new Map<Record<string, unknown>, number>()
  let invalidLineCount = 0
  let incompleteTailCount = 0
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    try {
      const value: unknown = JSON.parse(line)
      if (asRecord(value) === null) invalidLineCount += 1
      else {
        const record = value as Record<string, unknown>
        records.push(record)
        lineNumbers.set(record, index + 1)
      }
    } catch {
      // 末尾半行是 CLI 正在写入的正常瞬态；中间损坏行仍计入诊断。
      if (index !== lines.length - 1 || completeFinalLine) invalidLineCount += 1
      else if (looksLikeIncompleteJson(line)) incompleteTailCount += 1
    }
  })
  return { records, invalidLineCount, incompleteTailCount, lineNumbers }
}

function looksLikeIncompleteJson(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  let depth = 0
  let inString = false
  let escaping = false
  for (const char of trimmed) {
    if (inString) {
      if (escaping) escaping = false
      else if (char === '\\') escaping = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
  }
  return depth > 0 || inString || escaping
}

function extractTextBlocks(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) {
    const combined = value.map((item) => extractTextBlocks(item).trim()).filter(Boolean).join('\n')
    return combined || stringify(value)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'thinking', 'output', 'content', 'message']) {
      const nested = extractTextBlocks(record[key]).trim()
      if (nested) return nested
    }
    return stringify(value)
  }
  return text(value)
}

function transcriptTitle(records: readonly Record<string, unknown>[], messages: readonly CommandCodeHistoryMessage[], path: string): string {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    const metadata = asRecord(record?.meta)
    const title = text(record?.title ?? record?.aiTitle ?? metadata?.title).trim()
    if (title !== '') return normalizeTitle(title)
  }
  return normalizeTitle(messages.find((message) => message.role === 'user' && message.kind === 'text' && message.content.trim() !== '')?.content ?? '')
    || basename(path, '.jsonl')
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').slice(0, COMMAND_CODE_MAX_TITLE_LENGTH)
}

function readArchived(path: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(dirname(path), '.meta.json'), 'utf8')) as Record<string, unknown>
    return value.archived === true || value.isArchived === true
  } catch { return false }
}

function isSafeTranscriptPath(candidate: string, homeDirectory: string): boolean {
  const rootPath = resolve(join(homeDirectory, 'projects'))
  let root = rootPath
  try { if (existsSync(rootPath)) root = realpathSync(rootPath) } catch { return false }
  const value = resolve(candidate)
  let actualValue = value
  try { if (existsSync(value)) actualValue = realpathSync(value) } catch { return false }
  const relativePath = relative(root, actualValue)
  return relativePath !== '' && !relativePath.startsWith('..') && actualValue.endsWith('.jsonl')
}

function walkJsonlFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    let entries: string[]
    try { entries = readdirSync(directory) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry)
      try {
        const stats = statSync(path)
        if (stats.isDirectory()) visit(path)
        else if (stats.isFile() && entry.endsWith('.jsonl') && !entry.endsWith('.checkpoints.jsonl')) files.push(path)
      } catch { /* 文件在扫描期间消失，跳过即可 */ }
    }
  }
  visit(root)
  return files
}

function normalizeWorkspace(value: string): string { return resolve(value).replace(/[\\/]+$/u, '').toLowerCase() }
function workspaceSlug(value: string): string {
  return value.replace(/[\\/]+$/u, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll(':', '-').replaceAll('\\', '-').replaceAll('/', '-').replace(/[^a-zA-Z0-9_-]+/gu, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}
function statSafe(path: string): { readonly size: number; readonly mtimeMs: number; readonly dev: number; readonly ino: number } | null {
  try { const stats = statSync(path); return { size: stats.size, mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino } } catch { return null }
}
function asRecord(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function text(value: unknown): string { return typeof value === 'string' ? value : value === undefined || value === null ? '' : stringify(value) }
function stringify(value: unknown): string { if (typeof value === 'string') return value; try { return JSON.stringify(value) ?? '' } catch { return String(value) } }
function normalizeRole(value: unknown): 'user' | 'assistant' | 'tool' | 'system' { return value === 'assistant' || value === 'tool' || value === 'system' ? value : 'user' }
