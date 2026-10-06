/** Codingns4DSH 当前可接入的外部 Agent 标识。内部字段沿用 cli 命名以保持协议兼容。 */
export type CodingNsCliAdapterId = string

/** Host 侧可供 Client 展示的外部 Agent 摘要。 */
export interface CodingNsCliAdapterDescriptor {
  readonly id: CodingNsCliAdapterId
  readonly name: string
  /** 适配器使用的标准运行时协议，供设置页和诊断显示。 */
  readonly protocol?: 'command' | 'stream-json' | 'json-rpc' | 'acp' | 'http-sse'
  /** 适配器已经验证的能力；未声明的能力必须按不支持处理。 */
  readonly capabilities?: readonly CodingNsCliCapability[]
  readonly installed: boolean
  readonly enabled: boolean
  readonly version: string | null
  readonly command: string | null
  /** 最近一次安装探测的脱敏诊断；例如 CLI 已找到但启动依赖缺失。 */
  readonly diagnostic?: string
}

export type CodingNsCliCapability =
  | 'models'
  /** Provider 原生 Agent Skill 目录与显式调用能力。 */
  | 'skills'
  | 'stream'
  | 'resume'
  /** DSH 0.2 continuable child 生命周期；声明不代表已接入原生 Team。 */
  | 'continuable'
  /** DSH 0.2 Agent Team proxy 边界；当前插件未声明此能力。 */
  | 'team-proxy'
  | 'interrupt'
  | 'tool-events'
  | 'reasoning'
  | 'usage'
  | 'history'
  | 'permission'
  | 'questions'
  | 'steer'

/**
 * Provider 声明的服务档位（例如 Codex 官方订阅的 Fast / Standard）。
 *
 * `id` 是 Provider 线协议取值，`default` 保留给标准速度；`name` 与 `description`
 * 只用于展示，Host 不得据此推断档位语义。
 */
export interface CodingNsCliServiceTier {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** 适配器模型及其可用思考强度。 */
export interface CodingNsCliModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly efforts: readonly string[]
  /** 思考强度的展示名称；键仍是 Provider 实际接受的 effortId。 */
  readonly effortLabels?: Readonly<Record<string, string>>
  /**
   * Provider 为该模型声明的服务档位；空数组或缺省表示不支持档位切换。
   *
   * 目录声明只说明“该模型可以选”，是否真正可用还取决于账号类型，见
   * `CodingNsCliModelCatalog.officialSubscription`。
   */
  readonly serviceTiers?: readonly CodingNsCliServiceTier[]
}

export interface CodingNsCliModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly CodingNsCliModel[]
}

export interface CodingNsCliModelCatalog {
  readonly groups: readonly CodingNsCliModelGroup[]
  readonly currentModel: string | null
  readonly currentEffort: string | null
  /** 目录来自静态回退而非 Provider 实时确认；Registry 不应按长缓存保存。 */
  readonly fallback?: boolean
  /**
   * Provider 是否确认当前使用官方订阅。
   *
   * 服务档位是官方订阅能力：第三方中转或纯 API key 接入时，目录仍可能返回
   * 档位元数据，但档位不会真正生效。缺省表示未确认，UI 必须按不可用处理，
   * 不能把“没读到”当成“已确认官方订阅”。
   */
  readonly officialSubscription?: boolean
  /**
   * Provider 自身配置的默认档位，即 DSH 没有显式选择时线程真正生效的档位。
   *
   * 必须来自 Provider 的配置（Codex 的 `config/read.service_tier`），不能用
   * `model/list` 的 `defaultServiceTier`：后者只是目录元数据，app-server 在
   * `thread/start` 时并不会自动应用它（实测 gpt-6-luna 声明 priority，线程仍为
   * null）。用错来源会让开关显示“Fast 已开启”，而线程实际以标准档运行。
   */
  readonly defaultServiceTier?: string | null
}

/** Host 向 Client 暴露的 Skill 摘要；路径和 Skill 内容只留在 Host。 */
export interface CodingNsCliSkillDescriptor {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly displayName?: string
}

/** 驱动读取 Provider Skill 目录时使用的 Host 内部请求。 */
export interface CodingNsCliSkillListInput {
  readonly sessionId: string
  readonly cwd?: string
  readonly forceReload?: boolean
  readonly signal?: AbortSignal
}

/** DSH 0.2 Agent Team 能力诊断；明确区分“未接入”与“可用”。 */
export interface CodingNsCliTeamDiagnostic {
  readonly supported: boolean
  readonly code: 'DSH_TEAM_NATIVE_UNAVAILABLE' | 'DSH_TEAM_PROXY_READY'
  readonly message: string
}

/** 每个 DSH 会话绑定的 CLI 选择；不包含凭据。 */
export interface CodingNsCliSessionConfig {
  readonly adapterId: CodingNsCliAdapterId
  readonly modelId?: string
  readonly effortId?: string
  /**
   * Provider 服务档位（例如 Codex 的 `priority` = Fast）。
   *
   * `default` 与缺省语义不同：`default` 是用户显式选择的“标准速度”，驱动必须把它
   * 下发给 Provider；缺省表示 Host 没有该选择，驱动不得擅自改写 Provider 现状。
   * 界面关闭 Fast 时必须写 `default`，否则线程会保留上一次的加速档。
   */
  readonly serviceTierId?: string
  /** DSH 原生模型提供商，例如 deepseek-official、glor；不包含凭据。 */
  readonly providerId?: string
  /** 外部运行时会话标识，只保存在 Host 会话表中。 */
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
  /** DSH 0.2 Session V4 的父会话关系；外部 Provider 不得自行伪造。 */
  readonly parentSessionId?: string
  /** 会话来源，供 V4 projection 区分 subagent 与普通用户会话。 */
  readonly origin?: 'user' | 'subagent' | 'plugin'
  /** 子 Agent 委托深度；仅由 Host/Team adapter 写入。 */
  readonly delegationDepth?: number
  /** Continuable child 的稳定标识。 */
  readonly continuationId?: string
  /** 原生 Team 投影中的 Team 和成员标识。 */
  readonly teamId?: string
  readonly teamMemberId?: string
  /** 最近一次 Provider 用量快照；仅供 Client 展示，不参与会话恢复。 */
  readonly lastUsage?: CodingNsCliSessionUsage
}

/** 外部 Provider 最近一次用量快照；Qoder 等 Provider 可只提供上下文比例或额度。 */
export interface CodingNsCliSessionUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly contextWindow?: number
  readonly contextTokens?: number
  readonly contextUsageRatio?: number
  readonly providerCredits?: number
  readonly capturedAt: number
}

/** Client 展示会话 Agent 时使用的最小脱敏绑定。 */
export interface CodingNsSessionAdapterBinding {
  readonly sessionId: string
  readonly adapterId: CodingNsCliAdapterId
}

/** 外部 Agent 会话在 Host 侧的持久化索引。
 *
 * 这里只保存恢复会话所需的标识和摘要，不保存令牌、原始消息或进程句柄。
 * dshSessionId 仍然是 DSH 的会话主键，providerSessionId 只由 Host 使用。
 */
export type CodingNsCliSessionStatus = 'active' | 'idle' | 'error' | 'archived'

/** 外部 Provider 原始会话的可用状态；与 DSH 会话自身的运行状态相互独立。 */
export type CodingNsCliProviderSessionState =
  | 'unchecked'
  | 'available'
  | 'missing'
  | 'corrupt'
  | 'unreachable'
  | 'unknown'
  | 'ephemeral'

export interface CodingNsCliSessionRecord extends CodingNsCliSessionConfig {
  readonly dshSessionId: string
  readonly title?: string
  readonly cwd?: string
  readonly status: CodingNsCliSessionStatus
  /** 未填写表示旧记录尚未检查，语义等同于 unchecked。 */
  readonly providerState?: CodingNsCliProviderSessionState
  readonly providerCheckedAt?: string
  readonly providerStateReason?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastError?: string
}

/** DSH 会话当前生效的文件沙箱模式，与 DSH `SandboxMode` 取值一致。 */
export type CodingNsCliSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** DSH 会话当前生效的审批策略，与 DSH `ApprovalPolicy` 取值一致。 */
export type CodingNsCliApprovalPolicy = 'ask' | 'never'

/**
 * DSH 会话级权限状态，供驱动派生原生沙箱与审批参数。
 *
 * “请求的权限 ≠ 生效的权限”是硬性语义：字段缺省表示 Host **尚未读到**该事实，
 * 驱动必须保留自己的保守默认，不能把它当成“已确认无限制”。三个字段都只在
 * Host 内流转，不下发到 Client。
 */
export interface CodingNsCliPermissionState {
  /** DSH 已解析的生效模式，含部署默认；缺省表示未读到。 */
  readonly sandboxMode?: CodingNsCliSandboxMode
  /** DSH 已解析的生效审批策略，含部署默认；缺省表示未读到。 */
  readonly approvalPolicy?: CodingNsCliApprovalPolicy
  /** DSH 权限预设名，仅用于诊断与日志，不参与执行判定。 */
  readonly preset?: string
}

/** 传给 CLI 驱动的一轮完整上下文。 */
export interface CodingNsCliTurnInput {
  readonly sessionId: string
  readonly messages: readonly CodingNsCliMessage[]
  readonly prompt: string
  /** 当前用户消息中的已解析附件；路径只在 Host 内部传给驱动。 */
  readonly attachments?: readonly CodingNsCliAttachment[]
  /** DSH 会话权限状态；缺省表示 Host 未读到，驱动沿用保守默认。 */
  readonly permission?: CodingNsCliPermissionState
  /** Provider 原生计划模式；由 Host 显式指定时才下发。 */
  readonly plan?: boolean
  /** 从当前 Provider 会话派生独立会话；由 Host 显式指定时才下发。 */
  readonly forkSession?: boolean
  /** 启用 Provider 的结构化提问工具；由 Host 显式指定时才下发。 */
  readonly enableAskUserQuestion?: boolean
  /** 传给外部 CLI 的受控运行时环境；不会写入会话索引。 */
  readonly runtimeEnv?: Readonly<Record<string, string>>
  readonly modelId?: string
  readonly effortId?: string
  /** Provider 服务档位；`default` 表示标准速度，缺省表示不下发、沿用 Provider 默认。 */
  readonly serviceTierId?: string
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
  /** 仅由 Host 的 DSH 分段桥接使用；让支持的 Provider 在工具完成处结束当前 step。 */
  readonly splitToolSteps?: boolean
  /**
   * 仅由 Host 的 DSH 分段桥接使用；显式说明这次调用是在续接上一次被切分的
   * Provider 运行，而不是新的用户回合。驱动据此复用常驻进程。
   */
  readonly resumeSegmentedTurn?: boolean
}

/** 外部驱动可消费的本地附件路径。 */
export interface CodingNsCliAttachment {
  readonly kind: 'image' | 'file'
  readonly path: string
  readonly name?: string
  readonly mimeType?: string
}

export interface CodingNsAgentPermissionResponse {
  readonly requestId: string
  readonly approved: boolean
  readonly reason?: string
}

/** 外部 Agent 请求用户回答的一道结构化问题。 */
export interface CodingNsAgentQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly {
    readonly label: string
    readonly description?: string
  }[]
  readonly multiSelect?: boolean
}

/** 用户对一组外部 Agent 问题的结构化回答。 */
export interface CodingNsAgentQuestionResponse {
  readonly requestId: string
  readonly answers: readonly {
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }[]
}

export interface CodingNsCliMessage {
  readonly id?: string
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly content: unknown
  /** 工具结果对应的调用 ID；仅 `role:'tool'` 消息使用。 */
  readonly toolCallId?: string
  /** DSH 原生消息来源；插件上下文不能被当成人类输入再次发送给外部 Agent。 */
  readonly source?: { readonly kind?: string; readonly plugin?: string; readonly form?: string; readonly callId?: string }
}

/**
 * 外部 CLI 已经执行过的工具观察事件。
 *
 * `status` 表示真实生命周期。该事件只能写入只读历史，不能转换成
 * DSH 的待执行 `tool-call`。
 */
export interface CodingNsAgentToolEvent {
  readonly type: 'tool-event'
  readonly toolName: string
  readonly status?: 'started' | 'running' | 'completed' | 'failed'
  readonly callId?: string
  readonly input?: string
  readonly output?: string
  /**
   * output 的线协议语义。delta 表示追加片段，snapshot 表示截至当前的完整快照。
   * 只要提供 output 就必须显式填写。
   */
  readonly outputMode?: 'delta' | 'snapshot'
  readonly error?: string
  readonly agentId?: string
  readonly detail?: string
}

/**
 * 所有外部 Agent 必须输出的公共事件契约。
 *
 * Provider 驱动只能理解自己的线协议并生成这些事件；快照去重、交互请求、工具
 * 历史和 DSH 原生消息映射全部由公共消息投影层负责。
 */
export type CodingNsAgentEvent =
  | { readonly type: 'reasoning-delta'; readonly text: string; readonly messageId?: string }
  | { readonly type: 'reasoning-snapshot'; readonly text: string }
  | { readonly type: 'text-delta'; readonly text: string; readonly messageId?: string }
  | { readonly type: 'text-snapshot'; readonly text: string }
  | {
      /** Provider 在同一回合中切换 assistant item 时的内容块边界。 */
      readonly type: 'message-boundary'
      readonly channel: 'reasoning' | 'text'
      readonly messageId: string
    }
  | {
      /** Provider 的 assistant item 已切换，Host 应在当前流结束后注入下一个 DSH step。 */
      readonly type: 'step-boundary'
    }
  | CodingNsAgentToolEvent
  | {
      readonly type: 'usage'
      /**
       * Provider 上报的输入口径：Codex、Command Code 的 inputTokens 已包含缓存读写，
       * Anthropic 风格的 input 不含缓存。公共投影层按 `uncachedInputTokens` 折算成
       * DSH 的互斥桶口径（inputTokens 只含未缓存输入）后再交给 token-meter。
       */
      readonly inputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens?: number
      readonly cacheWriteTokens?: number
      /** 未缓存输入；Provider 给出缓存分桶时由 `usageChunk` 计算。 */
      readonly uncachedInputTokens?: number
      readonly totalTokens?: number
      /** 缓存读取 / 完整输入，百分比取值 0 到 100。 */
      readonly cacheHitRate?: number
      /** Provider 以额度或积分报告的本回合消耗；不把它伪装成 token。 */
      readonly providerCredits?: number
      /** Provider 明确报告的上下文窗口及当前占用，用于会话上下文用量展示。 */
      readonly contextWindow?: number
      readonly contextTokens?: number
      readonly contextUsageRatio?: number
    }
  | {
      readonly type: 'finish'
      readonly reason: 'stop' | 'cancel' | 'error'
      /** Provider 终态携带的真实失败详情；没有详情时由 Host 生成兜底信息。 */
      readonly failure?: { readonly message: string; readonly code?: string }
    }
  | { readonly type: 'session-binding'; readonly providerSessionId: string; readonly rawStoreRef?: string }
  | {
      readonly type: 'permission-request'
      readonly requestId: string
      readonly kind: string
      readonly toolName?: string
      readonly callId?: string
      readonly detail?: string
    }
  | {
      readonly type: 'question-request'
      readonly requestId: string
      readonly questions: readonly CodingNsAgentQuestion[]
      /** Provider 原生问题工具的调用 ID，用于把问题详情并入同一个 tool/call。 */
      readonly callId?: string
    }
  | {
      /** Provider 上下文压缩生命周期；由公共消息投影层写入 DSH 原生事件。 */
      readonly type: 'context-compaction'
      readonly phase: 'start' | 'summary' | 'end'
      readonly compactionId?: string
      readonly provider?: string
      readonly model?: string
      readonly summary?: string
      readonly shadowedItemCount?: number
      readonly shadowedTokenCount?: number
      readonly error?: string
    }
