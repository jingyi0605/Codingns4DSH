import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsCliMessage, CodingNsCliSessionConfig } from '../../shared/contracts/cli-adapter.js'
import { CommandCodeDriver } from './command-code-driver.js'
import { CodingNsCliAdapterRegistry } from './registry.js'
import type { CodingNsHostServices } from '../features/types.js'

export function createCliAdaptersFeature(options: { registry?: CodingNsCliAdapterRegistry } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'cliAdapters',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      const registry = options.registry ?? new CodingNsCliAdapterRegistry([new CommandCodeDriver()], context.services.settings?.get().agentAdapters)
      registry.applyEnabledSettings(context.services.settings?.get().agentAdapters)
      context.resources.add(context.services.rpc.register('cli', (action, payload) => {
        switch (action) {
          case 'catalog': return registry.catalog()
          case 'models': return registry.models(readAdapterId(payload))
          case 'adapter/set': return setAdapterEnabled(context.services.settings, registry, payload)
          case 'session/get': return registry.getSession(readSessionId(payload))
          case 'session/set': return registry.setSession(readSessionId(payload), readSessionConfig(payload))
          default: throw new Error(`未知 CLI RPC: cli/${action}`)
        }
      }))

      const settings = context.services.settings
      if (settings !== undefined) {
        context.resources.add(settings.watch((next) => {
          registry.applyEnabledSettings(next.agentAdapters)
        }))
      }

      const events = context.services.events
      if (events !== undefined) {
        const dispose = events.on('llm/stream', async function* (options: unknown, next: () => AsyncIterable<unknown>) {
          const value = asRecord(options)
          const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
          const config = sessionId ? registry.getSession(sessionId) : { adapterId: 'dsh' }
          if (config.adapterId === 'dsh' || value?.purpose === 'session-title' || value?.purpose === 'compaction') {
            yield* next()
            return
          }
          const messages = Array.isArray(value?.messages) ? value.messages.filter(isMessage) : []
          const input = {
            sessionId,
            messages,
            prompt: extractPrompt(messages),
            ...(config.modelId ? { modelId: config.modelId } : {}),
            ...(config.effortId ? { effortId: config.effortId } : {}),
            ...(typeof value?.cwd === 'string' ? { cwd: value.cwd } : {}),
            ...(isAbortSignal(value?.signal) ? { signal: value.signal } : {}),
          }
          try {
            for await (const chunk of registry.execute({ ...input, adapterId: config.adapterId })) yield toDshChunk(chunk)
          } catch (error) {
            yield { type: 'text-delta', index: 1, text: `\n\n> [${config.adapterId} 执行失败: ${safeError(error)}]\n\n` }
            yield { type: 'finish', reason: 'stop' }
          }
        })
        if (typeof dispose === 'function') context.resources.add(() => { (dispose as () => void)() })
      }
      context.resources.add(() => registry.dispose())
    },
  }
}

function readAdapterId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.adapterId !== 'string' || record.adapterId.trim() === '') throw new Error('adapterId 不能为空')
  return record.adapterId.trim()
}

function readSessionId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.sessionId !== 'string' || record.sessionId.trim() === '') throw new Error('sessionId 不能为空')
  return record.sessionId.trim()
}

function readSessionConfig(value: unknown): CodingNsCliSessionConfig {
  const record = asRecord(value)
  const adapterId = readAdapterId(record)
  return {
    adapterId,
    ...(typeof record?.modelId === 'string' && record.modelId.trim() ? { modelId: record.modelId.trim() } : {}),
    ...(typeof record?.effortId === 'string' && record.effortId.trim() ? { effortId: record.effortId.trim() } : {}),
  }
}

async function setAdapterEnabled(
  settings: CodingNsHostServices['settings'],
  registry: CodingNsCliAdapterRegistry,
  value: unknown,
): Promise<{ adapterId: string; enabled: boolean }> {
  const record = asRecord(value)
  const adapterId = readAdapterId(record)
  if (typeof record?.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
  const enabled = registry.setEnabled(adapterId, record.enabled)
  if (settings !== undefined) await settings.update({ agentAdapters: registry.enabledSnapshot() })
  return { adapterId, enabled }
}

function extractPrompt(messages: readonly CodingNsCliMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === 'user') return extractText(messages[index]!.content)
  return ''
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isRecord).map((part) => typeof part.text === 'string' ? part.text : '').join('\n').trim()
}

function toDshChunk(chunk: { type: string; text?: string; toolName?: string; inputTokens?: number; outputTokens?: number; reason?: string }): Record<string, unknown> {
  if (chunk.type === 'usage') return { type: 'usage', usage: { inputTokens: chunk.inputTokens ?? 0, outputTokens: chunk.outputTokens ?? 0 } }
  if (chunk.type === 'tool-running') return { type: 'text-delta', index: 1, text: `\n\n> [执行工具: ${chunk.toolName ?? 'unknown'}]\n\n` }
  if (chunk.type === 'finish') return { type: 'finish', reason: chunk.reason ?? 'stop' }
  return { type: chunk.type, index: chunk.type === 'reasoning-delta' ? 0 : 1, text: chunk.text ?? '' }
}

function asRecord(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function isRecord(value: unknown): value is Record<string, any> { return asRecord(value) !== null }
function isMessage(value: unknown): value is CodingNsCliMessage { const record = asRecord(value); return (record?.role === 'user' || record?.role === 'assistant' || record?.role === 'system') && 'content' in record }
function isAbortSignal(value: unknown): value is AbortSignal { return asRecord(value)?.aborted === true || (asRecord(value)?.addEventListener instanceof Function) }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) }
