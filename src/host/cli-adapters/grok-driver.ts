import { spawn, spawnSync } from 'node:child_process'
import type { CodingNsCliModelCatalog, CodingNsCliPermissionResponse, CodingNsCliStreamChunk, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, textValue, usageChunk } from './rpc-driver-utils.js'
import { GROK_CATALOG, isProviderDefaultModel } from './model-catalog.js'

export interface GrokBuildDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/** Grok Build 的 ACP stdio 驱动。ACP 会话和权限细节只在 Host 进程内处理。 */
export class GrokBuildDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'grok', name: 'Grok Build', protocol: 'acp', capabilities: ['models', 'stream', 'tool-events', 'reasoning', 'usage', 'permission'] as const } as const
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private cachedBinary: string | null = null
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly sessions = new Map<string, { rpc: JsonRpcProcess; cwd: string | undefined; providerSessionId: string; requests: Map<string, number | string> }>()

  constructor(options: GrokBuildDriverOptions = {}) {
    this.binaries = options.binaries ?? ['grok', 'grok-build']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) return emptyCatalog()
    const rpc = new JsonRpcProcess({ command, args: ['--acp'], spawn: this.runSpawn })
    try {
      await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'dsh-codingns', version: '0.1.0' }, capabilities: {} })
      rpc.notify('initialized', {})
      const session = await rpc.request('session/new', { cwd: process.cwd() })
      const parsed = parseGrokCatalog(session)
      return parsed.groups.length > 0 ? parsed : GROK_CATALOG
    } catch {
      return GROK_CATALOG
    } finally { rpc.dispose() }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error('Grok Build 未安装')
    const state = await this.getSession(input, command)
    const rpc = state.rpc
    let providerSessionId = state.providerSessionId
    try {
      if (providerSessionId === '') {
        const session = await rpc.request('session/new', {
          cwd: input.cwd ?? process.cwd(),
        ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}),
        }, { signal: input.signal })
        providerSessionId = readSessionId(session) ?? input.sessionId
        state.providerSessionId = providerSessionId
        this.sessions.set(input.sessionId, state)
        this.sessions.set(providerSessionId, state)
      }
      yield { type: 'session-binding', providerSessionId }
      const stream = streamGrokPrompt(rpc, providerSessionId, input.prompt, input.signal, (notification) => {
        const requestId = permissionRequestId(notification)
        if (requestId !== null && notification.id !== undefined && notification.id !== null) state.requests.set(requestId, notification.id)
      })
      let finishReason: 'stop' | 'cancel' | 'error'
      while (true) {
        const item = await stream.next()
        if (item.done) {
          finishReason = item.value
          break
        }
        const chunk = acpMessageToChunk(item.value)
        if (chunk !== null) yield chunk
      }
      if (finishReason === 'cancel') {
        try { await rpc.request('session/cancel', { sessionId: providerSessionId }, { killOnAbort: false }) }
        catch { /* 不同 ACP 版本的取消方法可能不同，请求级取消已经先行发出。 */ }
      }
      yield { type: 'finish', reason: finishReason }
    } finally { /* ACP 进程和会话跨轮复用，统一由 dispose() 回收。 */ }
  }

  respondPermission(sessionId: string, response: CodingNsCliPermissionResponse): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) throw new Error('Grok 权限请求已结束')
    const rpcId = state.requests.get(response.requestId)
    if (rpcId === undefined) throw new Error('Grok 权限请求不存在')
    state.requests.delete(response.requestId)
    const optionId = response.approved ? 'allow-once' : 'reject-once'
    state.rpc.respond(rpcId, { outcome: { outcome: 'selected', optionId } })
  }

  dispose(): void { for (const process of this.processes) process.dispose(); this.processes.clear(); this.sessions.clear(); this.cachedBinary = null }

  private async getSession(input: CodingNsCliTurnInput, command: string) {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd) return previous
    previous?.rpc.dispose()
    const rpc = new JsonRpcProcess({ command, args: ['--acp'], cwd: input.cwd, spawn: this.runSpawn })
    this.processes.add(rpc)
    const state = { rpc, cwd: input.cwd, providerSessionId: '', requests: new Map<string, number | string>() }
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'dsh-codingns', version: '0.1.0' },
      capabilities: {},
    })
    rpc.notify('initialized', {})
    if (input.providerSessionId) {
      try {
        const loaded = await rpc.request('session/load', { sessionId: input.providerSessionId, cwd: input.cwd ?? process.cwd() })
        state.providerSessionId = readSessionId(loaded) ?? input.providerSessionId
      } catch { /* 旧版 ACP 没有 load，下一轮在同一进程创建新会话 */ }
    }
    // ACP 权限是 Grok 发起的 server request，先挂起响应，待标准权限入口明确回复原始 id。
    rpc.setServerRequestHandler((message) => {
      const requestId = permissionRequestId(message)
      if (requestId !== null && message.id !== undefined && message.id !== null) state.requests.set(requestId, message.id)
      return new Promise<never>(() => undefined)
    })
    this.sessions.set(input.sessionId, state)
    if (state.providerSessionId !== '') this.sessions.set(state.providerSessionId, state)
    return state
  }
}

const GROK_DRAIN_WAIT_MS = 250

/**
 * Grok 可能先返回 prompt 响应，再补发最后一批 session/update。
 * 响应或终态任一先到都会启动固定排空窗口，窗口内的文本和错误仍会被消费。
 */
async function* streamGrokPrompt(
  rpc: JsonRpcProcess,
  sessionId: string,
  prompt: string,
  signal: AbortSignal | undefined,
  onNotification: (message: JsonRpcMessage) => void,
): AsyncGenerator<JsonRpcMessage, 'stop' | 'cancel' | 'error', void> {
  const queue: JsonRpcMessage[] = []
  const requestController = new AbortController()
  let wake: (() => void) | undefined
  let drainDeadline: number | null = null
  let terminalReason: 'stop' | 'cancel' | 'error' | null = null
  const notify = (): void => { wake?.(); wake = undefined }
  const beginDrain = (): void => {
    if (drainDeadline === null) drainDeadline = Date.now() + GROK_DRAIN_WAIT_MS
    notify()
  }
  const listener = (message: JsonRpcMessage): void => {
    queue.push(message)
    onNotification(message)
    const notificationReason = grokNotificationReason(message)
    if (notificationReason === null) {
      notify()
      return
    }
    terminalReason = mergeGrokReason(terminalReason, notificationReason)
    // 部分 Grok 版本只发终态通知而不回复 prompt，主动取消可清理待处理请求。
    requestController.abort()
    beginDrain()
  }
  const removeListener = rpc.addNotificationListener(listener)
  const onAbort = (): void => {
    terminalReason = 'cancel'
    queue.length = 0
    requestController.abort()
    drainDeadline = Date.now()
    notify()
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  void rpc.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: prompt }],
  }, { signal: requestController.signal, killOnAbort: false }).then(
    (response) => {
      const responseReason = grokPromptReason(response)
      if (responseReason !== null) terminalReason = mergeGrokReason(terminalReason, responseReason)
      beginDrain()
    },
    () => {
      if (terminalReason === null) terminalReason = signal?.aborted ? 'cancel' : 'error'
      beginDrain()
    },
  )

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      if (drainDeadline === null) {
        await new Promise<void>((resolve) => { wake = resolve })
        continue
      }
      const remaining = drainDeadline - Date.now()
      if (remaining <= 0) break
      await Promise.race([
        new Promise<void>((resolve) => { wake = resolve }),
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ])
      wake = undefined
    }
    return terminalReason ?? 'stop'
  } finally {
    signal?.removeEventListener('abort', onAbort)
    removeListener()
  }
}

function grokPromptReason(value: unknown): 'stop' | 'error' | null {
  if (!isRecord(value) || typeof value.stopReason !== 'string') return null
  const reason = value.stopReason.toLowerCase()
  return reason === 'cancelled' || reason === 'error' || reason === 'failed' ? 'error' : 'stop'
}

function mergeGrokReason(
  current: 'stop' | 'cancel' | 'error' | null,
  next: 'stop' | 'cancel' | 'error',
): 'stop' | 'cancel' | 'error' {
  if (current === 'error' || next === 'error') return 'error'
  if (current === 'cancel' || next === 'cancel') return 'cancel'
  return 'stop'
}

function grokNotificationReason(message: JsonRpcMessage): 'stop' | 'error' | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const type = typeof update.sessionUpdate === 'string'
    ? update.sessionUpdate.toLowerCase()
    : typeof update.type === 'string'
      ? update.type.toLowerCase()
      : ''
  if (type.includes('error') || type.includes('failed')) return 'error'
  if (type.includes('turn_completed') || type.includes('turn_complete') || type === 'completed' || type === 'done') return 'stop'
  return null
}

function acpMessageToChunk(message: Record<string, any>): CodingNsCliStreamChunk | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const type = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : typeof update.type === 'string' ? update.type : typeof message.method === 'string' ? message.method : ''
  const text = textValue(update.delta ?? update.text ?? update.content ?? update.message ?? update.detail)
  if (type.includes('permission')) {
    const requestId = permissionRequestId(message) ?? (typeof update.requestId === 'string' ? update.requestId : typeof update.id === 'string' ? update.id : null)
    if (requestId !== null) return { type: 'permission-request', requestId, kind: typeof update.kind === 'string' ? update.kind : 'unknown', ...(text ? { detail: text } : {}) }
  }
  if (type.includes('agent_message') || type.includes('text') || type === 'message') return text ? { type: 'text-delta', text } : null
  if (type.includes('thought') || type.includes('reason')) return text ? { type: 'reasoning-delta', text } : null
  if (type.includes('tool') || type.includes('command')) {
    const name = typeof update.name === 'string' ? update.name : typeof update.toolName === 'string' ? update.toolName : null
    return name ? { type: 'tool-running', toolName: name } : null
  }
  return usageChunk(update)
}

function permissionRequestId(message: Record<string, any>): string | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const type = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : typeof update.type === 'string' ? update.type : typeof message.method === 'string' ? message.method : ''
  if (!type.toLowerCase().includes('permission')) return null
  const id = message.id ?? update.requestId ?? update.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

function readSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId === 'string') return value.sessionId
  if (isRecord(value.session) && typeof value.session.id === 'string') return value.session.id
  return typeof value.id === 'string' ? value.id : null
}

function parseGrokCatalog(value: unknown): CodingNsCliModelCatalog {
  if (!isRecord(value)) return emptyCatalog()
  const models = isRecord(value.models) && Array.isArray(value.models.availableModels)
    ? value.models.availableModels
    : []
  const configOptions = Array.isArray(value.configOptions) ? value.configOptions : []
  const efforts = new Map<string, string[]>()
  for (const option of configOptions) {
    if (!isRecord(option)) continue
    const id = typeof option.id === 'string' ? option.id : ''
    if (!/model|reasoning/iu.test(id)) continue
    const values = Array.isArray(option.options) ? option.options : Array.isArray(option.values) ? option.values : []
    if (!/reasoning/iu.test(id)) continue
    for (const value of values) {
      const effort = typeof value === 'string' ? value : isRecord(value) && typeof value.id === 'string' ? value.id : null
      if (!effort) continue
      const modelId = typeof option.modelId === 'string' ? option.modelId : '*'
      const current = efforts.get(modelId) ?? []
      if (!current.includes(effort)) current.push(effort)
      efforts.set(modelId, current)
    }
  }
  const items = models.flatMap((entry) => {
    if (typeof entry === 'string') return [{ id: entry, name: entry, efforts: efforts.get(entry) ?? [] }]
    if (!isRecord(entry)) return []
    const id = typeof entry.modelId === 'string' ? entry.modelId : typeof entry.id === 'string' ? entry.id : null
    if (!id) return []
    const meta = isRecord(entry._meta) ? entry._meta : {}
    const declared = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.flatMap((item) => typeof item === 'string' ? [item] : isRecord(item) && typeof item.id === 'string' ? [item.id] : []) : []
    return [{ id, name: typeof entry.name === 'string' ? entry.name : id, efforts: declared.length > 0 ? declared : efforts.get(id) ?? efforts.get('*') ?? [] }]
  })
  if (items.length === 0) return emptyCatalog()
  const deduped = [...new Map(items.map((item) => [item.id, item])).values()]
  return { groups: [{ id: 'grok', name: 'Grok', models: deduped }], currentModel: null, currentEffort: null }
}
