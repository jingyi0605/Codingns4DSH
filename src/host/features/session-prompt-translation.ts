import type { SessionPromptAssembly, SessionPromptScope } from '../../dsh-capabilities/host/session-prompt-adapter.js'
import type { CodingNsCliMessage } from '../../shared/contracts/cli-adapter.js'
import type { SessionTranslationRecord } from '../../shared/contracts/session-translation.js'
import type { SessionTranslationService } from './session-translation-service.js'
import { SessionTranslationCancelled } from './session-translation-recovery.js'
import { createTranslationQueue, translationFailure } from './session-translation-runtime.js'
import type { TextProtectionOptions } from './session-translation-protection.js'

const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const schemaChildren = new Set(['items', 'additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'])
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Translates host-owned prose; shared schemas, provenance, and execution data stay immutable. */
export function createSessionPromptTranslation(
  service: SessionTranslationService | undefined,
  adapterFor: (sessionId: string) => string | undefined,
) {
  const lifetime = new AbortController()
  const queue = createTranslationQueue(4)
  const cache = new Map<string, SessionTranslationRecord>()
  const controllers = new Set<AbortController>()
  let cacheSize = 0
  const clear = (): void => { cache.clear(); cacheSize = 0 }
  const removeDeactivate = service?.onDeactivate?.(() => {
    clear()
    for (const controller of controllers) controller.abort(new SessionTranslationCancelled())
  })
  const settingsKey = (): string => JSON.stringify([service?.cacheKey, service?.inputLanguage])
  let currentKey = settingsKey()

  async function run<T>(scope: SessionPromptScope, original: T, transform: (translate: (text: string, protection?: TextProtectionOptions) => Promise<SessionTranslationRecord>) => Promise<T>): Promise<T> {
    const adapterId = adapterFor(scope.sessionId)
    if (service === undefined || !service.enabled || service.inputEnabled === false || scope.subagent || adapterId === undefined) return original
    const generation = settingsKey()
    if (generation !== currentKey) { clear(); currentKey = generation }
    const controller = new AbortController()
    controllers.add(controller)
    const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(scope.signal === undefined ? [] : [scope.signal])])
    const pending = new Map<string, Promise<SessionTranslationRecord>>()
    let failed = false
    const translate = (text: string, protection: TextProtectionOptions = {}): Promise<SessionTranslationRecord> => {
      const options = { ...protection, literals: [...new Set([...scope.literals, ...(protection.literals ?? [])])] }
      const key = JSON.stringify([generation, adapterId, text, options])
      const previous = cache.get(key)
      if (previous !== undefined) return Promise.resolve(previous)
      const active = pending.get(key)
      if (active !== undefined) return active
      const request = queue.run(async () => {
        const fallback: SessionTranslationRecord = { original: text, translated: text, targetLanguage: service.inputLanguage ?? 'en', bilingual: false }
        // Internal descriptions never become pending user messages. Stop queued
        // attempts after a failure instead of prompting for every schema field.
        if (failed) return { ...fallback, failed: true }
        let result: SessionTranslationRecord
        try {
          result = { ...fallback, ...(service.translateInputDetailed !== undefined
            ? await service.translateInputDetailed(adapterId, text, signal, true, options)
            : { translated: await service.translateInput(adapterId, text, signal, true, options) }) }
        } catch (error) {
          result = { ...fallback, failed: true, failure: translationFailure(error, signal) }
        }
        signal.throwIfAborted()
        if (generation !== settingsKey() || adapterFor(scope.sessionId) !== adapterId || !service.enabled) throw new SessionTranslationCancelled()
        if (result.failed) { failed = true; return { ...result, translated: text } }
        if (!result.failed && service.cacheKey !== undefined) {
          const size = key.length + result.original.length + result.translated.length
          if (size <= 1_000_000) {
            while (cache.size >= 256 || cacheSize + size > 1_000_000) {
              const first = cache.entries().next().value
              if (first === undefined) break
              cache.delete(first[0]); cacheSize -= first[0].length + first[1].original.length + first[1].translated.length
            }
            // Another session may have completed the same field while this one was running.
            if (!cache.has(key)) { cache.set(key, result); cacheSize += size }
          }
        }
        return result
      }, signal)
      pending.set(key, request)
      return request
    }
    try {
      signal.throwIfAborted()
      const result = await transform(translate)
      signal.throwIfAborted()
      if (generation !== settingsKey() || adapterFor(scope.sessionId) !== adapterId || !service.enabled) throw new SessionTranslationCancelled()
      return result
    } catch (error) { controller.abort(error); throw error }
    finally { controllers.delete(controller) }
  }

  return {
    dispose() { lifetime.abort(new SessionTranslationCancelled()); clear(); removeDeactivate?.() },
    translateAssembly(assembly: SessionPromptAssembly, scope: SessionPromptScope): Promise<SessionPromptAssembly> {
      return run(scope, assembly, async translate => ({
        ...assembly,
        sections: await Promise.all(assembly.sections.map(async section => ({
          ...section, text: (await translate(section.text, { promptMarkup: true })).translated,
        }))),
        tools: await Promise.all(assembly.tools.map(async tool => {
          const literals = [tool.name, ...schemaLiterals(tool.parameters)]
          const description = async (text: string): Promise<string> => (await translate(text, { literals })).translated
          return {
            ...tool,
            ...(tool.description === undefined ? {} : { description: await description(tool.description) }),
            ...(tool.parameters === undefined ? {} : { parameters: await translateSchema(tool.parameters, description) }),
          }
        })),
      }))
    },
    translateMessages(messages: readonly CodingNsCliMessage[], scope: SessionPromptScope): Promise<readonly CodingNsCliMessage[]> {
      return run(scope, messages, async translate => Promise.all(messages.map(async message => {
        const source = message.source
        if (source?.kind !== 'skill-catalog' && source?.kind !== 'agent-instructions') return message
        const audit = isRecord(source.codingnsTranslationContext) ? source.codingnsTranslationContext : undefined
        const originalContent = audit?.originalContent ?? message.content
        const literals = sourceLiterals(source)
        const records: SessionTranslationRecord[] = []
        const text = async (original: string): Promise<string> => {
          const record = await translate(original, { literals, promptMarkup: true })
          records.push(record)
          return record.translated
        }
        const content = typeof originalContent === 'string' ? await text(originalContent)
          : Array.isArray(originalContent) ? await Promise.all(originalContent.map(async block => isRecord(block) && block.type === 'text' && typeof block.text === 'string'
            ? { ...block, text: await text(block.text) } : block)) : originalContent
        if (records.length === 0) return message
        return { ...message, content, source: { ...source, codingnsTranslationContext: { originalContent, records } } }
      })))
    },
  }
}

function sourceLiterals(source: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const field of ['entries', 'changes']) {
    const entries = source[field]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) if (isRecord(entry)) for (const key of ['name', 'path']) {
      if (typeof entry[key] === 'string') values.push(entry[key])
    }
  }
  return values
}

/** Walk schema positions only; objects inside enum/default/examples are application data. */
async function translateSchema(value: unknown, translate: (text: string) => Promise<string>): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(child => translateSchema(child, translate)))
  if (!isRecord(value)) return value
  const entries = await Promise.all(Object.entries(value).map(async ([key, child]) => {
    if (key === 'description' && typeof child === 'string') return [key, await translate(child)] as const
    if (schemaMaps.has(key) && isRecord(child)) return [key, Object.fromEntries(await Promise.all(Object.entries(child).map(async ([name, schema]) => [name, await translateSchema(schema, translate)])))] as const
    if (schemaChildren.has(key) || schemaLists.has(key)) return [key, await translateSchema(child, translate)] as const
    return [key, child] as const
  }))
  return Object.fromEntries(entries)
}

function schemaLiterals(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaLiterals)
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, child]) => {
    if (schemaMaps.has(key) && isRecord(child)) return [...Object.keys(child), ...Object.values(child).flatMap(schemaLiterals)]
    if (schemaChildren.has(key) || schemaLists.has(key)) return schemaLiterals(child)
    if (key === 'enum' && Array.isArray(child)) return child.filter((item): item is string => typeof item === 'string')
    if (key === 'const' && typeof child === 'string') return [child]
    return []
  })
}
