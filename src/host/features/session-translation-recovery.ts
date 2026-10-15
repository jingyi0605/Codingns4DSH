import { randomUUID } from 'node:crypto'
import type { CodingNsCliSessionConfig } from '../../shared/contracts/cli-adapter.js'
import type { SessionTranslationPendingInput, SessionTranslationRecord, SessionTranslationRecoveryChoice } from '../../shared/contracts/session-translation.js'
import type { SessionTranslationService } from './session-translation-service.js'
import { translationFailure, withTranslationAbort } from './session-translation-runtime.js'

export class SessionTranslationCancelled extends Error {
  constructor() { super('Message sending cancelled'); this.name = 'SessionTranslationCancelled' }
}

/** Owns submission decisions; neither a disconnect nor a failed retry sends the original. */
export function createSessionTranslationRecovery(
  service: SessionTranslationService | undefined,
  session: (sessionId: string) => CodingNsCliSessionConfig,
) {
  const lifetime = new AbortController()
  const inputs = new Map<AbortController, string>()
  const pending = new Map<string, { request: SessionTranslationPendingInput; resolve(choice: SessionTranslationRecoveryChoice): void }>()
  const cancelSession = (sessionId: string): void => {
    for (const [controller, owner] of inputs) if (owner === sessionId) controller.abort(new SessionTranslationCancelled())
    for (const [id, entry] of pending) {
      if (entry.request.sessionId !== sessionId) continue
      pending.delete(id)
      entry.resolve('cancel')
    }
  }
  const removeDeactivate = service?.onDeactivate?.(() => {
    for (const controller of inputs.keys()) controller.abort(new SessionTranslationCancelled())
  })
  return {
    dispose() { lifetime.abort(new SessionTranslationCancelled()); pending.clear(); removeDeactivate?.() },
    cancelSession,
    cancelDisabled(nativeEnabled: boolean) {
      for (const sessionId of new Set(inputs.values())) {
        const config = session(sessionId)
        if (!(config.translationEnabled ?? (config.adapterId === 'dsh' && nativeEnabled))) cancelSession(sessionId)
      }
    },
    pending(payload: unknown): readonly SessionTranslationPendingInput[] {
      const sessionId = readSessionId(payload)
      return [...pending.values()].filter(entry => entry.request.sessionId === sessionId).map(entry => entry.request)
    },
    resolve(payload: unknown): { accepted: boolean } {
      const sessionId = readSessionId(payload)
      const value = payload as Record<string, unknown>
      if (typeof value.id !== 'string' || !['retry', 'send', 'cancel'].includes(String(value.choice))) throw new TypeError('Invalid translation decision')
      const entry = pending.get(value.id)
      if (entry === undefined || entry.request.sessionId !== sessionId) return { accepted: false }
      pending.delete(value.id)
      entry.resolve(value.choice as SessionTranslationRecoveryChoice)
      return { accepted: true }
    },
    async translateInput(sessionId: string, adapterId: string, text: string, requestSignal?: AbortSignal): Promise<SessionTranslationRecord> {
      const controller = new AbortController()
      inputs.set(controller, sessionId)
      const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(requestSignal ? [requestSignal] : [])])
      try {
        while (true) {
          signal.throwIfAborted()
          const fallback: SessionTranslationRecord = { original: text, translated: text, targetLanguage: service?.inputLanguage ?? 'en', bilingual: false }
          if (service === undefined || !service.enabled || text.trim() === '') return fallback
          let record: SessionTranslationRecord
          try {
            record = await withTranslationAbort(async () => ({ ...fallback, ...(service.translateInputDetailed
              ? await service.translateInputDetailed(adapterId, text, signal, true)
              : { translated: await service.translateInput(adapterId, text, signal, true) }) }), signal)
          } catch (error) {
            record = { ...fallback, failed: true, failure: translationFailure(error, signal) }
          }
          signal.throwIfAborted()
          if (!record.failed) return record
          const id = randomUUID()
          try {
            const choice = await withTranslationAbort(() => new Promise<SessionTranslationRecoveryChoice>(resolve => {
              pending.set(id, { request: { id, sessionId, record }, resolve })
            }), signal)
            if (choice === 'cancel') throw new SessionTranslationCancelled()
            if (choice === 'send') return { ...record, translated: text }
          } finally { pending.delete(id) }
        }
      } finally { inputs.delete(controller) }
    },
    async retryOutput(payload: unknown, requestSignal?: AbortSignal): Promise<SessionTranslationRecord> {
      const sessionId = readSessionId(payload)
      const value = payload as Record<string, unknown>
      if (typeof value.original !== 'string' || value.original.trim() === '' || value.original.length > 256_000
        || value.outputKind !== 'assistant' && value.outputKind !== 'reasoning') throw new TypeError('Invalid output translation request')
      const config = session(sessionId)
      if (service === undefined || !service.enabled || !(config.translationEnabled ?? (config.adapterId === 'dsh' && service.nativeEnabled === true))) {
        throw new Error('Session translation is disabled')
      }
      const signal = AbortSignal.any([lifetime.signal, ...(requestSignal ? [requestSignal] : [])])
      const fallback: SessionTranslationRecord = { original: value.original, translated: value.original, outputKind: value.outputKind,
        targetLanguage: service.outputLanguage ?? 'zh', bilingual: service.bilingual === true }
      try {
        return await withTranslationAbort(async () => await service.translateOutput(config.adapterId, fallback.outputKind!, fallback.original, signal, true) ?? fallback, signal)
      } catch (error) {
        signal.throwIfAborted()
        return { ...fallback, failed: true, failure: translationFailure(error, signal) }
      }
    },
  }
}

function readSessionId(payload: unknown): string {
  const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new TypeError('Invalid translation session')
  return sessionId
}
