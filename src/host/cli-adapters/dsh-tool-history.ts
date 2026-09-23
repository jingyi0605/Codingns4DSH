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
  ) {
    // 新桥接直接在工具通知到达时写入时间线标记；只有旧 Host 没有该接口时才保留旧的
    // assistant settlement 兼容路径。旧路径不能用于新桥接，否则工具一定会落到正文之后。
    const subscribe = nativeSessions?.appendExternalToolEvent === undefined
      && nativeSessions?.supportsEvents === true
      ? nativeSessions.subscribe
      : undefined
    this.deferNativeAppend = subscribe !== undefined
    this.removeNativeEventListener = subscribe?.call(nativeSessions!, {
      onEvent: (session, event) => {
        // DSH 的实时正文在 assistant/message 事件中才真正落盘。
        // 工具历史必须排在该事件之后，否则 UI 会在流式正文下方提前堆积工具卡片。
        if (session !== nativeSessions?.get(sessionId) || !isNativeAssistantSettlement(event)) return
        if (this.flushScheduled) return
        this.flushScheduled = true
        queueMicrotask(() => {
          this.flushScheduled = false
          this.flushNativeRecords()
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
    const input = event.input ?? current?.input
    const record = current ?? {
      callId,
      toolName,
      handle: null,
      failed: false,
      settled: false,
      resultAppended: false,
      externalPersisted: false,
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
      ...(record.output === undefined ? {} : { output: record.output }),
      ...(record.error === undefined ? {} : { error: record.error }),
    }
    let persisted = false
    if (this.nativeSessions?.appendExternalToolEvent !== undefined
      && this.sessionId.trim() !== ''
      && (current === undefined || record.externalPersisted)) {
      try {
        persisted = this.nativeSessions.appendExternalToolEvent(this.sessionId, marker)
        record.externalPersisted = persisted
      } catch {
        // 时间线展示失败不能中断外部 Agent 的真实执行；流式 marker 仍会发送给 Client。
      }
    } else if (!this.deferNativeAppend) {
      // 没有原生事件订阅的精简测试/旧 Host 继续使用旧兼容路径。
      this.flushNativeRecords()
    }
    // 持久事件已经同步发布给 Conversation，不能再发送同一 callId 的临时 start，
    // 否则 assembler 会把它视为重复起点。仅在持久化不可用时保留 transient fallback。
    return persisted ? null : marker
  }

  /** 流结束时补齐 Provider 遗漏的终态，避免原生组件永久停留在运行中。 */
  finalize(reason: 'stop' | 'cancel' | 'error', failure?: string): void {
    this.finalized = true
    for (const record of this.records.values()) {
      if (record.settled) continue
      if (failure !== undefined && record.error === undefined) this.assign(record, 'error', failure, 'snapshot')
      this.settle(record, record.failed || reason !== 'stop')
    }
    if (!this.deferNativeAppend) this.flushNativeRecords()
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

  /** 在 DSH assistant/message 已经落盘后，按 Provider 到达顺序追加工具历史。 */
  private flushNativeRecords(): void {
    if (this.nativeSessions?.appendExternalToolEvent !== undefined) return
    const append = this.nativeSessions?.appendToolCall
    if (append === undefined || this.sessionId.trim() === '') return
    for (const record of this.records.values()) {
      if (record.handle === null) record.handle = this.appendCall(record, append)
      if (!record.settled || record.resultAppended || record.handle === null) continue
      const appendResult = this.nativeSessions?.appendToolResult
      if (appendResult === undefined) continue
      const normalized = normalizeToolCall(record.toolName, record.input)
      const error = record.error?.trim()
      const output = normalizeToolOutput(record.output ?? error ?? '')
      try {
        appendResult.call(this.nativeSessions, record.handle, {
          output,
          isError: record.failed,
          ...(error ? { error } : {}),
          ...toolResultMeta(normalized.name, normalized.arguments),
        })
        record.resultAppended = true
      } catch {
        // DSH Session 是展示副作用，不能覆盖 Provider 的成功或失败终态。
      }
    }
    if (this.finalized) this.removeNativeEventListener?.()
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
  }
  return { name, arguments: JSON.stringify(args) }
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
  const path = stringValue(args?.file_path)
  const newText = stringValue(name === 'edit' ? args?.new_string : args?.content)
  if (path === null || newText === null) return {}
  const oldText = name === 'edit' ? stringValue(args?.old_string) : null
  return {
    meta: {
      diffs: [{ path, oldText, newText }],
    },
  }
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

function isNativeAssistantSettlement(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.type === 'assistant/message' || value.type === 'assistant/attempt'
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
