/** 诊断只接收标量指标，禁止把音频、正文、提示词和认证信息写入日志。 */
export type VoiceDiagnosticFields = Readonly<Record<string, string | number | boolean | null | undefined>>
export type VoiceDiagnosticTrace = (event: string, fields?: VoiceDiagnosticFields) => void
export interface VoiceDiagnosticRecord {
  readonly timestamp: number
  readonly event: string
  readonly fields: VoiceDiagnosticFields
}

const sinks = new Set<(record: VoiceDiagnosticRecord) => void>()
const allowedFields = new Set(`ownerId clientId callId requestId diagnosticId epoch sequence firstSequence lastSequence
  action state phase backend provider model code errorName status durationMs waitMs firstAudioMs firstTextMs
  firstSentenceMs firstPlaybackMs queueMs gapMs intervalMs maxIntervalMs processMs maxProcessMs decodeMs
  maxDecodeMs audioMs bytes pendingBytes pending frames chunks samples sampleRate inputRate threads tokens
  textLength systemLength messageCount toolCount count dropped stale aborted completed continuation muted
  sourceCount contextState processor cpuPercent rssMb heapMb eventLoopMeanMs eventLoopMaxMs eventLoopP99Ms
  realTimeFactor generationMs codecMs transportMs segment generationFrames fileIndex
  pcmBytes headerBytes pendingAudioMs inFlightMs endpointSilenceMs cached streaming
  webSearchAvailable searchRegistration`.split(/\s+/u))

export function sanitizeVoiceDiagnosticFields(value: unknown): VoiceDiagnosticFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const fields: Record<string, string | number | boolean | null> = {}
  for (const key of allowedFields) {
    const item = (value as Record<string, unknown>)[key]
    if (typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean' || item === null) fields[key] = item as number | boolean | null
    else if (typeof item === 'string') fields[key] = item.slice(0, 160)
  }
  return fields
}

/** 订阅函数异常不能进入语音业务链；未安装诊断时调用只做一次空集合检查。 */
export const traceVoice: VoiceDiagnosticTrace = (event, fields = {}) => {
  if (sinks.size === 0) return
  const record = { timestamp: Date.now(), event, fields: sanitizeVoiceDiagnosticFields(fields) }
  for (const sink of sinks) { try { sink(record) } catch { /* 诊断失败不影响通话 */ } }
}

export function subscribeVoiceDiagnostics(sink: (record: VoiceDiagnosticRecord) => void): () => void {
  sinks.add(sink)
  return () => { sinks.delete(sink) }
}

export function voiceDiagnosticsEnabled(): boolean { return sinks.size > 0 }

export function voiceDiagnosticId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` }
export function voiceDiagnosticError(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError' }

/** 单调时钟计时，系统时间校准不会造成负耗时。 */
export async function measureVoice<T>(event: string, fields: VoiceDiagnosticFields, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  traceVoice(`${event}.start`, fields)
  try {
    const result = await operation()
    traceVoice(`${event}.done`, { ...fields, durationMs: performance.now() - started })
    return result
  } catch (error) {
    traceVoice(`${event}.error`, { ...fields, durationMs: performance.now() - started, errorName: voiceDiagnosticError(error) })
    throw error
  }
}
