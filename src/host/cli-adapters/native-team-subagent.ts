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

/** 一次原生子代理启动请求，屏蔽两代 DSH API 的参数差异。 */
export interface NativeSubagentStartSpec {
  readonly provider: string
  readonly label?: string
  readonly request: {
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly parent: unknown
    /**
     * 子会话起始目录。alpha.2 起由 `startActivation` 解析：绝对路径直接使用，
     * 相对路径相对父级当前目录解析。旧版本只读自己认识的字段、不做 schema 校验，
     * 因此多传该字段会被静默忽略，不会让委派失败。
     */
    readonly cwd?: string
    /** DSH 原生 spawn 目标可显式覆盖子 Agent 的模型路由。 */
    readonly agentOptions?: {
      readonly provider?: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly maxTokens?: number
    }
  }
  readonly signal?: AbortSignal
}

/** 归一化后的启动结果；托管 Activation 不保证返回 messageId。 */
export interface NativeSubagentStart {
  readonly childId: string
  readonly messageId?: string
}

export interface NativeSubagentService {
  registerProvider(provider: {
    readonly name: string
    readonly capabilities: Record<string, boolean>
    readonly inheritsParentContext: boolean
    start(request: unknown): never
    prepareContinuable(request: { readonly sessionId: string; readonly parent: NativeParent; readonly signal: AbortSignal }): Promise<Record<string, never>>
  }): unknown
  /**
   * DSH 0.2.1-alpha.2 起的托管 Activation 入口。
   *
   * `delivery` 为必填：`parent` 表示结果由 DSH 通知父模型，`caller` 表示只经
   * `result` 返回调用方。返回值不再保证 `messageId`（外部后端可能没有本地收件箱）。
   */
  startActivation?(spec: NativeSubagentStartSpec & { readonly delivery: 'parent' | 'caller' }): Promise<{
    readonly childId: string
    readonly messageId?: string
    readonly result?: Promise<unknown>
    dispose?(): Promise<void>
  }>
  /** rc.1 到 alpha.1 的可续启动入口；alpha.2 起由 `startActivation` 取代。 */
  startContinuable?(spec: NativeSubagentStartSpec): Promise<{ readonly childId: string; readonly messageId: string }>
  /** DSH 0.2 可续子会话的后续消息入口；sender 必须是精确的父 Agent。 */
  sendMessage?(sender: unknown, targetId: string, content: readonly { readonly type: 'text'; readonly text: string }[], options?: { readonly signal?: AbortSignal }): Promise<string> | string
}

/**
 * 判断 Host 是否提供任一代原生子代理启动入口。
 *
 * 过去各处直接写 `service.startContinuable === undefined`；在 alpha.2 上这会把
 * 「入口已换成 `startActivation`」误判成「Host 不支持子代理」，让委派、托管桥接
 * 与 `agent_subagent` 工具整块静默降级。统一走这里，业务侧不再关心具体世代。
 */
export function hasNativeSubagentStart(service: NativeSubagentService | undefined): service is NativeSubagentService {
  return typeof service?.startActivation === 'function' || typeof service?.startContinuable === 'function'
}

/**
 * 启动一个原生子代理，屏蔽 `startActivation`（alpha.2+）与 `startContinuable`（更早）差异。
 *
 * `delivery: 'parent'` 与官方 `tool-subagent` 一致：结果由 DSH 投递给父模型，插件自己
 * 只观察子会话生命周期（`waitForChildFirstTurn`），因此不消费 Activation 的 `result`。
 * 托管 Activation 的 `result` 在捕获失败时会 reject，这里挂一个空 catch，避免无人消费
 * 的拒绝冒泡成 Host 进程的未处理异常。
 */
export async function startNativeSubagent(
  service: NativeSubagentService,
  spec: NativeSubagentStartSpec,
): Promise<NativeSubagentStart> {
  if (typeof service.startActivation === 'function') {
    const activation = await service.startActivation({ ...spec, delivery: 'parent' })
    void activation.result?.catch(() => undefined)
    return activation.messageId === undefined
      ? { childId: activation.childId }
      : { childId: activation.childId, messageId: activation.messageId }
  }
  if (typeof service.startContinuable === 'function') {
    const started = await service.startContinuable(spec)
    return { childId: started.childId, messageId: started.messageId }
  }
  throw new Error('DSH 原生 Subagent 能力不可用，当前 Host 未提供可续子会话')
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
      // 子会话必须继承父会话的 DSH 沙箱与审批上下文；外部 CLI 只负责执行协议，
      // 不能因为换了 Provider 就把工作区写入退回到默认的逐次询问模式。
      inheritsParentContext: true,
      start() { throw new Error('外部 Agent Team 提供方只支持可续聊子代理') },
      async prepareContinuable(request) {
        // DSH 可能把缺省的 signal 原样转发（undefined），这里保持容错。
        request.signal?.throwIfAborted()
        const registry = getAdapterRegistry()
        if (registry === undefined) throw new Error('外部 Agent 适配器尚未就绪')
        const adapter = (await registry.catalogForUse([adapterId])).find((item) => item.id === adapterId)
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
