import type { CodingNsAgentToolEvent } from '../../shared/contracts/cli-adapter.js'
import type {
  CodingNsNativeSessionBridge,
  CodingNsNativeToolCallHandle,
} from '../native-session-bridge.js'

interface ToolRecord {
  readonly callId: string
  toolName: string
  input?: string
  output?: string
  error?: string
  handle: CodingNsNativeToolCallHandle | null
  failed: boolean
  settled: boolean
  resultAppended: boolean
  externalPersisted: boolean
  externalMarker?: CodingNsDshExternalToolMarker
  externalMarkerPersisted: boolean
}

/** 外部工具的实时回退标记；正常 Host 会优先写入 Session 持久时间线。 */
export interface CodingNsDshExternalToolMarker {
  readonly source: 'codingns-external-tool'
  readonly phase: 'start' | 'update'
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly output?: string
  readonly error?: string
  readonly adapterId?: string
}

const FIELD_LIMIT = 64 * 1024
const CALL_LIMIT = 192 * 1024
const TURN_LIMIT = 768 * 1024
const CALL_COUNT_LIMIT = 256
const TRUNCATION_MARKER = '\n...[内容因长度限制已截断]'

/**
 * 所有外部 Agent 共用的 DSH 工具历史投影器。
 *
 * 驱动只需要产出统一的 tool-event 观察事件；这里负责生命周期聚合、工具别名、
 * 参数修正、结果文本和 diff 元数据，最后经唯一的原生 Session 桥接落盘。
 */
export class CodingNsDshToolHistoryProjector {
  private readonly records = new Map<string, ToolRecord>()
  private readonly deferNativeAppend: boolean
  private readonly removeNativeEventListener: (() => void) | undefined
  private anonymousSequence = 0
  private turnChars = 0
  private observedCalls = 0
  private finalized = false
  private flushScheduled = false

  constructor(
    private readonly nativeSessions: CodingNsNativeSessionBridge | undefined,
    private readonly sessionId: string,
    private readonly adapterId?: string,
  ) {
    // 工具通知必须在当前 llm/stream 结束前写入原生时间线。若把它延迟到
    // assistant/message 结算之后，最后一条事件会变成带 tool-call 的合成 assistant，
    // DSH 会把整步判定为 process，最终正文也会被收进折叠按钮。
    const subscribe = nativeSessions?.supportsEvents === true ? nativeSessions.subscribe : undefined
    this.deferNativeAppend = nativeSessions?.appendToolCall === undefined && nativeSessions?.appendExternalToolEvent === undefined && subscribe !== undefined
    this.removeNativeEventListener = subscribe?.call(nativeSessions!, {
      onEvent: (session, event) => {
        if (session !== nativeSessions?.get(sessionId)) return
        if (!isNativeStepStart(event) || this.flushScheduled) return
        this.flushScheduled = true
        queueMicrotask(() => {
          this.flushScheduled = false
          if (nativeSessions?.appendToolCall !== undefined) this.flushNativeRecords()
          else this.flushExternalMarkers()
        })
      },
    })
  }

  observe(event: CodingNsAgentToolEvent): CodingNsDshExternalToolMarker | null {
    const explicitCallId = event.callId?.trim()
    const callId = explicitCallId || this.nextAnonymousCallId()
    const key = explicitCallId ? `id:${explicitCallId}` : `anonymous:${callId}`
    const current = this.records.get(key)
    if (current === undefined && this.observedCalls >= CALL_COUNT_LIMIT) return null
    const toolName = meaningfulToolName(event.toolName, current?.toolName)
    const input = shouldIgnoreEmptyToolInput(event.input, current?.input)
      || shouldIgnoreEmptyQuestionInput(event.input, current?.input, toolName)
      ? undefined
      : event.input ?? current?.input
    const record = current ?? {
      callId,
      toolName,
      handle: null,
      failed: false,
      settled: false,
      resultAppended: false,
      externalPersisted: false,
      externalMarkerPersisted: false,
    }
    if (current === undefined) this.observedCalls += 1
    record.toolName = toolName
    this.assign(record, 'input', input, 'snapshot')
    if (event.output !== undefined) {
      if (event.outputMode === undefined) throw new Error('工具输出事件缺少 outputMode')
      this.assign(record, 'output', event.output, event.outputMode)
    }
    this.assign(record, 'error', event.error, 'snapshot')
    if (event.status === 'failed' || event.error !== undefined) record.failed = true
    this.records.set(key, record)
    if (event.status === 'completed' || event.status === 'failed') {
      this.settle(record, record.failed)
    }
    const normalized = normalizeToolCall(record.toolName, record.input)
    const status = record.failed
      ? 'failed'
      : record.settled
        ? 'completed'
        : 'running'
    const marker: CodingNsDshExternalToolMarker = {
      source: 'codingns-external-tool',
      phase: current === undefined ? 'start' : 'update',
      callId: record.callId,
      name: normalized.name,
      arguments: normalized.arguments,
      status,
      ...(this.adapterId === undefined ? {} : { adapterId: this.adapterId }),
      ...(record.output === undefined ? {} : { output: record.output }),
      ...(record.error === undefined ? {} : { error: record.error }),
    }
    record.externalMarker = marker
    record.externalMarkerPersisted = false
    if (this.nativeSessions?.appendToolCall !== undefined && this.sessionId.trim() !== '') {
      // DSH Chat 原生识别 tool/call 为运行中的工具节点，tool/result 负责更新它。
      // 不再额外伪造 reasoning-delta，否则每个工具通知都会触发 assistant 正文刷新。
      const persisted = this.persistNativeRecord(record)
      if (!persisted && this.nativeSessions.supportsEvents) this.scheduleFlush()
      return null
    }
    const hasExternalAppender = this.nativeSessions?.appendExternalToolEvent !== undefined && this.sessionId.trim() !== ''
    if (hasExternalAppender) this.persistExternalMarker(record)
    if (!hasExternalAppender && !this.deferNativeAppend) this.flushNativeRecords()
    return marker
  }

  /** 流结束时补齐 Provider 遗漏的终态，避免原生组件永久停留在运行中。 */
  finalize(reason: 'stop' | 'cancel' | 'error', failure?: string): void {
    this.finalized = true
    for (const record of this.records.values()) {
      if (record.settled) continue
      if (failure !== undefined && record.error === undefined) this.assign(record, 'error', failure, 'snapshot')
      this.settle(record, record.failed || reason !== 'stop')
    }
    if (this.nativeSessions?.appendToolCall !== undefined) {
      this.flushNativeRecords()
    } else if (this.nativeSessions?.appendExternalToolEvent !== undefined) {
      this.flushExternalMarkers()
      this.removeNativeEventListener?.()
    } else if (!this.deferNativeAppend) this.flushNativeRecords()
  }

  private assign(
    record: ToolRecord,
    field: 'input' | 'output' | 'error',
    incoming: string | undefined,
    mode: 'delta' | 'snapshot',
  ): void {
    if (incoming === undefined) return
    const current = record[field] ?? ''
    const callChars = (record.input?.length ?? 0) + (record.output?.length ?? 0) + (record.error?.length ?? 0)
    const available = Math.max(0, Math.min(
      FIELD_LIMIT,
      current.length + CALL_LIMIT - callChars,
      current.length + TURN_LIMIT - this.turnChars,
    ))
    const next = mode === 'snapshot'
      ? bounded(incoming, available)
      : bounded(`${current}${incoming}`, available)
    if (next === current) return
    record[field] = next
    this.turnChars += next.length - current.length
  }

  private settle(record: ToolRecord, isError: boolean): void {
    if (record.settled) return
    record.settled = true
    record.failed = isError
  }

  /** 按 Provider 到达顺序把工具调用和结果写入当前 DSH step。 */
  private flushNativeRecords(): void {
    if (this.nativeSessions?.appendToolCall === undefined || this.sessionId.trim() === '') return
    for (const record of this.records.values()) this.persistNativeRecord(record)
    if (this.finalized && !this.hasPendingNativeRecords()) this.removeNativeEventListener?.()
  }

  private hasPendingNativeRecords(): boolean {
    for (const record of this.records.values()) {
      if (record.handle === null || record.settled && !record.resultAppended) return true
    }
    return false
  }

  private persistNativeRecord(record: ToolRecord): boolean {
    const append = this.nativeSessions?.appendToolCall
    if (append === undefined || this.sessionId.trim() === '') return false
    // OpenCode 的 question 工具可能先发空 `{}` 输入，问题详情随后通过
    // question.asked 事件抵达；先暂缓原生 tool/call，避免空参数永久落盘。
    // write/edit/read 也遵循同一协议：input.started 先到，真实路径和正文在
    // input.ended 或 success.metadata.diffs 才出现。未结算前不能把 `{}` 固化到
    // assistant/message，否则后续更新只能补 result，原生编辑卡片永远没有参数。
    if (record.handle === null && (isPendingQuestionRecord(record) || isPendingToolInputRecord(record))) return false
    if (record.handle === null) record.handle = this.appendCall(record, append)
    if (!record.settled || record.resultAppended || record.handle === null) return record.handle !== null
    const appendResult = this.nativeSessions?.appendToolResult
    if (appendResult === undefined) return false
    const normalized = normalizeToolCall(record.toolName, record.input)
    const error = record.error?.trim()
    const output = normalizeToolOutput(record.output ?? error ?? '')
    try {
      record.resultAppended = appendResult.call(this.nativeSessions, record.handle, {
        output,
        isError: record.failed,
        ...(error ? { error } : {}),
        ...toolResultMeta(normalized.name, normalized.arguments),
      })
    } catch {
      record.resultAppended = false
    }
    return record.resultAppended
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      if (this.nativeSessions?.appendToolCall !== undefined) this.flushNativeRecords()
      else this.flushExternalMarkers()
    })
  }

  /** 活动 step 晚于首个工具通知时，补写尚未进入 Session 的工具标记。 */
  private flushExternalMarkers(): void {
    if (this.nativeSessions?.appendExternalToolEvent === undefined || this.sessionId.trim() === '') return
    for (const record of this.records.values()) {
      if (record.externalMarker === undefined || record.externalMarkerPersisted) continue
      this.persistExternalMarker(record)
    }
  }

  /** 先补齐同一调用的 start，再追加当前 update，保持 Conversation 生命周期合法。 */
  private persistExternalMarker(record: ToolRecord): boolean {
    const append = this.nativeSessions?.appendExternalToolEvent
    const marker = record.externalMarker
    if (append === undefined || marker === undefined || this.sessionId.trim() === '') return false
    if (!record.externalPersisted && (isPendingQuestionRecord(record) || isPendingToolInputRecord(record))) return false
    if (!record.externalPersisted) {
      const start: CodingNsDshExternalToolMarker = marker.phase === 'start'
        ? marker
        : {
            source: marker.source,
            phase: 'start',
            callId: marker.callId,
            name: marker.name,
            arguments: marker.arguments,
            status: 'running',
            ...(this.adapterId === undefined ? {} : { adapterId: this.adapterId }),
          }
      try {
        if (!append.call(this.nativeSessions, this.sessionId, start)) return false
        record.externalPersisted = true
      } catch {
        return false
      }
      if (marker.phase === 'start') {
        record.externalMarkerPersisted = true
        return true
      }
    }
    try {
      record.externalMarkerPersisted = append.call(this.nativeSessions, this.sessionId, marker)
      return record.externalMarkerPersisted
    } catch {
      return false
    }
  }

  private appendCall(
    record: ToolRecord,
    append: NonNullable<CodingNsNativeSessionBridge['appendToolCall']>,
  ): CodingNsNativeToolCallHandle | null {
    const normalized = normalizeToolCall(record.toolName, record.input)
    try {
      return append.call(this.nativeSessions!, this.sessionId, {
        callId: record.callId,
        name: normalized.name,
        arguments: normalized.arguments,
        ...(this.adapterId === undefined ? {} : { adapterId: this.adapterId }),
      })
    } catch {
      // 原生展示失败不能中断外部 Agent 的真实执行。
      return null
    }
  }

  private nextAnonymousCallId(): string {
    this.anonymousSequence += 1
    return `external-tool-${this.anonymousSequence}`
  }
}

interface NormalizedToolCall {
  readonly name: string
  readonly arguments: string
}

function normalizeToolCall(toolName: string, input: string | undefined): NormalizedToolCall {
  const name = canonicalToolName(toolName)
  const parsed = parseRecord(input)
  const args = parsed ?? (input === undefined || input === ''
    ? {}
    : name === 'bash'
      ? { command: input }
      : { input })

  if (name === 'read' || name === 'write' || name === 'edit') {
    rename(args, 'path', 'file_path')
    rename(args, 'filePath', 'file_path')
  }
  if (name === 'edit') {
    rename(args, 'oldString', 'old_string')
    rename(args, 'newString', 'new_string')
    rename(args, 'replaceAll', 'replace_all')
    normalizeEditChanges(args)
  }
  return { name, arguments: JSON.stringify(args) }
}

/**
 * 将多文件编辑补齐为 DSH 原生 edit 卡片可识别的单文件字段。
 *
 * changes 仍完整保留，完成态由 toolResultMeta 生成全部文件的 Diff；顶层字段
 * 只取首个有效变更，用于 DSH 原生组件识别工具类型、展示文件名和实时 Diff。
 */
function normalizeEditChanges(args: Record<string, unknown>): void {
  if (!Array.isArray(args.changes)) return
  const existingPath = stringValue(args.file_path)?.trim()
  if (existingPath && typeof args.old_string === 'string' && typeof args.new_string === 'string') return
  for (const value of args.changes) {
    if (!isRecord(value)) continue
    const path = stringValue(value.file_path ?? value.path)
    const diff = stringValue(value.diff ?? value.patch)
    if (path === null || diff === null) continue
    const parsed = unifiedDiffChangedText(path, diff, stringValue(value.kind))
    if (!existingPath) args.file_path = parsed.path
    if (typeof args.old_string !== 'string') args.old_string = parsed.oldText ?? ''
    if (typeof args.new_string !== 'string') args.new_string = parsed.newText
    return
  }
}

function canonicalToolName(value: string): string {
  const original = value.trim() || 'tool'
  const key = original.toLowerCase().replace(/[\s-]+/gu, '_')
  if (['read', 'read_file'].includes(key)) return 'read'
  if (['write', 'write_file'].includes(key)) return 'write'
  if (['edit', 'edit_file'].includes(key)) return 'edit'
  if (['bash', 'shell', 'shell_command', 'run_shell_command', 'command_execution'].includes(key)) return 'bash'
  return original
}

function toolResultMeta(name: string, argumentsJson: string): { readonly meta?: unknown } {
  if (name !== 'edit' && name !== 'write') return {}
  const args = parseRecord(argumentsJson)
  if (name === 'edit' && Array.isArray(args?.changes)) {
    const diffs = args.changes.flatMap((value) => {
      if (!isRecord(value)) return []
      const path = stringValue(value.file_path ?? value.path)
      const diff = stringValue(value.diff ?? value.patch)
      if (path === null || diff === null) return []
      return [unifiedDiffMeta(path, diff, stringValue(value.kind))]
    })
    return diffs.length > 0 ? { meta: { diffs } } : {}
  }
  const path = stringValue(args?.file_path)
  const newText = stringValue(name === 'edit' ? args?.new_string : args?.content)
  if (name === 'edit' && path !== null) {
    const diff = stringValue(args?.diff ?? args?.patch)
    if (diff !== null) return { meta: { diffs: [unifiedDiffMeta(path, diff, stringValue(args?.kind))] } }
  }
  if (path === null || newText === null) return {}
  const oldText = name === 'edit' ? stringValue(args?.old_string) : null
  return {
    meta: {
      diffs: [{ path, oldText, newText }],
    },
  }
}

function unifiedDiffMeta(path: string, diff: string, kind: string | null): { readonly path: string; readonly oldText: string | null; readonly newText: string } {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) continue
    if (line.startsWith('-')) oldLines.push(line.slice(1))
    else if (line.startsWith('+')) newLines.push(line.slice(1))
    else if (line.startsWith(' ')) {
      const context = line.slice(1)
      oldLines.push(context)
      newLines.push(context)
    }
  }
  const oldText = kind === 'add' || kind === 'create' ? null : oldLines.join('\n')
  const newText = kind === 'delete' || kind === 'remove' ? '' : newLines.join('\n')
  return { path, oldText, newText }
}

/**
 * 编辑卡片的行数只应统计真实变更行；上下文行留在 tool/result.meta 的 Diff 中。
 * DSH 原生编辑预览会把 old_string/new_string 的每一行都计入删除/新增，
 * 因此不能直接把 unified diff 的上下文行传给顶层工具参数。
 */
function unifiedDiffChangedText(path: string, diff: string, kind: string | null): { readonly path: string; readonly oldText: string | null; readonly newText: string } {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('-') && !line.startsWith('--- ')) oldLines.push(line.slice(1))
    else if (line.startsWith('+') && !line.startsWith('+++ ')) newLines.push(line.slice(1))
  }
  const oldText = kind === 'add' || kind === 'create' ? null : oldLines.join('\n')
  const newText = kind === 'delete' || kind === 'remove' ? '' : newLines.join('\n')
  return { path, oldText, newText }
}

/** Command Code 等 Provider 会把文本块包成 JSON；原生结果只展示真正文本。 */
function normalizeToolOutput(value: string): string {
  if (value === '') return ''
  try {
    const parsed: unknown = JSON.parse(value)
    const texts = collectTextBlocks(parsed)
    return texts.length > 0 ? texts.join('\n') : value
  } catch {
    return value
  }
}

function collectTextBlocks(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTextBlocks)
  if (!isRecord(value)) return []
  if (value.type === 'text' && typeof value.text === 'string') return [value.text]
  if (Array.isArray(value.content)) return value.content.flatMap(collectTextBlocks)
  return []
}

function meaningfulToolName(incoming: string, previous: string | undefined): string {
  const normalized = incoming.trim() || 'tool'
  return normalized === 'tool' && previous !== undefined ? previous : normalized
}

function isPendingQuestionRecord(record: Pick<ToolRecord, 'toolName' | 'input' | 'settled'>): boolean {
  if (record.settled || canonicalToolName(record.toolName) !== 'question') return false
  return isPendingQuestionInput(record.input)
}

function isPendingToolInputRecord(record: Pick<ToolRecord, 'input' | 'settled'>): boolean {
  if (record.settled) return false
  return isEmptyToolInput(record.input)
}

function shouldIgnoreEmptyQuestionInput(incoming: string | undefined, current: string | undefined, toolName: string): boolean {
  return canonicalToolName(toolName) === 'question'
    && isPendingQuestionInput(incoming)
    && !isPendingQuestionInput(current)
}

/** Provider 的空 called 快照不能覆盖已经由 input.delta/ended 收集的参数。 */
function shouldIgnoreEmptyToolInput(incoming: string | undefined, current: string | undefined): boolean {
  return current !== undefined
    && !isEmptyToolInput(current)
    && incoming !== undefined
    && isEmptyToolInput(incoming)
}

function isEmptyToolInput(input: string | undefined): boolean {
  const trimmed = input?.trim()
  return trimmed === undefined || trimmed === '' || trimmed === '{}' || trimmed === 'null'
}

function isPendingQuestionInput(input: string | undefined): boolean {
  const trimmed = input?.trim()
  return trimmed === undefined || trimmed === '' || trimmed === '{}'
}

function isNativeStepStart(value: unknown): boolean {
  return isRecord(value) && value.type === 'step/start'
}

function parseRecord(value: string | undefined): Record<string, unknown> | null {
  if (value === undefined || value.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? { ...parsed } : null
  } catch {
    return null
  }
}

function rename(record: Record<string, unknown>, source: string, target: string): void {
  if (record[target] === undefined && record[source] !== undefined) record[target] = record[source]
  if (source !== target) delete record[source]
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function bounded(value: string, limit = FIELD_LIMIT): string {
  if (value.length <= limit) return value
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit)
  return `${value.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
