import { getAdapterRegistry } from './registry-holder.js'

/** 委派目标在 DSH 原生 Subagent Provider 中使用的稳定标识。 */
export const EXTERNAL_SUBAGENT_IDS = [
  // `dsh` 是 DSH 自带的进程内子智能体目标，不对应 cli-adapters Registry 中的外部驱动。
  // 它仍然放在同一份稳定 ID 列表里，保证 agent_subagent schema、委派 carrier 和
  // Host 派发入口使用同一套白名单。
  'dsh', 'mcode', 'zcode', 'claude-code', 'codex', 'kimi', 'gemini', 'pi', 'opencode', 'grok', 'command-code',
] as const

export function externalTeamProvider(adapterId: string): string {
  // DSH 原生的进程内 spawn 后端默认注册名就是 `spawn`。`dsh` 目标直接复用
  // 这个 Provider，不能注册一个 `codingns-external-dsh` 的空壳，否则会把
  // 子会话错误地路由到外部 CLI 桥接层。
  if (adapterId === 'dsh') return 'spawn'
  return `codingns-external-${adapterId}`
}

interface NativeParent {
  readonly id: string
  readonly session?: { readonly header?: { readonly id?: string } }
}

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
    readonly request: {
      readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
      readonly parent: unknown
      /** DSH 原生 spawn 目标可显式覆盖子 Agent 的模型路由。 */
      readonly agentOptions?: {
        readonly provider?: string
        readonly model?: string
        readonly reasoningEffort?: string
        readonly maxTokens?: number
      }
    }
    readonly signal?: AbortSignal
  }): Promise<{ readonly childId: string; readonly messageId: string }>
  /** DSH 0.2 可续子会话的后续消息入口；sender 必须是精确的父 Agent。 */
  sendMessage?(sender: unknown, targetId: string, content: readonly { readonly type: 'text'; readonly text: string }[], options?: { readonly signal?: AbortSignal }): Promise<string> | string
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
    // `spawn` 是 DSH 自身安装的 Provider，由 DSH 负责注册和释放。这里仅
    // 注册外部 CLI 的虚拟 Provider，避免重复注册 `dsh` 目标。
    if (adapterId === 'dsh') continue
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
        // DSH Agent 的 `id` 与会话头 id 在某些宿主实现中不是同一个值；派发
        // 选择键使用会话 id，Provider 准备阶段优先读 Agent id。两者都查，避免
        // 用户明确选择的模型在创建子会话时静默退回适配器默认模型。
        const selected = pendingSelections.get(selectionKey(request.parent.id, adapterId))
          ?? (request.parent.session?.header?.id === undefined
            ? undefined
            : pendingSelections.get(selectionKey(request.parent.session.header.id, adapterId)))
        const parentSessionId = request.parent.session?.header?.id?.trim() || request.parent.id
        registry.setSession(request.sessionId, {
          adapterId,
          parentSessionId,
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
