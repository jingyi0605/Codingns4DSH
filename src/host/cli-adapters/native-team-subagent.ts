import { getAdapterRegistry } from './registry-holder.js'

/** 外部适配器在 DSH 原生 Subagent Provider 中使用的稳定名称。 */
export const EXTERNAL_SUBAGENT_IDS = [
  'mcode', 'zcode', 'claude-code', 'codex', 'kimi', 'gemini', 'pi', 'opencode', 'grok', 'command-code',
] as const

export function externalTeamProvider(adapterId: string): string {
  return `codingns-external-${adapterId}`
}

interface NativeParent { readonly id: string }

export interface NativeSubagentService {
  registerProvider(provider: {
    readonly name: string
    readonly capabilities: Record<string, boolean>
    readonly inheritsParentContext: boolean
    start(request: unknown): never
    prepareContinuable(request: { readonly sessionId: string; readonly parent: NativeParent; readonly signal: AbortSignal }): Promise<Record<string, never>>
  }): unknown
  startContinuable?(spec: {
    readonly provider: string
    readonly label?: string
    readonly request: { readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]; readonly parent: unknown }
    readonly signal?: AbortSignal
  }): Promise<{ readonly childId: string; readonly messageId: string }>
}

interface PendingSelection { readonly modelId?: string }
const pendingSelections = new Map<string, PendingSelection>()
const registeredServices = new WeakMap<object, () => void>()

function selectionKey(parentId: string, adapterId: string): string {
  return `${parentId}\u0000${adapterId}`
}

/** DSH Agent 工具不是并发安全的，同一父会话同一 Provider 只允许一个预留。 */
export async function withTeamSubagentSelection<T>(parentId: string, adapterId: string, modelId: string | undefined, action: () => Promise<T>): Promise<T> {
  const key = selectionKey(parentId, adapterId)
  if (pendingSelections.has(key)) throw new Error('同一 Agent 的子代理创建正在进行中')
  pendingSelections.set(key, modelId === undefined ? {} : { modelId })
  try { return await action() } finally { pendingSelections.delete(key) }
}

const creationChains = new Map<string, Promise<unknown>>()

/**
 * 创建阶段的排队版本：保留“同一父会话同一 Provider 一次只创建一条”的并发约束，
 * 但把并行批次排成队列而不是直接拒绝。桥接拦截外部 CLI 的并行子代理时使用。
 */
export function enqueueTeamSubagentSelection<T>(parentId: string, adapterId: string, modelId: string | undefined, action: () => Promise<T>): Promise<T> {
  const key = selectionKey(parentId, adapterId)
  const run = async (): Promise<T> => {
    if (pendingSelections.has(key)) throw new Error('同一 Agent 的子代理创建正在进行中')
    pendingSelections.set(key, modelId === undefined ? {} : { modelId })
    try { return await action() } finally { pendingSelections.delete(key) }
  }
  const previous = creationChains.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.then(() => undefined, () => undefined)
  creationChains.set(key, settled)
  void settled.then(() => {
    if (creationChains.get(key) === settled) creationChains.delete(key)
  })
  return next
}

/** 在 Subagent scope 注册外部 Provider；返回值用于 Host 停用时释放注册。 */
export function registerNativeTeamSubagentProviders(service: NativeSubagentService): () => void {
  if ((typeof service !== 'object' && typeof service !== 'function')) return () => undefined
  const existing = registeredServices.get(service)
  if (existing !== undefined) return existing
  const disposers: (() => void)[] = []
  for (const adapterId of EXTERNAL_SUBAGENT_IDS) {
    const result = service.registerProvider({
      name: externalTeamProvider(adapterId),
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: true, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start() { throw new Error('外部 Agent Team 提供方只支持可续聊子代理') },
      async prepareContinuable(request) {
        // DSH 可能把缺省的 signal 原样转发（undefined），这里保持容错。
        request.signal?.throwIfAborted()
        const registry = getAdapterRegistry()
        if (registry === undefined) throw new Error('外部 Agent 适配器尚未就绪')
        const adapter = (await registry.catalog()).find((item) => item.id === adapterId)
        if (adapter === undefined || !adapter.installed || !adapter.enabled) throw new Error(`${adapterId} 未安装或未启用`)
        const selected = pendingSelections.get(selectionKey(request.parent.id, adapterId))
        registry.setSession(request.sessionId, {
          adapterId,
          parentSessionId: request.parent.id,
          origin: 'subagent',
          ...(selected?.modelId === undefined ? {} : { modelId: selected.modelId }),
        })
        await registry.flushSessionBindings()
        return {}
      },
    })
    if (typeof result === 'function') disposers.push(result as () => void)
    else if (typeof result === 'object' && result !== null && typeof (result as { dispose?: unknown }).dispose === 'function') {
      disposers.push(() => { (result as { dispose(): void }).dispose() })
    }
  }
  const dispose = (): void => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 清理继续执行 */ }
    }
    registeredServices.delete(service)
  }
  registeredServices.set(service, dispose)
  return dispose
}
