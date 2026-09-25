import { spawnSync, type SpawnSyncResult } from 'node:child_process'
import type { CodingNsCliModelCatalog, CodingNsAgentEvent } from '../../shared/contracts/cli-adapter.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { WINDOWS } from './process-utils.js'

export interface RpcBinaryOptions {
  readonly binaries: readonly string[]
  readonly spawnSync?: typeof spawnSync
}

export async function detectBinary(options: RpcBinaryOptions): Promise<{ installed: boolean; version: string | null; command: string | null }> {
  const run = options.spawnSync ?? spawnSync
  for (const command of options.binaries) {
    try {
      const result = run(command, ['--version'], { encoding: 'utf8', timeout: 3_000, windowsHide: true, shell: WINDOWS })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      const version = output.match(/\d+\.\d+(?:\.\d+)?/u)?.[0] ?? null
      if (result.status === 0 && version !== null) return { installed: true, version, command }
    } catch { /* PATH 中没有该命令 */ }
  }
  return { installed: false, version: null, command: null }
}

/** 把一个 JSON-RPC 请求期间收到的通知排成异步流，同时等待最终响应。 */
export async function* streamRpcRequest(
  process: JsonRpcProcess,
  method: string,
  params: unknown,
  signal: AbortSignal | undefined,
  options: { readonly dispose?: boolean; readonly killOnAbort?: boolean; readonly onNotification?: (message: JsonRpcMessage) => void } = {},
): AsyncGenerator<JsonRpcMessage, unknown, void> {
  const queue: JsonRpcMessage[] = []
  let wake: (() => void) | undefined
  let settled = false
  let failure: unknown
  const listener = (message: JsonRpcMessage): void => {
    queue.push(message)
    options.onNotification?.(message)
    wake?.()
    wake = undefined
  }
  const removeListener = process.addNotificationListener(listener)
  const response = process.request(method, params, {
    ...(signal === undefined ? {} : { signal }),
    ...(options.killOnAbort === undefined ? {} : { killOnAbort: options.killOnAbort }),
  }).then((value) => { settled = true; wake?.(); wake = undefined; return value }, (error: unknown) => { failure = error; settled = true; wake?.(); wake = undefined; return undefined })

  try {
    while (!settled || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
    if (failure !== undefined) throw failure
    return await response
  } finally {
    removeListener()
    if (options.dispose !== false) process.dispose()
  }
}

export function emptyCatalog(): CodingNsCliModelCatalog {
  return { groups: [], currentModel: null, currentEffort: null }
}

export function textValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return null
  for (const key of ['text', 'delta', 'content', 'message']) if (typeof value[key] === 'string') return value[key] as string
  return null
}

export function usageChunk(value: unknown): CodingNsAgentEvent | null {
  if (!isRecord(value)) return null
  const usage = isRecord(value.usage) ? value.usage : value
  const explicitUncachedInputTokens = optionalNumberValue(usage.uncachedInputTokens ?? usage.uncached_input_tokens)
  const inputTokens = explicitUncachedInputTokens
    ?? numberValue(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount)
  const outputTokens = numberValue(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount)
  const cacheReadInputTokens = optionalNumberValue(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens)
  const cacheWriteInputTokens = optionalNumberValue(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens)
  const cacheReadTokens = optionalNumberValue(
    usage.cacheReadTokens
      ?? usage.cachedReadTokens
      ?? usage.cache_read_tokens
      ?? usage.cached_read_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cachedInputTokens
      ?? usage.cached_input_tokens
      ?? usage.cachedContentTokenCount
      ?? cacheReadInputTokens,
  )
  const cacheWriteTokens = optionalNumberValue(
    usage.cacheWriteTokens
      ?? usage.cacheCreationTokens
      ?? usage.cache_write_tokens
      ?? usage.cache_creation_tokens
      ?? usage.cache_write_input_tokens
      ?? usage.cache_creation_input_tokens
      ?? cacheWriteInputTokens,
  )
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === undefined && cacheWriteTokens === undefined) return null
  const totalTokens = optionalNumberValue(usage.totalTokens ?? usage.total_tokens ?? usage.totalTokenCount)
  const hasCacheBreakdown = explicitUncachedInputTokens !== undefined || cacheReadTokens !== undefined || cacheWriteTokens !== undefined
  const cachedInputTokens = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  const inputExcludesCache = explicitUncachedInputTokens !== undefined || cacheReadInputTokens !== undefined || cacheWriteInputTokens !== undefined
  const fullInputTokens = inputTokens + (inputExcludesCache ? cachedInputTokens : 0)
  return {
    type: 'usage',
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(hasCacheBreakdown ? { uncachedInputTokens: inputExcludesCache ? inputTokens : Math.max(0, inputTokens - cachedInputTokens) } : {}),
    ...(totalTokens === undefined && !hasCacheBreakdown ? {} : { totalTokens: totalTokens ?? fullInputTokens + outputTokens }),
    ...(cacheReadTokens === undefined || fullInputTokens <= 0
      ? {}
      : { cacheHitRate: Number((cacheReadTokens / fullInputTokens * 100).toFixed(4)) }),
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined
}

export type { SpawnSyncResult }
