import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsCliMessage, CodingNsCliSessionConfig } from '../../shared/contracts/cli-adapter.js'
import { CommandCodeDriver } from './command-code-driver.js'
import { ClaudeCodeDriver } from './claude-driver.js'
import { GeminiCliDriver } from './gemini-driver.js'
import { KimiCliDriver } from './kimi-driver.js'
import { PiAgentDriver } from './pi-driver.js'
import { CodexAppServerDriver } from './codex-driver.js'
import { GrokBuildDriver } from './grok-driver.js'
import { OpenCodeDriver } from './opencode-driver.js'
import { CodingNsCliAdapterRegistry } from './registry.js'
import { CodingNsCliSessionStore } from './session-store.js'
import { CodingNsDshToolHistoryProjector } from './dsh-tool-history.js'
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
      const sessionStore = new CodingNsCliSessionStore(context.services.settings === undefined ? {} : { settings: context.services.settings })
      const registry = options.registry ?? new CodingNsCliAdapterRegistry([
        new CommandCodeDriver(),
        new ClaudeCodeDriver(),
        new KimiCliDriver(),
        new GeminiCliDriver(),
        new PiAgentDriver(),
        new CodexAppServerDriver(),
        new OpenCodeDriver(),
        new GrokBuildDriver(),
      ], context.services.settings?.get().agentAdapters, {
        sessionStore,
        ...(context.services.nativeSessions === undefined ? {} : { nativeSessions: context.services.nativeSessions }),
      })
      registry.applyEnabledSettings(context.services.settings?.get().agentAdapters)
      const nativeSessions = context.services.nativeSessions
      if (nativeSessions !== undefined) {
        const disposeNativeEvents = nativeSessions.subscribe({
          onEvent: (session, event) => {
            const sessionId = nativeSessionId(session)
            const eventType = nativeEventType(event)
            if (sessionId === undefined || eventType === undefined) return
            const current = sessionStore.get(sessionId)
            if (current === undefined || current.status === 'archived') return
            if (eventType === 'turn/start') {
              sessionStore.upsert(sessionId, { ...current, status: 'active' })
            } else if (eventType === 'turn/end') {
              sessionStore.upsert(sessionId, { ...current, status: 'idle' })
            }
          },
        })
        context.resources.add(disposeNativeEvents)
      }
      context.resources.add(context.services.rpc.register('cli', (action, payload) => {
        switch (action) {
          case 'catalog': return registry.catalog()
          case 'models': return registry.models(readAdapterId(payload))
          case 'adapter/set': return setAdapterEnabled(context.services.settings, registry, payload)
          case 'session/get': return registry.getSession(readSessionId(payload))
          case 'session/set': return registry.setSession(readSessionId(payload), readSessionConfig(payload))
          case 'session/list': return registry.listSessions(readSessionListOptions(payload))
          case 'session/archive': return registry.archiveSession(readSessionId(payload))
          case 'permission/respond': return registry.respondPermission(readSessionId(payload), readPermissionResponse(payload))
          case 'session/steer': return registry.steer(readSessionId(payload), readPrompt(payload), false)
          case 'session/follow-up': return registry.steer(readSessionId(payload), readPrompt(payload), true)
          case 'session/interrupt': return registry.interrupt(readSessionId(payload))
          default: throw new Error(`未知 CLI RPC: cli/${action}`)
        }
      }))

      const settings = context.services.settings
      if (settings !== undefined) {
        context.resources.add(settings.watch((next) => {
          registry.applyEnabledSettings(next.agentAdapters)
          sessionStore.sync(next.cliSessions)
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
          const cwd = resolveSessionCwd(context.services.nativeSessions, sessionId, value)
          const input = {
            sessionId,
            messages,
            prompt: extractPrompt(messages),
            ...(config.modelId ? { modelId: config.modelId } : {}),
            ...(config.effortId ? { effortId: config.effortId } : {}),
            ...(config.providerSessionId ? { providerSessionId: config.providerSessionId } : {}),
            ...(config.rawStoreRef ? { rawStoreRef: config.rawStoreRef } : {}),
            ...(cwd === undefined ? {} : { cwd }),
            ...(isAbortSignal(value?.signal) ? { signal: value.signal } : {}),
          }
          const toolHistory = new CodingNsDshToolHistoryProjector(nativeSessions, sessionId)
          try {
            for await (const chunk of registry.execute({ ...input, adapterId: config.adapterId })) {
              if (chunk.type === 'session-binding') continue
              if (chunk.type === 'tool-running') {
                toolHistory.observe(chunk)
                continue
              }
              if (chunk.type === 'finish') {
                toolHistory.finalize(chunk.reason)
                for (const dshChunk of toDshChunks(chunk)) yield dshChunk
                // DSH 要求 finish 是唯一且最后一个 chunk。这里 return 也会关闭上游迭代器。
                return
              }
              for (const dshChunk of toDshChunks(chunk)) yield dshChunk
            }
            const reason = input.signal?.aborted ? 'cancel' : 'stop'
            toolHistory.finalize(reason)
            for (const dshChunk of toDshChunks({ type: 'finish', reason })) yield dshChunk
          } catch (error) {
            const reason = input.signal?.aborted ? 'cancel' : 'error'
            const message = safeError(error)
            toolHistory.finalize(reason, message)
            if (reason === 'error') yield { type: 'text-delta', index: 1, text: formatExecutionFailure(config.adapterId, message) }
            for (const dshChunk of toDshChunks({ type: 'finish', reason }, message)) yield dshChunk
          }
        })
        if (typeof dispose === 'function') context.resources.add(() => { (dispose as () => void)() })
      }
      context.resources.add(async () => { await registry.dispose(); await sessionStore.flush() })
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
    ...(typeof record?.providerSessionId === 'string' && record.providerSessionId.trim() ? { providerSessionId: record.providerSessionId.trim() } : {}),
  }
}

function readSessionListOptions(value: unknown): { includeArchived?: boolean; adapterId?: string } {
  const record = asRecord(value)
  const adapterId = typeof record?.adapterId === 'string' && record.adapterId.trim() ? record.adapterId.trim() : undefined
  const includeArchived = record?.includeArchived === true ? true : undefined
  return {
    ...(adapterId ? { adapterId } : {}),
    ...(includeArchived === true ? { includeArchived: true } : {}),
  }
}

function readPrompt(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.prompt !== 'string' || record.prompt.trim() === '') throw new Error('prompt 不能为空')
  return record.prompt.trim()
}

function readPermissionResponse(value: unknown): { requestId: string; approved: boolean; reason?: string } {
  const record = asRecord(value)
  if (typeof record?.requestId !== 'string' || record.requestId.trim() === '') throw new Error('requestId 不能为空')
  if (typeof record?.approved !== 'boolean') throw new Error('approved 必须是布尔值')
  return {
    requestId: record.requestId.trim(),
    approved: record.approved,
    ...(typeof record.reason === 'string' && record.reason.trim() ? { reason: record.reason.trim() } : {}),
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

function toDshChunks(
  chunk: { type: string; text?: string; toolName?: string; callId?: string; input?: string; kind?: string; inputTokens?: number; outputTokens?: number; reason?: string },
  failureMessage?: string,
): readonly Record<string, unknown>[] {
  if (chunk.type === 'reasoning-snapshot' || chunk.type === 'text-snapshot') throw new Error('CLI 快照未经过公共流规范化器')
  if (chunk.type === 'session-binding') return [{ type: 'session-binding' }]
  if (chunk.type === 'permission-request') return [{ type: 'text-delta', index: 1, text: `\n\n> [${chunk.kind ?? '工具'} 请求等待确认]\n\n` }]
  if (chunk.type === 'usage') return [{ type: 'usage', usage: { inputTokens: chunk.inputTokens ?? 0, outputTokens: chunk.outputTokens ?? 0 } }]
  // 工具事件由公共只读投影器直接保存到 Session，绝不作为 StreamChunk.tool-call
  // 交回 Agent Loop，否则 DSH 会把外部 Agent 已执行的工具再执行一次。
  if (chunk.type === 'tool-running') return []
  if (chunk.type === 'finish') return [{ type: 'finish', reason: toDshFinishReason(chunk.reason, failureMessage) }]
  return [{ type: chunk.type, index: chunk.type === 'reasoning-delta' ? 0 : 1, text: chunk.text ?? '' }]
}

function toDshFinishReason(reason: string | undefined, failureMessage?: string): Record<string, unknown> {
  if (reason === 'cancel') {
    return { kind: 'aborted', failure: { message: failureMessage ?? '外部 Agent 执行已取消', code: 'ABORTED' } }
  }
  if (reason === 'error') {
    return { kind: 'error', failure: { message: failureMessage ?? '外部 Agent 执行失败', code: 'PROVIDER_ERROR' } }
  }
  return { kind: 'stop' }
}

function formatExecutionFailure(adapterId: string, message: string): string {
  const content = `[${adapterId}] ${message}`
  const fence = '~'.repeat(Math.max(3, longestCharacterRun(content, '~') + 1))
  return `\n\n**外部 Agent 执行失败**\n\n${fence}text\n${content}\n${fence}\n`
}

function longestCharacterRun(value: string, character: string): number {
  let longest = 0
  let current = 0
  for (const item of value) {
    current = item === character ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return longest
}

function resolveSessionCwd(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  sessionId: string,
  value: Record<string, any> | null,
): string | undefined {
  const direct = typeof value?.cwd === 'string' && value.cwd.trim() ? value.cwd.trim() : undefined
  if (direct !== undefined) return direct
  if (nativeSessions === undefined || sessionId.trim() === '') return undefined
  const session = nativeSessions.get(sessionId)
  const record = asRecord(session)
  const header = asRecord(record?.header)
  const meta = asRecord(record?.meta)
  const cwd = [header?.cwd, meta?.cwd, record?.cwd].find((item): item is string => typeof item === 'string' && item.trim() !== '')
  return cwd?.trim()
}

function asRecord(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function isRecord(value: unknown): value is Record<string, any> { return asRecord(value) !== null }
function nativeSessionId(value: unknown): string | undefined {
  const record = asRecord(value)
  return typeof record?.id === 'string' && record.id.trim() ? record.id.trim() : typeof record?.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined
}
function nativeEventType(value: unknown): string | undefined {
  const record = asRecord(value)
  return typeof record?.type === 'string' ? record.type : undefined
}
function isMessage(value: unknown): value is CodingNsCliMessage { const record = asRecord(value); return (record?.role === 'user' || record?.role === 'assistant' || record?.role === 'system') && 'content' in record }
function isAbortSignal(value: unknown): value is AbortSignal { return asRecord(value)?.aborted === true || (asRecord(value)?.addEventListener instanceof Function) }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) }
