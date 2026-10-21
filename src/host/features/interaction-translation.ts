import type { CodingNsCliSessionConfig } from '../../shared/contracts/cli-adapter.js'
import type { InteractionTranslationDiagnostic, InteractionTranslationField, InteractionTranslationResult } from '../../shared/contracts/interaction-translation.js'
import type { SessionTranslationRecord } from '../../shared/contracts/session-translation.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'
import type { SessionTranslationService } from './session-translation-service.js'
import { isLanguageNeutralText } from './session-translation-protection.js'
import { createTranslationQueue, translationDeadline, translationDelay, translationFailure, withTranslationAbort } from './session-translation-runtime.js'

const MAX_FIELDS = 128
const MAX_CHARACTERS = 256_000
const CACHE_LIMIT = 512
// Queue waiting must not consume a field's execution budget. Allow model fallback
// after its 30-second attempt timeout, while bounding the entire panel's wait.
const FIELD_TIMEOUT_MS = 65_000
const BATCH_TIMEOUT_MS = 180_000
const RETRY_DELAY_MS = 500
const MAX_ATTEMPTS = 2

/** Shared by live questions, late replies, plan previews, and plan progress. */
export function createInteractionTranslation(
  service: SessionTranslationService | undefined,
  session: (sessionId: string) => CodingNsCliSessionConfig,
) {
  const cache = new Map<string, SessionTranslationRecord>()
  const fieldInFlight = new Map<string, Promise<{ record: SessionTranslationRecord; diagnostic: InteractionTranslationDiagnostic }>>()
  const lifetime = new AbortController()
  // Bound history work without making a submitted reply wait behind every visible row.
  const queues = {
    output: createTranslationQueue(4),
    input: createTranslationQueue(1),
  }
  const translateField = async (
    request: { sessionId: string; direction: 'input' | 'output' },
    config: CodingNsCliSessionConfig,
    configuration: string | undefined,
    field: InteractionTranslationField,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<{ record: SessionTranslationRecord; diagnostic: InteractionTranslationDiagnostic }> => {
    if (service === undefined) throw new Error('Translation service is unavailable')
    const key = JSON.stringify([request.sessionId, config.adapterId, configuration, request.direction, field.text])
    const cached = (): SessionTranslationRecord | undefined => configuration === undefined ? undefined : cache.get(key)
    const ready = cached()
    if (ready !== undefined) return { record: ready, diagnostic: { attempts: 0, queueMs: 0, executionMs: 0, phase: 'complete', cacheHit: true } }

    const current = fieldInFlight.get(key)
    if (current !== undefined) {
      const shared = await withTranslationAbort(() => current, signal)
      if (shared.record.failure?.code === 'cancelled' && !signal.aborted && isCurrent()) {
        if (fieldInFlight.get(key) === current) fieldInFlight.delete(key)
        return translateField(request, config, configuration, field, signal, isCurrent)
      }
      return shared
    }

    const fallback: SessionTranslationRecord = {
      original: field.text, translated: field.text, bilingual: service.bilingual === true,
      targetLanguage: request.direction === 'input' ? service.inputLanguage ?? 'en' : service.outputLanguage ?? 'zh',
    }
    if (isLanguageNeutralText(field.text)) {
      if (configuration !== undefined && isCurrent()) {
        cache.set(key, fallback)
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      }
      return { record: fallback, diagnostic: { attempts: 0, queueMs: 0, executionMs: 0, phase: 'complete', cacheHit: false } }
    }

    const queue = queues[request.direction]
    const pending = (async () => {
      let record: SessionTranslationRecord | undefined
      let attempts = 0, queueMs = 0, executionMs = 0
      let phase: InteractionTranslationDiagnostic['phase'] = 'complete'
      for (let attempt = 0; record === undefined && attempt < MAX_ATTEMPTS; attempt++) {
        phase = 'queue'
        const queuedAt = Date.now()
        try {
          record = await queue.run(async () => {
            queueMs += Date.now() - queuedAt
            phase = 'translation'
            if (!isCurrent()) throw new DOMException('Translation request is obsolete', 'AbortError')
            const ready = cached()
            if (ready !== undefined) return ready
            attempts++
            const startedAt = Date.now()
            const fieldDeadline = translationDeadline(FIELD_TIMEOUT_MS, signal)
            try {
              return await withTranslationAbort(async () => {
                if (request.direction === 'output') return await service.translateOutput(config.adapterId, 'assistant', field.text, fieldDeadline.signal, true) ?? fallback
                if (service.translateInputDetailed !== undefined) return { ...fallback, ...await service.translateInputDetailed(config.adapterId, field.text, fieldDeadline.signal, true) }
                return { ...fallback, translated: await service.translateInput(config.adapterId, field.text, fieldDeadline.signal, true) }
              }, fieldDeadline.signal)
            } finally { executionMs += Date.now() - startedAt; fieldDeadline.dispose() }
          }, signal)
        } catch (error) {
          if (phase === 'queue') queueMs += Date.now() - queuedAt
          record = { ...fallback, failed: true, failure: translationFailure(error, signal) }
        }
        if (!record.failed || !record.failure?.retryable || attempt + 1 === MAX_ATTEMPTS || signal.aborted || !isCurrent()) break
        phase = 'retry'
        try { await translationDelay(RETRY_DELAY_MS, signal) }
        catch (error) { record = { ...fallback, failed: true, failure: translationFailure(error, signal) }; break }
        record = undefined
      }
      record ??= fallback
      if (!record.failed) phase = 'complete'
      const diagnostic: InteractionTranslationDiagnostic = { attempts, queueMs, executionMs, phase, cacheHit: false, ...(record.failure ? { failure: record.failure } : {}) }
      const log = record.failed ? debugWarn : debugInfo
      log('codingns4dsh: Interaction field translation', {
        sessionId: request.sessionId, direction: request.direction, fields: [field.key],
        characters: field.text.length, model: record.model, ...diagnostic,
      })
      if (!record.failed && !signal.aborted && configuration !== undefined && isCurrent()) {
        cache.set(key, record)
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      }
      return { record, diagnostic }
    })()
    fieldInFlight.set(key, pending)
    try { return await pending }
    finally { if (fieldInFlight.get(key) === pending) fieldInFlight.delete(key) }
  }
  const translateRequest = async (
    request: { sessionId: string; direction: 'input' | 'output'; fields: readonly InteractionTranslationField[] },
    config: CodingNsCliSessionConfig,
    requestSignal?: AbortSignal,
  ): Promise<InteractionTranslationResult> => {
    const enabled = service?.enabled === true && (config.translationEnabled ?? (config.adapterId === 'dsh' && service.nativeEnabled === true))
    if (!enabled || service === undefined) return { enabled: false, records: {} }
    const configuration = service.cacheKey
    const deadline = translationDeadline(BATCH_TIMEOUT_MS, AbortSignal.any([lifetime.signal, ...(requestSignal ? [requestSignal] : [])]))
    const signal = deadline.signal
    const records: Record<string, SessionTranslationRecord> = Object.create(null)
    const diagnostics: Record<string, InteractionTranslationDiagnostic> = Object.create(null)
    const isCurrent = (): boolean => {
      const current = session(request.sessionId)
      return !lifetime.signal.aborted && !requestSignal?.aborted && service.enabled
        && current.adapterId === config.adapterId && service.cacheKey === configuration
        && (current.translationEnabled ?? (current.adapterId === 'dsh' && service.nativeEnabled === true))
    }
    const groups = new Map<string, InteractionTranslationField[]>()
    for (const field of request.fields) groups.set(field.text, [...groups.get(field.text) ?? [], field])
    const batches = [...groups.values()]
    let cursor = 0
    try {
      await Promise.all(Array.from({ length: Math.min(queues[request.direction].concurrency, batches.length) }, async () => {
        while (cursor < batches.length) {
          const fields = batches[cursor++]!
          const field = fields[0]!
          let result: { record: SessionTranslationRecord; diagnostic: InteractionTranslationDiagnostic }
          try { result = await translateField(request, config, configuration, field, signal, isCurrent) }
          catch (error) {
            const fallback: SessionTranslationRecord = {
              original: field.text, translated: field.text, bilingual: service.bilingual === true,
              targetLanguage: request.direction === 'input' ? service.inputLanguage ?? 'en' : service.outputLanguage ?? 'zh',
              failed: true, failure: translationFailure(error, signal),
            }
            result = { record: fallback, diagnostic: { attempts: 0, queueMs: 0, executionMs: 0, phase: 'translation', cacheHit: false, ...(fallback.failure === undefined ? {} : { failure: fallback.failure }) } }
          }
          for (const item of fields) { records[item.key] = result.record; diagnostics[item.key] = result.diagnostic }
        }
      }))
      if (!isCurrent()) return { enabled: false, records: {} }
      return { enabled: true, records, diagnostics }
    } finally { deadline.dispose() }
  }
  const translate = async (payload: unknown, requestSignal?: AbortSignal): Promise<InteractionTranslationResult> => {
    const request = readRequest(payload)
    const config = session(request.sessionId)
    return await translateRequest(request, config, requestSignal)
  }
  return {
    dispose() { lifetime.abort(); cache.clear(); fieldInFlight.clear() },
    translate,
    prefetch(payload: unknown): void {
      void translate(payload).catch(() => undefined)
    },
  }
}

function readRequest(value: unknown): { sessionId: string; direction: 'input' | 'output'; fields: readonly InteractionTranslationField[] } {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid interaction translation request')
  const request = value as Record<string, unknown>
  if (typeof request.sessionId !== 'string' || request.sessionId.trim() === ''
    || request.direction !== 'input' && request.direction !== 'output'
    || !Array.isArray(request.fields) || request.fields.length > MAX_FIELDS) throw new TypeError('Invalid interaction translation request')
  const keys = new Set<string>()
  let size = 0
  const fields = request.fields.map((field: unknown): InteractionTranslationField => {
    if (typeof field !== 'object' || field === null) throw new TypeError('Invalid translation field')
    const item = field as Record<string, unknown>
    if (typeof item.key !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/u.test(item.key) || keys.has(item.key)
      || typeof item.text !== 'string' || item.text.length > 64_000) throw new TypeError('Invalid translation field')
    keys.add(item.key)
    size += item.text.length
    if (size > MAX_CHARACTERS) throw new TypeError('Translation request is too large')
    return { key: item.key, text: item.text }
  })
  return { sessionId: request.sessionId, direction: request.direction, fields }
}
