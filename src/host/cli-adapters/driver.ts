import type {
  CodingNsCliAdapterDescriptor,
  CodingNsAgentEvent,
  CodingNsAgentQuestionResponse,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
  CodingNsAgentPermissionResponse,
  CodingNsCliSkillDescriptor,
  CodingNsCliSkillListInput,
  CodingNsCliDetection,
} from '../../shared/contracts/cli-adapter.js'

/** 外部 Provider 原始会话的只读存在性状态。 */
export type CodingNsCliSessionProbeState =
  | 'available'
  | 'missing'
  | 'corrupt'
  | 'unreachable'
  | 'unknown'
  | 'ephemeral'

/**
 * 会话探测只接收恢复所需的 Host 私有索引，不得通过 resume/load/prompt 探测，
 * 因为这些协议调用可能修改 Provider 状态或意外创建新会话。
 */
export interface CodingNsCliSessionProbeInput {
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
  readonly cwd?: string
  /** 由 Registry 的探测超时控制器提供；网络型驱动应向下传递。 */
  readonly signal?: AbortSignal
}

export interface CodingNsCliSessionProbeResult {
  readonly state: CodingNsCliSessionProbeState
  readonly reason: string
  /** 探测确认的原始存储位置，只能留在 Host。 */
  readonly rawStoreRef?: string
}

/**
 * Host 内部的标准 Agent 运行时边界。
 *
 * 各适配器可以使用自己的 CLI、JSON-RPC、ACP 或 HTTP/SSE 协议，但对上层只返回
 * 统一的模型目录、会话绑定、文本/推理/工具/用量/完成事件。凭据、原始协议和
 * 进程句柄永远留在 Host 侧，Client 只消费 descriptor 与标准流。
 */
export interface CodingNsCliDriver {
  readonly descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>
  /** @deprecated 兼容旧驱动声明；模型统一按首次使用加载，启动不再预热。 */
  readonly warmModelCatalog?: boolean
  /** 驱动是否已经自行维护 Provider turn 的 step 边界。 */
  readonly supportsSegmentedTurns?: boolean
  /** 驱动可以由 Registry 在工具完成后挂起并续读同一个事件迭代器。 */
  readonly supportsToolStepSplitting?: boolean
  /** 丢弃等待下一个 DSH step 的 Provider 运行；只有自行分段的驱动需要实现。 */
  discardSegmentedTurn?(sessionId: string): void
  detect(): Promise<CodingNsCliDetection>
  /** 安装探测失败时的脱敏原因，供设置页解释“为什么未识别”。 */
  getDiscoveryDiagnostic?(): string | undefined
  getDiscoveryFailure?(): CodingNsCliDetection['detectionFailure']
  /**
   * 影响模型目录语义的 Provider 配置指纹（同步、廉价、脱敏）。
   *
   * 目录里的账号级事实（例如 Codex 的 `officialSubscription`、`defaultServiceTier`）
   * 由 Provider 自己的配置文件决定，而不是由 CLI 版本决定。用户在外部工具里切换
   * 供应商或登录状态时，CLI 可执行文件没有任何变化，安装探测指纹因此不会变，
   * 长 TTL 的目录缓存会把旧的账号判定一直沿用下去——界面就会长期缺少依赖该判定
   * 的控件（例如 Codex 官方订阅的 Fast 服务档位开关）。
   *
   * Registry 在每次读取目录前比对该指纹：一旦变化就立刻作废目录缓存并重新探测，
   * 不必等待 TTL 到期，也不必重启 Host。
   *
   * 实现约束：
   * - 只返回脱敏摘要（哈希或规范化后的非敏感字段），绝不能包含凭据原文；
   * - 必须是同步且廉价的读取，因为它位于每次目录读取的热路径上；
   * - 读不到配置时返回 `undefined`，表示“无法判断”，Registry 不会据此失效缓存。
   */
  catalogFingerprint?(): string | undefined
  listModels(): Promise<CodingNsCliModelCatalog>
  /** 读取 Provider 原生 Skill 目录；未声明 `skills` 能力的驱动不得实现此方法。 */
  listSkills?(input: CodingNsCliSkillListInput): Promise<readonly CodingNsCliSkillDescriptor[]>
  probeSession?(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult>
  executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent>
  respondPermission?(sessionId: string, response: CodingNsAgentPermissionResponse): Promise<void> | void
  respondQuestion?(sessionId: string, response: CodingNsAgentQuestionResponse): Promise<void> | void
  steer?(sessionId: string, prompt: string): Promise<void> | void
  followUp?(sessionId: string, prompt: string): Promise<void> | void
  interrupt?(sessionId: string): Promise<void> | void
  dispose?(): Promise<void> | void
}
