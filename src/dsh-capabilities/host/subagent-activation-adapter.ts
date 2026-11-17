/** CodingNS 内部统一的启动参数；旧宿主直接接收嵌套 request。 */
export interface NativeSubagentStartSpec {
  readonly provider: string
  readonly label?: string
  readonly request: {
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly parent: unknown
    /** 相对目录由 DSH 相对父会话解析；未指定时继承父目录。 */
    readonly cwd?: string
    /** 仅原生 spawn 目标支持逐个子代理覆盖模型路由。 */
    readonly agentOptions?: {
      readonly provider?: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly maxTokens?: number
    }
  }
  readonly signal?: AbortSignal
}

type Delivery = { readonly delivery: 'parent' | 'caller' }
type NestedActivationSpec = NativeSubagentStartSpec & Delivery
type FlatActivationSpec = Omit<NativeSubagentStartSpec, 'request'> & NativeSubagentStartSpec['request'] & Delivery

export interface NativeSubagentStart {
  readonly childId: string
  readonly messageId?: string
}

export interface DshSubagentStartService {
  /** rc.2 的命名子代理树接口，与顶层 Activation 参数一起发布。 */
  namesOf?(agent: unknown): unknown
  rootOf?(agent: unknown): unknown
  /** 托管结果不保证 messageId；delivery 决定结果由父会话还是调用方接收。 */
  startActivation?(spec: NestedActivationSpec | FlatActivationSpec): Promise<NativeSubagentStart & {
    readonly result?: Promise<unknown>
    dispose?(): Promise<void>
  }>
  /** 保留旧可续启动入口，参数仍为嵌套 request。 */
  startContinuable?(spec: NativeSubagentStartSpec): Promise<{ readonly childId: string; readonly messageId: string }>
}

/** 探测命名子代理树契约，不调用宿主，也不通过失败重试猜测参数格式。 */
export function supportsFlatSubagentActivation(service: unknown): boolean {
  const candidate = service as DshSubagentStartService | undefined
  return typeof candidate?.startActivation === 'function'
    && typeof candidate.namesOf === 'function'
    && typeof candidate.rootOf === 'function'
}

export function hasNativeSubagentStart(service: DshSubagentStartService | undefined): service is DshSubagentStartService {
  return typeof service?.startActivation === 'function' || typeof service?.startContinuable === 'function'
}

/**
 * alpha.2 的 Activation 使用嵌套 request；命名子代理树契约使用顶层 parent/prompt。
 * 保留精确的父 Agent、取消信号和 Provider 选项，仅在这个边界转换参数。
 * delivery=parent 由 DSH 投递结果；插件观察会话事件，因此只处理 result 的拒绝。
 */
export async function startNativeSubagent(
  service: DshSubagentStartService,
  spec: NativeSubagentStartSpec,
): Promise<NativeSubagentStart> {
  if (typeof service.startActivation === 'function') {
    const { request, ...options } = spec
    const activation = await service.startActivation(supportsFlatSubagentActivation(service)
      ? { ...options, ...request, delivery: 'parent' }
      : { ...spec, delivery: 'parent' })
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
