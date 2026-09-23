/** CodingNS 当前可接入的外部 Agent 标识。内部字段沿用 cli 命名以保持协议兼容。 */
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
}

export type CodingNsCliCapability =
  | 'models'
  | 'stream'
  | 'resume'
  | 'interrupt'
  | 'tool-events'
  | 'reasoning'
  | 'usage'
  | 'permission'
  | 'questions'
  | 'steer'

/** 适配器模型及其可用思考强度。 */
export interface CodingNsCliModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly efforts: readonly string[]
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
}

/** 每个 DSH 会话绑定的 CLI 选择；不包含凭据。 */
export interface CodingNsCliSessionConfig {
  readonly adapterId: CodingNsCliAdapterId
  readonly modelId?: string
  readonly effortId?: string
  /** 外部运行时会话标识，只保存在 Host 会话表中。 */
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
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

/** 传给 CLI 驱动的一轮完整上下文。 */
export interface CodingNsCliTurnInput {
  readonly sessionId: string
  readonly messages: readonly CodingNsCliMessage[]
  readonly prompt: string
  readonly modelId?: string
  readonly effortId?: string
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
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
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: unknown
  /** DSH 原生消息来源；插件上下文不能被当成人类输入再次发送给外部 Agent。 */
  readonly source?: { readonly kind?: string; readonly plugin?: string; readonly form?: string }
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
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'reasoning-snapshot'; readonly text: string }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'text-snapshot'; readonly text: string }
  | CodingNsAgentToolEvent
  | {
      readonly type: 'usage'
      /** Command Code 的 inputTokens 是包含缓存读写的完整输入。 */
      readonly inputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens?: number
      readonly cacheWriteTokens?: number
      readonly uncachedInputTokens?: number
      readonly totalTokens?: number
      /** 缓存读取 / 完整输入，百分比取值 0 到 100。 */
      readonly cacheHitRate?: number
    }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'cancel' | 'error' }
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
    }
